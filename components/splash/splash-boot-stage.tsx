"use client";

// 打开 App 时放的自定义开屏。原图在 App 一加载时就开始读（main-app 里的 splashBootImage），
// 图一到就铺上、背景入场跟着开始，字体到了（或等够了）再播字。字体晚到会自动换上，图片晚到也会补上。

import { useLayoutEffect, useRef } from "react";
import { applySplashImage, buildSplashStage, playSplashStage, type SplashPlayback } from "@/lib/splash-effects";
import { ensureSplashFonts, splashBootImage, type SplashBootPlan } from "@/lib/splash-store";

/** 最多等图片这么久，再久先把字播起来 */
const IMAGE_WAIT_MS = 3000;
/** 字体多等这么久，没到就先用宋体，到了自动换上 */
const FONT_WAIT_MS = 1200;
/** 播完再停一下才算结束 */
const HOLD_MS = 800;

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([promise, new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), ms); })]);
}

export function SplashBootStage({ plan, onDone }: { plan: Extract<SplashBootPlan, { kind: "custom" }>; onDone: () => void }) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    // layout effect：图已经读好的话，开屏第一帧就是它
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const { config } = plan;
        let cancelled = false;
        const playbacks: SplashPlayback[] = [];
        let timer = 0;
        void (async () => {
            try {
                const image = splashBootImage();
                const fonts = ensureSplashFonts(plan.fonts);
                const imageUrl = await within(image, IMAGE_WAIT_MS);
                if (cancelled) return;
                buildSplashStage(root, config, imageUrl, Boolean(config.imageAssetId));
                const background = playSplashStage(root, config, "background");
                playbacks.push(background);
                if (config.imageAssetId && !imageUrl) void image.then((url) => { if (!cancelled) applySplashImage(root, url, config.bgColor); });
                await within(fonts, FONT_WAIT_MS);
                if (cancelled) return;
                const text = playSplashStage(root, config, "text");
                playbacks.push(text);
                timer = window.setTimeout(() => onDoneRef.current(), Math.max(background.endMs, text.endMs) + HOLD_MS);
            } catch (error) {
                // 哪一步出错都不能让人卡在开屏上
                console.warn("[Splash] 开屏播放失败", error);
                if (!cancelled) onDoneRef.current();
            }
        })();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            playbacks.forEach((playback) => playback.stop());
        };
    }, [plan]);

    return <div ref={rootRef} className="splash-stage" style={plan.config.imageAssetId ? undefined : { backgroundColor: plan.config.bgColor }} aria-hidden="true" />;
}
