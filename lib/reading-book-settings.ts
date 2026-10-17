"use client";

// lib/reading-book-settings.ts — 「每本书自己的设置」：排版覆盖 + 自定义分章节点。
//
// 为什么单独一份而不是塞进 Book 或全局外观：
//  · 全局外观（设置 → 阅读外观）是「所有书的默认」，而排版（字号/行距/缩进/页边距/对齐）
//    常常这本书要调、那本书不用动——尤其 EPUB 还原原书排版以后，同一套字号在
//    不同书的观感差很远。所以这里给每本书一份「覆盖值」，只填用户动过的项，
//    没填的继续跟随全局。
//  · 分章节点是阅读过程里随手标出来的（划线 → 设置节点），量小、要同步读，
//    和划线一样放 kv，免得为它升 IndexedDB 版本。
//
// 写入后派发 reading-book-settings-changed：阅读器常驻挂载，阅读外观那套
// CSS 变量挂在它上层的 reading-app 里，靠事件让上层重新读一遍覆盖值。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
    READING_FIRST_LINE_INDENT_MAX,
    READING_PAGE_PADDING_MAX,
    type ReadingAppearance,
    type ReadingTextAlign,
} from "./reading-appearance";

/** 这本书自己的排版覆盖。缺的项 = 跟随全局外观。 */
export type ReadingBookTypography = {
    fontSize?: number;
    lineHeight?: number;
    firstLineIndent?: number;
    pagePaddingX?: number;
    textAlign?: ReadingTextAlign;
};

export const READING_BOOK_FONT_SIZE_MIN = 14;
export const READING_BOOK_FONT_SIZE_MAX = 34;
export const READING_BOOK_LINE_HEIGHT_MIN = 1.2;
export const READING_BOOK_LINE_HEIGHT_MAX = 3.2;

/** 一个自定义分章节点：从「第几章第几段」这一段的开头另起一章。
 *  锚点用章号 + 段号（和批注、划线同一套坐标系），所以重新分章后能精确搬过去。 */
export type ReadingSplitNode = {
    id: string;
    chapterIndex: number;
    paragraphIndex: number;
    /** 用户给这一章起的名字；空 = 自动「第N章」 */
    title?: string;
    /** 划线时选中的那句原文，列表里靠它认出是哪儿 */
    quote?: string;
    createdAt: string;
};

export type ReadingSplitMode = "merge" | "only";

export type ReadingBookSettings = {
    typography?: ReadingBookTypography;
    splitNodes?: ReadingSplitNode[];
    /** merge = 在自动目录基础上加节点；only = 只按用户节点切 */
    splitMode?: ReadingSplitMode;
};

const SETTINGS_KEY = "ai_phone_reading_book_settings_v1";
registerKvMigration(SETTINGS_KEY);

export const READING_BOOK_SETTINGS_EVENT = "reading-book-settings-changed";

type SettingsStore = Record<string, ReadingBookSettings>;

function clampNumber(value: unknown, min: number, max: number, digits = 0): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    const clamped = Math.min(max, Math.max(min, parsed));
    const factor = 10 ** digits;
    return Math.round(clamped * factor) / factor;
}

/** 只保留认识且合法的字段。存进来什么脏数据都不该让阅读器崩掉。 */
export function normalizeBookTypography(input: unknown): ReadingBookTypography {
    if (!input || typeof input !== "object") return {};
    const raw = input as Record<string, unknown>;
    const out: ReadingBookTypography = {};
    const fontSize = clampNumber(raw.fontSize, READING_BOOK_FONT_SIZE_MIN, READING_BOOK_FONT_SIZE_MAX);
    if (fontSize !== undefined) out.fontSize = fontSize;
    const lineHeight = clampNumber(raw.lineHeight, READING_BOOK_LINE_HEIGHT_MIN, READING_BOOK_LINE_HEIGHT_MAX, 2);
    if (lineHeight !== undefined) out.lineHeight = lineHeight;
    const indent = clampNumber(raw.firstLineIndent, 0, READING_FIRST_LINE_INDENT_MAX);
    if (indent !== undefined) out.firstLineIndent = indent;
    const padding = clampNumber(raw.pagePaddingX, 0, READING_PAGE_PADDING_MAX);
    if (padding !== undefined) out.pagePaddingX = padding;
    if (raw.textAlign === "justify" || raw.textAlign === "left") out.textAlign = raw.textAlign;
    return out;
}

function loadAll(): SettingsStore {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(SETTINGS_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SettingsStore : {};
    } catch {
        return {};
    }
}

function normalizeNodes(input: unknown): ReadingSplitNode[] {
    if (!Array.isArray(input)) return [];
    const out: ReadingSplitNode[] = [];
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const chapterIndex = Number(raw.chapterIndex);
        const paragraphIndex = Number(raw.paragraphIndex);
        if (!Number.isFinite(chapterIndex) || !Number.isFinite(paragraphIndex)) continue;
        out.push({
            id: typeof raw.id === "string" && raw.id ? raw.id : `sn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            chapterIndex: Math.max(0, Math.trunc(chapterIndex)),
            paragraphIndex: Math.max(0, Math.trunc(paragraphIndex)),
            ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
            ...(typeof raw.quote === "string" && raw.quote ? { quote: raw.quote.slice(0, 80) } : {}),
            createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        });
    }
    // 按书内顺序排好，界面直接用
    return out.sort((a, b) => a.chapterIndex - b.chapterIndex || a.paragraphIndex - b.paragraphIndex);
}

export function loadReadingBookSettings(bookId: string): ReadingBookSettings {
    const raw = loadAll()[bookId];
    if (!raw) return {};
    return {
        typography: normalizeBookTypography(raw.typography),
        splitNodes: normalizeNodes(raw.splitNodes),
        splitMode: raw.splitMode === "only" ? "only" : "merge",
    };
}

export function saveReadingBookSettings(bookId: string, next: ReadingBookSettings): ReadingBookSettings {
    const normalized: ReadingBookSettings = {
        typography: normalizeBookTypography(next.typography),
        splitNodes: normalizeNodes(next.splitNodes),
        splitMode: next.splitMode === "only" ? "only" : "merge",
    };
    if (typeof window !== "undefined") {
        const all = loadAll();
        all[bookId] = normalized;
        kvSet(SETTINGS_KEY, JSON.stringify(all));
        window.dispatchEvent(new CustomEvent(READING_BOOK_SETTINGS_EVENT, { detail: { bookId } }));
    }
    return normalized;
}

/** 只改排版那部分，节点列表原样保留 */
export function saveReadingBookTypography(bookId: string, typography: ReadingBookTypography): ReadingBookSettings {
    const current = loadReadingBookSettings(bookId);
    return saveReadingBookSettings(bookId, { ...current, typography });
}

export function saveReadingSplitNodes(
    bookId: string,
    splitNodes: ReadingSplitNode[],
    splitMode?: ReadingSplitMode,
): ReadingBookSettings {
    const current = loadReadingBookSettings(bookId);
    return saveReadingBookSettings(bookId, {
        ...current,
        splitNodes,
        splitMode: splitMode ?? current.splitMode ?? "merge",
    });
}

export function addReadingSplitNode(bookId: string, node: ReadingSplitNode): ReadingBookSettings {
    const current = loadReadingBookSettings(bookId);
    const nodes = current.splitNodes || [];
    // 同一段上重复设节点没有意义：保留已经存在的那一个（标题以旧的不动，用户可在列表里改）
    const exists = nodes.some((item) => item.chapterIndex === node.chapterIndex && item.paragraphIndex === node.paragraphIndex);
    return saveReadingSplitNodes(bookId, exists ? nodes : [...nodes, node]);
}

export function removeReadingSplitNode(bookId: string, nodeId: string): ReadingBookSettings {
    const current = loadReadingBookSettings(bookId);
    return saveReadingSplitNodes(bookId, (current.splitNodes || []).filter((node) => node.id !== nodeId));
}

export function updateReadingSplitNode(
    bookId: string,
    nodeId: string,
    patch: Partial<Pick<ReadingSplitNode, "title">>,
): ReadingBookSettings {
    const current = loadReadingBookSettings(bookId);
    return saveReadingSplitNodes(
        bookId,
        (current.splitNodes || []).map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    );
}

/** 把这本书的排版覆盖叠到全局外观上，得到「这本书实际生效的那一套」。
 *  只覆盖阅读器真正会读的几项——颜色、字体这些仍然只认全局设置，
 *  否则一本书一套配色，收起来以后很难解释。 */
export function resolveReadingAppearance(appearance: ReadingAppearance, typography?: ReadingBookTypography): ReadingAppearance {
    if (!typography) return appearance;
    const next: ReadingAppearance = { ...appearance };
    if (typography.fontSize !== undefined) next.fontSize = typography.fontSize;
    if (typography.lineHeight !== undefined) next.lineHeight = typography.lineHeight;
    if (typography.firstLineIndent !== undefined) next.firstLineIndent = typography.firstLineIndent;
    if (typography.pagePaddingX !== undefined) next.pagePaddingX = typography.pagePaddingX;
    if (typography.textAlign !== undefined) next.textAlign = typography.textAlign;
    return next;
}

/** 排版覆盖的摘要，用在「更多设置」入口旁边一行说明 */
export function describeBookTypography(typography?: ReadingBookTypography): string {
    if (!typography) return "跟随全局外观";
    const parts: string[] = [];
    if (typography.fontSize !== undefined) parts.push(`${typography.fontSize}px`);
    if (typography.lineHeight !== undefined) parts.push(`行距 ${typography.lineHeight}`);
    if (typography.firstLineIndent !== undefined) parts.push(`缩进 ${typography.firstLineIndent} 字`);
    if (typography.pagePaddingX !== undefined) parts.push(`边距 ${typography.pagePaddingX}px`);
    if (typography.textAlign === "justify") parts.push("两端对齐");
    return parts.length > 0 ? parts.join(" · ") : "跟随全局外观";
}
