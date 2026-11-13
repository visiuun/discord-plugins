/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog, IpcMainInvokeEvent, shell } from "electron";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, extname, join, parse } from "path";

const ALLOWED_HOSTS = new Set([
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
]);

const CONCURRENCY = 3;

export interface DownloadItem {
    url: string;
    filename: string;
}

function sanitize(name: string) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "file";
}

function uniquePath(dir: string, filename: string, taken: Set<string>) {
    const segments = filename.split(/[/\\]/).filter(s => s && s !== "." && s !== "..").map(sanitize);
    const { name, ext } = parse(segments.pop() ?? "file");
    const base = join(dir, ...segments);
    let candidate = join(base, name + ext);
    for (let i = 1; taken.has(candidate.toLowerCase()) || existsSync(candidate); i++)
        candidate = join(base, `${name} (${i})${ext}`);
    taken.add(candidate.toLowerCase());
    return candidate;
}

export function getDefaultFolder() {
    return app.getPath("downloads");
}

export async function pickFolder(_: IpcMainInvokeEvent, defaultPath?: string) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: "Choose where to save",
        defaultPath: defaultPath || app.getPath("downloads"),
        properties: ["openDirectory", "createDirectory"],
    });
    return canceled ? null : filePaths[0];
}

export function openFolder(_: IpcMainInvokeEvent, dir: string) {
    return shell.openPath(dir);
}

export async function downloadFiles(_: IpcMainInvokeEvent, dir: string, items: DownloadItem[]) {
    await mkdir(dir, { recursive: true });

    const taken = new Set<string>();
    const errors: string[] = [];
    let saved = 0;
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const { url, filename } = items[next++];
            try {
                const parsed = URL.parse(url);
                if (!parsed || !ALLOWED_HOSTS.has(parsed.hostname)) throw new Error("Blocked host");

                const res = await fetch(parsed, { signal: AbortSignal.timeout(120_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const data = Buffer.from(await res.arrayBuffer());
                const name = extname(filename) ? filename : filename + guessExt(res.headers.get("content-type"));
                const path = uniquePath(dir, name, taken);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, data);
                saved++;
            } catch (e) {
                errors.push(`${filename}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return { saved, errors, dir };
}

function guessExt(contentType: string | null) {
    const sub = contentType?.split(";")[0].split("/")[1];
    if (!sub) return "";
    return "." + ({ jpeg: "jpg", "svg+xml": "svg", quicktime: "mov" }[sub] ?? sub);
}
