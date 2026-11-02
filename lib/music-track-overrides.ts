// 每首歌自己改的封面、歌词、歌名、歌手（本地上传的和网易云的都行）。
// 一首一个 kv 键，只存改过的那几项；没改的照常用歌曲本来的，删掉改动就恢复原样。
// 放歌、播放列表、锁屏读的都是叠上改动之后的那份（在 music-context 里叠）。
"use client";

import { useEffect, useState } from "react";
import type { MusicTrack } from "./music-storage";
import { kvGet, kvRemove, kvSet } from "./kv-db";

export const MUSIC_TRACK_OVERRIDE_PREFIX = "music-track-override-v1:";
const CHANGED_EVENT = "music-track-overrides-changed";

export type MusicTrackOverride = {
    title?: string;
    artist?: string;
    /** data URL，上传时已经缩到 600px 以内 */
    coverUrl?: string;
    lyrics?: string;
    updatedAt?: string;
};

const FIELDS = ["title", "artist", "coverUrl", "lyrics"] as const;

let revision = 0;
// 同一个键反复读不用每次都 JSON.parse：列表里每首歌每次渲染都要查一遍
const parsedCache = new Map<string, { raw: string; value: MusicTrackOverride | null }>();

export function loadTrackOverride(trackId: string): MusicTrackOverride | null {
    if (!trackId) return null;
    const key = MUSIC_TRACK_OVERRIDE_PREFIX + trackId;
    const raw = kvGet(key);
    if (!raw) return null;
    const cached = parsedCache.get(key);
    if (cached && cached.raw === raw) return cached.value;
    let value: MusicTrackOverride | null = null;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
            const next: MusicTrackOverride = {};
            for (const field of FIELDS) {
                if (typeof parsed[field] === "string" && parsed[field]) next[field] = parsed[field] as string;
            }
            value = Object.keys(next).length > 0 ? next : null;
        }
    } catch { /* 坏数据当没改过 */ }
    parsedCache.set(key, { raw, value });
    return value;
}

/** 只存非空的几项；一项都没有就把这首的记录删掉 */
export function saveTrackOverride(trackId: string, override: MusicTrackOverride | null): void {
    if (!trackId) return;
    const key = MUSIC_TRACK_OVERRIDE_PREFIX + trackId;
    const next: MusicTrackOverride = {};
    for (const field of FIELDS) {
        const value = override?.[field];
        if (typeof value === "string" && value.trim()) next[field] = field === "lyrics" || field === "coverUrl" ? value : value.trim();
    }
    if (Object.keys(next).length === 0) kvRemove(key);
    else kvSet(key, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }));
    revision += 1;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { trackId } }));
}

// 叠了改动的那份 → 原样。叠过的歌要是又被传回播放器（播放列表里点、加进队列），
// 先换回原样再存，不然改动会被焊进播放列表，之后「清除」就恢复不了
const baseOfOverridden = new WeakMap<MusicTrack, MusicTrack>();

export function applyTrackOverride<T extends MusicTrack | null | undefined>(track: T): T {
    if (!track) return track;
    const base = trackBase(track);
    const override = loadTrackOverride(base.id);
    if (!override) return base as T;
    const merged = { ...base, ...override };
    baseOfOverridden.set(merged, base);
    return merged as T;
}

/** 叠过改动的歌换回原样；本来就是原样的原样返回 */
export function trackBase(track: MusicTrack): MusicTrack {
    return baseOfOverridden.get(track) ?? track;
}

/** 改动变了就 +1，给 useMemo 当依赖 */
export function useTrackOverridesRevision(): number {
    const [value, setValue] = useState(revision);
    useEffect(() => {
        const update = () => setValue(revision);
        window.addEventListener(CHANGED_EVENT, update);
        return () => window.removeEventListener(CHANGED_EVENT, update);
    }, []);
    return value;
}

/** 上传的封面缩到 600px 以内存成 JPEG，免得一张原图几 MB 塞进存储 */
export function coverFileToDataUrl(file: File, maxSize = 600): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext("2d");
            if (!context) { reject(new Error("图片处理失败")); return; }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.86));
        };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("这张图片打不开")); };
        image.src = url;
    });
}

/** .lrc / .txt 读成文字：先按 UTF-8，不是合法 UTF-8 再按 GBK（不少中文歌词文件是 GBK 存的） */
export async function readLyricsFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
    } catch {
        try { return new TextDecoder("gbk").decode(buffer); } catch { return new TextDecoder().decode(buffer); }
    }
}
