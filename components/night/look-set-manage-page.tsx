"use client";

// 外观 → 管理搭配：每套一行，点一行进那套的配置页（日间是底子，没有配置页）；
// 左滑删除（日间、夜间删不了，删之前再问一次）；按住右边三条杠上下拖换顺序，松手才存。

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Menu, Plus } from "lucide-react";
import {
    DAY_SET_ID,
    deleteLookSet,
    listLookSets,
    loadNightSet,
    reorderLookSets,
    useNightRevision,
    type LookSet,
} from "@/lib/night-mode";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { ConfirmDialog } from "@/components/ui/modal";
import { LookSetEditSheet, LookSetThumb, useSheetHost } from "./look-set-sheets";

type Drag = { id: string; pointerId: number };

export function LookSetManagePage({ onOpenSet }: { onOpenSet: (setId: string) => void }) {
    useNightRevision();
    const swipe = useSwipeActions(62);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<LookSet | null>(null);
    const host = useSheetHost();
    const [order, setOrder] = useState<string[] | null>(null);
    const dragRef = useRef<Drag | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const sets = listLookSets();
    const shown = order ? order.map((id) => sets.find((set) => set.id === id)).filter((set) => set !== undefined) : sets;

    const startDrag = (event: ReactPointerEvent<HTMLSpanElement>, id: string) => {
        // 别让这一下被当成左滑
        event.stopPropagation();
        swipe.close();
        dragRef.current = { id, pointerId: event.pointerId };
        setOrder(sets.map((set) => set.id));
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    };

    const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !order || !listRef.current) return;
        // 手指压在哪一行的上半 / 下半，就挪到那一行前 / 后
        const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-look-row]"));
        let target = rows.length - 1;
        for (let i = 0; i < rows.length; i += 1) {
            const box = rows[i].getBoundingClientRect();
            if (event.clientY < box.top + box.height / 2) { target = i; break; }
        }
        const from = order.indexOf(drag.id);
        if (from === -1 || from === target) return;
        const next = order.filter((id) => id !== drag.id);
        next.splice(target, 0, drag.id);
        setOrder(next);
    };

    const endDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (order) reorderLookSets(order);
        setOrder(null);
    };

    return (
        <div className="night-page">
            {/* 整页就这一个列表，直接铺在页面上，不再套一张卡 */}
            <div className="look-manage" ref={listRef}>
                {shown.map((set) => {
                    const meta = set.id === DAY_SET_ID ? "默认搭配" : Object.keys(loadNightSet(set.id)).length ? "已配置" : "";
                    return (
                        <SwipeActionRow
                            key={set.id}
                            controller={swipe}
                            id={set.id}
                            disabled={set.builtin || Boolean(order)}
                            actions={(
                                <button
                                    type="button"
                                    className="ui-swipe-action"
                                    data-variant="delete"
                                    onClick={() => { swipe.close(); setDeleting(set); }}
                                >
                                    删除
                                </button>
                            )}
                        >
                            <div className="look-manage-row" data-look-row="" data-dragging={dragRef.current?.id === set.id ? "true" : undefined}>
                                <button
                                    type="button"
                                    className="look-manage-main"
                                    disabled={set.id === DAY_SET_ID}
                                    onClick={() => { if (!swipe.consumeClickSuppression()) onOpenSet(set.id); }}
                                >
                                    <LookSetThumb set={set} mini />
                                    <span className="menu-label">{set.name}</span>
                                </button>
                                {meta ? <span className="menu-desc look-manage-meta">{meta}</span> : null}
                                <span
                                    className="look-manage-handle"
                                    role="button"
                                    aria-label={`拖动「${set.name}」换顺序`}
                                    onPointerDown={(event) => startDrag(event, set.id)}
                                    onPointerMove={moveDrag}
                                    onPointerUp={endDrag}
                                    onPointerCancel={endDrag}
                                >
                                    <Menu size={16} aria-hidden="true" />
                                </span>
                            </div>
                        </SwipeActionRow>
                    );
                })}
                <button type="button" className="menu-item look-manage-add" onClick={() => setCreating(true)}>
                    <Plus size={15} aria-hidden="true" />
                    新建搭配
                </button>
            </div>
            {creating ? <LookSetEditSheet onClose={() => setCreating(false)} onDone={onOpenSet} /> : null}
            {deleting && host ? createPortal(
                <ConfirmDialog
                    title={`删除「${deleting.name}」搭配？`}
                    message="这套里配的东西会一起删掉，删了找不回来。正在用这套的话会回到日间。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={() => { deleteLookSet(deleting.id); setDeleting(null); }}
                    onCancel={() => setDeleting(null)}
                />,
                host,
            ) : null}
        </div>
    );
}
