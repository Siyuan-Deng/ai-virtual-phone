"use client";

// 聊天里点头像换头像：先显示现在的头像，选图后在圆形选取框里拖动、双指（或滑条、滚轮）缩放，
// 框里的部分就是新头像，不用先去相册裁好。输出 400×400 的正方形图。

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { ImagePlus, RotateCcw, User } from "lucide-react";

const OUTPUT_SIZE = 400;
const MAX_ZOOM = 4;

type View = { x: number; y: number; z: number };
type Loaded = { url: string; width: number; height: number; img: HTMLImageElement };

function clampView(view: View, loaded: Loaded, stage: number, base: number): View {
    const z = Math.min(MAX_ZOOM, Math.max(1, view.z));
    const w = loaded.width * base * z;
    const h = loaded.height * base * z;
    return {
        z,
        x: Math.min(0, Math.max(stage - w, view.x)),
        y: Math.min(0, Math.max(stage - h, view.y)),
    };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        // 不支持 webp 的浏览器会自己给 png
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("图片导出失败"))), "image/webp", 0.9);
    });
}

export function AvatarCropDialog({
    title,
    currentUrl,
    canReset,
    onSave,
    onReset,
    onClose,
}: {
    title: string;
    /** 现在显示的头像（可能是默认的） */
    currentUrl: string | null;
    /** 这个聊天里换过头像，才有「恢复默认」 */
    canReset: boolean;
    onSave: (blob: Blob) => Promise<void> | void;
    onReset: () => void;
    onClose: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [stage] = useState(() => (typeof window === "undefined" ? 280 : Math.max(200, Math.min(280, window.innerWidth - 96))));
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const viewRef = useRef(view);
    viewRef.current = view;

    const base = loaded ? Math.max(stage / loaded.width, stage / loaded.height) : 1;

    useEffect(() => () => {
        if (loaded) URL.revokeObjectURL(loaded.url);
    }, [loaded]);

    const pickFile = () => fileInputRef.current?.click();

    const handleFile = (file: File | undefined) => {
        if (!file) return;
        setError(null);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const next = { url, width: img.naturalWidth, height: img.naturalHeight, img };
            const b = Math.max(stage / next.width, stage / next.height);
            setLoaded(next);
            setView({ z: 1, x: (stage - next.width * b) / 2, y: (stage - next.height * b) / 2 });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            setError("这张图片打不开，换一张试试");
        };
        img.src = url;
    };

    /** 以舞台上 (cx, cy) 这一点为中心缩放 */
    const zoomAround = useCallback((nextZ: number, cx: number, cy: number) => {
        if (!loaded) return;
        const current = viewRef.current;
        const z = Math.min(MAX_ZOOM, Math.max(1, nextZ));
        const px = (cx - current.x) / (base * current.z);
        const py = (cy - current.y) / (base * current.z);
        setView(clampView({ z, x: cx - px * base * z, y: cy - py * base * z }, loaded, stage, base));
    }, [base, loaded, stage]);

    const stagePoint = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!loaded) return;
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // 拿不到也不影响拖动，只是手指移出框外就不跟了
        }
        pointersRef.current.set(event.pointerId, stagePoint(event));
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pointers = pointersRef.current;
        const previous = pointers.get(event.pointerId);
        if (!loaded || !previous) return;
        const point = stagePoint(event);
        if (pointers.size === 1) {
            const current = viewRef.current;
            setView(clampView({ ...current, x: current.x + point.x - previous.x, y: current.y + point.y - previous.y }, loaded, stage, base));
            pointers.set(event.pointerId, point);
            return;
        }
        // 双指：按两指距离的变化缩放，以两指中点为中心
        const other = Array.from(pointers.entries()).find(([id]) => id !== event.pointerId)?.[1];
        pointers.set(event.pointerId, point);
        if (!other) return;
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(point.x - other.x, point.y - other.y);
        if (before < 1) return;
        zoomAround(viewRef.current.z * (after / before), (point.x + other.x) / 2, (point.y + other.y) / 2);
    };

    const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
    };

    const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
        if (!loaded) return;
        const point = stagePoint(event);
        zoomAround(viewRef.current.z * Math.exp(-event.deltaY / 400), point.x, point.y);
    };

    const confirm = async () => {
        if (!loaded || saving) return;
        setSaving(true);
        setError(null);
        try {
            const scale = base * view.z;
            const canvas = document.createElement("canvas");
            canvas.width = OUTPUT_SIZE;
            canvas.height = OUTPUT_SIZE;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("图片导出失败");
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(loaded.img, -view.x / scale, -view.y / scale, stage / scale, stage / scale, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
            await onSave(await canvasToBlob(canvas));
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存失败，请重试");
            setSaving(false);
        }
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div className="modal-dialog chat-avatar-crop-dialog" data-ui="modal-dialog" onClick={(event) => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title">{title}</h3>
                </div>
                <div className="modal-body flex flex-col items-center gap-3" data-ui="modal-body">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            handleFile(event.target.files?.[0]);
                            event.target.value = "";
                        }}
                    />
                    {loaded ? (
                        <>
                            <div
                                className="chat-avatar-crop-stage"
                                style={{ width: stage, height: stage }}
                                onPointerDown={onPointerDown}
                                onPointerMove={onPointerMove}
                                onPointerUp={onPointerEnd}
                                onPointerCancel={onPointerEnd}
                                onWheel={onWheel}
                            >
                                <img
                                    src={loaded.url}
                                    alt=""
                                    draggable={false}
                                    style={{
                                        width: loaded.width * base * view.z,
                                        height: loaded.height * base * view.z,
                                        transform: `translate(${view.x}px, ${view.y}px)`,
                                    }}
                                />
                                <div className="chat-avatar-crop-mask" aria-hidden="true" />
                            </div>
                            <input
                                type="range"
                                className="chat-avatar-crop-zoom"
                                min={1}
                                max={MAX_ZOOM}
                                step={0.01}
                                value={view.z}
                                aria-label="缩放"
                                onChange={(event) => zoomAround(Number(event.target.value), stage / 2, stage / 2)}
                            />
                            <span className="menu-desc">拖动图片调整位置，双指或滑条缩放</span>
                        </>
                    ) : (
                        <>
                            <div className="chat-avatar-crop-current">
                                {currentUrl ? <img src={currentUrl} alt="" /> : <User size={32} />}
                            </div>
                            <button type="button" className="ui-btn ui-btn-primary w-full" onClick={pickFile}>
                                <ImagePlus size={16} /> 从相册选择
                            </button>
                            {canReset ? (
                                <button type="button" className="ui-btn ui-btn-outline w-full" onClick={onReset}>
                                    <RotateCcw size={16} /> 恢复默认头像
                                </button>
                            ) : null}
                        </>
                    )}
                    {error ? <span className="menu-desc text-[var(--c-danger)]">{error}</span> : null}
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    {loaded ? (
                        <>
                            <button type="button" className="ui-btn ui-btn-outline" onClick={pickFile} disabled={saving}>重新选择</button>
                            <button type="button" className="ui-btn ui-btn-primary" onClick={confirm} disabled={saving}>{saving ? "保存中…" : "确定"}</button>
                        </>
                    ) : (
                        <button type="button" className="ui-btn ui-btn-outline" onClick={onClose}>取消</button>
                    )}
                </div>
            </div>
        </div>
    );
}
