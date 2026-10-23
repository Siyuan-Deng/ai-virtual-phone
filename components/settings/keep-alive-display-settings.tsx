"use client";

// 设置 → 后台保活那一格点进来：后台保活放静音时，锁屏和灵动岛上显示什么。
// 上面一张锁屏预览，下面「自己填 / 跟着角色」。改了马上存，保活开着的话锁屏上马上换。

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Pause, SkipBack, SkipForward, X } from "lucide-react";
import {
    EMPTY_KEEP_ALIVE_DISPLAY,
    latestChatCharacter,
    loadKeepAliveDisplay,
    resolveKeepAliveNowPlaying,
    saveKeepAliveDisplay,
    type KeepAliveDisplay,
} from "@/lib/keep-alive-display";

const COVER_SIZE = 512;

/** 挑的图裁成正中间的方图，压成 JPEG（锁屏封面要方的，JPEG 各家都认） */
async function squareCover(file: File): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = COVER_SIZE;
        canvas.height = COVER_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, COVER_SIZE, COVER_SIZE);
        return canvas.toDataURL("image/jpeg", 0.86);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function nowText(): { time: string; date: string } {
    const now = new Date();
    const weekday = "日一二三四五六"[now.getDay()];
    return {
        time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        date: `${now.getMonth() + 1}月${now.getDate()}日 星期${weekday}`,
    };
}

function Artwork({ src, size }: { src?: string; size: "island" | "card" }) {
    return (
        <span className={`keepalive-art keepalive-art-${size}`} aria-hidden="true">
            {src ? <img src={src} alt="" /> : null}
        </span>
    );
}

export function KeepAliveDisplaySettings() {
    const [display, setDisplay] = useState<KeepAliveDisplay | null>(() => loadKeepAliveDisplay());
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [character] = useState(() => latestChatCharacter());
    const [clock, setClock] = useState(nowText);
    useEffect(() => {
        const timer = window.setInterval(() => setClock(nowText()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    const current = display ?? EMPTY_KEEP_ALIVE_DISPLAY;
    const update = (patch: Partial<KeepAliveDisplay>) => {
        const next = { ...current, ...patch };
        setDisplay(next);
        saveKeepAliveDisplay(next);
    };
    const preview = resolveKeepAliveNowPlaying(current);

    return (
        <div className="flex flex-col gap-5 pb-6">
            <div className="keepalive-lock" aria-label="锁屏预览">
                <div className="keepalive-island">
                    <Artwork src={preview?.artwork} size="island" />
                    <span className="keepalive-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                </div>
                <div className="keepalive-date">{clock.date}</div>
                <div className="keepalive-clock">{clock.time}</div>
                <div className="keepalive-np">
                    <div className="keepalive-np-top">
                        <Artwork src={preview?.artwork} size="card" />
                        <span className="keepalive-np-text">
                            <span className="keepalive-np-title">{preview?.title || "（没设，照系统默认）"}</span>
                            {preview?.artist ? <span className="keepalive-np-sub">{preview.artist}</span> : null}
                        </span>
                    </div>
                    <div className="keepalive-np-bar" />
                    <div className="keepalive-np-ctl" aria-hidden="true"><SkipBack size={18} fill="currentColor" /><Pause size={20} fill="currentColor" /><SkipForward size={18} fill="currentColor" /></div>
                </div>
            </div>

            <div className="night-card-seg" role="radiogroup" aria-label="锁屏显示什么">
                {(["custom", "character"] as const).map((mode) => (
                    <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={current.mode === mode}
                        data-on={current.mode === mode ? "true" : undefined}
                        onClick={() => update({ mode })}
                    >
                        {mode === "custom" ? "自己填" : "跟着角色"}
                    </button>
                ))}
            </div>

            <div className="g-card">
                {current.mode === "custom" ? (
                    <>
                        <div className="keepalive-cover-row">
                            <button type="button" className="keepalive-cover" onClick={() => fileRef.current?.click()} aria-label="换封面">
                                {current.cover ? <img src={current.cover} alt="" /> : <ImagePlus size={20} aria-hidden="true" />}
                            </button>
                            <span className="flex flex-col gap-1 min-w-0">
                                <span className="menu-label">封面</span>
                                <span className="menu-desc !mt-0">方图，锁屏和灵动岛都用它</span>
                            </span>
                            {current.cover ? (
                                <button type="button" className="keepalive-link" onClick={() => update({ cover: "" })}>去掉</button>
                            ) : null}
                            <input
                                ref={fileRef}
                                type="file"
                                accept="image/*"
                                hidden
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (!file) return;
                                    void squareCover(file).then((cover) => update({ cover })).catch(() => alert("这张图读不出来，换一张试试"));
                                }}
                            />
                        </div>
                        <div className="ui-row-divider !mx-0" />
                        <div className="flex flex-col gap-1.5">
                            <span className="menu-desc !mt-0">标题{current.titles.length > 1 ? "（填了好几个就每小时随机换一个）" : ""}</span>
                            {current.titles.map((title, index) => (
                                <div key={index} className="keepalive-title-row">
                                    <input
                                        className="ui-input"
                                        value={title}
                                        maxLength={40}
                                        placeholder={index === 0 ? "不填就用网页标题" : "再一个标题"}
                                        aria-label={`标题 ${index + 1}`}
                                        onChange={(event) => update({ titles: current.titles.map((item, i) => (i === index ? event.target.value : item)) })}
                                    />
                                    {current.titles.length > 1 ? (
                                        <button
                                            type="button"
                                            className="keepalive-title-remove"
                                            aria-label={`删掉标题 ${index + 1}`}
                                            onClick={() => update({ titles: current.titles.filter((_, i) => i !== index) })}
                                        >
                                            <X size={16} aria-hidden="true" />
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                            <button type="button" className="keepalive-link keepalive-title-add" onClick={() => update({ titles: [...current.titles, ""] })}>
                                ＋ 再加一个标题
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="keepalive-cover-row">
                        <Artwork src={character?.avatar || undefined} size="card" />
                        <span className="flex flex-col gap-1 min-w-0">
                            <span className="menu-label">{character ? character.name : "还没有聊过天"}</span>
                            <span className="menu-desc !mt-0">{character ? "最近聊天的角色：用 TA 的头像和名字" : "先用「自己填」的那套"}</span>
                        </span>
                    </div>
                )}
                <div className="ui-row-divider !mx-0" />
                <label className="flex flex-col gap-1.5">
                    <span className="menu-desc !mt-0">副标题</span>
                    <input className="ui-input" value={current.subtitle} maxLength={40} placeholder="比如：在线" onChange={(event) => update({ subtitle: event.target.value })} />
                </label>
            </div>

            <p className="menu-desc mx-2 leading-relaxed">
                后台保活开着、没在放歌时，锁屏和灵动岛显示这些；放歌时显示歌名、歌手和封面。锁屏卡片角落的来源（Safari 或者主屏幕上 App 的名字）是系统定的，改不了。
            </p>
            {display ? (
                <button type="button" className="keepalive-link self-center" onClick={() => { setDisplay(null); saveKeepAliveDisplay(null); }}>
                    恢复系统默认
                </button>
            ) : null}
        </div>
    );
}
