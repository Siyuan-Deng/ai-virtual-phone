"use client";

// 打开 App 时放的自定义开屏。有图的先铺小预览图（存在 localStorage，马上就有），原图读到（或等够了）再开始播。
// 图片和字体分开等：字体文件大、解析慢，不能拖累图片；到得晚的图片、字体播的时候补上，不会丢。

import { useEffect, useRef } from "react";
import { applySplashImage, buildSplashStage, playSplashStage, type SplashPlayback } from "@/lib/splash-effects";
import { backfillSplashPreview, ensureSplashFonts, type SplashBootPlan } from "@/lib/splash-store";
import { getThemeAssetDataUrl } from "@/lib/theme-storage";

/** 最多等图片这么久，再久先把字播起来 */
const IMAGE_WAIT_MS = 3000;
/** 字体多等这么久，没到就先用宋体，到了自动换上 */
const FONT_WAIT_MS = 1200;
/** 播完再停一下才算结束 */
const HOLD_MS = 800;

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([promise, new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), ms); })]);
}

async function readImage(assetId: string | null): Promise<string | null> {
    if (!assetId) return null;
    const url = await getThemeAssetDataUrl(assetId).catch(() => null);
    if (url) {
        const image = new Image();
        image.src = url;
        await image.decode().catch(() => undefined);
    }
    return url;
}

export function SplashBootStage({ plan, onDone }: { plan: Extract<SplashBootPlan, { kind: "custom" }>; onDone: () => void }) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        let cancelled = false;
        let playback: SplashPlayback | null = null;
        let timer = 0;
        void (async () => {
            try {
                const image = readImage(plan.config.imageAssetId);
                const fonts = ensureSplashFonts(plan.fonts);
                const imageUrl = await within(image, IMAGE_WAIT_MS);
                await within(fonts, FONT_WAIT_MS);
                if (cancelled) return;
                const { config } = plan;
                buildSplashStage(root, config, imageUrl, Boolean(config.imageAssetId));
                playback = playSplashStage(root, config);
                if (config.imageAssetId && !imageUrl) void image.then((url) => { if (!cancelled) applySplashImage(root, url, config.bgColor); });
                if (config.imageAssetId && !config.imagePreview) void image.then((url) => (url ? backfillSplashPreview(config.id, url) : undefined));
                timer = window.setTimeout(() => onDoneRef.current(), playback.endMs + HOLD_MS);
            } catch (error) {
                // 哪一步出错都不能让人卡在开屏上
                console.warn("[Splash] 开屏播放失败", error);
                if (!cancelled) onDoneRef.current();
            }
        })();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            playback?.stop();
        };
    }, [plan]);

    const { imageAssetId, imagePreview, bgColor } = plan.config;
    const style = imageAssetId ? (imagePreview ? { backgroundImage: `url("${imagePreview}")` } : undefined) : { backgroundColor: bgColor };
    return <div ref={rootRef} className="splash-stage" style={style} aria-hidden="true" />;
}
