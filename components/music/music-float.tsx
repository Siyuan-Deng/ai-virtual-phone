// components/music/music-float.tsx — 后台音乐悬浮球
// 半透明球可拖动，松手吸附边缘，静置半透明收进旁边（歌照放）；点球展开面板，球下方「关闭」才停歌。
// 原版还有顶部灵动岛样式，iPhone 自己的灵动岛已经显示正在播放（lib/now-playing），没搬。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayerOptional, type MusicControlsValue } from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";

const DRAG_START_THRESHOLD = 6;
const EDGE_MARGIN = 10;

function formatTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

/** 点开悬浮球的面板：封面/歌名/进度条/播放控制 */
function IslandPanel({ player, track, className, closeButton }: {
    player: MusicControlsValue & { currentTime: number };
    track: MusicTrack;
    className?: string;
    closeButton?: React.ReactNode;
}) {
    const duration = player.duration || 0;
    const currentTime = player.currentTime || 0;
    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

    const handleSeek = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!player.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        player.seek(ratio * player.duration);
    };

    return (
        <div className={`music-float-island${className ? ` ${className}` : ""}`}>
            <div className="music-float-island-top">
                <div
                    className="music-float-island-cover"
                    onClick={(e) => { e.stopPropagation(); player.openFullPlayer(); }}
                >
                    {track.coverUrl ? (
                        <img src={track.coverUrl} alt="" draggable={false} />
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                    )}
                </div>
                <div className="music-float-island-info">
                    <div className="music-float-island-title">{track.title}</div>
                    <div className="music-float-island-artist">{track.artist}</div>
                </div>
                {closeButton}
                {!closeButton && (
                    <div className="music-float-island-wave" aria-hidden>
                        <span /><span /><span /><span />
                    </div>
                )}
            </div>

            <div className="music-float-island-progress-row">
                <span className="music-float-island-time">{formatTime(currentTime)}</span>
                <div className="music-float-progress" onPointerDown={handleSeek}>
                    <div className="music-float-progress-fill" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="music-float-island-time">-{formatTime(Math.max(0, duration - currentTime))}</span>
            </div>

            <div className="music-float-island-controls">
                <button className="music-float-island-btn" onClick={(e) => { e.stopPropagation(); player.prev(); }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                    </svg>
                </button>
                <button className="music-float-island-btn music-float-island-btn-play" onClick={(e) => { e.stopPropagation(); player.togglePlay(); }}>
                    {player.isPlaying ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                        </svg>
                    ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <button className="music-float-island-btn" onClick={(e) => { e.stopPropagation(); player.next(); }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                    </svg>
                </button>
            </div>
        </div>
    );
}


export default function MusicFloat({ hidden }: { hidden?: boolean }) {
    const player = useMusicPlayerOptional();
    const rootRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x: 320, y: 620 });
    const [side, setSide] = useState<"left" | "right">("right"); // 吸附边
    const dragRef = useRef<{
        pointerId: number | null; active: boolean;
        startX: number; startY: number; origX: number; origY: number;
        moved: boolean;
    }>({ pointerId: null, active: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [dismissing, setDismissing] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [tucked, setTucked] = useState(false); // 贴边静置后半透明藏在旁边
    const tuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** 贴边静置 2.8s 后收进边缘；拖动/展开/点按时不收 */
    const armTuckTimer = useCallback(() => {
        if (tuckTimerRef.current) clearTimeout(tuckTimerRef.current);
        tuckTimerRef.current = setTimeout(() => setTucked(true), 2800);
    }, []);

    useEffect(() => {
        if (expanded || dragging) {
            setTucked(false);
            if (tuckTimerRef.current) clearTimeout(tuckTimerRef.current);
            return;
        }
        armTuckTimer();
        return () => { if (tuckTimerRef.current) clearTimeout(tuckTimerRef.current); };
    }, [expanded, dragging, pos, armTuckTimer]);

    /** 把球限制在屏幕内 */
    const clampPos = useCallback((x: number, y: number) => {
        const el = rootRef.current;
        const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!el || !parent) return { x, y };
        return {
            x: Math.max(0, Math.min(x, parent.clientWidth - el.offsetWidth)),
            y: Math.max(0, Math.min(y, parent.clientHeight - el.offsetHeight)),
        };
    }, []);

    /** 松手后吸附到最近的边，并记录吸附方向（决定面板展开方向） */
    const snapToEdge = useCallback((x: number, y: number) => {
        const el = rootRef.current;
        const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!el || !parent) return { x, y, side: "right" as const };
        const pw = parent.clientWidth;
        const toLeft = x + el.offsetWidth / 2 < pw / 2;
        const snappedX = toLeft ? EDGE_MARGIN : pw - el.offsetWidth - EDGE_MARGIN;
        const next = clampPos(snappedX, y);
        return { ...next, side: (toLeft ? "left" : "right") as "left" | "right" };
    }, [clampPos]);

    const dismissFloat = useCallback(() => {
        if (!player) return;
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        setDismissing(true);
        dismissTimerRef.current = setTimeout(() => {
            player.stop();
            player.dismissFloat();
            setDismissing(false);
            setExpanded(false);
            dismissTimerRef.current = null;
        }, 220);
    }, [player]);

    useEffect(() => () => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        // 面板和关闭按钮里的交互不触发拖动
        if (target.closest("button") || target.closest(".music-float-island") || target.closest(".music-float-progress")) return;
        e.preventDefault();
        e.stopPropagation();
        setTucked(false); // 点按立刻唤醒
        armTuckTimer();
        rootRef.current?.setPointerCapture?.(e.pointerId);
        dragRef.current = {
            pointerId: e.pointerId,
            active: true,
            startX: e.clientX, startY: e.clientY,
            origX: pos.x, origY: pos.y,
            moved: false,
        };
    }, [pos, armTuckTimer]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > DRAG_START_THRESHOLD || Math.abs(dy) > DRAG_START_THRESHOLD) d.moved = true;
        if (d.moved) {
            setDragging(true);
            setPos(clampPos(d.origX + dx, d.origY + dy));
        }
    }, [clampPos]);

    const finishPointer = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        if (rootRef.current?.hasPointerCapture?.(e.pointerId)) {
            rootRef.current.releasePointerCapture(e.pointerId);
        }
        d.active = false;
        d.pointerId = null;
        setDragging(false);
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;

        if (d.moved) {
            const snapped = snapToEdge(d.origX + dx, d.origY + dy);
            setSide(snapped.side);
            setPos({ x: snapped.x, y: snapped.y });
            return;
        }

        if (player) {
            // 收进边缘时第一下点按只是唤醒，第二下才展开
            if (tucked) {
                setTucked(false);
                armTuckTimer();
                return;
            }
            setExpanded(prev => !prev);
        }
    }, [player, snapToEdge, tucked, armTuckTimer]);

    if (!player || !player.currentTrack || hidden || player.floatDismissed) return null;

    const track = player.currentTrack;

    const closeBtn = (
        <button
            type="button"
            className="music-float-close"
            onClick={(e) => { e.stopPropagation(); dismissFloat(); }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            关闭
        </button>
    );

    return (
        <div
            ref={rootRef}
            className="music-float"
            data-side={side}
            {...(expanded ? { "data-expanded": "" } : {})}
            {...(dismissing ? { "data-dismissing": "" } : {})}
            {...(dragging ? { "data-dragging": "" } : {})}
            {...(tucked && !expanded ? { "data-tucked": "" } : {})}
            {...(player.isPlaying ? { "data-playing": "" } : {})}
            style={{ left: pos.x, top: pos.y }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
        >
            {/* 悬浮球 */}
            <div className="music-float-orb">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
            </div>

            {/* 灵动岛面板 */}
            {expanded && <IslandPanel player={player} track={track} />}

            {/* 关闭按钮：展开后出现 */}
            {expanded && closeBtn}
        </div>
    );
}
