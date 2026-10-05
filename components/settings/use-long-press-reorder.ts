"use client";

// 设置页卡片的「长按拖动排序」（API 配置、世界书、预设共用）：
// 按住约 0.4 秒卡片浮起来跟着手指走，经过别的卡片就和它换位置，松手才保存。
// 只在同一组里换（置顶的、文件夹、普通卡片各是一组）。按下后手指先动了就当是在滚动列表，不进拖动。
// 拖的是卡片本身（不复制一份，主题样式不会丢）；别的卡片滑过去让位；
// 靠近列表上下边缘（上边缘算在顶部标题栏下面）时自动滚动。

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { moveId } from "@/lib/list-order";

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE_PX = 8;
const EDGE_PX = 56;
const MAX_SCROLL_SPEED = 14;
const LIFT_SCALE = 1.03;
const SHIFT_MS = 180;

type Session = {
    group: string;
    id: string;
    order: string[];
    el: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    grabX: number;
    grabY: number;
    active: boolean;
    timer: number | null;
    scroller: HTMLElement | null;
    raf: number | null;
    cleanupListeners: () => void;
};

type Preview = { group: string; order: string[]; draggingId: string };

function findScroller(el: HTMLElement): HTMLElement | null {
    for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return (document.scrollingElement as HTMLElement | null) ?? null;
}

function blockTouchScroll(event: TouchEvent) {
    if (event.cancelable) event.preventDefault();
}

function swallowClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
}

function groupElements(group: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-reorder-group]"))
        .filter((el) => el.dataset.reorderGroup === group);
}

export function useLongPressReorder(onCommit: (group: string, orderedIds: string[]) => void) {
    const sessionRef = useRef<Session | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    /** 换位置前各卡片在哪（画面上的位置），换完以后从那里滑到新位置 */
    const shiftFromRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    /** 卡片挪到手指下面：先量出没加位移时的位置（重排之后布局会变），再算位移 */
    const placeCard = useCallback(() => {
        const s = sessionRef.current;
        if (!s?.active) return;
        const previous = s.el.style.transform;
        s.el.style.transform = "none";
        const rect = s.el.getBoundingClientRect();
        s.el.style.transform = previous;
        const dx = s.x - s.grabX - rect.left;
        const dy = s.y - s.grabY - rect.top;
        s.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${LIFT_SCALE})`;
    }, []);

    /** 手指下面是同组的另一张卡片就换位置 */
    const hitTest = useCallback(() => {
        const s = sessionRef.current;
        if (!s?.active) return;
        const target = document.elementFromPoint(s.x, s.y)?.closest<HTMLElement>("[data-reorder-id]");
        if (!target || target.dataset.reorderGroup !== s.group) return;
        const targetId = target.dataset.reorderId;
        if (!targetId || targetId === s.id) return;
        const next = moveId(s.order, s.id, targetId);
        if (next === s.order) return;
        s.order = next;
        shiftFromRef.current = new Map(
            groupElements(s.group).filter((el) => el !== s.el).map((el) => [el, el.getBoundingClientRect()]),
        );
        setPreview({ group: s.group, order: next, draggingId: s.id });
    }, []);

    const finish = useCallback((commit: boolean) => {
        const s = sessionRef.current;
        if (!s) return;
        sessionRef.current = null;
        if (s.timer !== null) window.clearTimeout(s.timer);
        if (s.raf !== null) cancelAnimationFrame(s.raf);
        s.cleanupListeners();
        if (!s.active) return;
        document.removeEventListener("touchmove", blockTouchScroll);
        for (const prop of ["transform", "transition", "pointer-events", "z-index", "position"]) s.el.style.removeProperty(prop);
        shiftFromRef.current = null;
        for (const el of groupElements(s.group)) {
            el.style.removeProperty("transform");
            el.style.removeProperty("transition");
        }
        // 松手后紧跟着的那次 click 别把卡片点开
        window.addEventListener("click", swallowClick, true);
        window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 350);
        if (commit) commitRef.current(s.group, s.order);
        setPreview(null);
    }, []);

    const autoScroll = useCallback(() => {
        const s = sessionRef.current;
        if (!s?.active) return;
        const scroller = s.scroller;
        if (scroller) {
            const box = scroller === document.scrollingElement
                ? { top: 0, bottom: window.innerHeight }
                : scroller.getBoundingClientRect();
            // 设置页的标题栏是浮在列表上面的，列表靠 padding-top 让出位置：上边缘从标题栏底下算
            const rect = { top: box.top + (parseFloat(getComputedStyle(scroller).paddingTop) || 0), bottom: box.bottom };
            let speed = 0;
            if (s.y < rect.top + EDGE_PX) speed = -MAX_SCROLL_SPEED * Math.min(1, (rect.top + EDGE_PX - s.y) / EDGE_PX);
            else if (s.y > rect.bottom - EDGE_PX) speed = MAX_SCROLL_SPEED * Math.min(1, (s.y - (rect.bottom - EDGE_PX)) / EDGE_PX);
            if (speed !== 0) {
                const before = scroller.scrollTop;
                scroller.scrollTop += speed;
                if (scroller.scrollTop !== before) {
                    placeCard();
                    hitTest();
                }
            }
        }
        s.raf = requestAnimationFrame(autoScroll);
    }, [hitTest, placeCard]);

    const activate = useCallback(() => {
        const s = sessionRef.current;
        if (!s) return;
        s.timer = null;
        s.active = true;
        const rect = s.el.getBoundingClientRect();
        s.grabX = s.x - rect.left;
        s.grabY = s.y - rect.top;
        s.scroller = findScroller(s.el);
        // 先直接改样式，不等 React：pointer-events 关掉，手指下面才能探到别的卡片
        s.el.style.position = "relative";
        s.el.style.zIndex = "30";
        s.el.style.pointerEvents = "none";
        s.el.style.transition = "box-shadow 0.15s ease";
        s.el.style.transform = `translate3d(0, 0, 0) scale(${LIFT_SCALE})`;
        document.addEventListener("touchmove", blockTouchScroll, { passive: false });
        navigator.vibrate?.(12);
        setPreview({ group: s.group, order: s.order, draggingId: s.id });
        s.raf = requestAnimationFrame(autoScroll);
    }, [autoScroll]);

    const start = useCallback((event: ReactPointerEvent<HTMLElement>, group: string, id: string, ids: string[]) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (sessionRef.current || ids.length < 2) return;
        const el = event.currentTarget;
        const onMove = (e: PointerEvent) => {
            const s = sessionRef.current;
            if (!s || e.pointerId !== s.pointerId) return;
            s.x = e.clientX;
            s.y = e.clientY;
            if (!s.active) {
                if (Math.hypot(s.x - s.startX, s.y - s.startY) > MOVE_TOLERANCE_PX) finish(false);
                return;
            }
            placeCard();
            hitTest();
        };
        const onUp = (e: PointerEvent) => {
            if (sessionRef.current && e.pointerId === sessionRef.current.pointerId) finish(true);
        };
        const onCancel = (e: PointerEvent) => {
            if (sessionRef.current && e.pointerId === sessionRef.current.pointerId) finish(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        sessionRef.current = {
            group,
            id,
            order: ids,
            el,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            grabX: 0,
            grabY: 0,
            active: false,
            timer: window.setTimeout(activate, LONG_PRESS_MS),
            scroller: null,
            raf: null,
            cleanupListeners: () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onCancel);
            },
        };
    }, [activate, finish, hitTest, placeCard]);

    // 换完位置：别的卡片从原来的位置滑过去（FLIP），被拖的卡片重新对准手指
    useLayoutEffect(() => {
        const from = shiftFromRef.current;
        shiftFromRef.current = null;
        if (from) {
            for (const [el, first] of from) {
                if (!el.isConnected) continue;
                el.style.transition = "none";
                el.style.removeProperty("transform");
                const last = el.getBoundingClientRect();
                const dx = first.left - last.left;
                const dy = first.top - last.top;
                if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                    el.style.removeProperty("transition");
                    continue;
                }
                el.style.transform = `translate(${dx}px, ${dy}px)`;
                void el.offsetWidth;
                requestAnimationFrame(() => {
                    el.style.transition = `transform ${SHIFT_MS}ms ease`;
                    el.style.removeProperty("transform");
                });
            }
        }
        placeCard();
    }, [preview, placeCard]);

    useEffect(() => () => finish(false), [finish]);

    /** 这一组现在该按什么顺序画（拖动中是预览顺序） */
    const order = useCallback(<T extends { id: string }>(group: string, items: T[]): T[] => {
        if (!preview || preview.group !== group) return items;
        const byId = new Map(items.map((item) => [item.id, item]));
        const ordered = preview.order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
        // 拖动中途列表变了（比如别处删了一项）就照原样
        return ordered.length === items.length ? ordered : items;
    }, [preview]);

    /** 放在每张卡片上的属性；ids 是这一组当前的顺序 */
    const itemProps = useCallback((group: string, id: string, ids: string[]) => ({
        "data-reorder-group": group,
        "data-reorder-id": id,
        "data-dragging": preview?.draggingId === id ? "true" : undefined,
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, group, id, ids),
        onContextMenu: (event: ReactMouseEvent) => {
            if (sessionRef.current) event.preventDefault();
        },
    }), [preview, start]);

    return { order, itemProps, dragging: preview !== null };
}
