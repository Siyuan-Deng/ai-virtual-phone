"use client";

import { useLayoutEffect, type RefObject } from "react";

const CHAT_BOTTOM_RESERVE_CSS_VAR = "--chat-bottom-reserve";
const STICK_TO_BOTTOM_THRESHOLD = 120;

function findBottomOverlay(wrapper: HTMLElement): HTMLElement | null {
    for (const child of Array.from(wrapper.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const ui = child.dataset.ui;
        if (ui === "input" || ui === "multi-select") return child;
    }
    return null;
}

export function useChatBottomReserve<TWrapper extends HTMLElement, TScroll extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    scrollRef: RefObject<TScroll | null>,
    refreshKey: string,
) {
    useLayoutEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        let frame = 0;
        let bottomScrollFrame = 0;
        let observer: ResizeObserver | null = null;

        const scheduleStickToBottom = () => {
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            bottomScrollFrame = window.requestAnimationFrame(() => {
                bottomScrollFrame = 0;
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
            });
        };

        // 上一次量到的高度。没变就一律提前返回：getBoundingClientRect 是强制同步
        // 布局，setProperty 又会把布局标脏，滚动中每帧都跑一遍就成「读布局 → 写样式
        // → 再读布局」的循环，是消息列表滑动掉帧的主要来源。
        let lastHeight = -1;

        const measure = () => {
            frame = 0;
            const overlay = findBottomOverlay(wrapper);
            if (!overlay) {
                if (lastHeight !== 0) {
                    lastHeight = 0;
                    wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
                }
                return;
            }

            const height = Math.ceil(overlay.getBoundingClientRect().height);
            if (height === lastHeight) return;
            lastHeight = height;

            const el = scrollRef.current;
            const wasNearBottom = el
                ? el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD
                : false;

            if (height > 0) {
                wrapper.style.setProperty(CHAT_BOTTOM_RESERVE_CSS_VAR, `${height}px`);
            } else {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
            }

            if (wasNearBottom) scheduleStickToBottom();
        };

        const requestMeasure = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        const overlay = findBottomOverlay(wrapper);
        if (overlay && typeof ResizeObserver !== "undefined") {
            // 输入区高度变化（多行输入、面板开合、键盘弹出）由 ResizeObserver 负责，
            // 它只在尺寸真的变了时回调，比监听滚动可靠也更便宜。
            observer = new ResizeObserver(requestMeasure);
            observer.observe(overlay);
        }

        measure();

        // 不监听 visualViewport 的 scroll：输入区高度不会因为滚动而改变，而滚动事件
        // 每帧都在触发（手指滑消息列表时），白白把强制同步布局带进滚动路径。
        // window.resize 与 visualViewport.resize 常常同时触发、指向同一个回调，
        // 两个都注册等于每次 resize 白跑两遍：只保留后者，无 visualViewport 时回落前者。
        const viewport = window.visualViewport;
        if (viewport) {
            viewport.addEventListener("resize", requestMeasure);
        } else {
            window.addEventListener("resize", requestMeasure);
        }

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            observer?.disconnect();
            if (viewport) {
                viewport.removeEventListener("resize", requestMeasure);
            } else {
                window.removeEventListener("resize", requestMeasure);
            }
        };
    }, [wrapperRef, scrollRef, refreshKey]);
}
