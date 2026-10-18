"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

/** 长按纸条拖进垃圾桶删除：TA的日记、我的日记、片刻纪事共用 */
export type DragToTrashState<T> = {
  item: T;
  x: number;
  y: number;
  width: number;
  height: number;
  isOverTrash: boolean;
};

type DragSession<T> = {
  item: T;
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  timer: number | null;
  dragging: boolean;
};

type DragScrollLock = {
  bodyOverflow: string;
  bodyTouchAction: string;
  htmlOverscrollBehavior: string;
  htmlTouchAction: string;
  main: HTMLElement | null;
  mainOverflow: string;
  mainTouchAction: string;
  mainScrollTop: number;
};

export function useDragToTrash<T>({ enabled, scrollRef, onDrop }: {
  /** 不在列表页（比如书架）就不让拖 */
  enabled: boolean;
  /** 拖的时候锁住这个滚动容器 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 拖进垃圾桶松手 */
  onDrop: (item: T) => void;
}) {
  const [drag, setDrag] = useState<DragToTrashState<T> | null>(null);
  const trashRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession<T> | null>(null);
  const clickSuppressedRef = useRef(false);
  const clickSuppressTimerRef = useRef<number | null>(null);
  const scrollLockRef = useRef<DragScrollLock | null>(null);
  const touchMoveBlockerRef = useRef<((event: globalThis.TouchEvent) => void) | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const clearTimer = useCallback(() => {
    const timer = sessionRef.current?.timer;
    if (timer !== null && timer !== undefined) {
      window.clearTimeout(timer);
      if (sessionRef.current) sessionRef.current.timer = null;
    }
  }, []);

  const suppressClick = useCallback((duration = 700) => {
    if (clickSuppressTimerRef.current !== null) {
      window.clearTimeout(clickSuppressTimerRef.current);
    }
    clickSuppressedRef.current = true;
    clickSuppressTimerRef.current = window.setTimeout(() => {
      clickSuppressedRef.current = false;
      clickSuppressTimerRef.current = null;
    }, duration);
  }, []);

  const lockScroll = useCallback(() => {
    if (scrollLockRef.current || typeof document === "undefined") return;
    const main = scrollRef.current;
    scrollLockRef.current = {
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      main,
      mainOverflow: main?.style.overflow ?? "",
      mainTouchAction: main?.style.touchAction ?? "",
      mainScrollTop: main?.scrollTop ?? 0,
    };
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    if (!touchMoveBlockerRef.current) {
      touchMoveBlockerRef.current = (event: globalThis.TouchEvent) => {
        event.preventDefault();
      };
      document.addEventListener("touchmove", touchMoveBlockerRef.current, { capture: true, passive: false });
    }
    if (main) {
      main.style.overflow = "hidden";
      main.style.touchAction = "none";
    }
  }, [scrollRef]);

  const unlockScroll = useCallback(() => {
    const lock = scrollLockRef.current;
    if (!lock || typeof document === "undefined") return;
    document.body.style.overflow = lock.bodyOverflow;
    document.body.style.touchAction = lock.bodyTouchAction;
    document.documentElement.style.overscrollBehavior = lock.htmlOverscrollBehavior;
    document.documentElement.style.touchAction = lock.htmlTouchAction;
    if (touchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", touchMoveBlockerRef.current, { capture: true });
      touchMoveBlockerRef.current = null;
    }
    if (lock.main) {
      lock.main.style.overflow = lock.mainOverflow;
      lock.main.style.touchAction = lock.mainTouchAction;
      lock.main.scrollTop = lock.mainScrollTop;
    }
    scrollLockRef.current = null;
  }, []);

  const isOverTrash = useCallback((clientX: number, clientY: number, width: number, height: number) => {
    const trashRect = trashRef.current?.getBoundingClientRect();
    if (!trashRect) return false;
    const itemRect = {
      left: clientX - width / 2,
      right: clientX + width / 2,
      top: clientY - height / 2,
      bottom: clientY + height / 2,
    };
    return itemRect.left < trashRect.right
      && itemRect.right > trashRect.left
      && itemRect.top < trashRect.bottom
      && itemRect.bottom > trashRect.top;
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    const session = sessionRef.current;
    if (session?.dragging) {
      suppressClick();
    }
    if (session) {
      try {
        session.target.releasePointerCapture(session.pointerId);
      } catch {
        // Pointer capture may already be gone.
      }
    }
    sessionRef.current = null;
    setDrag(null);
    unlockScroll();
  }, [clearTimer, suppressClick, unlockScroll]);

  const updatePosition = useCallback((clientX: number, clientY: number) => {
    const session = sessionRef.current;
    if (!session?.dragging) return;
    const lock = scrollLockRef.current;
    if (lock?.main) lock.main.scrollTop = lock.mainScrollTop;
    setDrag({
      item: session.item,
      x: clientX,
      y: clientY,
      width: session.width,
      height: session.height,
      isOverTrash: isOverTrash(clientX, clientY, session.width, session.height),
    });
  }, [isOverTrash]);

  const finish = useCallback((clientX: number, clientY: number) => {
    const session = sessionRef.current;
    if (!session) return;
    const shouldDrop = session.dragging && isOverTrash(clientX, clientY, session.width, session.height);
    const item = session.item;
    reset();
    if (shouldDrop) onDropRef.current(item);
  }, [isOverTrash, reset]);

  useEffect(() => {
    if (!drag) return;
    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session?.dragging || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updatePosition(event.clientX, event.clientY);
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      finish(event.clientX, event.clientY);
    };
    const handleWindowPointerCancel = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      reset();
    };
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [drag, finish, reset, updatePosition]);

  useEffect(() => {
    return () => {
      reset();
      unlockScroll();
      if (clickSuppressTimerRef.current !== null) {
        window.clearTimeout(clickSuppressTimerRef.current);
        clickSuppressTimerRef.current = null;
      }
    };
  }, [reset, unlockScroll]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>, item: T) => {
    if (!enabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearTimer();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.currentTarget;
    sessionRef.current = {
      item,
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      timer: window.setTimeout(() => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== event.pointerId || session.dragging) return;
        session.dragging = true;
        session.timer = null;
        suppressClick(900);
        lockScroll();
        try {
          session.target.setPointerCapture(session.pointerId);
        } catch {
          // Some touch browsers release capture during native gestures.
        }
        setDrag({
          item: session.item,
          x: event.clientX,
          y: event.clientY,
          width: session.width,
          height: session.height,
          isOverTrash: isOverTrash(event.clientX, event.clientY, session.width, session.height),
        });
      }, 430),
      dragging: false,
    };
  }, [enabled, clearTimer, isOverTrash, lockScroll, suppressClick]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging) {
      if (Math.hypot(dx, dy) > 8) {
        clearTimer();
        sessionRef.current = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updatePosition(event.clientX, event.clientY);
  }, [clearTimer, updatePosition]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finish(event.clientX, event.clientY);
  }, [finish]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    reset();
  }, [reset]);

  const onPointerLeave = useCallback((event: PointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    clearTimer();
    sessionRef.current = null;
  }, [clearTimer]);

  /** 刚拖完松手那一下浏览器还会补一个 click，别让它把纸条打开 */
  const isClickSuppressed = useCallback(() => clickSuppressedRef.current, []);

  return { drag, trashRef, isClickSuppressed, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave };
}
