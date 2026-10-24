"use client";

// 阅读的文字颜色、全屏背景、背景亮度在各套搭配里的那份，存在搭配的「reading.look」格里（JSON）。
// 背景图存在阅读资源库里，key 记在 JSON 里（复制搭配时两套指着同一张）。字体、字号、行距、批注样式所有搭配共用一份。

import { getNightBinding, listLookSets, nightSlotKeys, setNightBinding } from "./night-mode";
import { deleteReadingAssetsByPrefix, loadReadingAsset, saveReadingAsset } from "./reading-appearance";

const ASSET_PREFIX = "look-bg:";

export type ReadingLook = {
    /** 正文文字颜色；没有就跟随日间 */
    textColor?: string;
    /** 背景亮度；没有就跟随日间 */
    backgroundBrightness?: number;
    /** own：这套单独一张背景图；none：这套不要背景图；没有就跟随日间 */
    background?: "own" | "none";
    /** own 时那张图在阅读资源库里的 key */
    backgroundAsset?: string;
};

export function loadReadingLook(setId: string): ReadingLook | null {
    const binding = getNightBinding(nightSlotKeys.readingLook, setId);
    if (binding?.kind !== "own") return null;
    try {
        const parsed = JSON.parse(binding.value) as ReadingLook;
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** 存一套的文字颜色和背景。backgroundFile：这套换了新背景图。哪套都不用了的旧图顺手删掉 */
export async function saveReadingLook(setId: string, look: ReadingLook, backgroundFile?: Blob | null): Promise<void> {
    let backgroundAsset = look.background === "own" ? look.backgroundAsset : undefined;
    if (backgroundFile) {
        backgroundAsset = `${ASSET_PREFIX}${setId}:${Date.now().toString(36)}`;
        await saveReadingAsset(backgroundAsset, backgroundFile);
    }
    const background = backgroundFile ? "own" : look.background;
    const cleaned: ReadingLook = {
        ...(look.textColor ? { textColor: look.textColor } : {}),
        ...(look.backgroundBrightness !== undefined ? { backgroundBrightness: look.backgroundBrightness } : {}),
        ...(background ? { background } : {}),
        ...(background === "own" && backgroundAsset ? { backgroundAsset } : {}),
    };
    setNightBinding(nightSlotKeys.readingLook, Object.keys(cleaned).length ? { kind: "own", value: JSON.stringify(cleaned) } : null, setId);
    const used = new Set(listLookSets().map((set) => loadReadingLook(set.id)?.backgroundAsset).filter(Boolean));
    await deleteReadingAssetsByPrefix(ASSET_PREFIX, (key) => used.has(key));
}

export async function loadReadingLookBackground(look: ReadingLook | null): Promise<Blob | null> {
    if (look?.background !== "own" || !look.backgroundAsset) return null;
    return loadReadingAsset(look.backgroundAsset);
}
