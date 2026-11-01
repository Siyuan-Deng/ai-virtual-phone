"use client";

// 设置 → 后台保活那一格点进来：后台保活放静音时，锁屏和灵动岛上显示什么。
// 上面一张锁屏预览，下面「自己填 / 跟着角色」。改了马上存，保活开着的话锁屏上马上换。
// 封面可以放好几张：一行里叠成一摞，点「管理」从下面弹出来增删；好几个时多久换一次在「随机更换频率」里选。

import { useEffect, useRef, useState } from "react";
import { ChevronRight, ImagePlus, Pause, Plus, SkipBack, SkipForward, X } from "lucide-react";
import { BottomSheet } from "@/components/ui/modal";
import {
    EMPTY_KEEP_ALIVE_DISPLAY,
    KEEP_ALIVE_ROTATIONS,
    MAX_KEEP_ALIVE_COVERS,
    formatClockInput,
    latestChatCharacter,
    loadKeepAliveDisplay,
    parseClock,
    resolveKeepAliveNowPlaying,
    saveKeepAliveDisplay,
    type KeepAliveDisplay,
    type KeepAliveRotation,
} from "@/lib/keep-alive-display";

const ROTATION_LABELS: Record<KeepAliveRotation, string> = {
    halfHour: "半小时",
    hour: "每小时",
    day: "每天",
    custom: "自定义",
    never: "不换",
};

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

/** 秒数写成「分:秒」（够一小时就「时:分:秒」） */
function formatClock(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 能填好几个的一列（标题、副标题）：一行一个，右边 × 删掉，下面「＋ 再加一个」 */
function TextList({ label, items, firstPlaceholder, manyHint, onChange }: {
    label: string;
    items: string[];
    firstPlaceholder: string;
    /** 填了好几个时标签后面那句 */
    manyHint: string;
    onChange: (items: string[]) => void;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="menu-desc !mt-0">{label}{items.length > 1 ? manyHint : ""}</span>
            {items.map((value, index) => (
                <div key={index} className="keepalive-title-row">
                    <input
                        className="ui-input"
                        value={value}
                        maxLength={40}
                        placeholder={index === 0 ? firstPlaceholder : `再一个${label}`}
                        aria-label={`${label} ${index + 1}`}
                        onChange={(event) => onChange(items.map((item, i) => (i === index ? event.target.value : item)))}
                    />
                    {items.length > 1 ? (
                        <button
                            type="button"
                            className="keepalive-title-remove"
                            aria-label={`删掉${label} ${index + 1}`}
                            onClick={() => onChange(items.filter((_, i) => i !== index))}
                        >
                            <X size={16} aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
            ))}
            <button type="button" className="keepalive-link keepalive-title-add" onClick={() => onChange([...items, ""])}>
                ＋ 再加一个{label}
            </button>
        </div>
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

    const [coversOpen, setCoversOpen] = useState(false);
    const [everyDraft, setEveryDraft] = useState(() => String((display ?? EMPTY_KEEP_ALIVE_DISPLAY).rotationEvery));

    const current = display ?? EMPTY_KEEP_ALIVE_DISPLAY;
    const update = (patch: Partial<KeepAliveDisplay>) => {
        const next = { ...current, ...patch };
        setDisplay(next);
        saveKeepAliveDisplay(next);
    };
    const preview = resolveKeepAliveNowPlaying(current);
    const covers = current.covers;
    const manyHint = current.rotation === "never" ? "（填了好几个也只用第一个）" : "（填了好几个就随机换）";

    /** 一次挑好几张：裁好了接在后面（裁图要一会儿，接的时候按存着的最新的接） */
    const addCovers = async (files: File[]) => {
        const room = MAX_KEEP_ALIVE_COVERS - covers.length;
        if (room <= 0) return;
        const results = await Promise.allSettled(files.slice(0, room).map(squareCover));
        const added = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        if (added.length) {
            const base = loadKeepAliveDisplay() ?? EMPTY_KEEP_ALIVE_DISPLAY;
            const next = { ...base, covers: [...base.covers, ...added].slice(0, MAX_KEEP_ALIVE_COVERS) };
            setDisplay(next);
            saveKeepAliveDisplay(next);
        }
        if (added.length < results.length) alert(added.length ? "有几张读不出来，没加上" : "这张图读不出来，换一张试试");
    };

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
                    <div className="keepalive-np-bar">
                        {preview?.position && preview.position.total > 0 ? (
                            <i style={{ width: `${Math.min(100, (preview.position.elapsed / preview.position.total) * 100)}%` }} />
                        ) : null}
                    </div>
                    {preview?.position ? (
                        <div className="keepalive-np-times">
                            <span>{formatClock(preview.position.elapsed)}</span>
                            <span>-{formatClock(Math.max(0, preview.position.total - preview.position.elapsed))}</span>
                        </div>
                    ) : null}
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
                            {covers.length > 1 ? (
                                <button type="button" className="keepalive-cover-pile" onClick={() => setCoversOpen(true)} aria-label="管理封面">
                                    {covers.slice(0, 3).map((src, index) => (
                                        <img key={index} src={src} alt="" data-depth={index} />
                                    )).reverse()}
                                    <span className="keepalive-cover-count">{covers.length}</span>
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="keepalive-cover"
                                    onClick={() => (covers.length ? setCoversOpen(true) : fileRef.current?.click())}
                                    aria-label={covers.length ? "管理封面" : "加封面"}
                                >
                                    {covers.length ? <img src={covers[0]} alt="" /> : <ImagePlus size={20} aria-hidden="true" />}
                                </button>
                            )}
                            <span className="flex flex-col gap-1 min-w-0">
                                <span className="menu-label">封面</span>
                                <span className="menu-desc !mt-0">
                                    {covers.length > 1
                                        ? `${covers.length} 张，${current.rotation === "never" ? "一直用第一张" : "随机换"}`
                                        : "方图，锁屏和灵动岛都用它"}
                                </span>
                            </span>
                            {covers.length ? (
                                <button type="button" className="keepalive-link keepalive-manage" onClick={() => setCoversOpen(true)}>
                                    管理<ChevronRight size={14} aria-hidden="true" />
                                </button>
                            ) : null}
                            <input
                                ref={fileRef}
                                type="file"
                                accept="image/*"
                                multiple
                                hidden
                                onChange={(event) => {
                                    const files = Array.from(event.target.files ?? []);
                                    event.target.value = "";
                                    if (files.length) void addCovers(files);
                                }}
                            />
                        </div>
                        <div className="ui-row-divider !mx-0" />
                        <TextList label="标题" items={current.titles} firstPlaceholder="不填就用网页标题" manyHint={manyHint} onChange={(titles) => update({ titles })} />
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
                <TextList label="副标题" items={current.subtitles} firstPlaceholder="比如：在线" manyHint={manyHint} onChange={(subtitles) => update({ subtitles })} />
            </div>

            <div className="g-card">
                <span className="menu-label">随机更换频率</span>
                <div className="night-card-seg" role="radiogroup" aria-label="随机更换频率">
                    {KEEP_ALIVE_ROTATIONS.map((rotation) => (
                        <button
                            key={rotation}
                            type="button"
                            role="radio"
                            aria-checked={current.rotation === rotation}
                            data-on={current.rotation === rotation ? "true" : undefined}
                            onClick={() => update({ rotation })}
                        >
                            {ROTATION_LABELS[rotation]}
                        </button>
                    ))}
                </div>
                {current.rotation === "custom" ? (
                    <div className="keepalive-rotation-custom">
                        <span>每</span>
                        <input
                            className="ui-input keepalive-rotation-every"
                            value={everyDraft}
                            inputMode="numeric"
                            aria-label="每几分钟或几小时换一次"
                            onChange={(event) => {
                                const text = event.target.value.replace(/\D/g, "").slice(0, 3);
                                setEveryDraft(text);
                                const every = Number(text);
                                if (every >= 1) update({ rotationEvery: every });
                            }}
                            onBlur={() => setEveryDraft(String(current.rotationEvery))}
                        />
                        <div className="night-card-seg keepalive-rotation-unit" role="radiogroup" aria-label="单位">
                            {(["minute", "hour"] as const).map((unit) => (
                                <button
                                    key={unit}
                                    type="button"
                                    role="radio"
                                    aria-checked={current.rotationUnit === unit}
                                    data-on={current.rotationUnit === unit ? "true" : undefined}
                                    onClick={() => update({ rotationUnit: unit })}
                                >
                                    {unit === "minute" ? "分钟" : "小时"}
                                </button>
                            ))}
                        </div>
                        <span>换一次</span>
                    </div>
                ) : null}
            </div>

            <div className="g-card">
                <span className="menu-label">进度条两边的时间</span>
                <div className="keepalive-time-row">
                    {([["elapsed", "左边（已播放）", "比如 13:14"], ["remaining", "右边（还剩）", "比如 5:20"]] as const).map(([field, label, placeholder]) => (
                        <label key={field} className="flex flex-col gap-1.5 min-w-0">
                            <span className="menu-desc !mt-0">{label}</span>
                            <input
                                className="ui-input"
                                value={current[field]}
                                inputMode="numeric"
                                placeholder={placeholder}
                                onChange={(event) => update({ [field]: formatClockInput(event.target.value) })}
                            />
                        </label>
                    ))}
                </div>
                {(current.elapsed.trim() && parseClock(current.elapsed) === null) || (current.remaining.trim() && parseClock(current.remaining) === null) ? (
                    <span className="keepalive-time-error">最后两位是秒，要在 00 到 59 之间</span>
                ) : null}
                <span className="menu-desc !mt-0 leading-relaxed">只按数字就行，冒号会自己补上（1314 就是 13:14）。锁屏上就停在这两个数，进度条停在对应的位置，不会往前走。不填就照系统默认。</span>
            </div>

            {display ? (
                <button type="button" className="keepalive-link self-center" onClick={() => { setDisplay(null); saveKeepAliveDisplay(null); }}>
                    恢复系统默认
                </button>
            ) : null}

            {coversOpen ? (
                <BottomSheet title="封面" onClose={() => setCoversOpen(false)} onDone={() => setCoversOpen(false)}>
                    <div className="keepalive-cover-grid">
                        {covers.map((src, index) => (
                            <span key={index} className="keepalive-cover-tile">
                                <img src={src} alt="" />
                                <button
                                    type="button"
                                    aria-label={`删掉第 ${index + 1} 张封面`}
                                    onClick={() => update({ covers: covers.filter((_, i) => i !== index) })}
                                >
                                    <X size={11} strokeWidth={2.6} aria-hidden="true" />
                                </button>
                            </span>
                        ))}
                        {covers.length < MAX_KEEP_ALIVE_COVERS ? (
                            <button type="button" className="keepalive-cover-tile keepalive-cover-add" onClick={() => fileRef.current?.click()} aria-label="加封面">
                                <Plus size={20} aria-hidden="true" />
                            </button>
                        ) : null}
                    </div>
                    <p className="keepalive-cover-caption">
                        {covers.length < MAX_KEEP_ALIVE_COVERS ? "点 ＋ 一次可以挑好几张" : `最多 ${MAX_KEEP_ALIVE_COVERS} 张`}
                    </p>
                </BottomSheet>
            ) : null}
        </div>
    );
}
