"use client";

// 锁屏、灵动岛上「正在播放」那张卡（网页的 Media Session）。整个页面只有一份，谁在放就显示谁：
// 放歌时显示歌名、歌手、封面；没在放歌、后台保活在放静音时显示「后台保活」里设的那套；
// 都没有就交回系统默认。来源那行（Safari / 主屏幕 App 名字）是系统定的，改不了。

export type NowPlaying = {
    title: string;
    artist?: string;
    album?: string;
    /** 图片地址（data: / http(s):）；锁屏和灵动岛都用它 */
    artwork?: string;
    /** 进度条：已播放几秒、一共几秒（左边显示已播放，右边显示还剩），停在这里不往前走；不给就照播放器自己的 */
    position?: { elapsed: number; total: number };
};

/** 进度条要停住：速度不能填 0（会报错），填一个小到看不出在走的数 */
const FROZEN_RATE = 1e-6;

let musicItem: NowPlaying | null = null;
let keepAliveItem: NowPlaying | null = null;

function artworkType(src: string): string | undefined {
    const match = /^data:(image\/[\w+.-]+)[;,]/.exec(src);
    return match?.[1];
}

function apply(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const item = musicItem ?? keepAliveItem;
    try {
        navigator.mediaSession.metadata = item
            ? new MediaMetadata({
                title: item.title,
                artist: item.artist ?? "",
                album: item.album ?? "",
                artwork: item.artwork ? [{ src: item.artwork, sizes: "512x512", ...(artworkType(item.artwork) ? { type: artworkType(item.artwork) } : {}) }] : [],
            })
            : null;
    } catch {
        // 图片地址不认之类的：不影响播放
    }
    applyPosition(item);
}

function applyPosition(item: NowPlaying | null): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
    try {
        const position = item?.position;
        if (position && position.total > 0) {
            navigator.mediaSession.setPositionState({ duration: position.total, position: Math.min(position.elapsed, position.total), playbackRate: FROZEN_RATE });
        } else {
            navigator.mediaSession.setPositionState();
        }
    } catch {
        // 不支持或者数不对：进度条照播放器自己的
    }
}

/** 后台保活的静音每秒循环一次，Safari 每循环一次就把锁屏进度拨回这段静音自己的时间（0:00）；
 *  循环完调这个，把填的进度再设回去 */
export function reapplyNowPlayingPosition(): void {
    const item = musicItem ?? keepAliveItem;
    if (item?.position) applyPosition(item);
}

/** 音乐 App：正在放的歌；停了传 null */
export function setMusicNowPlaying(item: NowPlaying | null): void {
    musicItem = item;
    apply();
}

/** 后台保活：放静音时锁屏显示什么；不显示（没设过、保活关了）传 null */
export function setKeepAliveNowPlaying(item: NowPlaying | null): void {
    keepAliveItem = item;
    apply();
}
