/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { ImageIcon, StickerIcon } from "@components/Icons";
import { fetchUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { pluralize } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel, Guild, Message, User } from "@vencord/discord-types";
import { ChannelStore, Menu, MessageStore, UserProfileStore } from "@webpack/common";
import type { ReactElement } from "react";

import { applyTemplate, bannerMedia, collectEmojis, collectMedia, guildMedia, Media, mediaFromUrl, Source, sourceFromMessage, sourceFromUser, userMedia } from "./media";
import style from "./styles.css?managed";

const Native = VencordNative.pluginHelpers.BetterDownload as PluginNative<typeof import("./native")>;
const logger = new Logger("BetterDownload");
function DownloadIcon({ height = 24, width = 24, className }: { height?: number | string; width?: number | string; className?: string; }) {
    return (
        <svg className={className} height={height} width={width} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 1 0 0 2h18a1 1 0 1 0 0-2H3Z" />
        </svg>
    );
}

function FolderPicker() {
    const { folder } = settings.use(["folder"]);
    return (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {folder || "Downloads folder"}
            </code>
            <Button size="small" onClick={async () => {
                const picked = await Native.pickFolder(folder);
                if (picked) settings.store.folder = picked;
            }}>Browse</Button>
            {folder && <Button size="small" variant="secondary" onClick={() => settings.store.folder = ""}>Reset</Button>}
        </div>
    );
}

const settings = definePluginSettings({
    folder: {
        type: OptionType.STRING,
        description: "Folder downloads are saved to. Leave empty for your Downloads folder.",
        default: "",
        hidden: true
    },
    folderPicker: {
        type: OptionType.COMPONENT,
        description: "Where downloads are saved.",
        component: FolderPicker
    },
    askEveryTime: {
        type: OptionType.BOOLEAN,
        description: "Ask for a folder every time instead of using the one above.",
        default: false
    },
    filenameTemplate: {
        type: OptionType.STRING,
        description: "How files are named. Tokens: {filename} {name} {ext} {username} {displayname} {userid} {server} {channel} {messageid} {date} {time} {index}. Use / to make subfolders, like {username}/{filename}.",
        default: "{filename}"
    },
    hotkey: {
        type: OptionType.STRING,
        description: "Key that downloads the message you are hovering. Hold Shift with it to download only the image under your cursor. Leave empty to turn off.",
        default: "v"
    },
    popoverButton: {
        type: OptionType.BOOLEAN,
        description: "Show a download button in the bar that appears when hovering a message.",
        default: true
    },
    includeEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Also download images and videos from embeds, like links to images, GIFs and tweets.",
        default: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a small popup at the top when a download finishes. Click it to open the folder.",
        default: true
    },
    openFolderAfter: {
        type: OptionType.BOOLEAN,
        description: "Open the folder once the download finishes.",
        default: false
    }
});

let pillTimer: ReturnType<typeof setTimeout> | undefined;

function pill(text: string, state: "busy" | "ok" | "warn" | "fail", opts: { thumb?: string; onClick?: () => void; } = {}) {
    if (!settings.store.notify) return;
    clearTimeout(pillTimer);
    let el = document.getElementById("bd-pill");
    if (!el) {
        el = document.createElement("div");
        el.id = "bd-pill";
        document.body.appendChild(el);
    }
    el.className = `bd-${state}`;
    el.replaceChildren();
    if (opts.thumb) el.appendChild(Object.assign(document.createElement("img"), { src: opts.thumb }));
    else el.appendChild(Object.assign(document.createElement("i"), { className: "bd-dot" }));
    el.appendChild(Object.assign(document.createElement("span"), { textContent: text }));
    el.onclick = () => {
        opts.onClick?.();
        el.classList.remove("bd-show");
    };
    requestAnimationFrame(() => el.classList.add("bd-show"));
    if (state !== "busy") pillTimer = setTimeout(() => el.classList.remove("bd-show"), 3500);
}

type Item = Media & { source?: Source; };

async function download(items: Item[], source?: Source) {
    if (!items.length) return;
    const { askEveryTime, folder, filenameTemplate, openFolderAfter } = settings.store;

    const dir = askEveryTime ? await Native.pickFolder(folder) : folder || await Native.getDefaultFolder();
    if (!dir) return;

    const named = items.map((m, i) => ({ url: m.url, filename: applyTemplate(filenameTemplate, m, m.source ?? source, i) }));
    pill(`Downloading ${pluralize(items.length, "file")}...`, "busy");

    const { saved, errors } = await Native.downloadFiles(dir, named);
    if (errors.length) logger.warn("Some downloads failed:", errors);

    if (!saved) {
        pill(`Download failed. ${errors[0] ?? ""}`, "fail");
        return;
    }

    const folderName = dir.split(/[/\\]/).filter(Boolean).pop();
    pill(
        errors.length ? `Saved ${saved} of ${items.length}, ${errors.length} failed` : `Saved ${pluralize(saved, "file")} to ${folderName}`,
        errors.length ? "warn" : "ok",
        { thumb: items.find(m => /\.(png|jpe?g|gif|webp)$/i.test(m.filename))?.url, onClick: () => Native.openFolder(dir) }
    );

    if (openFolderAfter) Native.openFolder(dir);
}

async function downloadBanners(user: User, guildId: string | undefined, which: "user" | "server" | "both") {
    pill("Fetching profile...", "busy");
    const profile = await fetchUserProfile(user.id, guildId ? { guild_id: guildId } : undefined, false).catch(() => undefined);
    const media = [
        which !== "server" && bannerMedia(user, profile?.banner),
        which !== "user" && guildId && bannerMedia(user, UserProfileStore.getGuildMemberProfile(user.id, guildId)?.banner, guildId)
    ].filter((m): m is Media => !!m);
    if (media.length) download(media, sourceFromUser(user));
    else pill(`${user.username} has no ${which === "server" ? "server banner" : "banner"}`, "fail");
}

const downloadMessage = (message: Message) => download(collectMedia(message, settings.store.includeEmbeds), sourceFromMessage(message));

function mediaUrlOf(el: Element | null | undefined) {
    const media = el?.closest("img, video") ?? el?.querySelector("img, video");
    const src = media?.getAttribute("src") ?? el?.closest("a[href]")?.getAttribute("href");
    if (!src) return null;
    try {
        const { hostname } = new URL(src);
        return hostname.endsWith("discordapp.net") || hostname.endsWith("discordapp.com") ? src : null;
    } catch {
        return null;
    }
}

function onKeyDown(e: KeyboardEvent) {
    const { hotkey } = settings.store;
    if (!hotkey || e.key.toLowerCase() !== hotkey.toLowerCase() || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;

    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) return;

    const hovered = [...document.querySelectorAll(":hover")].at(-1);
    if (!hovered) return;

    const row = hovered.closest("[id^='chat-messages-']");
    const [channelId, messageId] = row?.id.replace("chat-messages-", "").split("-") ?? [];
    const message = channelId && messageId ? MessageStore.getMessage(channelId, messageId) : undefined;
    const hoveredUrl = mediaUrlOf(hovered);

    if (message) {
        const items = collectMedia(message, settings.store.includeEmbeds);
        if (e.shiftKey && hoveredUrl) download([mediaFromUrl(hoveredUrl, items)], sourceFromMessage(message));
        else if (items.length) download(items, sourceFromMessage(message));
        else return;
    } else if (hoveredUrl) {
        download([mediaFromUrl(hoveredUrl)]);
    } else return;

    e.preventDefault();
    e.stopPropagation();
}

const item = (id: string, label: string, action: () => void, icon = DownloadIcon) => (
    <Menu.MenuItem id={id} key={id} label={label} icon={icon} leadingAccessory={{ type: "icon", icon }} action={action} />
);

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message, target }: { message?: Message; target?: HTMLElement; }) => {
    if (!message) return;
    const media = collectMedia(message, settings.store.includeEmbeds);
    const emojis = collectEmojis(message);
    const clickedUrl = mediaUrlOf(target);
    const source = sourceFromMessage(message);

    const entries = [
        clickedUrl && media.length > 1 && item("bd-download-this", "Download This", () => download([mediaFromUrl(clickedUrl, media)], source), ImageIcon),
        media.length > 0 && item("bd-download-all", media.length === 1 ? "Download" : `Download All (${media.length})`, () => download(media, source)),
        emojis.length > 0 && item("bd-download-emojis", `Download Emojis & Stickers (${emojis.length})`, () => download(emojis, source), StickerIcon)
    ].filter((e): e is ReactElement => !!e);
    if (!entries.length) return;

    (findGroupChildrenByChildId("copy-link", children) ?? children).push(...entries);
};

const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user) return;
    const all = userMedia(user, guildId);
    const downloadAll = async () => {
        const profile = await fetchUserProfile(user.id, guildId ? { guild_id: guildId } : undefined, false).catch(() => undefined);
        const banners = [bannerMedia(user, profile?.banner), guildId && bannerMedia(user, UserProfileStore.getGuildMemberProfile(user.id, guildId)?.banner, guildId)];
        download([...all.map(a => a.media), ...banners.filter((m): m is Media => !!m)], sourceFromUser(user));
    };
    children.push(
        <Menu.MenuItem id="bd-user" label="Download" icon={DownloadIcon} leadingAccessory={{ type: "icon", icon: DownloadIcon }}>
            {all.map(({ label, media }) => item(`bd-user-${label}`, label, () => download([media], sourceFromUser(user)), ImageIcon))}
            {item("bd-user-banner", "Banner", () => downloadBanners(user, guildId, "user"), ImageIcon)}
            {guildId && item("bd-user-server-banner", "Server Banner", () => downloadBanners(user, guildId, "server"), ImageIcon)}
            {item("bd-user-all", "Download All", downloadAll)}
        </Menu.MenuItem>
    );
};

const guildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;
    const all = guildMedia(guild);
    if (!all.length) return;
    const source = { username: "", displayname: "", userid: "", messageid: "", channel: "", server: guild.name, time: Date.now() };
    children.push(
        <Menu.MenuItem id="bd-guild" label="Download" icon={DownloadIcon} leadingAccessory={{ type: "icon", icon: DownloadIcon }}>
            {all.map(({ label, media }) => item(`bd-guild-${label}`, label, () => download([media], source), ImageIcon))}
            {all.length > 1 && item("bd-guild-all", "Download All", () => download(all.map(a => a.media), source))}
        </Menu.MenuItem>
    );
};

const channelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel) return;
    const messages = MessageStore.getMessages(channel.id)?._array as Message[] | undefined;
    const count = messages?.reduce((n, m) => n + collectMedia(m, settings.store.includeEmbeds).length, 0) ?? 0;
    if (!messages || !count) return;
    children.push(item("bd-channel", `Download Loaded Media (${count})`, () => download(messages.flatMap(m => {
        const source = sourceFromMessage(m);
        return collectMedia(m, settings.store.includeEmbeds).map(media => ({ ...media, source }));
    }))));
};

export default definePlugin({
    name: "BetterDownload",
    description: "Better downloading tools. Download every file in a message at once from the menu, the hover bar or a hotkey, plus avatars, banners, server icons, emojis, stickers and whole channels.",
    authors: [{ name: "visiuun", id: 636585243846901802n }],
    settings,
    managedStyle: style,

    messagePopoverButton: {
        icon: DownloadIcon,
        render(message: Message) {
            if (!settings.store.popoverButton) return null;
            const count = collectMedia(message, settings.store.includeEmbeds).length;
            if (!count) return null;
            return {
                label: count === 1 ? "Download" : `Download All (${count})`,
                icon: DownloadIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => downloadMessage(message)
            };
        }
    },

    contextMenus: {
        "message": messageContextMenuPatch,
        "user-context": userContextMenuPatch,
        "user-profile-actions": userContextMenuPatch,
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildContextMenuPatch,
        "channel-context": channelContextMenuPatch,
        "thread-context": channelContextMenuPatch
    },

    start() {
        window.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        window.removeEventListener("keydown", onKeyDown, true);
        document.getElementById("bd-pill")?.remove();
    }
});
