"use client";

// 剧情正篇 / 番外：右下角「↑ 上一轮」「↓ 下一轮」两个方块键，和右上角两个按钮一个样子。
// 一轮从你发出去的那条开始：你的发言、番外指令卡、系统指令卡（文章上挂着 data-story-round）。
// 点一下把那条的开头滑到屏幕上方 1/3 处，下面能接着看它回的内容；
// 往回翻到还没加载的地方，先加载再跳；下面没有下一轮了，「↓」就回到最底部。
// 平时藏着，手指 / 滚轮滑动时才出现，停下 1.5 秒后淡出。

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** false：一直显示；true：滑动时才出现，停下 1.5 秒后淡出 */
const AUTO_HIDE = true;
const LINE = 1 / 3;
/** 滚动位置差几像素以内算「已经在这一轮」 */
const SLACK = 4;
/** 手指移动超过这么多才算滑动：只是点一下不叫出键，不然会挡住「保存」 */
const SWIPE = 8;

type Props = {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 列表变了（新消息、加载更多、切会话）就重新算两个键能不能点 */
  revision: string;
  /** 还没加载出来的更早消息里有没有一轮的开头 */
  hiddenHasRound: boolean;
  onLoadMore: () => void;
};

export function StoryRoundJump({ scrollRef, revision, hiddenHasRound, onLoadMore }: Props) {
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [awake, setAwake] = useState(!AUTO_HIDE);
  const [bottom, setBottom] = useState(70);
  const navRef = useRef<HTMLDivElement | null>(null);
  // 平滑滚动还没停时连点：以正要去的位置为准，不然会一直跳回同一轮
  const headingRef = useRef<{ top: number; at: number } | null>(null);
  const pendingPrevRef = useRef<{ fromBottom: number } | null>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 什么时候之前的滚动算「人在滑」：生成时自动贴底、内容变高也会触发滚动，那种不该把键叫出来
  const userScrollUntilRef = useRef(0);
  const hiddenHasRoundRef = useRef(hiddenHasRound);
  hiddenHasRoundRef.current = hiddenHasRound;

  /** 每一轮开头要滚到的位置（已经卡在可滚范围里），从上到下 */
  const stops = useCallback(() => {
    const stage = scrollRef.current;
    if (!stage) return [];
    const stageTop = stage.getBoundingClientRect().top;
    const maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
    return Array.from(stage.querySelectorAll<HTMLElement>("[data-story-round]")).map((el) => {
      const top = el.getBoundingClientRect().top - stageTop + stage.scrollTop;
      return { el, want: Math.min(maxScroll, Math.max(0, top - stage.clientHeight * LINE)) };
    });
  }, [scrollRef]);

  /** 还在往某一轮滑（没到、没超时、手指也没接管）就以那一轮为准，否则就是现在的位置 */
  const currentTop = useCallback(() => {
    const stage = scrollRef.current;
    if (!stage) return 0;
    const heading = headingRef.current;
    if (heading && performance.now() - heading.at < 1500 && Math.abs(stage.scrollTop - heading.top) > SLACK) {
      return heading.top;
    }
    headingRef.current = null;
    return stage.scrollTop;
  }, [scrollRef]);

  const refresh = useCallback(() => {
    const now = currentTop();
    const list = stops();
    setCanPrev(list.some((stop) => stop.want < now - SLACK) || hiddenHasRoundRef.current);
    // 下面没有下一轮了也能点：回到最底部
    const stage = scrollRef.current;
    const maxScroll = stage ? Math.max(0, stage.scrollHeight - stage.clientHeight) : 0;
    setCanNext(list.some((stop) => stop.want > now + SLACK) || now < maxScroll - SLACK);
  }, [currentTop, scrollRef, stops]);

  const wake = useCallback(() => {
    if (!AUTO_HIDE) return;
    setAwake(true);
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = setTimeout(() => setAwake(false), 1500);
  }, []);

  const jumpTo = useCallback((stop: { el: HTMLElement; want: number }) => {
    const stage = scrollRef.current;
    if (!stage) return;
    headingRef.current = { top: stop.want, at: performance.now() };
    // 跳过去的这一路也算在滑：滑到停下再过 1.5 秒才淡出，方便接着点
    userScrollUntilRef.current = performance.now() + 1000;
    stage.scrollTo({ top: stop.want, behavior: "smooth" });
    stop.el.classList.remove("story-round-flash");
    void stop.el.offsetWidth;
    stop.el.classList.add("story-round-flash");
  }, [scrollRef]);

  /** from：从哪个滚动位置往上找；不给就是现在的位置 */
  const goPrev = useCallback((from?: number) => {
    const stage = scrollRef.current;
    if (!stage) return;
    const now = from ?? currentTop();
    const target = stops().filter((stop) => stop.want < now - SLACK).pop();
    if (target) {
      jumpTo(target);
      return;
    }
    // 上面已经没有了：更早的还没加载，先加载，列表一变再接着找。
    // 记的是离底部多远：加载完顶上多出一截，按离底部的距离换算回来才是原来那个位置
    if (hiddenHasRoundRef.current) {
      pendingPrevRef.current = { fromBottom: stage.scrollHeight - now };
      onLoadMore();
    }
  }, [currentTop, jumpTo, onLoadMore, scrollRef, stops]);

  const goNext = useCallback(() => {
    const stage = scrollRef.current;
    if (!stage) return;
    const now = currentTop();
    const target = stops().find((stop) => stop.want > now + SLACK);
    if (target) {
      jumpTo(target);
      return;
    }
    // 已经是最后一轮：回到最底部
    const maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
    if (now >= maxScroll - SLACK) return;
    headingRef.current = { top: maxScroll, at: performance.now() };
    userScrollUntilRef.current = performance.now() + 1000;
    stage.scrollTo({ top: maxScroll, behavior: "smooth" });
  }, [currentTop, jumpTo, scrollRef, stops]);

  useEffect(() => {
    const pending = pendingPrevRef.current;
    const stage = scrollRef.current;
    if (pending && stage) {
      pendingPrevRef.current = null;
      goPrev(stage.scrollHeight - pending.fromBottom);
    }
    refresh();
  }, [revision, goPrev, refresh, scrollRef]);

  useEffect(() => {
    const stage = scrollRef.current;
    if (!stage) return;
    let frame = 0;
    const scheduleRefresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const onScroll = () => {
      // 手指松开后的惯性也一直在滚：滚着就顺延，停下来才开始算 1.5 秒
      const now = performance.now();
      if (now < userScrollUntilRef.current) {
        userScrollUntilRef.current = now + 300;
        wake();
      }
      scheduleRefresh();
    };
    // 自己用手指 / 滚轮滑了：叫出两个键，并且不再按「正在去的那一轮」算
    const takeOver = () => {
      headingRef.current = null;
      userScrollUntilRef.current = performance.now() + 1000;
      wake();
    };
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      headingRef.current = null;
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchStartY === null || Math.abs(y - touchStartY) < SWIPE) return;
      takeOver();
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchmove", onTouchMove, { passive: true });
    stage.addEventListener("wheel", takeOver, { passive: true });
    // 生成中、展开折叠、图片加载完，内容高度会变（只重算能不能点，不叫出键）
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleRefresh) : null;
    if (stage.firstElementChild) observer?.observe(stage.firstElementChild);
    return () => {
      stage.removeEventListener("scroll", onScroll);
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchmove", onTouchMove);
      stage.removeEventListener("wheel", takeOver);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, refresh, wake, revision]);

  // 跟着输入栏的高度走：多行输入时输入栏变高，两个键往上让
  useEffect(() => {
    const composer = navRef.current?.parentElement?.querySelector<HTMLElement>(".story-composer");
    if (!composer) return;
    const update = () => setBottom(composer.offsetHeight + 10);
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(composer);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => () => {
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
  }, []);

  return (
    <div
      ref={navRef}
      className="story-round-jump"
      style={{ bottom }}
      data-asleep={awake ? undefined : "true"}
    >
      <button
        type="button"
        className="story-top-btn story-round-jump-btn"
        aria-label="上一轮"
        disabled={!canPrev}
        onClick={() => { goPrev(); wake(); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true"><polyline points="6 15 12 9 18 15" /></svg>
      </button>
      <button
        type="button"
        className="story-top-btn story-round-jump-btn"
        aria-label="下一轮"
        disabled={!canNext}
        onClick={() => { goNext(); wake(); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </div>
  );
}
