/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 visiuun
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * NotificationSounds: different sounds for DMs, group DMs, pings, reply pings, role pings, @everyone, @here, threads…
 * Idea and default category sounds from DevilBro's BetterDiscord plugin of the same name (no code taken from it).
 *
 * How it works:
 *   Discord still decides WHETHER a notification sound plays (mutes, DND, focus, suppress settings,
 *   streamer mode, "disable sounds" toggles all keep working). This plugin only decides WHICH sound.
 *   1. A Flux interceptor sees every MESSAGE_CREATE before Discord's own handlers and classifies it.
 *   2. When Discord then creates its message sound, an AudioPlayerAPI processor swaps the source
 *      and volume for the one configured for that category. Nothing else is patched.
 */

import "./styles.css";

import { addAudioProcessor, defaultAudioNames, playAudio, PreprocessAudioData, removeAudioProcessor } from "@api/AudioPlayer";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildMemberStore, PresenceStore, SelectedChannelStore, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";

const PLUGIN = "NotificationSounds";
const logger = new Logger(PLUGIN, "#f0b232");

// ─── Types & constants ──────────────────────────────────────────────────────────────────────────

/** `def` is the sound a category gets out of the box (same defaults as DevilBro's plugin). */
const CATEGORIES = [
    { id: "dm", name: "Direct message", hint: "A 1-on-1 DM", def: "message3" },
    { id: "groupdm", name: "Group DM", hint: "A message in a group DM", def: "message3" },
    { id: "mention", name: "Ping", hint: "Someone @mentions you in a server", def: "message2" },
    { id: "reply", name: "Reply ping", hint: "Someone replies to you with the ping turned on", def: "message2" },
    { id: "role", name: "Role ping", hint: "A role you have gets @mentioned", def: "mention1" },
    { id: "everyone", name: "@everyone", hint: "Server-wide @everyone ping", def: "mention2" },
    { id: "here", name: "@here", hint: "Server-wide @here ping", def: "mention3" },
    { id: "thread", name: "Thread message", hint: "A message in a thread you follow", def: "message1" },
    { id: "server", name: "Server message", hint: "Any other server message Discord plays a sound for (channels set to All Messages)", def: "message1" },
    { id: "current", name: "Current channel", hint: "A message in the channel you're viewing, when Discord plays a sound for it", def: "message3" },
] as const;

type CategoryId = typeof CATEGORIES[number]["id"];

const CATEGORY_DEFAULT = Object.fromEntries(CATEGORIES.map(c => [c.id, c.def])) as Record<CategoryId, string>;

/**
 * src: ""          → default (categories: their own default sound; other sounds: Discord's sound)
 *      "keep"      → categories only: leave Discord's sound alone
 *      "none"      → silent
 *      "d:<name>"  → a built-in Discord sound
 *      "f:<id>"    → one of your uploaded files
 */
interface SoundConfig {
    src: string;
    volume: number;
    muteInvisible?: boolean;
    muteStreaming?: boolean;
}

interface FileMeta {
    name: string;
    size: number;
    added: number;
}

interface MatchLog {
    time: number;
    sound: string;
    rule: string;
    result: string;
}

/** Sounds Discord uses for message notifications, including soundpack/seasonal variants (bit_message1, halloween_message1…). */
const MESSAGE_SOUND = /(?:^|_)(?:message[1-3]|mention[1-3])$/;
/** How long a classified message stays eligible to be matched to the next message sound. */
const MATCH_WINDOW_MS = 2000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FILE_KEY = (id: string) => `${PLUGIN}_file_${id}`;
const THREAD_TYPES = new Set([10, 11, 12]);

const DEFAULT_CFG: SoundConfig = { src: "", volume: 100 };

// ─── Discord sound names ────────────────────────────────────────────────────────────────────────

/** Sounds that exist but Discord never plays as a normal event sound. */
const HIDDEN_SOUNDS = new Set(["human_man", "robot_man", "overlayunlock", "call_ringing_beat"]);
const NAME_SYNONYMS: Record<string, string> = { reconnect: "Invited To Speak" };
const NAME_PREFIXES: Record<string, string> = { user_join: "Voice Channel", user_leave: "Voice Channel", user_moved: "Voice Channel" };

let packCache: Set<string> | null = null;
/** Seasonal/themed packs that re-skin many sounds (halloween_, winter_…), so `halloween_mute` counts as `mute`. */
function soundPacks(): Set<string> {
    if (packCache) return packCache;
    const names = defaultAudioNames();
    const counts: Record<string, number> = {};
    for (const n of names) {
        const i = n.indexOf("_");
        if (i > 0) counts[n.slice(0, i)] = (counts[n.slice(0, i)] ?? 0) + 1;
    }
    const packs = new Set(Object.keys(counts).filter(p => counts[p] > 8));
    if (names.length) packCache = packs;
    return packs;
}

/** `halloween_mute` → `mute`; anything else unchanged. */
function baseSoundName(name: string): string {
    const i = name.indexOf("_");
    if (i > 0 && soundPacks().has(name.slice(0, i))) {
        const rest = name.slice(i + 1);
        if (defaultAudioNames().includes(rest)) return rest;
    }
    return name;
}

function prettySoundName(id: string): string {
    const words = (NAME_SYNONYMS[id] ?? id).replace("ddr-", "HotKeys_").replace("ptt_", "Push2Talk_").split(/[_-]/);
    return [NAME_PREFIXES[id], ...words].filter(Boolean).map(w => w![0].toUpperCase() + w!.slice(1)).join(" ");
}

/** Every event sound worth listing: no pack re-skins, no numbered message/mention sounds (those are the categories). */
function listableSounds(): string[] {
    const packs = soundPacks();
    return defaultAudioNames()
        .filter(n => !HIDDEN_SOUNDS.has(n) && !n.startsWith("poggermode_") && !/\d$/.test(n) && !packs.has(n.split("_")[0]))
        .sort((a, b) => prettySoundName(a).localeCompare(prettySoundName(b)));
}

// ─── Settings ───────────────────────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    masterVolume: {
        type: OptionType.SLIDER,
        description: "Volume for every sound this plugin plays (on top of Discord's output volume and each sound's own volume)",
        markers: [0, 25, 50, 75, 100],
        default: 100,
        stickToMarkers: false
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Debug mode: log every match to the console (Ctrl+Shift+I) and show recent matches below",
        default: false
    },
    categories: {
        type: OptionType.CUSTOM,
        description: "Per-category sound configuration",
        default: {} as Record<string, SoundConfig>
    },
    sounds: {
        type: OptionType.CUSTOM,
        description: "Per-Discord-sound overrides",
        default: {} as Record<string, SoundConfig>
    },
    files: {
        type: OptionType.CUSTOM,
        description: "Uploaded sound files (metadata only; audio lives in IndexedDB)",
        default: {} as Record<string, FileMeta>
    },
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    }
});

// ─── Stores that might not exist in every fork/version ─────────────────────────────────────────

const UserGuildSettingsStore = findStoreLazy("UserGuildSettingsStore");
const SelfPresenceStore = findStoreLazy("SelfPresenceStore");
const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function myStatus(): string | undefined {
    return safe(() => SelfPresenceStore.getStatus(), undefined)
        ?? safe(() => PresenceStore.getStatus(UserStore.getCurrentUser().id), undefined);
}

function isStreaming(): boolean {
    return safe(() => !!ApplicationStreamingStore.getCurrentUserActiveStream(), false);
}

// ─── Uploaded files ─────────────────────────────────────────────────────────────────────────────

const fileCache = new Map<string, string>();
const fileLoads = new Map<string, Promise<string | null>>();

function loadFile(id: string): Promise<string | null> {
    const cached = fileCache.get(id);
    if (cached) return Promise.resolve(cached);

    let p = fileLoads.get(id);
    if (!p) {
        p = DataStore.get<string>(FILE_KEY(id))
            .then(uri => {
                if (uri) fileCache.set(id, uri);
                else logger.warn(`Sound file ${id} is missing from storage`);
                return uri ?? null;
            })
            .catch(err => {
                logger.error(`Could not load sound file ${id}`, err);
                return null;
            })
            .finally(() => fileLoads.delete(id));
        fileLoads.set(id, p);
    }
    return p;
}

function referencedFileIds(): Set<string> {
    const ids = new Set<string>();
    const all = [...Object.values(settings.store.categories ?? {}), ...Object.values(settings.store.sounds ?? {})] as SoundConfig[];
    for (const cfg of all) if (cfg?.src?.startsWith("f:")) ids.add(cfg.src.slice(2));
    return ids;
}

/** Drops cached audio for files no rule uses anymore, so they don't sit in memory. */
function pruneFileCache() {
    const used = referencedFileIds();
    for (const id of fileCache.keys()) if (!used.has(id)) fileCache.delete(id);
}

function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
        reader.readAsDataURL(file);
    });
}

/** Makes sure Chromium can actually decode the file before we save it. */
function probeAudio(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const audio = new Audio();
        const done = (err?: Error) => {
            clearTimeout(timer);
            audio.onloadedmetadata = audio.onerror = null;
            audio.removeAttribute("src");
            audio.load();
            err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => done(new Error("Timed out while reading the audio")), 8000);
        audio.preload = "metadata";
        audio.onloadedmetadata = () => done();
        audio.onerror = () => done(new Error("This file can't be played. Try an .mp3, .ogg or .wav"));
        audio.src = src;
    });
}

async function addFile(file: File): Promise<string> {
    if (file.size > MAX_FILE_BYTES)
        throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB`);

    const uri = await readAsDataURL(file);
    await probeAudio(uri);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await DataStore.set(FILE_KEY(id), uri);
    fileCache.set(id, uri);
    settings.store.files = { ...settings.store.files, [id]: { name: file.name, size: file.size, added: Date.now() } };
    return id;
}

async function removeFile(id: string) {
    const ref = `f:${id}`;
    const strip = (map: Record<string, SoundConfig>) => {
        let changed = false;
        const next: Record<string, SoundConfig> = {};
        for (const [k, v] of Object.entries(map ?? {})) {
            if (v?.src === ref) {
                next[k] = { ...v, src: "" };
                changed = true;
            } else next[k] = v;
        }
        return changed ? next : null;
    };

    const cats = strip(settings.store.categories);
    if (cats) settings.store.categories = cats;
    const snds = strip(settings.store.sounds);
    if (snds) settings.store.sounds = snds;

    const { [id]: _, ...rest } = settings.store.files ?? {};
    settings.store.files = rest;
    fileCache.delete(id);
    await DataStore.del(FILE_KEY(id));
}

// ─── Classification ─────────────────────────────────────────────────────────────────────────────

let pending: { cat: CategoryId; ts: number; } | null = null;
const recent: MatchLog[] = [];

function debugLog(entry: Omit<MatchLog, "time">) {
    if (!settings.store.debug) return;
    const full = { time: Date.now(), ...entry };
    recent.unshift(full);
    if (recent.length > 15) recent.length = 15;
    logger.info(`${entry.sound} → [${entry.rule}] ${entry.result}`);
}

function mentionsUser(mentions: any[] | undefined, userId: string): boolean {
    if (!Array.isArray(mentions)) return false;
    for (const m of mentions) if ((typeof m === "string" ? m : m?.id) === userId) return true;
    return false;
}

function classify(msg: any, channel: any, myId: string): CategoryId | null {
    const { type } = channel;
    if (type === 1) return "dm";
    if (type === 3) return "groupdm";

    const guildId: string | undefined = msg.guild_id ?? channel.guild_id;
    const content: string = typeof msg.content === "string" ? msg.content : "";

    if (mentionsUser(msg.mentions, myId)) {
        // A reply pings the replied-to author through `mentions` without writing <@id> in the text.
        const explicit = content.includes(`<@${myId}>`) || content.includes(`<@!${myId}>`);
        return msg.type === 19 && !explicit ? "reply" : "mention";
    }

    if (guildId && Array.isArray(msg.mention_roles) && msg.mention_roles.length
        && !safe(() => UserGuildSettingsStore.isSuppressRolesEnabled(guildId), false)) {
        const roles: string[] | undefined = GuildMemberStore.getMember(guildId, myId)?.roles;
        if (roles?.some(r => msg.mention_roles.includes(r))) return "role";
    }

    if (msg.mention_everyone && !(guildId && safe(() => UserGuildSettingsStore.isSuppressEveryoneEnabled(guildId), false))) {
        if (content.includes("@everyone")) return "everyone";
        if (content.includes("@here")) return "here";
        return "everyone";
    }

    if (channel.id === SelectedChannelStore.getChannelId()) return "current";
    if (THREAD_TYPES.has(type)) return "thread";
    return "server";
}

function onMessageCreate(action: any) {
    const msg = action.message;
    if (!msg || action.optimistic) return;

    const me = UserStore.getCurrentUser();
    if (!me || msg.author?.id === me.id) return;

    const channel = ChannelStore.getChannel(msg.channel_id ?? action.channelId);
    if (!channel) return;

    const cat = classify(msg, channel, me.id);
    if (cat) pending = { cat, ts: Date.now() };
}

/** Runs before every Flux action handler. Must return false or Discord drops the action. */
function interceptor(action: any): boolean {
    if (action?.type === "MESSAGE_CREATE") {
        try {
            onMessageCreate(action);
        } catch (err) {
            logger.error("Failed to classify message", err);
        }
    }
    return false;
}

// ─── Audio processing ───────────────────────────────────────────────────────────────────────────

let previewing = false;
let subscribedFallback = false;

function isSilencedByStatus(cfg: SoundConfig): boolean {
    if (!cfg.muteInvisible && !cfg.muteStreaming) return false;
    if (cfg.muteStreaming && isStreaming()) return true;
    if (cfg.muteInvisible) {
        const status = myStatus();
        if (status === "invisible" || status === "offline") return true;
    }
    return false;
}

/** Returns the audio string to play, null for silence, or undefined to keep the original. */
function resolveSource(src: string): string | null | undefined {
    if (!src) return undefined;
    if (src === "none") return null;
    if (src.startsWith("d:")) return src.slice(2);
    if (src.startsWith("f:")) {
        const id = src.slice(2);
        const uri = fileCache.get(id);
        if (!uri) void loadFile(id); // ready next time; this time Discord's own sound plays
        return uri;
    }
    return undefined;
}

function scaledVolume(base: number, cfg: SoundConfig): number {
    return base * (cfg.volume ?? 100) / 100 * (settings.store.masterVolume ?? 100) / 100;
}

function applyConfig(data: PreprocessAudioData, cfg: SoundConfig): string {
    if (isSilencedByStatus(cfg)) {
        data.volume = 0;
        return "silenced by status";
    }
    const audio = resolveSource(cfg.src);
    if (audio === null) {
        data.volume = 0;
        return "silent";
    }
    if (audio) data.audio = audio;
    data.volume = scaledVolume(data.volume, cfg);
    return audio ? `→ ${cfg.src.startsWith("f:") ? settings.store.files?.[cfg.src.slice(2)]?.name ?? "file" : audio}` : "file not loaded yet, kept Discord's sound";
}

/**
 * The sound a category's "Default" stands for. With a message soundpack on (bit_message1, lofi_message1…)
 * the pack's own variant is used when it has one; otherwise the pack sound Discord picked is kept.
 */
function categoryDefault(cat: CategoryId, playing: string): string {
    const def = CATEGORY_DEFAULT[cat];
    const pack = playing.match(/^(.+)_(?:message|mention)\d$/)?.[1];
    if (!pack) return def;
    const variant = `${pack}_${def}`;
    return defaultAudioNames().includes(variant) ? variant : playing;
}

function categoryConfig(cat: CategoryId): SoundConfig {
    return { ...DEFAULT_CFG, ...settings.store.categories?.[cat] };
}

function processAudio(data: PreprocessAudioData) {
    if (previewing) return;
    const name = data.audio;
    if (typeof name !== "string" || name.length > 64) return; // data URIs / URLs from other code

    try {
        const base = baseSoundName(name);
        let matchedCat: CategoryId | null = null;
        if (MESSAGE_SOUND.test(name) && pending) {
            const { cat, ts } = pending;
            pending = null;
            if (Date.now() - ts <= MATCH_WINDOW_MS) {
                const cfg = categoryConfig(cat);
                if (cfg.src !== "keep") {
                    const effective = cfg.src ? cfg : { ...cfg, src: `d:${categoryDefault(cat, name)}` };
                    debugLog({ sound: name, rule: cfg.src ? cat : `${cat} (default)`, result: applyConfig(data, effective) });
                    return;
                }
                matchedCat = cat;
            }
        }

        // A category set to "Discord's sound" still lets a per-sound override apply.
        const cfg = settings.store.sounds?.[base] as SoundConfig | undefined;
        if (cfg?.src) {
            debugLog({ sound: name, rule: matchedCat ? `${matchedCat} → sound:${base}` : `sound:${base}`, result: applyConfig(data, cfg) });
        } else if (matchedCat) {
            debugLog({ sound: name, rule: matchedCat, result: "category keeps Discord's sound" });
        } else if (MESSAGE_SOUND.test(name)) {
            debugLog({ sound: name, rule: "none", result: "no rule matched, Discord's sound plays" });
        }
    } catch (err) {
        logger.error("Audio processor failed; Discord's sound will play unchanged", err);
    }
}

// ─── Preview ────────────────────────────────────────────────────────────────────────────────────

let lastPreview: { stop(): void; } | null = null;

async function preview(cfg: SoundConfig, fallback = "message1") {
    let audio: string | null | undefined;
    if (cfg.src.startsWith("f:")) audio = await loadFile(cfg.src.slice(2));
    else audio = resolveSource(cfg.src);
    const volume = Math.min(100, scaledVolume(100, cfg));
    // AudioPlayerAPI treats volume 0 as "unset" (full volume), so skip silent previews entirely.
    if (audio === null || volume <= 0) return;

    try {
        lastPreview?.stop();
    } catch { }

    previewing = true;
    try {
        lastPreview = playAudio(audio ?? fallback, { volume });
    } catch (err) {
        logger.error("Preview failed", err);
    } finally {
        previewing = false;
    }
}

// ─── Settings UI ────────────────────────────────────────────────────────────────────────────────

function useDiscordSounds(): string[] {
    return useMemo(() => safe(() => [...defaultAudioNames()].sort(), [] as string[]), []);
}

function formatBytes(n: number) {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const MESSAGE_SOUNDS = ["message1", "message2", "message3", "mention1", "mention2", "mention3"];

/** Splits the sound list into dropdown groups so the message/mention sounds aren't buried alphabetically. */
function groupSounds(all: string[]): [string, string[]][] {
    const listed = new Set(safe(listableSounds, [] as string[]));
    const message = MESSAGE_SOUNDS.filter(n => all.includes(n));
    const packs = all.filter(n => /_(?:message|mention)\d$/.test(n)).sort();
    const event = all.filter(n => listed.has(n)).sort((a, b) => prettySoundName(a).localeCompare(prettySoundName(b)));
    const used = new Set([...message, ...packs, ...event]);
    const extra = all.filter(n => !used.has(n)).sort();
    return [
        ["Message & mention sounds", message],
        ["Message soundpacks", packs],
        ["Other Discord sounds", event],
        ["Seasonal & extras", extra],
    ];
}

function soundLabel(n: string): string {
    if (MESSAGE_SOUNDS.includes(n) || /_(?:message|mention)\d$/.test(n)) return n;
    const pretty = prettySoundName(n);
    return pretty.toLowerCase().replace(/ /g, "_") === n.toLowerCase() ? pretty : `${pretty} (${n})`;
}

function SourceSelect({ value, onChange, files, discordSounds, defaultLabel, allowKeep }: {
    value: string;
    onChange(v: string): void;
    files: Record<string, FileMeta>;
    discordSounds: string[];
    defaultLabel: string;
    allowKeep?: boolean;
}) {
    const fileEntries = Object.entries(files);
    const groups = useMemo(() => groupSounds(discordSounds), [discordSounds]);
    const known = !value || value === "none" || (allowKeep && value === "keep")
        || (value.startsWith("f:") && files[value.slice(2)])
        || (value.startsWith("d:") && discordSounds.includes(value.slice(2)));

    return (
        <select className="vc-ns-select" value={value} onChange={e => onChange(e.currentTarget.value)}>
            <option value="">{defaultLabel}</option>
            {allowKeep && <option value="keep">Discord's own sound (no change)</option>}
            <option value="none">Silent</option>
            {!known && <option value={value}>Missing: {value.slice(2)}</option>}
            {fileEntries.length > 0 && (
                <optgroup label="My sounds">
                    {fileEntries.map(([id, f]) => <option key={id} value={`f:${id}`}>{f.name}</option>)}
                </optgroup>
            )}
            {groups.map(([label, names]) => names.length > 0 && (
                <optgroup key={label} label={label}>
                    {names.map(n => <option key={n} value={`d:${n}`}>{soundLabel(n)}</option>)}
                </optgroup>
            ))}
        </select>
    );
}

function SoundRow({ title, hint, cfg, files, discordSounds, previewFallback, defaultLabel, isCategory, statusToggles, onChange }: {
    title: string;
    hint?: string;
    cfg: SoundConfig;
    files: Record<string, FileMeta>;
    discordSounds: string[];
    /** What ▶ plays when the source is "" or "keep". */
    previewFallback: string | ((src: string) => string);
    defaultLabel: string;
    /** Categories replace the sound even on "Default", so volume and toggles stay usable there. */
    isCategory?: boolean;
    statusToggles?: boolean;
    onChange(cfg: SoundConfig): void;
}) {
    const replaces = cfg.src === "" ? !!isCategory : cfg.src !== "none" && cfg.src !== "keep";
    const fallbackFor = (src: string) => typeof previewFallback === "function" ? previewFallback(src) : previewFallback;
    const [volume, setVolume] = useState(cfg.volume ?? 100);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => setVolume(cfg.volume ?? 100), [cfg.volume]);
    useEffect(() => () => clearTimeout(timer.current), []);

    const changeVolume = (v: number) => {
        setVolume(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange({ ...cfg, volume: v }), 300);
    };

    return (
        <div className={"vc-ns-row" + (cfg.src && cfg.src !== "keep" ? " vc-ns-row-active" : "")}>
            <div className="vc-ns-row-head">
                <div className="vc-ns-row-text">
                    <div className="vc-ns-title">{title}</div>
                    {hint && <div className="vc-ns-hint">{hint}</div>}
                </div>
                <button
                    className="vc-ns-btn vc-ns-icon-btn"
                    title="Play"
                    disabled={cfg.src === "none"}
                    onClick={() => preview({ ...cfg, volume }, fallbackFor(cfg.src))}
                >▶</button>
            </div>
            <div className="vc-ns-controls">
                <SourceSelect
                    value={cfg.src}
                    files={files}
                    discordSounds={discordSounds}
                    defaultLabel={defaultLabel}
                    allowKeep={isCategory}
                    onChange={src => {
                        const next = { ...cfg, src, volume };
                        onChange(next);
                        if (src !== "none") void preview(next, fallbackFor(src));
                    }}
                />
                <label className="vc-ns-volume" title="Volume">
                    <input
                        type="range"
                        min={0}
                        max={100}
                        value={volume}
                        disabled={!replaces}
                        onChange={e => changeVolume(Number(e.currentTarget.value))}
                    />
                    <span>{volume}%</span>
                </label>
            </div>
            {statusToggles && replaces && (
                <div className="vc-ns-toggles">
                    <label>
                        <input type="checkbox" checked={!!cfg.muteInvisible} onChange={e => onChange({ ...cfg, volume, muteInvisible: e.currentTarget.checked })} />
                        Silent while Invisible
                    </label>
                    <label>
                        <input type="checkbox" checked={!!cfg.muteStreaming} onChange={e => onChange({ ...cfg, volume, muteStreaming: e.currentTarget.checked })} />
                        Silent while streaming
                    </label>
                </div>
            )}
        </div>
    );
}

function FilesSection({ files }: { files: Record<string, FileMeta>; }) {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ ok: boolean; text: string; } | null>(null);
    const entries = Object.entries(files).sort((a, b) => a[1].name.localeCompare(b[1].name));

    const onPick = async (list: FileList | null) => {
        if (!list?.length) return;
        setBusy(true);
        setStatus(null);
        const added: string[] = [];
        const failed: string[] = [];
        for (const file of Array.from(list)) {
            try {
                await addFile(file);
                added.push(file.name);
            } catch (err: any) {
                failed.push(err?.message ?? String(err));
            }
        }
        setBusy(false);
        if (input.current) input.current.value = "";
        setStatus(failed.length
            ? { ok: false, text: failed.join(" · ") }
            : { ok: true, text: `Added ${added.join(", ")}. Pick it in a dropdown above.` });
    };

    return (
        <div className="vc-ns-section">
            <div className="vc-ns-section-title">My sounds</div>
            <div className="vc-ns-hint">mp3, ogg, wav, m4a or webm, up to {MAX_FILE_BYTES / 1048576} MB each. Stored locally on this device.</div>
            <div className="vc-ns-files">
                {entries.length === 0 && <div className="vc-ns-empty">No uploaded sounds yet.</div>}
                {entries.map(([id, f]) => (
                    <div className="vc-ns-file" key={id}>
                        <span className="vc-ns-file-name" title={f.name}>{f.name}</span>
                        <span className="vc-ns-file-size">{formatBytes(f.size)}</span>
                        <button className="vc-ns-btn vc-ns-icon-btn" title="Play" onClick={() => preview({ src: `f:${id}`, volume: 100 })}>▶</button>
                        <button
                            className="vc-ns-btn vc-ns-icon-btn vc-ns-danger"
                            title="Delete"
                            onClick={() => {
                                if (confirm(`Delete "${f.name}"? Rules using it go back to Discord's default.`)) void removeFile(id);
                            }}
                        >✕</button>
                    </div>
                ))}
            </div>
            <input ref={input} type="file" accept="audio/*,video/webm,.mp3,.ogg,.wav,.m4a,.webm" multiple hidden onChange={e => onPick(e.currentTarget.files)} />
            <button className="vc-ns-btn vc-ns-primary" disabled={busy} onClick={() => input.current?.click()}>
                {busy ? "Adding…" : "Upload sound"}
            </button>
            {status && <div className={status.ok ? "vc-ns-ok" : "vc-ns-error"}>{status.text}</div>}
        </div>
    );
}

function OtherSoundsSection({ sounds, files, discordSounds }: {
    sounds: Record<string, SoundConfig>;
    files: Record<string, FileMeta>;
    discordSounds: string[];
}) {
    const [query, setQuery] = useState("");
    const [changedOnly, setChangedOnly] = useState(false);
    const all = useMemo(() => safe(listableSounds, [] as string[]), [discordSounds]);
    const q = query.trim().toLowerCase();
    const shown = all.filter(n =>
        (!changedOnly || sounds[n]?.src)
        && (!q || n.toLowerCase().includes(q) || prettySoundName(n).toLowerCase().includes(q)));

    return (
        <div className="vc-ns-section">
            <div className="vc-ns-section-title">Other Discord sounds</div>
            <div className="vc-ns-hint">
                Calls, voice joins/leaves, mute, deafen, streams and the rest. Seasonal versions (Halloween, winter…) follow the same setting.
            </div>
            <div className="vc-ns-filter">
                <input className="vc-ns-search" placeholder={`Search ${all.length} sounds…`} value={query} onChange={e => setQuery(e.currentTarget.value)} />
                <label>
                    <input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.currentTarget.checked)} />
                    Changed only
                </label>
            </div>
            {shown.length === 0 && <div className="vc-ns-empty">No sounds match.</div>}
            {shown.map(name => (
                <SoundRow
                    key={name}
                    title={prettySoundName(name)}
                    hint={name}
                    cfg={{ ...DEFAULT_CFG, ...sounds[name] }}
                    files={files}
                    discordSounds={discordSounds}
                    previewFallback={name}
                    defaultLabel="Discord default"
                    statusToggles
                    onChange={cfg => {
                        if (cfg.src) settings.store.sounds = { ...settings.store.sounds, [name]: cfg };
                        else {
                            const { [name]: _, ...rest } = settings.store.sounds ?? {};
                            settings.store.sounds = rest;
                        }
                        pruneFileCache();
                    }}
                />
            ))}
        </div>
    );
}

function DebugSection() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);

    return (
        <div className="vc-ns-section">
            <div className="vc-ns-section-title">Recent matches</div>
            <div className="vc-ns-hint">Live. Full log is in the console (Ctrl+Shift+I), prefixed [{PLUGIN}].</div>
            {recent.length === 0
                ? <div className="vc-ns-empty">Nothing yet. Get someone to ping you.</div>
                : (
                    <div className="vc-ns-log">
                        {recent.map((r, i) => (
                            <div key={r.time + ":" + i}>
                                <span className="vc-ns-log-time">{new Date(r.time).toLocaleTimeString()}</span>
                                {" "}<b>{r.sound}</b> [{r.rule}] {r.result}
                            </div>
                        ))}
                    </div>
                )}
        </div>
    );
}

function SettingsPanel() {
    const { categories = {}, sounds = {}, files = {}, debug } = settings.use(["categories", "sounds", "files", "debug"]);
    const discordSounds = useDiscordSounds();

    useEffect(() => {
        for (const id of referencedFileIds()) void loadFile(id);
    }, []);

    return (
        <div className="vc-ns">
            <div className="vc-ns-section">
                <div className="vc-ns-section-title">Message notifications</div>
                <div className="vc-ns-hint">
                    Discord still decides whether a sound plays (mutes, DND, focus and notification settings all apply). These only change which sound you hear.
                </div>
                {CATEGORIES.map(c => (
                    <SoundRow
                        key={c.id}
                        title={c.name}
                        hint={c.hint}
                        cfg={{ ...DEFAULT_CFG, ...categories[c.id] }}
                        files={files}
                        discordSounds={discordSounds}
                        previewFallback={src => src === "keep" ? (c.id === "current" ? "message3" : "message1") : c.def}
                        defaultLabel={`Default (${c.def})`}
                        isCategory
                        statusToggles
                        onChange={cfg => {
                            settings.store.categories = { ...settings.store.categories, [c.id]: cfg };
                            pruneFileCache();
                        }}
                    />
                ))}
            </div>
            <FilesSection files={files} />
            <OtherSoundsSection sounds={sounds} files={files} discordSounds={discordSounds} />
            {debug && <DebugSection />}
        </div>
    );
}

// ─── Plugin ─────────────────────────────────────────────────────────────────────────────────────

export default definePlugin({
    name: PLUGIN,
    description: "Different notification sounds for DMs, group DMs, pings, reply pings, role pings, @everyone, @here, threads and more. Upload your own sounds or pick Discord's.",
    authors: [{ name: "visiuun", id: 636585243846901802n }],
    dependencies: ["AudioPlayerAPI"],
    settings,

    start() {
        addAudioProcessor(PLUGIN, processAudio);

        if (typeof FluxDispatcher.addInterceptor === "function") {
            FluxDispatcher.addInterceptor(interceptor);
        } else {
            // Very old/odd builds: still works, but may race Discord's own handler.
            logger.warn("FluxDispatcher.addInterceptor missing, falling back to subscribe()");
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreateSafe);
            subscribedFallback = true;
        }

        for (const id of referencedFileIds()) void loadFile(id);
        if (settings.store.debug) logger.info("Started. Rules:", { categories: settings.store.categories, sounds: settings.store.sounds });
    },

    stop() {
        removeAudioProcessor(PLUGIN);

        const list: unknown[] | undefined = (FluxDispatcher as any)._interceptors;
        const idx = list?.indexOf(interceptor) ?? -1;
        if (idx !== -1) list!.splice(idx, 1);
        if (subscribedFallback) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreateSafe);
            subscribedFallback = false;
        }

        try {
            lastPreview?.stop();
        } catch { }
        lastPreview = null;
        pending = null;
        recent.length = 0;
        fileCache.clear();
    },

    /** Console helper: Vencord.Plugins.plugins.NotificationSounds.test("role") */
    test(cat: CategoryId) {
        if (!(cat in CATEGORY_DEFAULT)) return logger.warn(`Unknown category "${cat}". Use one of: ${Object.keys(CATEGORY_DEFAULT).join(", ")}`);
        const cfg = categoryConfig(cat);
        if (cfg.src === "keep") return logger.info(`"${cat}" keeps Discord's own sound`);
        void preview(cfg, CATEGORY_DEFAULT[cat]);
    },

    /** Console helper: shows what the next message sound would be matched to. */
    inspect() {
        return { pending, recent: [...recent], cachedFiles: [...fileCache.keys()] };
    }
});

function onMessageCreateSafe(action: any) {
    try {
        onMessageCreate(action);
    } catch (err) {
        logger.error("Failed to classify message", err);
    }
}
