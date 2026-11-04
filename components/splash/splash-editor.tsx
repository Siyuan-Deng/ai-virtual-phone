"use client";

// 开屏编辑器：编辑时屏幕就是开屏本身，字直接拖。右上「背景」「文字」打开设置，「重播」看整体效果。

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ChevronLeft, ImageIcon, Play, Type } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { useSheetHost } from "@/components/night/look-set-sheets";
import {
    SPLASH_BUILTIN_FONTS,
    SPLASH_EFFECTS,
    buildSplashStage,
    playSplashStage,
    type SplashMotion,
    type SplashPlayback,
    type SplashTextLayer,
} from "@/lib/splash-effects";
import {
    SPLASH_MAX_TEXTS,
    addSplashFont,
    ensureSplashFonts,
    makeSplashTextLayer,
    releaseSplashImage,
    removeSplashFont,
    saveSplashConfig,
    useSplashLibrary,
    type SplashConfig,
} from "@/lib/splash-store";
import { AnimatedAssetTooLargeError, getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";

const MOTIONS: Array<{ id: SplashMotion; name: string }> = [
    { id: "none", name: "无" },
    { id: "fade", name: "淡入" },
    { id: "zoom", name: "缓慢放大" },
    { id: "settle", name: "缩小落定" },
    { id: "bright", name: "由暗转亮" },
];
const TEXT_COLORS = ["#ffffff", "#f4ead9", "#1a1a1a", "#174BFF", "#ffd166", "#ff6b6b"];
const BG_COLORS = ["#174BFF", "#ece6d9", "#101426", "#ffffff"];
/** 拖到离中线这么近就吸上去 */
const SNAP_X = 1.8;
const SNAP_Y = 1.2;
/** 面板往下拖这么多就收起 */
const PANEL_CLOSE_DRAG = 70;

type Tab = "bg" | "text";
type Drag = { id: string; pointerId: number; x: number; y: number; originX: number; originY: number; moved: boolean };

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
    return <button type="button" className="splash-chip" data-on={on ? "true" : undefined} onClick={onClick}>{children}</button>;
}

function isHexColor(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value);
}

export function SplashEditor({ config, isNew, poolSet, onClose, onNotice }: {
    config: SplashConfig;
    isNew: boolean;
    poolSet: string;
    onClose: () => void;
    onNotice: (text: string) => void;
}) {
    const host = useSheetHost();
    const library = useSplashLibrary();
    const [draft, setDraft] = useState<SplashConfig>(config);
    const [selectedId, setSelectedId] = useState<string | null>(config.texts[0]?.id ?? null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [imageReady, setImageReady] = useState(!config.imageAssetId);
    const [tab, setTab] = useState<Tab>("text");
    const [panelOpen, setPanelOpen] = useState(false);
    const [arrow, setArrow] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [guides, setGuides] = useState({ x: false, y: false });
    const [stageShift, setStageShift] = useState(0);
    const [dirty, setDirty] = useState(isNew);
    const [leaving, setLeaving] = useState(false);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const imageUrlRef = useRef(imageUrl);
    imageUrlRef.current = imageUrl;
    const selectedRef = useRef(selectedId);
    selectedRef.current = selectedId;
    const playbackRef = useRef<SplashPlayback | null>(null);
    const timersRef = useRef<number[]>([]);
    const replayTimerRef = useRef(0);
    const dragRef = useRef<Drag | null>(null);
    /** 这次打开编辑器时传上来的图：放弃修改时要删掉 */
    const uploadsRef = useRef<string[]>([]);

    const selected = draft.texts.find((text) => text.id === selectedId) ?? null;

    const markSelected = useCallback(() => {
        stageRef.current?.querySelectorAll<HTMLElement>(".splash-text").forEach((node) => {
            node.dataset.selected = node.dataset.textId === selectedRef.current ? "true" : "";
        });
    }, []);

    const play = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return;
        window.clearTimeout(replayTimerRef.current);
        playbackRef.current?.stop();
        timersRef.current.forEach((timer) => window.clearTimeout(timer));
        buildSplashStage(stage, draftRef.current, imageUrlRef.current);
        const playback = playSplashStage(stage, draftRef.current);
        playbackRef.current = playback;
        markSelected();
        setArrow(false);
        setPlaying(true);
        timersRef.current = [
            window.setTimeout(() => setPlaying(false), Math.max(600, playback.endMs)),
            window.setTimeout(() => setArrow(true), Math.max(1500, playback.endMs + 200)),
        ];
    }, [markSelected]);

    const playSoon = useCallback(() => {
        window.clearTimeout(replayTimerRef.current);
        replayTimerRef.current = window.setTimeout(play, 260);
    }, [play]);

    const change = useCallback((next: SplashConfig, replay = true) => {
        draftRef.current = next;
        setDraft(next);
        setDirty(true);
        if (replay) playSoon();
    }, [playSoon]);

    const patchText = (patch: Partial<SplashTextLayer>) => {
        if (!selectedId) return;
        change({ ...draftRef.current, texts: draftRef.current.texts.map((text) => (text.id === selectedId ? { ...text, ...patch } : text)) });
    };

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const url = config.imageAssetId ? await getThemeAssetDataUrl(config.imageAssetId).catch(() => null) : null;
            if (cancelled) return;
            imageUrlRef.current = url;
            setImageUrl(url);
            setImageReady(true);
        })();
        return () => { cancelled = true; };
    }, [config.imageAssetId]);

    const fontKey = library.fonts.map((font) => font.id).join(",");
    useEffect(() => {
        void ensureSplashFonts(library.fonts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fontKey]);

    useEffect(() => {
        if (imageReady && host) play();
    }, [imageReady, host, play]);

    useEffect(() => () => {
        window.clearTimeout(replayTimerRef.current);
        timersRef.current.forEach((timer) => window.clearTimeout(timer));
        playbackRef.current?.stop();
    }, []);

    useEffect(() => { markSelected(); }, [selectedId, markSelected]);

    // 设置面板盖住下半屏时，把选中的字推到露出来的那块里
    useEffect(() => {
        const stage = stageRef.current;
        const panel = panelRef.current;
        if (!stage || !panel || !panelOpen || !selected || tab !== "text") {
            setStageShift(0);
            return;
        }
        const height = stage.clientHeight;
        const visible = height - panel.offsetHeight;
        const y = (selected.y / 100) * height;
        const barHeight = height - visible > 0 ? 56 : 0;
        setStageShift(Math.round(Math.min(0, Math.max((visible + barHeight) / 2 - y, visible - height))));
    }, [panelOpen, selected, tab]);

    // 选中的动效常常在一长排后面，打开时滚到它
    useEffect(() => {
        if (!panelOpen || tab !== "text") return;
        panelRef.current?.querySelector('.splash-chips.is-scroll [data-on="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    }, [panelOpen, tab, selectedId]);

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        const node = (event.target as HTMLElement).closest<HTMLElement>(".splash-text");
        const id = node?.dataset.textId;
        const layer = draftRef.current.texts.find((text) => text.id === id);
        if (!node || !layer || !id) return;
        selectedRef.current = id;
        setSelectedId(id);
        markSelected();
        dragRef.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: layer.x, originY: layer.y, moved: false };
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // 拿不到也能拖，只是手指滑出屏幕就停
        }
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const stage = stageRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !stage) return;
        const rect = stage.getBoundingClientRect();
        const dx = ((event.clientX - drag.x) / rect.width) * 100;
        const dy = ((event.clientY - drag.y) / rect.height) * 100;
        if (Math.abs(dx) + Math.abs(dy) > 0.4) drag.moved = true;
        if (!drag.moved) return;
        let x = Math.min(96, Math.max(4, drag.originX + dx));
        let y = Math.min(96, Math.max(4, drag.originY + dy));
        const snapX = Math.abs(x - 50) < SNAP_X;
        const snapY = Math.abs(y - 50) < SNAP_Y;
        if (snapX) x = 50;
        if (snapY) y = 50;
        const node = stage.querySelector<HTMLElement>(`[data-text-id="${CSS.escape(drag.id)}"]`);
        if (node) {
            node.style.left = `${x}%`;
            node.style.top = `${y}%`;
        }
        draftRef.current = { ...draftRef.current, texts: draftRef.current.texts.map((text) => (text.id === drag.id ? { ...text, x, y } : text)) };
        setGuides((current) => (current.x === snapX && current.y === snapY ? current : { x: snapX, y: snapY }));
    };

    const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setGuides({ x: false, y: false });
        if (drag.moved) change(draftRef.current, false);
    };

    // 点开屏上没有字的地方：收起设置看整体
    const onStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!(event.target as HTMLElement).closest(".splash-text")) setPanelOpen(false);
    };

    // 面板已经滑到顶还往下拖：跟手收起；滑条和横向那排动效的手势留给它们自己
    const panelDragRef = useRef<{ y: number; active: boolean } | null>(null);
    const onPanelTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const fromGrab = Boolean(target.closest(".splash-edit-grab"));
        const blocked = target.closest("input[type=range], textarea, .splash-chips.is-scroll");
        panelDragRef.current = !blocked && (fromGrab || (panelRef.current?.scrollTop ?? 0) <= 0) ? { y: event.touches[0].clientY, active: false } : null;
    };
    const onPanelTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        const panel = panelRef.current;
        if (!drag || !panel) return;
        const dy = event.touches[0].clientY - drag.y;
        if (dy <= 0 || panel.scrollTop > 0) {
            if (drag.active) panel.style.transform = "";
            panelDragRef.current = null;
            return;
        }
        drag.active = true;
        panel.style.transition = "none";
        panel.style.transform = `translateY(${dy}px)`;
    };
    const onPanelTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        const panel = panelRef.current;
        panelDragRef.current = null;
        if (!drag?.active || !panel) return;
        panel.style.transition = "";
        panel.style.transform = "";
        if (event.changedTouches[0].clientY - drag.y > PANEL_CLOSE_DRAG) setPanelOpen(false);
    };

    const togglePanel = (next: Tab) => {
        setPanelOpen((open) => !(open && tab === next));
        setTab(next);
    };

    const addText = () => {
        const count = draftRef.current.texts.length;
        if (count >= SPLASH_MAX_TEXTS) return;
        const layer = makeSplashTextLayer(42 + count * 12, 0.4 + count * 1.2);
        layer.size = count ? 24 : 40;
        selectedRef.current = layer.id;
        setSelectedId(layer.id);
        change({ ...draftRef.current, texts: [...draftRef.current.texts, layer] });
    };

    const removeText = () => {
        const texts = draftRef.current.texts.filter((text) => text.id !== selectedId);
        selectedRef.current = texts[0]?.id ?? null;
        setSelectedId(texts[0]?.id ?? null);
        change({ ...draftRef.current, texts });
    };

    const onPickImage = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const assetId = await saveThemeAssetFromBlob(file, "bg");
            uploadsRef.current.push(assetId);
            const url = await getThemeAssetDataUrl(assetId);
            imageUrlRef.current = url;
            setImageUrl(url);
            change({ ...draftRef.current, imageAssetId: assetId });
        } catch (error) {
            onNotice(error instanceof AnimatedAssetTooLargeError ? "这张动图太大了，换一张小一点的" : "图片存不进去，换一张试试");
        }
    };

    const clearImage = (bgColor?: string) => {
        imageUrlRef.current = null;
        setImageUrl(null);
        change({ ...draftRef.current, imageAssetId: null, ...(bgColor ? { bgColor } : {}) });
    };

    const onPickFont = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const assetId = await saveThemeAssetFromBlob(file, "font");
            const font = addSplashFont({ assetId, name: file.name.replace(/\.[^.]+$/, "").slice(0, 6) });
            await ensureSplashFonts([font]);
            patchText({ font: font.id });
        } catch {
            onNotice("这个字体文件读不出来");
        }
    };

    const save = async () => {
        const saved = { ...draftRef.current, texts: draftRef.current.texts.filter((text) => text.text.trim()) };
        saveSplashConfig(saved, isNew ? poolSet : undefined);
        if (config.imageAssetId !== saved.imageAssetId) await releaseSplashImage(config.imageAssetId);
        await Promise.all(uploadsRef.current.filter((id) => id !== saved.imageAssetId).map((id) => releaseSplashImage(id)));
        onNotice("已保存");
        onClose();
    };

    const discard = async () => {
        await Promise.all(uploadsRef.current.map((id) => releaseSplashImage(id)));
        onClose();
    };

    if (!host) return null;
    return createPortal(
        // 挂在 .phone-shell 上，但 React 事件还会冒泡回桌面那一层，别让桌面的手势接管
        <div className="splash-editor" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="splash-edit-canvas" style={stageShift ? { transform: `translateY(${stageShift}px)` } : undefined}>
                <div
                    ref={stageRef}
                    className="splash-stage splash-edit-stage"
                    data-playing={playing ? "true" : undefined}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerEnd}
                    onPointerCancel={onPointerEnd}
                    onClick={onStageClick}
                />
                {guides.x ? <i className="splash-guide splash-guide-x" aria-hidden="true" /> : null}
                {guides.y ? <i className="splash-guide splash-guide-y" aria-hidden="true" /> : null}
                <span className={arrow ? "splash-enter-button splash-enter-button-show splash-edit-arrow" : "splash-enter-button splash-edit-arrow"} style={{ color: draft.texts[0]?.color ?? "#ffffff" }} aria-hidden="true">
                    <ArrowRight size={18} strokeWidth={1.8} />
                </span>
            </div>

            <div className="splash-edit-bar">
                <button type="button" aria-label="返回" onClick={() => { if (dirty) setLeaving(true); else onClose(); }}><ChevronLeft size={22} /></button>
                <b>{draft.name}</b>
                <button type="button" className="splash-edit-save" onClick={() => { void save(); }}>保存</button>
            </div>

            <div className="splash-edit-tools">
                <button type="button" aria-pressed={panelOpen && tab === "bg"} onClick={() => togglePanel("bg")}><ImageIcon size={18} />背景</button>
                <button type="button" aria-pressed={panelOpen && tab === "text"} onClick={() => togglePanel("text")}><Type size={18} />文字</button>
                <button type="button" onClick={() => { setPanelOpen(false); play(); }}><Play size={18} />重播</button>
            </div>

            <div
                ref={panelRef}
                className="splash-edit-panel"
                data-open={panelOpen ? "true" : undefined}
                onTouchStart={onPanelTouchStart}
                onTouchMove={onPanelTouchMove}
                onTouchEnd={onPanelTouchEnd}
                onTouchCancel={onPanelTouchEnd}
            >
                <button type="button" className="splash-edit-grab" aria-label="收起" onClick={() => setPanelOpen(false)}><i /></button>
                <div className="splash-edit-tabs">
                    {(["bg", "text"] as const).map((item) => (
                        <button key={item} type="button" data-on={tab === item ? "true" : undefined} onClick={() => setTab(item)}>{item === "bg" ? "背景" : "文字"}</button>
                    ))}
                </div>

                {tab === "bg" ? (
                    <>
                        <div className="splash-edit-label">图片</div>
                        <div className="splash-bg-tiles">
                            <label className="splash-bg-tile" data-on={draft.imageAssetId ? "true" : undefined} style={imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined}>
                                {imageUrl ? null : "上传"}
                                <input type="file" accept="image/*" aria-label="上传图片" onChange={(event) => { void onPickImage(event); }} />
                            </label>
                            {BG_COLORS.map((color) => (
                                <button key={color} type="button" className="splash-bg-tile" aria-label={`背景色 ${color}`} data-on={!draft.imageAssetId && draft.bgColor === color ? "true" : undefined} style={{ background: color }} onClick={() => clearImage(color)} />
                            ))}
                        </div>
                        <div className="splash-edit-row">
                            <span>颜色</span>
                            <input type="color" className="splash-color" aria-label="自选背景色" value={isHexColor(draft.bgColor) ? draft.bgColor : "#174bff"} onChange={(event) => change({ ...draftRef.current, bgColor: event.target.value })} />
                            {draft.imageAssetId ? <button type="button" className="splash-link" onClick={() => clearImage()}>去掉图片</button> : <span />}
                        </div>
                        <div className="splash-edit-label">图片入场</div>
                        <div className="splash-chips">
                            {MOTIONS.map((motion) => <Chip key={motion.id} on={draft.motion === motion.id} onClick={() => change({ ...draftRef.current, motion: motion.id })}>{motion.name}</Chip>)}
                        </div>
                        <div className="splash-edit-row">
                            <span>压暗</span>
                            <input type="range" className="ui-slider" aria-label="压暗" min={0} max={70} step={1} value={draft.shade} onChange={(event) => change({ ...draftRef.current, shade: Number(event.target.value) })} />
                            <span className="splash-edit-value">{draft.shade}%</span>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="splash-chips">
                            {draft.texts.map((text) => (
                                <Chip key={text.id} on={text.id === selectedId} onClick={() => setSelectedId(text.id)}>{Array.from(text.text.replace(/\n/g, " ")).slice(0, 6).join("") || "（空）"}</Chip>
                            ))}
                            {draft.texts.length < SPLASH_MAX_TEXTS ? <Chip onClick={addText}>+ 加文字</Chip> : null}
                        </div>
                        {selected ? (
                            <>
                                <textarea className="splash-edit-input" aria-label="文字内容" rows={2} maxLength={40} value={selected.text} onChange={(event) => patchText({ text: event.target.value })} />
                                <div className="splash-edit-label">动效</div>
                                <div className="splash-chips is-scroll">
                                    {SPLASH_EFFECTS.map((effect) => <Chip key={effect.id} on={selected.effect === effect.id} onClick={() => patchText({ effect: effect.id })}>{effect.name}</Chip>)}
                                </div>
                                <div className="splash-edit-label">字体</div>
                                <div className="splash-chips">
                                    {SPLASH_BUILTIN_FONTS.map((font) => <Chip key={font.id} on={selected.font === font.id} onClick={() => patchText({ font: font.id })}>{font.name}</Chip>)}
                                    {library.fonts.map((font) => (
                                        <span key={font.id} className="splash-chip-group">
                                            <Chip on={selected.font === font.id} onClick={() => patchText({ font: font.id })}>{font.name}</Chip>
                                            <button
                                                type="button"
                                                className="splash-chip-remove"
                                                aria-label={`删除字体 ${font.name}`}
                                                onClick={() => {
                                                    if (selected.font === font.id) patchText({ font: "song" });
                                                    void removeSplashFont(font.id);
                                                }}
                                            >×</button>
                                        </span>
                                    ))}
                                    <label className="splash-chip">
                                        上传字体
                                        <input type="file" accept=".ttf,.otf,.woff,.woff2" aria-label="上传字体" onChange={(event) => { void onPickFont(event); }} />
                                    </label>
                                </div>
                                <div className="splash-edit-row">
                                    <span>大小</span>
                                    <input type="range" className="ui-slider" aria-label="文字大小" min={14} max={110} step={1} value={selected.size} onChange={(event) => patchText({ size: Number(event.target.value) })} />
                                    <span className="splash-edit-value">{selected.size} px</span>
                                </div>
                                <div className="splash-edit-row">
                                    <span>开始</span>
                                    <input type="range" className="ui-slider" aria-label="开始时间" min={0} max={4} step={0.1} value={selected.start} onChange={(event) => patchText({ start: Number(event.target.value) })} />
                                    <span className="splash-edit-value">{selected.start.toFixed(1)} 秒</span>
                                </div>
                                <div className="splash-edit-row">
                                    <span>速度</span>
                                    <input type="range" className="ui-slider" aria-label="文字速度" min={50} max={200} step={10} value={Math.round(selected.speed * 100)} onChange={(event) => patchText({ speed: Number(event.target.value) / 100 })} />
                                    <span className="splash-edit-value">{Math.round(selected.speed * 100)}%</span>
                                </div>
                                <div className="splash-edit-row">
                                    <span>颜色</span>
                                    <span className="splash-swatches">
                                        {TEXT_COLORS.map((color) => (
                                            <button key={color} type="button" className="splash-swatch" aria-label={`颜色 ${color}`} data-on={selected.color.toLowerCase() === color.toLowerCase() ? "true" : undefined} style={{ background: color }} onClick={() => patchText({ color })} />
                                        ))}
                                        <input type="color" className="splash-color" aria-label="自选颜色" value={isHexColor(selected.color) ? selected.color : "#ffffff"} onChange={(event) => patchText({ color: event.target.value })} />
                                    </span>
                                    <span />
                                </div>
                                <div className="splash-edit-row">
                                    <span>排列</span>
                                    <span className="splash-chips">
                                        <Chip on={selected.dir === "h"} onClick={() => patchText({ dir: "h" })}>横排</Chip>
                                        <Chip on={selected.dir === "v"} onClick={() => patchText({ dir: "v" })}>竖排</Chip>
                                    </span>
                                    <span />
                                </div>
                                <button type="button" className="splash-edit-delete" onClick={removeText}>删除这段文字</button>
                            </>
                        ) : null}
                    </>
                )}
            </div>

            {leaving ? (
                <ConfirmDialog
                    title="放弃修改？"
                    message="这次的改动还没有保存。"
                    confirmLabel="放弃"
                    variant="danger"
                    onConfirm={() => { void discard(); }}
                    onCancel={() => setLeaving(false)}
                />
            ) : null}
        </div>,
        host,
    );
}
