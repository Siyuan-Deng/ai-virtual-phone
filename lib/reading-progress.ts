// lib/reading-progress.ts — 全书进度的唯一口径。
//
// 改这一版之前，同一件事有两套算法并存：
//  · 显示的百分比、存盘的 progressFraction 按「字数加权」算（一本里版权页几十字、
//    正文一万多字，按章数算出来的百分比根本没用）；
//  · 底部进度条却按「第几章 / 共几章」线性铺开，拖动后再反解成「第几章 + 章内比例」。
// 两条线在章节长短不均的书上必然错开：用户拖过没读的章节，滑块位置和百分比各说各话，
// 而且「跳过的部分」在滑块那套里被压成了等分，等于没算进去。
//
// 现在所有换算都走这里：章节字数 → 全书比例 → 反解回「第几章 + 章内比例」。
// 纯函数、不碰 IO，翻页 / 连续滚动 / 书签 / 分享卡片共用同一份。

import type { BookChapter } from "./reading-types";

export type BookPositionIndex = {
    /** 每章真实字符数 */
    lengths: number[];
    /** 计入进度的权重。0 字章节用非空章节的平均字数兜底，见 buildBookPositionIndex */
    weights: number[];
    /** 每章起点在全书中的累计权重 */
    offsets: number[];
    /** 全书总权重 */
    total: number;
    /** 是否真的量到了字数。全 0 时只能退回「按章数等分」的老办法 */
    measured: boolean;
};

export type BookPosition = {
    chapterIndex: number;
    /** 章内比例（0-1） */
    within: number;
};

const clamp01 = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
};

/**
 * 给一本书建立进度换算表。
 *
 * 0 字章节（纯插图章、PDF 懒解析还没跑到的页块、被切坏的章节）不能直接按 0 算：
 * 那样它前面所有章的累计权重加起来会小于真实比例，百分比会在这些章节处「原地跳一下」，
 * 反解时也会把整章塌成一个点。所以按非空章节的平均字数给它们一份权重。
 */
export function buildBookPositionIndex(chapters: BookChapter[]): BookPositionIndex {
    const lengths = chapters.map((chapter) =>
        chapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0),
    );
    const positive = lengths.filter((length) => length > 0);
    const average = positive.length > 0
        ? positive.reduce((sum, length) => sum + length, 0) / positive.length
        : 0;
    const weights = lengths.map((length) => (length > 0 ? length : average));

    const offsets: number[] = new Array(weights.length);
    let acc = 0;
    for (let i = 0; i < weights.length; i += 1) {
        offsets[i] = acc;
        acc += weights[i];
    }

    return { lengths, weights, offsets, total: acc, measured: positive.length > 0 };
}

/** 「第几章 + 章内比例」→ 全书比例（0-1） */
export function chapterToBookFraction(
    chapterIndex: number,
    withinChapter: number,
    index: BookPositionIndex,
): number {
    const count = index.weights.length;
    if (count === 0) return 0;
    const within = clamp01(withinChapter);

    // 量不到字数（整本都是空章节）时退回改动前那套按章数等分，别让进度永远停在 0
    if (!index.measured || index.total <= 0) {
        return clamp01((chapterIndex + within) / count);
    }

    const safeIndex = Math.min(count - 1, Math.max(0, Math.trunc(chapterIndex)));
    const weight = index.weights[safeIndex] ?? 0;
    const offset = index.offsets[safeIndex] ?? 0;
    return clamp01((offset + weight * within) / index.total);
}

/** 全书比例（0-1）→「第几章 + 章内比例」。用于进度条拖动、按百分比定位 */
export function bookFractionToPosition(
    fraction: number,
    index: BookPositionIndex,
): BookPosition {
    const count = index.weights.length;
    if (count === 0) return { chapterIndex: 0, within: 0 };

    if (!index.measured || index.total <= 0) {
        const scaled = clamp01(fraction) * count;
        const chapterIndex = Math.min(count - 1, Math.floor(scaled));
        return { chapterIndex, within: clamp01(scaled - chapterIndex) };
    }

    const target = clamp01(fraction) * index.total;
    // 二分找最后一个 offsets[i] <= target 的章节（offsets 单调不减）
    let low = 0;
    let high = count - 1;
    let found = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (index.offsets[mid] <= target) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const weight = index.weights[found] ?? 0;
    const within = weight > 0 ? clamp01((target - (index.offsets[found] ?? 0)) / weight) : 0;
    return { chapterIndex: found, within };
}

/** 进度条刻度：把 0-1 铺到整数上，滑块与百分比从此是同一个数，不会各说各话。 */
export const BOOK_SLIDER_STEPS = 1000;

export function bookFractionToSliderValue(fraction: number): number {
    return 1 + clamp01(fraction) * BOOK_SLIDER_STEPS;
}

export function sliderValueToBookFraction(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return clamp01((value - 1) / BOOK_SLIDER_STEPS);
}
