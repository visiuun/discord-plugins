/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Guild, Message, User } from "@vencord/discord-types";
import { ChannelStore, GuildMemberStore, GuildStore, SnowflakeUtils } from "@webpack/common";

export interface Media {
    url: string;
    filename: string;
}

export interface Source {
    username: string;
    displayname: string;
    userid: string;
    messageid: string;
    channel: string;
    server: string;
    time: number;
}

const CDN = "https://cdn.discordapp.com";
const ext = (hash: string) => hash.startsWith("a_") ? "gif" : "png";

export function originalUrl(url: string) {
    const u = new URL(url);
    if (u.hostname === "media.discordapp.net" && u.pathname.startsWith("/attachments/")) u.hostname = "cdn.discordapp.com";
    for (const p of ["width", "height", "format", "quality"]) u.searchParams.delete(p);
    return u.href;
}

export function nameFromUrl(url: string) {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
}

const pathOf = (url: string) => new URL(url).pathname;

export function mediaFromUrl(url: string, inMessage: Media[] = []): Media {
    const full = originalUrl(url);
    return inMessage.find(m => pathOf(m.url) === pathOf(full)) ?? { url: full, filename: nameFromUrl(full) };
}

export function collectMedia(message: Message, includeEmbeds: boolean): Media[] {
    const items = new Map<string, Media>();
    const add = (url: string | undefined, filename?: string) => {
        if (!url) return;
        const full = originalUrl(url);
        if (!items.has(full)) items.set(full, { url: full, filename: filename ?? nameFromUrl(full) });
    };

    for (const msg of [message, ...message.messageSnapshots.map(s => s.message)]) {
        for (const a of msg.attachments) add(a.url, a.filename);
        if (!includeEmbeds) continue;
        for (const e of msg.embeds) {
            if (e.video?.proxyURL) add(e.video.proxyURL);
            else if (e.image || e.images?.length) [e.image, ...(e.images ?? [])].forEach(m => add(m?.proxyURL));
            else if (e.type === "image") add(e.thumbnail?.proxyURL);
        }
    }
    return [...items.values()];
}

export function collectEmojis(message: Message): Media[] {
    const items = new Map<string, Media>();
    for (const msg of [message, ...message.messageSnapshots.map(s => s.message)]) {
        for (const [, animated, name, id] of msg.content.matchAll(/<(a?):(\w+):(\d+)>/g))
            items.set(id, { url: `${CDN}/emojis/${id}.${animated ? "gif" : "png"}?size=4096`, filename: `${name}.${animated ? "gif" : "png"}` });
        for (const s of msg.stickerItems) {
            const format = Number(s.format_type);
            if (format === 3) continue;
            const e = format === 4 ? "gif" : "png";
            items.set(s.id, { url: `https://media.discordapp.net/stickers/${s.id}.${e}?size=4096`, filename: `${s.name}.${e}` });
        }
    }
    return [...items.values()];
}

export function userMedia(user: User, guildId?: string): { label: string; media: Media; }[] {
    const out: { label: string; media: Media; }[] = [];
    if (user.avatar) out.push({ label: "Avatar", media: { url: `${CDN}/avatars/${user.id}/${user.avatar}.${ext(user.avatar)}?size=4096`, filename: `${user.username} avatar.${ext(user.avatar)}` } });

    const member = guildId ? GuildMemberStore.getMember(guildId, user.id) : null;
    if (member?.avatar) out.push({ label: "Server Avatar", media: { url: `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.${ext(member.avatar)}?size=4096`, filename: `${user.username} server avatar.${ext(member.avatar)}` } });
    return out;
}

export function bannerMedia(user: User, hash: string | null | undefined, guildId?: string): Media | null {
    if (!hash) return null;
    return guildId
        ? { url: `${CDN}/guilds/${guildId}/users/${user.id}/banners/${hash}.${ext(hash)}?size=4096`, filename: `${user.username} server banner.${ext(hash)}` }
        : { url: `${CDN}/banners/${user.id}/${hash}.${ext(hash)}?size=4096`, filename: `${user.username} banner.${ext(hash)}` };
}

export function guildMedia(guild: Guild): { label: string; media: Media; }[] {
    const out: { label: string; media: Media; }[] = [];
    if (guild.icon) out.push({ label: "Server Icon", media: { url: `${CDN}/icons/${guild.id}/${guild.icon}.${ext(guild.icon)}?size=4096`, filename: `${guild.name} icon.${ext(guild.icon)}` } });
    if (guild.banner) out.push({ label: "Server Banner", media: { url: `${CDN}/banners/${guild.id}/${guild.banner}.${ext(guild.banner)}?size=4096`, filename: `${guild.name} banner.${ext(guild.banner)}` } });
    if (guild.splash) out.push({ label: "Invite Background", media: { url: `${CDN}/splashes/${guild.id}/${guild.splash}.png?size=4096`, filename: `${guild.name} splash.png` } });
    return out;
}

export function sourceFromMessage(message: Message): Source {
    const channel = ChannelStore.getChannel(message.channel_id);
    return {
        username: message.author.username,
        displayname: message.author.globalName ?? message.author.username,
        userid: message.author.id,
        messageid: message.id,
        channel: channel?.name || "DM",
        server: GuildStore.getGuild(channel?.guild_id)?.name ?? "Direct Messages",
        time: SnowflakeUtils.extractTimestamp(message.id)
    };
}

export function sourceFromUser(user: User): Source {
    return {
        username: user.username,
        displayname: user.globalName ?? user.username,
        userid: user.id,
        messageid: "",
        channel: "",
        server: "",
        time: Date.now()
    };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function applyTemplate(template: string, media: Media, source: Source | undefined, index: number) {
    const d = new Date(source?.time ?? Date.now());
    const dot = media.filename.lastIndexOf(".");
    const tokens: Record<string, string> = {
        filename: media.filename,
        name: dot > 0 ? media.filename.slice(0, dot) : media.filename,
        ext: dot > 0 ? media.filename.slice(dot + 1) : "",
        index: String(index + 1),
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
        username: source?.username ?? "",
        displayname: source?.displayname ?? "",
        userid: source?.userid ?? "",
        messageid: source?.messageid ?? "",
        channel: source?.channel ?? "",
        server: source?.server ?? ""
    };
    const out = template.replace(/\{(\w+)\}/g, (m, k: string) => tokens[k.toLowerCase()] ?? m).trim() || media.filename;
    return !tokens.ext || out.toLowerCase().endsWith(`.${tokens.ext.toLowerCase()}`) ? out : `${out}.${tokens.ext}`;
}
