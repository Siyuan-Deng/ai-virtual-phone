"use client";

// 打开 App 时放的自定义开屏。背景色先铺上，图片和字体读到再开始播，读得慢也不会看到半成品。

import { useEffect, useRef } from "react";
import { buildSplashStage, playSplashStage, type SplashPlayback } from "@/lib/splash-effects";
import { ensureSplashFonts, type SplashBootPlan } from "@/lib/splash-store";
import { getThemeAssetDataUrl } from "@/lib/theme-storage";

/** 素材最多等这么久，等不到就先播（图片缺了显示背景色） */
const ASSET_WAIT_MS = 1200;
/** 播完再停一下才算结束 */
const HOLD_MS = 800;

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
            const assets = Promise.all([
                plan.config.imageAssetId ? getThemeAssetDataUrl(plan.config.imageAssetId).catch(() => null) : Promise.resolve(null),
                ensureSplashFonts(plan.fonts),
            ]);
            const timeout = new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), ASSET_WAIT_MS); });
            const ready = await Promise.race([assets, timeout]);
            if (cancelled) return;
            buildSplashStage(root, plan.config, ready?.[0] ?? null);
            playback = playSplashStage(root, plan.config);
            timer = window.setTimeout(() => onDoneRef.current(), playback.endMs + HOLD_MS);
        })();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            playback?.stop();
        };
    }, [plan]);

    return <div ref={rootRef} className="splash-stage" style={{ backgroundColor: plan.config.bgColor }} aria-hidden="true" />;
}
