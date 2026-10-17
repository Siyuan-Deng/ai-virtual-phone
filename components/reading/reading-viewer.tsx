"use client";

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Highlighter, Languages, Menu, Minus, PenLine, Rocket, SendHorizontal, X, ZoomIn } from "lucide-react";
import {
    loadChapters,
    loadProgress,
    saveProgress,
    loadAnnotations,
    saveAnnotations,
    saveAnnotation,
    deleteAnnotation,
    saveChapters,
    loadRawFileBlob,
    updateBook,
    loadReadingInteractionConfig,
    saveReadingInteractionConfig,
    loadBookmarks,
    saveBookmark,
    deleteBookmark,
    DEFAULT_READING_INTERACTION_CONFIG,
} from "@/lib/reading-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { loadReadingMarks, saveReadingMark, deleteReadingMark, readingMarkGroup, readingMarkGroupId } from "@/lib/reading-marks";
import {
    appendReadingAnnotationMemos,
    deleteReadingAnnotationMemo,
    loadReadingSummaryMemos,
    updateReadingAnnotationMemoContent,
    type ReadingAnnotationMemo,
} from "@/lib/reading-memory";
import { annotationExportFileName, buildAnnotationMarkdown } from "@/lib/reading-export";
import { downloadFile } from "@/lib/download-utils";
import { collectSelectionSegments, type ReadingSelectionSegment } from "./reading-selection";
import { isUserAnnotation, type ReadingBookmark, type ReadingMark, type ReadingMarkStyle } from "@/lib/reading-types";
import { generateAnnotationBatch, generateReadingChat, parseReadingDiscussResponse, summarizeReadingRange, type ReadingDiscussAction, type ReadingDiscussContext } from "@/lib/reading-engine";
import { loadChatMessages, pushChatMessage, deleteChatMessage, editChatMessage, loadChatContacts, createOrGetSession, isReadingDiscussMessage } from "@/lib/chat-storage";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ContentDialog } from "@/components/ui/modal";
import { Select, Toggle } from "@/components/ui/form";
import { PdfPageRenderer } from "./reading-pdf-viewer";
import { ReadingShareDialog } from "./reading-share-dialog";
import { decodeTxtArrayBuffer, parsePdfPageRange, PDF_PAGES_PER_CHAPTER, parseTxtContent, parseEpubFile, parseMobiFile } from "@/lib/reading-parser";
import type { Book, BookChapter, ReadingAnnotation, ReadingProgress, ReadingBlockStyle, ReadingInlineSpan } from "@/lib/reading-types";
import type { Character } from "@/lib/character-types";
import { splitBilingualText } from "@/lib/bilingual-text";
import {
    parseReadingImageMarker,
    readingImageAssetKey,
    type ReadingImageRef,
} from "@/lib/reading-inline-image";
import { loadReadingAsset, loadReadingAssets } from "@/lib/reading-appearance";
import {
    BOOK_SLIDER_STEPS,
    bookFractionToPosition,
    bookFractionToSliderValue,
    buildBookPositionIndex,
    chapterToBookFraction,
    sliderValueToBookFraction,
} from "@/lib/reading-progress";
import { ReadingBookSettings } from "./reading-book-settings";
import {
    addReadingSplitNode,
    loadReadingBookSettings,
    READING_BOOK_SETTINGS_EVENT,
    type ReadingSplitNode,
} from "@/lib/reading-book-settings";

/** 一行要用的原书排版信息；只在「还原原书排版」开着、且这本书带样式数据时才有值。 */
type LineBlockStyle = {
    /** 字号倍率（相对全局字号） */
    scale: number;
    align?: "center" | "right";
    bold: boolean;
    italic: boolean;
    quote: boolean;
    footnote: boolean;
    /** 首行缩进几个字（滚动模式靠它决定要不要缩进） */
    indentChars: number;
    /** 段内行内样式区间（加粗/斜体/下划线/上下标）；下标相对整段文字的位置 */
    spans: ReadingInlineSpan[] | null;
};

type TxtPageItem =
    | {
        kind: "line";
        text: string;
        chapterIndex: number;
        paragraphIndex: number;
        indent?: boolean;
        segEnd?: boolean;
        charStart?: number;
        /** 这一行占多高（px）。还原原书排版时逐行不同（标题比正文大），分页按它累计 */
        lineHeight?: number;
        block?: LineBlockStyle;
        /** 这一行里的行内小图（脚注角标之类），按出现顺序给出插图序号 */
        inlineImages?: number[];
        /** 这一行是段落的最后一行、而这一段有批注时给：批注条数与是否已展开。
         *  收起时正文里只在段末画一个 💬 图标，点开才在段下展开批注卡片。 */
        annotationCount?: number;
        annotationsExpanded?: boolean;
    }
    | { kind: "gap"; chapterIndex: number; paragraphIndex: number; height?: number }
    | { kind: "image"; image: ReadingImageRef; chapterIndex: number; paragraphIndex: number }
    | { kind: "annotation"; annotation: ReadingAnnotation; chapterIndex: number; paragraphIndex: number };

/** 菜单半宽，避免贴着某个点算出来的位置把菜单顶出屏幕 */
const MENU_HALF_WIDTH = 96;

function clampMenuX(centerX: number, width: number): number {
    return Math.min(Math.max(centerX, MENU_HALF_WIDTH), Math.max(MENU_HALF_WIDTH, width - MENU_HALF_WIDTH));
}

/** iOS 的 Copy / Look Up 条出现在选区上方还是下方，UIKit 没有公开规则，
 *  实测同一本书里两种都出现过，跟着选区放就一定有撞上的时候。
 *  但它永远「紧贴选区」，所以我们去离选区最远的那一端：
 *  选区在上半屏就把菜单钉在页脚上方，在下半屏就钉在页眉下方，两者不可能重合。 */
function selectionMenuStyle(placeAtTop: boolean, topOffset: number, footerHeight: number): React.CSSProperties {
    if (placeAtTop) return { top: `${topOffset}px`, left: "50%", transform: "translateX(-50%)" };
    return { bottom: `${footerHeight + 12}px`, left: "50%", transform: "translateX(-50%)" };
}

type ParagraphRef = {
    absoluteIndex: number;
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
    pageNum?: number;
    yRatio?: number;
};

type AnnotationBatchRequest = {
    key: string;
    title: string;
    size: number;
    items: ParagraphRef[];
};

type AnnotationDialogMode = "manual" | "auto";
type AnnotationBatchMode = AnnotationDialogMode | "auto-current";

const DISCUSS_TARGET_CHARS = 1000;
const DISCUSS_MIN_CHARS = 700;
const DISCUSS_MAX_CHARS = 1600;
const DISCUSS_MAX_PARAGRAPHS = 16;
const MAX_MANUAL_PDF_PREFETCH_PAGES = 30;

/** 聊天悬浮球/悬浮条/悬浮窗的位置记忆键 */
const CHAT_FLOAT_POS_KEY = "reading-chat-float-pos-v1";
const CHAT_FLOAT_MARGIN = 12;

function toCanvasFont(style: CSSStyleDeclaration): string {
    return [
        style.fontStyle,
        style.fontVariant,
        style.fontWeight,
        style.fontSize,
        style.fontFamily,
    ].join(" ");
}

function formatParagraphRangeLabel(start: number, end: number): string {
    return start === end ? `第${start + 1}段` : `第${start + 1}-${end + 1}段`;
}

function getParagraphLength(text: string): number {
    return text.replace(/\s+/g, "").length || text.trim().length;
}

/** 静默重试：生成失败时按用户配置的次数重试，重试间隔逐渐加大，全部失败后抛出最后一次错误 */
async function withAnnotationRetry<T>(task: () => Promise<T>, retryCount: number): Promise<T> {
    const maxAttempts = Math.max(1, retryCount + 1);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await task();
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts) break;
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1200, 400 * attempt)));
        }
    }
    throw lastError;
}

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

function buildParagraphRefsFromChapters(chapters: BookChapter[]): ParagraphRef[] {
    const refs: ParagraphRef[] = chapters.flatMap((chapter, currentChapterIndex) =>
        chapter.paragraphs.flatMap((text, paragraphIndex) => (
            // 插图占位不是正文，不该出现在给模型的段落里，也不该被批注
            parseReadingImageMarker(text) ? [] : [{
            absoluteIndex: 0,
            chapterIndex: currentChapterIndex,
            paragraphIndex,
            text,
            pageNum: chapter.paragraphPages?.[paragraphIndex],
            yRatio: chapter.paragraphYPositions?.[paragraphIndex],
        }]
        )),
    );

    for (let i = 0; i < refs.length; i += 1) {
        refs[i].absoluteIndex = i;
    }

    return refs;
}

function trimTrailingGaps(items: TxtPageItem[]): TxtPageItem[] {
    let end = items.length;
    while (end > 0 && items[end - 1]?.kind === "gap") end -= 1;
    return items.slice(0, end);
}

/** 行内小图的占位字符（与 lib/reading-parser.ts 的 INLINE_IMAGE_CHAR 一致）。
 *  正文里它占一个字符位，渲染时变成一个 1em 高的小图 + 一个零宽空格。 */
const INLINE_IMAGE_CHAR = "\uFFFC";

/** 行内小图的对齐样式。EPUB 里那些嵌在句子里的脚注角标 / 装饰符用它。
 *
 *  这里踩过两个坑，两条都必须照现在这样写：
 *  ① 外层不能定高、里面也不能放 display:block 的图。原来的写法是「外层 span 定高 1em，
 *     里面排 零宽空格 + block 图」：零宽空格先占掉一行（行高 1em），块级图再往下一格，
 *     盒子却只有 1em 高，图被顶出盒子——看起来就是整张小图往下掉了大半行。
 *     现在让 img 自己当 inline-block，零宽空格排在它后面当文本基线，不再产生额外行盒。
 *  ② 必须写 vertical-align: middle。缺了它图片按基线对齐，底边压在文字基线上，
 *     同样显得偏低。middle 让图和同一行的文字上下居中。
 *
 *  高度锁在 1em 内、宽度按原比例并留一点上限，免得一张宽图把整行顶出去——
 *  分页那边是按「一个字宽」估算这个占位的（见 wrapTextToLines 的 symbolWidth）。 */
const INLINE_IMAGE_IMG_STYLE: CSSProperties = {
    display: "inline-block",
    verticalAlign: "middle",
    height: "1em",
    width: "auto",
    maxWidth: "1.4em",
    objectFit: "contain",
    padding: "0 0.04em",
};

/** 包住行内小图的外层。只当「一个字符位的容器」，不参与排版决策：
 *  display 固定 inline，绝不 block（否则就是整行一张图那个老问题）。 */
const INLINE_IMAGE_WRAPPER_STYLE: CSSProperties = {
    display: "inline",
};

/** 段末那个「💬」图标。自己画 SVG 而不是塞 emoji 文本：
 *  emoji 在安卓各家字体里大小和基线差别很大；更重要的是它会被算进这一行的
 *  textContent 长度，而选区偏移正是按 textContent 换算的（reading-selection.ts），
 *  多出一个字，这一行后面的划线和批注就会整体错位。SVG 不产生文本节点。 */
function AnnotationBubbleIcon({ filled }: { filled: boolean }) {
    return (
        <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9.1 9.1 0 0 1-3.9-.86L4 20.5l1.5-4.2A8.2 8.2 0 0 1 4.5 11.5 8.4 8.4 0 0 1 13 3.1a8.4 8.4 0 0 1 8 8.4Z" />
        </svg>
    );
}

/** 段末批注图标的样式。尺寸用 em 跟着正文走；vertical-align: middle 让它和同一行
 *  的文字上下居中。高度 1.05em 小于一行（行距通常 2 左右），所以不会把行撑高——
 *  分页量的是 .reading-line 的 line-height，行高不变，分页就不会算错。 */
const ANNOTATION_BUBBLE_STYLE: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.05em",
    height: "1.05em",
    margin: "0 0.16em",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--reading-warm-brown, #a9764a)",
    opacity: 0.82,
    verticalAlign: "middle",
    lineHeight: 1,
    cursor: "pointer",
};

function countInlineImageChars(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) if (text[i] === INLINE_IMAGE_CHAR) count += 1;
    return count;
}

/** 逐字宽度缓存。分页要为整章每个字量一次宽，而 canvas 量一次宽要走完整套字体
 *  shaping；同一个字在书里会反复出现，缓存能把分页开销压掉一大截。
 *  键用「度量时的 ctx.font 规范化结果 + 字符」——直接取 ctx.font，调用方传进来的
 *  字体串写法和浏览器规范化后的写法不一致时也不会让缓存串味。
 *  上限只是防失控：几种字重 × 几千个常用汉字，正常远到不了。 */
const CHAR_WIDTH_CACHE_LIMIT = 24000;
const charWidthCache = new Map<string, number>();

function measureCharWidth(ctx: CanvasRenderingContext2D, char: string): number {
    const key = `${ctx.font}\u0000${char}`;
    const cached = charWidthCache.get(key);
    if (cached !== undefined) return cached;
    const width = ctx.measureText(char).width;
    if (charWidthCache.size >= CHAR_WIDTH_CACHE_LIMIT) charWidthCache.clear();
    charWidthCache.set(key, width);
    return width;
}

/** 逐字折行（单一字体）。调用前必须先把 ctx.font 设成要用的字体——量宽走缓存，
 *  字体没设对会一路量错。不丢字符：各行拼接严格等于原文，
 *  字符游标（荧光笔/划线的定位）就建立在「拼接等于原文」这个前提上。 */
function wrapTextToLines(
    text: string,
    maxWidth: number,
    ctx: CanvasRenderingContext2D,
    firstLineOffset = 0,
    /** 行内小图占位字符按多宽算（0 = 按常量量）。渲染时小图被限制在一个字符高，
     *  宽度按原图比例；这里按一个字宽估，最多差半个字，不会让某页明显溢出。 */
    symbolWidth = 0,
): string[] {
    if (!text) return [""];

    const lines: string[] = [];
    let current = "";
    let lineIndex = 0;
    let width = 0;

    for (const char of Array.from(text)) {
        const charWidth = char === INLINE_IMAGE_CHAR && symbolWidth > 0
            ? symbolWidth
            : measureCharWidth(ctx, char);
        const lineLimit = lineIndex === 0 ? Math.max(1, maxWidth - firstLineOffset) : maxWidth;
        if (current && width + charWidth > lineLimit) {
            lines.push(current);
            current = char;
            width = charWidth;
            lineIndex += 1;
        } else {
            current += char;
            width += charWidth;
        }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

/** 引用块的左内缩（含左侧竖线的宽度）。分页按它收窄正文宽度，
 *  CSS 里 padding-left + border-left 必须等于同一个数，否则排版和渲染会对不上。
 *  导出去给 reading-app 注入样式用，避免两处各写一个数。 */
export const QUOTE_INSET_PX = 21;
/** 中文书的首行缩进档位：原书没给缩进信息时，沿用改动前的「缩进两个字」。 */
const DEFAULT_BLOCK_INDENT = 2;

/** 字体一致的一段文字。行内加粗/斜体让同一行里出现多种字体。
 *
 *  为什么按片段而不是逐字换字体：`ctx.font` 赋值是 canvas 里最贵的操作之一
 *  （每次都要重新解析字体简写并切换 shaping 上下文），逐字改会把整章分页
 *  拖慢一个数量级。切成片段后，字体只在片段边界变一次。 */
type FontRun = { text: string; font: string };

/** 按片段折行：ctx.font 只在片段变化时设置，逐字量宽走缓存。
 *  同样保证不丢字符——各行拼接等于所有片段文本拼接。 */
function wrapFontRunsToLines(
    runs: FontRun[],
    maxWidth: number,
    ctx: CanvasRenderingContext2D,
    firstLineOffset: number,
    symbolWidth = 0,
): string[] {
    const lines: string[] = [];
    let current = "";
    let lineIndex = 0;
    let width = 0;

    for (const run of runs) {
        ctx.font = run.font;
        for (const char of Array.from(run.text)) {
            const charWidth = char === INLINE_IMAGE_CHAR && symbolWidth > 0
                ? symbolWidth
                : measureCharWidth(ctx, char);
            const limit = lineIndex === 0 ? Math.max(1, maxWidth - firstLineOffset) : maxWidth;
            if (current && width + charWidth > limit) {
                lines.push(current);
                current = char;
                width = charWidth;
                lineIndex += 1;
            } else {
                current += char;
                width += charWidth;
            }
        }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

/** 把一段文字切成「字体一致的片段」。
 *  @param offset 这一段在整段文字里的起始位置（段落被 \n 拆开后的第 n 段）；
 *                spans 是按整段文字的下标存的，要减掉它才对得上。
 *  只用于量宽，不参与渲染：片段不改动任何字符。 */
function buildEmphasisRuns(
    text: string,
    spans: ReadingInlineSpan[] | null,
    offset: number,
    baseFont: string,
    parts: { style: string; variant: string; weight: string; family: string },
    metrics: Pick<BlockMetrics, "fontSize" | "bold" | "italic">,
): FontRun[] {
    const length = text.length;
    if (length === 0) return [];

    // 1 = 加粗，2 = 斜体，可叠加。先铺一张逐字符标记表，
    // 免得后面每走一个字都把整份 spans 扫一遍（那是 O(字数 × 片段数)）。
    let flags: Uint8Array | null = null;
    if (spans && spans.length > 0) {
        for (const span of spans) {
            if (!span.bold && !span.italic) continue;
            const from = Math.max(0, span.start - offset);
            const to = Math.min(length, span.end - offset);
            if (to <= from) continue;
            if (!flags) flags = new Uint8Array(length);
            for (let i = from; i < to; i += 1) {
                flags[i] |= (span.bold ? 1 : 0) | (span.italic ? 2 : 0);
            }
        }
    }

    const fontForFlags = (value: number) => {
        const bold = metrics.bold || (value & 1) !== 0;
        const italic = metrics.italic || (value & 2) !== 0;
        // 这一段的基准字体（含整段加粗/斜体）就是 baseFont，没有额外强调时直接复用
        if (!bold && !italic) return baseFont;
        return canvasFontFor({ fontSize: metrics.fontSize, bold, italic }, parts);
    };

    const runs: FontRun[] = [];
    let runStart = 0;
    let runFlags = flags ? flags[0] : 0;
    for (let i = 1; i < length; i += 1) {
        const next = flags ? flags[i] : 0;
        if (next === runFlags) continue;
        runs.push({ text: text.slice(runStart, i), font: fontForFlags(runFlags) });
        runStart = i;
        runFlags = next;
    }
    runs.push({ text: text.slice(runStart), font: fontForFlags(runFlags) });
    return runs;
}

/** 一行的排版参数（px 全部按当前字号/行距算好，分页与渲染共用同一套数）。 */
type BlockMetrics = {
    fontSize: number;
    lineHeight: number;
    scale: number;
    bold: boolean;
    italic: boolean;
    /** 首行缩进几个字；0 = 不缩进 */
    indentChars: number;
    quote: boolean;
    footnote: boolean;
    align?: "center" | "right";
};

/** 原书标题级别 → 字号倍率。h1 最大，h5/h6 基本等于正文（原书里它们常靠加粗区分）。 */
function blockScaleFor(style: ReadingBlockStyle | null): number {
    if (!style) return 1;
    if (style.heading) {
        const scales = [1.55, 1.32, 1.18, 1.1, 1.02, 1.02];
        return scales[Math.min(scales.length - 1, Math.max(0, style.heading - 1))];
    }
    if (style.epigraph) return 0.94;
    if (style.quote) return 0.96;
    if (style.footnote) return 0.82;
    return 1;
}

/** 把一个块的语义样式翻成排版参数。
 *  没样式（null）= 用改动前那套：首行缩进两字、字号行距跟随全局设置。 */
function resolveBlockMetrics(
    style: ReadingBlockStyle | null,
    baseFontSize: number,
    baseLineHeight: number,
    /** 原书没给缩进信息时用的档位（来自外观设置）。缺省沿用老规矩：两个全角字。 */
    defaultIndent = DEFAULT_BLOCK_INDENT,
): BlockMetrics {
    const scale = blockScaleFor(style);
    const centering = style?.align ?? (style?.epigraph ? "center" : undefined);
    // 居中/右对齐、引用、题记、脚注、标题都不带首行缩进（原书里它们本来就不缩）
    const noIndent = Boolean(style?.align || style?.heading || style?.quote || style?.epigraph || style?.footnote);
    return {
        fontSize: baseFontSize * scale,
        lineHeight: baseLineHeight * scale,
        scale,
        bold: style?.bold ?? Boolean(style?.heading),
        italic: style?.italic ?? false,
        indentChars: noIndent ? 0 : (style?.indent ?? defaultIndent),
        quote: Boolean(style?.quote),
        footnote: Boolean(style?.footnote),
        ...(centering ? { align: centering } : {}),
    };
}

/** 两段之间留多少空白。还原原书排版时按块的角色给：
 *  标题上下留白最大、缩进段落贴紧（段落靠缩进区分）、没缩进的段落沿用原来的段间距。 */
function blockGapHeight(prev: BlockMetrics, next: BlockMetrics, fallbackGap: number): number {
    if (next.align === "center" && next.scale < 1) return Math.round(next.lineHeight * 0.5);
    if (next.quote) return Math.round(next.lineHeight * 0.45);
    if (next.footnote && !prev.footnote) return Math.round(next.lineHeight * 1.1);
    if (prev.footnote && !next.footnote) return Math.round(next.lineHeight * 0.9);
    if (next.scale > 1) return Math.round(next.lineHeight * 0.75);
    if (prev.scale > 1) return Math.round(prev.lineHeight * 0.55);
    return next.indentChars > 0 ? Math.round(next.lineHeight * 0.42) : fallbackGap;
}

/** 按块的排版参数拼 canvas 字体串，量宽必须和渲染用的是同一套字。 */
function canvasFontFor(
    metrics: Pick<BlockMetrics, "fontSize" | "bold" | "italic">,
    parts: { style: string; variant: string; weight: string; family: string },
): string {
    return [
        metrics.italic ? "italic" : parts.style,
        parts.variant,
        metrics.bold ? "700" : parts.weight,
        `${metrics.fontSize}px`,
        parts.family,
    ].join(" ");
}

function ReadingLoadingView({
    title,
    subtitle,
    compact = false,
    overlay = false,
}: {
    title: string;
    subtitle: string;
    compact?: boolean;
    overlay?: boolean;
}) {
    return (
        <div
            className={`reading-loading-view${compact ? " reading-loading-view--compact" : ""}${overlay ? " reading-loading-view--overlay" : ""}`}
            data-no-nav="true"
        >
            <div className="reading-loading-mark" aria-hidden="true">
                <span className="reading-loading-page reading-loading-page--back" />
                <span className="reading-loading-page reading-loading-page--middle" />
                <span className="reading-loading-page reading-loading-page--front" />
            </div>
            <div className="reading-loading-copy">
                <span className="reading-loading-title">
                    {title}
                    <span className="reading-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <span className="reading-loading-subtitle">{subtitle}</span>
            </div>
            <div className="reading-loading-lines" aria-hidden="true">
                <span />
                <span />
                <span />
            </div>
        </div>
    );
}

function ReadingAnnotationContent({
    text,
    bilingualEnabled,
    expanded,
    onToggle,
}: {
    text: string;
    bilingualEnabled: boolean;
    expanded: boolean;
    onToggle: () => void;
}) {
    const bilingual = bilingualEnabled ? splitBilingualText(text) : null;
    if (!bilingual) {
        return <div className="reading-annotation-text">{text}</div>;
    }

    return (
        <div className="reading-annotation-text">
            <div>{bilingual.original}</div>
            <button
                type="button"
                className="chat-bilingual-toggle reading-annotation-bilingual-toggle"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onPointerCancel={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                aria-expanded={expanded}
            >
                {expanded ? "收起中文" : "中文"}
            </button>
            {expanded && <div className="reading-annotation-translation">{bilingual.translated}</div>}
        </div>
    );
}

type Props = {
    book: Book;
    /** 正文字体 / 字号 / 行距的指纹。变了就得重排——翻页模式的断行是按当时的
     *  字体量出来的，阅读器返回书架时又不卸载，不重排就会用旧字体的断行位置。 */
    appearanceKey?: string;
    /** 正文首行缩进字数（阅读外观设置）。分页断行和滚动模式的逐段缩进都读它，
     *  与根节点的 --reading-block-indent 是同一个来源，不接受第二套数字。 */
    firstLineIndent?: number;
    onBack: () => void;
};

export function ReadingViewer({ book, appearanceKey, firstLineIndent, onBack }: Props) {
    const isPdf = book.format === "pdf";
    const [readingConfig, setReadingConfig] = useState(() => loadReadingInteractionConfig());
    // 阅读器保持挂载（返回书架不卸载），书架设置页保存后通过事件同步最新配置
    useEffect(() => {
        const reload = () => setReadingConfig(loadReadingInteractionConfig());
        window.addEventListener("reading-interaction-config-changed", reload);
        return () => window.removeEventListener("reading-interaction-config-changed", reload);
    }, []);
    const [chapters, setChapters] = useState<BookChapter[]>([]);
    const [chapterIndex, setChapterIndex] = useState(0);
    const [pdfCurrentPage, setPdfCurrentPage] = useState(1);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);
    const [txtPage, setTxtPage] = useState(0);
    const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([]);
    const [generating, setGenerating] = useState(false);
    const [companionId, setCompanionId] = useState<string | null>(null);
    const [marks, setMarks] = useState<ReadingMark[]>([]);
    /** 插图序号 → objectURL。只为当前正在显示的章节加载，读到哪加载到哪 */
    const [inlineImageUrls, setInlineImageUrls] = useState<Record<number, string>>({});
    /** 与 inlineImageUrls 同步的镜像：插图加载是异步的，判定「这张已经取过了」
     *  要读当下的值，闭包里拿 state 会读到过期的那一份，导致重复取库。 */
    const inlineImageUrlsRef = useRef<Record<number, string>>({});
    useEffect(() => { inlineImageUrlsRef.current = inlineImageUrls; }, [inlineImageUrls]);
    const [selectionInfo, setSelectionInfo] = useState<
        {
            text: string;
            /** 划选覆盖的每一段。跨段划选时不止一条，按阅读顺序排好 */
            segments: ReadingSelectionSegment[];
            /** 菜单落点：系统菜单永远紧贴选区，所以我们去屏幕另一端 */
            placeAtTop: boolean; topOffset: number;
        } | null
    >(null);
    /** 点到已有的荧光笔/划线时弹出的删除菜单 */
    const [markMenu, setMarkMenu] = useState<{ mark: ReadingMark; x: number; y: number } | null>(null);
    const [shareTarget, setShareTarget] = useState<ReadingMark[] | null>(null);
    /** 选字菜单要停在页脚正上方，页脚高度随安全区/字号变，量出来最稳 */
    const footerRef = useRef<HTMLElement | null>(null);
    const headerRef = useRef<HTMLElement | null>(null);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const [footerHeight, setFooterHeight] = useState(96);
    const [showMyAnnotation, setShowMyAnnotation] = useState(false);
    const [showCharAnnotationMenu, setShowCharAnnotationMenu] = useState(false);
    const [showMyMarksPanel, setShowMyMarksPanel] = useState(false);
    const [exportNote, setExportNote] = useState("");
    /** 面板里按章折叠要看全书；页面渲染用的 annotations 只覆盖读过的章节，两者分开 */
    const [panelAnnotations, setPanelAnnotations] = useState<ReadingAnnotation[]>([]);
    const [summaryMemos, setSummaryMemos] = useState<ReadingAnnotationMemo[]>([]);
    const [showRangeSummary, setShowRangeSummary] = useState(false);
    const [summaryRange, setSummaryRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    const [summaryDraft, setSummaryDraft] = useState("");
    const [summaryLabel, setSummaryLabel] = useState("");
    const [summaryBusy, setSummaryBusy] = useState(false);
    const [summaryNote, setSummaryNote] = useState("");
    const [pendingQuote, setPendingQuote] = useState<
        { text: string; chapterIndex: number; paragraphIndex: number } | null
    >(null);
    const [myAnnotationText, setMyAnnotationText] = useState("");
    const [immersive, setImmersive] = useState(true);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [charPickerClosing, setCharPickerClosing] = useState(false);
    const closeCharPicker = useCallback(() => {
        if (!showCharPicker || charPickerClosing) return;
        setCharPickerClosing(true);
        setTimeout(() => { setShowCharPicker(false); setCharPickerClosing(false); }, 180);
    }, [showCharPicker, charPickerClosing]);
    const [showChat, setShowChat] = useState(false);
    const [chatExpanded, setChatExpanded] = useState(false);
    const [chatOffset, setChatOffset] = useState<{ x: number; y: number }>(() => {
        try {
            const raw = localStorage.getItem(CHAT_FLOAT_POS_KEY);
            if (!raw) return { x: 0, y: 0 };
            const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
            if (typeof parsed.x === "number" && typeof parsed.y === "number" && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                return { x: parsed.x, y: parsed.y };
            }
        } catch {
            // ignore storage errors
        }
        return { x: 0, y: 0 };
    });
    const [isDragging, setIsDragging] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatting, setChatting] = useState(false);
    const [autoAnnotate, setAutoAnnotate] = useState(false);
    const [annotationBatchSize, setAnnotationBatchSize] = useState(isPdf ? 5 : 50);
    const [annotationBatchInput, setAnnotationBatchInput] = useState(String(isPdf ? 5 : 50));
    const [annotationDialogMode, setAnnotationDialogMode] = useState<AnnotationDialogMode | null>(null);
    const [showReadingSettings, setShowReadingSettings] = useState(false);
    const [showTranslationDialog, setShowTranslationDialog] = useState(false);
    const [pdfRenderDraft, setPdfRenderDraft] = useState(() => ({
        pdfZoom: readingConfig.pdfZoom ?? 1,
        pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
        pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
    }));
    const [showNavigationDialog, setShowNavigationDialog] = useState(false);
    /** 本书「更多设置」：正文排版 + 自定义章节目录 + 章节重命名。
     *  分章节点本身不在这里设，而是在正文里划线、点菜单里的「设置节点」标出来。 */
    const [showBookSettings, setShowBookSettings] = useState(false);
    /** 这本书标出来的分章节点（锚点是章号 + 段号） */
    const [splitNodes, setSplitNodes] = useState<ReadingSplitNode[]>([]);
    /** 设置完节点的一次性提示 */
    const [splitNodeNote, setSplitNodeNote] = useState("");
    /** 已展开批注的段落（`章:段`）。收起时正文里只有一个 💬 图标 */
    const [expandedAnnotationParagraphs, setExpandedAnnotationParagraphs] = useState<string[]>([]);
    const [bookmarks, setBookmarks] = useState<ReadingBookmark[]>([]);
    const [showBookmarks, setShowBookmarks] = useState(false);
    const [pdfJumpPage, setPdfJumpPage] = useState<number | undefined>(undefined);
    /** PDF 手动预批注对话框：自定义起始页/结束页，确认后立即预解析并预生成该范围批注 */
    const [pdfPrefetchDialogOpen, setPdfPrefetchDialogOpen] = useState(false);
    const [pdfPrefetchStartInput, setPdfPrefetchStartInput] = useState("");
    const [pdfPrefetchEndInput, setPdfPrefetchEndInput] = useState("");
    const [chaptersLoaded, setChaptersLoaded] = useState(false);
    const touchStartRef = useRef({ x: 0, y: 0 });
    const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
    const [readingMessageMenu, setReadingMessageMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
    const [editingDiscussMessage, setEditingDiscussMessage] = useState<ChatMessage | null>(null);
    const [editingDiscussContent, setEditingDiscussContent] = useState("");
    const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
    /** 正在手动编辑的批注（自己写的和角色写的都能改） */
    const [editingAnnotation, setEditingAnnotation] = useState<ReadingAnnotation | null>(null);
    const [editingText, setEditingText] = useState("");
    const [annotationTranslationOverrides, setAnnotationTranslationOverrides] = useState<Record<string, boolean>>({});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const readingMessagePressStartRef = useRef<{ x: number; y: number } | null>(null);
    const chatDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const chatMovedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const chatListRef = useRef<HTMLDivElement>(null); // 共读讨论悬浮窗消息列表（滚动容器）
    const txtMeasureLineRef = useRef<HTMLParagraphElement>(null);
    const txtMeasureGapRef = useRef<HTMLDivElement>(null);
    const txtMeasureAnnotationRef = useRef<HTMLDivElement>(null);
    const generatedBatchesRef = useRef<Set<string>>(new Set());
    /** 同步「生成中」锁：防止 auto/prefetch 竞态导致同一帧内并发发起多个批注生成任务 */
    const annotationInFlightRef = useRef(false);
    /** 正在生成中的批次 key：防止同一批在生成完成前被再次发起 */
    const inFlightBatchesRef = useRef<Set<string>>(new Set());
    const pendingTxtPageFractionRef = useRef<number | null>(null);
    const lastTxtPaginationSignatureRef = useRef("");
    // 滚动阅读模式：连续滚动（多章窗口无缝衔接）
    const scrollFractionRef = useRef(0);
    /** 上一次真正提交给渲染的滚动比例，见 commitScrollFraction */
    const committedScrollFractionRef = useRef(0);
    const initialScrollFractionRef = useRef<number | null>(null); // 打开书时保存的章节内比例
    const pendingScrollFractionRef = useRef<number | null>(null); // 滑块跨章待定位比例
    const scrollContentRef = useRef<HTMLDivElement>(null);        // 滚动内容容器（含多章块）
    const chapterMetricsRef = useRef<Map<number, { top: number; height: number }>>(new Map()); // 各章块在滚动坐标系中的 top/height
    const pendingScrollActionRef = useRef<{ kind: "shift-forward"; oldScrollTop: number; removedHeight: number } | { kind: "shift-backward"; oldScrollTop: number } | null>(null);
    const shiftCooldownRef = useRef(false);                      // 窗口平移后的冷却期，防止边界来回抖动
    const scrollPositionedKeyRef = useRef("");                   // 已做过初始定位的「书+模式」标识
    const chapterIndexRef = useRef(0);
    const chaptersLenRef = useRef(0);
    const [txtLayoutVersion, setTxtLayoutVersion] = useState(0);
    // 外观改了就重排一次。分页那个 effect 已经把 txtLayoutVersion 列进依赖，
    // 这里只负责把「字体变了」这件事翻译成它认识的信号。
    useEffect(() => {
        setTxtLayoutVersion((version) => version + 1);
    }, [appearanceKey]);
    const [txtPages, setTxtPages] = useState<TxtPageItem[][]>([]);
    /** 一页能放下的高度，同时用来限制插图的最大高度（翻页模式） */
    const [imageMaxHeight, setImageMaxHeight] = useState(0);
    const [scrollFraction, setScrollFraction] = useState(0);
    const [flipAnim, setFlipAnim] = useState<{ direction: 'forward' | 'backward'; items: TxtPageItem[] } | null>(null);

    const [enrichedContacts, setEnrichedContacts] = useState<(ReturnType<typeof loadChatContacts>[number] & { char: Character })[]>([]);

    useEffect(() => {
        const chars = loadCharacters();
        const contacts = loadChatContacts();
        const enriched = contacts
            .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
            .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];
        setEnrichedContacts(enriched);
    }, []);

    useEffect(() => {
        const nextSize = isPdf ? 5 : 50;
        setAnnotationBatchSize(nextSize);
        setAnnotationBatchInput(String(nextSize));
        setAutoAnnotate(false);
        generatedBatchesRef.current.clear();
    }, [book.id, isPdf]);

    useEffect(() => {
        setAnnotationTranslationOverrides({});
    }, [book.id, chapterIndex, readingConfig.collapseBilingualTranslation]);

    const companion = companionId ? (enrichedContacts.find(c => c.characterId === companionId)?.char || loadCharacters().find(c => c.id === companionId)) : null;
    const bilingualTranslationEnabled = readingConfig.bilingualTranslationEnabled === true;
    /** 翻页动画；老配置里没有这个字段时默认开着，和加开关之前的表现一致 */
    const flipAnimationEnabled = readingConfig.pageFlipAnimation !== false;
    const defaultTranslationExpanded = readingConfig.collapseBilingualTranslation !== true;
    const isScrollMode = !isPdf && readingConfig.readingMode === "scroll";
    /** 首行缩进字数（外观设置）。分页断行的起点、滚动模式逐段的缩进都用这一个值，
     *  与根节点上的 --reading-block-indent 同源，不在别处再写一个数。 */
    const defaultIndentChars = Math.max(0, firstLineIndent ?? DEFAULT_BLOCK_INDENT);
    // 保持 ref 与最新状态同步（供长生命周期滚动回调读取）
    chapterIndexRef.current = chapterIndex;
    chaptersLenRef.current = chapters.length;
    // 滚动模式渲染的章节窗口：上一章 + 当前章 + 下一章（无缝衔接用）
    const windowChapters = useMemo(() => {
        if (chapters.length === 0) return [] as BookChapter[];
        const start = Math.max(0, chapterIndex - 1);
        const end = Math.min(chapters.length - 1, chapterIndex + 1);
        const out: BookChapter[] = [];
        for (let i = start; i <= end; i++) out.push(chapters[i]);
        return out;
    }, [chapters, chapterIndex]);
    /** 提交滚动比例。
     *
     *  滚动时每个滚动帧都会算一次比例，但**不能每帧都 setState**：scrollFraction 一变，
     *  整个阅读器（滚动窗口里好几章的段落）就要重渲染一遍，进度保存也会跟着写一次库。
     *  变化不足 0.4% 时只更新 ref（滚动位置计算、批注窗口估算仍能读到最新值），
     *  不触发重渲染；到顶/到底一律提交，免得末端的百分比迟迟不更新。
     *  force = 明确的跳转（滑块、打开书籍恢复位置），这种必须立刻提交。 */
    const commitScrollFraction = useCallback((fraction: number, force = false) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        scrollFractionRef.current = clamped;
        const last = committedScrollFractionRef.current;
        const atEdge = clamped <= 0 || clamped >= 1;
        if (!force && !atEdge && Math.abs(clamped - last) < 0.004) return;
        if (last === clamped && !force) return;
        committedScrollFractionRef.current = clamped;
        setScrollFraction(clamped);
    }, []);

    // 滚动模式：将「章节内比例(0-1)」换算为具体滚动位置（窗口布局下按当前章块定位）
    const scrollToChapterFraction = useCallback((fraction: number, targetChapterIndex: number) => {
        const body = scrollRef.current;
        if (!body) return;
        const metrics = chapterMetricsRef.current.get(targetChapterIndex);
        if (!metrics) return;
        const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
        const span = Math.max(0, metrics.height - body.clientHeight);
        const target = Math.max(0, Math.min(maxScroll, metrics.top + Math.max(0, Math.min(1, fraction)) * span));
        body.scrollTop = target;
        const actual = span > 0 ? Math.min(1, Math.max(0, (target - metrics.top) / span)) : 0;
        // 明确跳转，必须立刻提交（否则滑块拖完数字不跟着走）
        commitScrollFraction(actual, true);
    }, [commitScrollFraction]);
    const currentChapter = chapters[chapterIndex];

    /** 当前屏上会用到的插图序号。只加载这些，读完就放掉，
     *  免得整本画册的图全挂在内存里。 */
    const visibleImageIndices = useMemo(() => {
        const source = isScrollMode ? windowChapters : (currentChapter ? [currentChapter] : []);
        const indices = new Set<number>();
        for (const chapter of source) {
            for (const paragraph of chapter.paragraphs) {
                const marker = parseReadingImageMarker(paragraph);
                if (marker) indices.add(marker.index);
            }
            // 行内小图也要一起取出来，否则脚注角标会一直显示成空白占位
            chapter.paragraphInlineImages?.forEach((list) => {
                list?.forEach((index) => indices.add(index));
            });
        }
        return [...indices].sort((a, b) => a - b);
    }, [currentChapter, isScrollMode, windowChapters]);

    useEffect(() => {
        let cancelled = false;
        const wanted = new Set(visibleImageIndices);
        // 离开视野的先放掉（objectURL 不回收就一直占着内存）
        setInlineImageUrls((prev) => {
            let changed = false;
            const next: Record<number, string> = {};
            for (const [key, url] of Object.entries(prev)) {
                if (wanted.has(Number(key))) next[Number(key)] = url;
                else { URL.revokeObjectURL(url); changed = true; }
            }
            return changed ? next : prev;
        });
        void (async () => {
            // 已经在手里的不再取；剩下的用一次事务批量拿回来。
            // 原来逐张 loadReadingAsset（每张开关一次 IndexedDB），插图书翻页时很拖。
            const missing = [...wanted].filter((index) => !inlineImageUrlsRef.current[index]).sort((a, b) => a - b);
            if (missing.length === 0) return;
            const loaded = await loadReadingAssets(missing.map((index) => readingImageAssetKey(book.id, index)));
            if (cancelled) return;
            const created: Record<number, string> = {};
            for (const index of missing) {
                const blob = loaded.get(readingImageAssetKey(book.id, index));
                if (!blob || blob.size === 0) continue;
                created[index] = URL.createObjectURL(blob);
            }
            if (Object.keys(created).length === 0) return;
            setInlineImageUrls((prev) => {
                const merged: Record<number, string> = {};
                for (const [key, url] of Object.entries(created)) {
                    const index = Number(key);
                    // 期间别处已经建过同一张图的 URL：丢掉这份新的，别让它泄漏
                    if (prev[index]) { URL.revokeObjectURL(url); continue; }
                    merged[index] = url;
                }
                return Object.keys(merged).length > 0 ? { ...prev, ...merged } : prev;
            });
        })();
        return () => { cancelled = true; };
    }, [book.id, visibleImageIndices]);

    // 离开阅读器时把剩下的 objectURL 全放掉
    useEffect(() => () => {
        setInlineImageUrls((prev) => {
            Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
            return {};
        });
    }, []);
    // 批注署名用绑定的用户身份，不写死
    const userDisplayName = useMemo(
        () => resolveUserIdentity(companionId || undefined, "reading")?.name?.trim() || "我",
        [companionId],
    );
    const txtPagesChapterIndex = txtPages[0]?.find((item) => item.kind !== "gap")?.chapterIndex ?? txtPages[0]?.[0]?.chapterIndex;
    const txtPagesReadyForCurrentChapter = !isPdf && !isScrollMode && txtPages.length > 0 && txtPagesChapterIndex === chapterIndex;
    const showTxtLoading = !isPdf && (
        !chaptersLoaded ||
        (chaptersLoaded && chapters.length > 0 && Boolean(currentChapter) && !isScrollMode && !txtPagesReadyForCurrentChapter)
    );

    const renderTxtPage = (pageIndex: number) => {
        const pageItems = txtPages[pageIndex] || [];
        if (pageItems.length === 0) return null;
        return (
            <div className="reading-page-content">
                {pageItems.map((item, i) => (
                    item.kind === "gap"
                        ? <div key={i} className="reading-line-gap" />
                        : item.kind === "annotation"
                            ? renderAnnotationItem(item.annotation)
                            : item.kind === "image"
                                ? renderImageItem(item.image, i)
                                : renderLine(item, i)
                ))}
            </div>
        );
    };

    useEffect(() => { setMarks(loadReadingMarks(book.id)); }, [book.id]);

    /** 分章节点存在 kv 里；「更多设置」保存后派发事件，这里跟着重读（两边同一个来源）。 */
    useEffect(() => {
        const reload = () => setSplitNodes(loadReadingBookSettings(book.id).splitNodes || []);
        reload();
        window.addEventListener(READING_BOOK_SETTINGS_EVENT, reload);
        return () => window.removeEventListener(READING_BOOK_SETTINGS_EVENT, reload);
    }, [book.id]);

    /** 换书/换章时把展开过的批注收起来：上一章的段号套到这一章上是错的 */
    useEffect(() => {
        setExpandedAnnotationParagraphs([]);
    }, [book.id, chapterIndex]);

    useEffect(() => {
        const el = footerRef.current;
        if (!el) return;
        const sync = () => setFooterHeight(el.offsetHeight);
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);


    /** 松手后读取选区：定位到覆盖的每一段，换算成段落内字符区间 */
    const captureSelection = useCallback(() => {
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelectionInfo(null); return; }

        const range = sel.getRangeAt(0);
        const surface = surfaceRef.current;
        if (!surface) { setSelectionInfo(null); return; }
        // 跨段划选：拆成「每段一条」。批注卡片不带 data-paragraph，不会被算进来，
        // 所以从正文划到下一段时，中间那张批注卡片的文字不会混进摘抄。
        const segments = collectSelectionSegments(range, surface);
        if (segments.length === 0) { setSelectionInfo(null); return; }
        // 正文按数据里的段落切，不从 DOM 取：翻页模式下一段可能被切成好几行，
        // 中间还可能夹着批注卡片
        const selectedText = segments
            .map((segment) => (chapters[segment.chapterIndex]?.paragraphs[segment.paragraphIndex] || "").slice(segment.start, segment.end))
            .filter(Boolean)
            .join("\n");
        if (selectedText.trim().length < 2) { setSelectionInfo(null); return; }

        const surfaceRect = surfaceRef.current?.getBoundingClientRect();
        const rect = range.getBoundingClientRect();
        const originY = surfaceRect?.top ?? 0;
        const surfaceHeight = surfaceRect?.height ?? (typeof window !== "undefined" ? window.innerHeight : 812);
        const headerRect = headerRef.current?.getBoundingClientRect();
        const selectionCenterY = (rect.top + rect.bottom) / 2 - originY;
        setSelectionInfo({
            text: selectedText,
            segments,
            placeAtTop: selectionCenterY > surfaceHeight / 2,
            topOffset: (headerRect ? headerRect.bottom - originY : 56) + 12,
        });
    }, [chapters]);

    /** 点已有标记：iOS 的系统菜单只在有选区时出现，这里是单纯点击，就近弹自己的菜单 */
    const handleSurfaceClick = (e: React.MouseEvent) => {
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return; // 正在选字，交给选字菜单
        const hit = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-mark-id]");
        if (!hit) { setMarkMenu(null); return; }
        const mark = marks.find(item => item.id === hit.dataset.markId);
        if (!mark) return;
        const rect = hit.getBoundingClientRect();
        const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375;
        setMarkMenu({ mark, x: clampMenuX(rect.left + rect.width / 2, viewportWidth), y: rect.bottom });
    };

    const openShareDialog = (mark: ReadingMark) => {
        setShareTarget(readingMarkGroup(marks, mark));
        setMarkMenu(null);
    };

    const removeMark = (mark: ReadingMark) => {
        // 跨段划出来的那几条是一体的，删一条就该整组消失
        const group = readingMarkGroup(marks, mark);
        const ids = new Set(group.map(item => item.id));
        group.forEach(item => deleteReadingMark(book.id, item.id));
        setMarks(prev => prev.filter(item => !ids.has(item.id)));
        setMarkMenu(null);
    };

    const addMark = (style: ReadingMarkStyle) => {
        if (!selectionInfo || selectionInfo.segments.length === 0) return;
        // 跨段划选存成一组：渲染仍按段落切开，删除/批注/分享时按整组处理
        const groupId = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = new Date().toISOString();
        const created: ReadingMark[] = selectionInfo.segments.map((segment, index) => ({
            id: `mk_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            chapterIndex: segment.chapterIndex,
            paragraphIndex: segment.paragraphIndex,
            start: segment.start,
            end: segment.end,
            text: (chapters[segment.chapterIndex]?.paragraphs[segment.paragraphIndex] || "").slice(segment.start, segment.end),
            style,
            createdAt,
            groupId,
        }));
        created.forEach(saveReadingMark);
        setMarks(prev => [...prev, ...created]);
        clearSelection();
    };

    /** 划完句子的菜单里也能直接设节点（不用先划成高亮再点它）：
     *  以这一组划选的第一段作为新一章的开头。 */
    const splitNodeAtSelection = () => {
        if (!selectionInfo || selectionInfo.segments.length === 0) return;
        const first = selectionInfo.segments[0];
        const node: ReadingSplitNode = {
            id: `sn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            chapterIndex: first.chapterIndex,
            paragraphIndex: first.paragraphIndex,
            quote: selectionInfo.text.slice(0, 40),
            createdAt: new Date().toISOString(),
        };
        const next = addReadingSplitNode(book.id, node);
        setSplitNodes(next.splitNodes || []);
        clearSelection();
        setSplitNodeNote(
            `已在这一段开头设好分章节点（第 ${first.chapterIndex + 1} 章 · 第 ${first.paragraphIndex + 1} 段）。`
            + "到「更多设置 → 自定义章节目录」里改章名、一起应用。",
        );
        window.setTimeout(() => setSplitNodeNote(""), 6000);
    };

    const clearSelection = () => {
        setSelectionInfo(null);
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    };

    useEffect(() => {
        const onUp = () => { window.setTimeout(captureSelection, 10); };
        document.addEventListener("pointerup", onUp);
        document.addEventListener("selectionchange", onUp);
        return () => {
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("selectionchange", onUp);
        };
    }, [captureSelection]);

    /** 批注落库后同步往记忆日志追一条。没有共读角色时不写——没人可记。 */
    const toAnnotationMemos = (list: ReadingAnnotation[]): ReadingAnnotationMemo[] =>
        list
            .filter(annotation => annotation.characterId)
            .map(annotation => ({
                id: annotation.id,
                characterId: annotation.characterId,
                bookId: book.id,
                bookTitle: book.title,
                chapterIndex: annotation.chapterIndex,
                chapterTitle: chapters.find(chapter => chapter.index === annotation.chapterIndex)?.title || "",
                authorType: annotation.authorType === "user" ? "user" as const : "character" as const,
                quote: annotation.quote,
                content: annotation.content,
                createdAt: annotation.createdAt,
            }));

    /** 按章折叠的列表壳。当前章默认展开，其余收起，长书里才好找。 */
    const renderChapterFoldList = (
        sections: Array<{ index: number; count: number; rows: React.ReactNode }>,
        emptyText: string,
    ) => {
        if (sections.length === 0) {
            return <div className="reading-settings-inline-note"><span>{emptyText}</span></div>;
        }
        return (
            <>
                {sections.map(section => (
                    <details key={section.index} className="reading-fold" open={section.index === chapterIndex}>
                        <summary className="reading-fold-summary">
                            <span>{chapters.find(chapter => chapter.index === section.index)?.title?.trim() || `第${section.index + 1}章`}</span>
                            <span className="reading-fold-count">{section.count}</span>
                        </summary>
                        <div className="reading-fold-body">{section.rows}</div>
                    </details>
                ))}
            </>
        );
    };

    /** 导出全书批注。state 里的 annotations 只覆盖读过的章节，这里重新按章全量取一遍。 */
    const exportAnnotations = async () => {
        setExportNote("正在整理…");
        try {
            const groups = await Promise.all(chapters.map(chapter => loadAnnotations(book.id, chapter.index)));
            const markdown = buildAnnotationMarkdown({
                book,
                chapters,
                annotations: groups.flat(),
                marks,
                userName: userDisplayName,
            });
            await downloadFile(
                new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
                annotationExportFileName(book),
            );
            setExportNote("");
        } catch (err) {
            setExportNote(err instanceof Error ? err.message : "导出失败");
        }
    };

    const saveMyAnnotation = async () => {
        const text = myAnnotationText.trim();
        if (!text || !pendingQuote) return;
        const annotation: ReadingAnnotation = {
            id: `ann_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            chapterIndex: pendingQuote.chapterIndex,
            paragraphIndex: pendingQuote.paragraphIndex,
            // 用户批注仍记录当前共读的角色，便于「这条是写给谁看的」
            characterId: companionId || "",
            characterName: "",
            content: text,
            createdAt: new Date().toISOString(),
            authorType: "user",
            quote: pendingQuote.text,
        };
        await saveAnnotation(annotation);
        appendReadingAnnotationMemos(toAnnotationMemos([annotation]));
        setAnnotations(prev => [...prev, annotation]);
        setShowMyAnnotation(false);
        setMyAnnotationText("");
        setPendingQuote(null);
    };

    /** 段末 💬 图标：展开 / 收起这一段的批注。
     *  展开会多出批注卡片的实际高度，翻页模式必须重新分页，所以顺手推一次 txtLayoutVersion。 */
    const toggleParagraphAnnotations = useCallback((targetChapterIndex: number, paragraphIndex: number) => {
        const key = `${targetChapterIndex}:${paragraphIndex}`;
        setExpandedAnnotationParagraphs((prev) => (
            prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
        ));
        setTxtLayoutVersion((version) => version + 1);
    }, []);

    /** 划线后菜单里的「设置节点」：以这组划线的第一段为「新一章的开头」。
     *  只记锚点，不改任何正文；真正切成几章在「更多设置 → 自定义章节目录」里统一应用。 */
    const markSplitNodeAt = (mark: ReadingMark) => {
        const group = readingMarkGroup(marks, mark);
        const first = group[0] || mark;
        const node: ReadingSplitNode = {
            id: `sn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            chapterIndex: first.chapterIndex,
            paragraphIndex: first.paragraphIndex,
            quote: first.text.slice(0, 40),
            createdAt: new Date().toISOString(),
        };
        const next = addReadingSplitNode(book.id, node);
        setSplitNodes(next.splitNodes || []);
        setMarkMenu(null);
        setSplitNodeNote(
            `已在这一段开头设好分章节点（第 ${first.chapterIndex + 1} 章 · 第 ${first.paragraphIndex + 1} 段）。`
            + "到「更多设置 → 自定义章节目录」里改章名、一起应用。",
        );
        window.setTimeout(() => setSplitNodeNote(""), 6000);
    };

    /** 手动改批注。记忆区那条要一起改，否则角色嘴上记得的还是旧话。 */
    const saveEditedAnnotation = async () => {
        if (!editingAnnotation) return;
        const content = editingText.trim();
        if (!content || content === editingAnnotation.content) { setEditingAnnotation(null); return; }
        const updated = { ...editingAnnotation, content };
        await saveAnnotation(updated);
        updateReadingAnnotationMemoContent(updated.id, content);
        setAnnotations(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setEditingAnnotation(null);
        setEditingText("");
    };

    // 批注块（翻页与滚动模式共用）：长按呼出 编辑/复制/删除 菜单
    const renderAnnotationItem = (annotation: ReadingAnnotation) => (
        <div
            key={annotation.id}
            // 菜单挂在卡片下沿外面，不抬层就会被下一张批注卡片盖住
            className={`reading-annotation reading-annotation-interactive${activeAnnotationId === annotation.id ? " is-menu-open" : ""}`}
            data-author={annotation.authorType === "user" ? "user" : "character"}
            data-no-nav="true"
            onPointerDown={() => {
                longPressTimer.current = setTimeout(() => {
                    setActiveMessageId(null);
                    setActiveAnnotationId(annotation.id);
                }, 500);
            }}
            onPointerUp={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerLeave={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onClick={(e) => {
                e.stopPropagation();
                if (activeAnnotationId && activeAnnotationId !== annotation.id) setActiveAnnotationId(null);
            }}
        >
            <span className="reading-annotation-name">
                {annotation.authorType === "user" ? userDisplayName : annotation.characterName}
            </span>
            <ReadingAnnotationContent
                text={annotation.content}
                bilingualEnabled={bilingualTranslationEnabled}
                expanded={isAnnotationTranslationExpanded(annotation.id)}
                onToggle={() => handleAnnotationTranslationToggle(annotation.id)}
            />
            {activeAnnotationId === annotation.id && (
                <div className="ctx-menu reading-annotation-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                        onClick={() => {
                            setEditingAnnotation(annotation);
                            setEditingText(annotation.content);
                            setActiveAnnotationId(null);
                        }}
                        className="ctx-menu-btn"
                    >
                        编辑
                    </button>
                    <button
                        onClick={() => {
                            copyToClipboard(annotation.content);
                            setActiveAnnotationId(null);
                        }}
                        className="ctx-menu-btn"
                    >
                        复制
                    </button>
                    <button
                        onClick={() => { void handleDeleteReadingAnnotation(annotation.id); }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >
                        删除
                    </button>
                </div>
            )}
        </div>
    );

    const marksByParagraph = useMemo(() => {
        const map = new Map<string, ReadingMark[]>();
        for (const mark of marks) {
            const key = `${mark.chapterIndex}:${mark.paragraphIndex}`;
            map.set(key, [...(map.get(key) || []), mark]);
        }
        return map;
    }, [marks]);

    /** 一张行内小图（脚注角标、装饰符）。
     *  里面那个零宽空格是必需的：正文里它对应一个占位字符，而 DOM 的 textContent
     *  长度是选区换算字符偏移的依据（见 reading-selection.ts）。少了它，
     *  这一行之后的偏移会整体错一位，划线和批注就会落歪。 */
    const renderInlineImage = (imageIndex: number, key: string) => {
        // -1 = 这个占位字符没有对得上的图（数据缺项）。仍然要渲染那一个零宽空格，
        // 否则这一行的 DOM 文字会比段落文字短一个字符，选区偏移整体错位。
        const url = imageIndex >= 0 ? inlineImageUrls[imageIndex] : undefined;
        // 对齐方式写在 INLINE_IMAGE_BOX_STYLE / INLINE_IMAGE_IMG_STYLE 里（含原因说明）：
        // 这里只负责把样式挂上去，JSX 里不写注释，免得又踩「注释位置非法」那个坑。
        return (
            <span
                key={key}
                className="reading-inline-image-inline"
                data-inline-image={imageIndex}
                // 外层显式 inline：万一别处的 CSS 把它改成 block，这一格就会独占一行，
                // 行内小图立刻变成「整段大图」——那个老问题就是这么回来的。
                style={INLINE_IMAGE_WRAPPER_STYLE}
            >
                {url ? <img src={url} alt="" style={INLINE_IMAGE_IMG_STYLE} /> : null}
                {"\u200B"}
            </span>
        );
    };

    /** 一行文字的渲染：按「行内小图」切成若干段文字，逐段渲染 */
    const renderLineContent = (item: Extract<TxtPageItem, { kind: "line" }>) => {
        if (!item.text.includes(INLINE_IMAGE_CHAR)) return renderTextRun(item.text, item.charStart ?? 0, item, "");

        const pieces = item.text.split(INLINE_IMAGE_CHAR);
        const inlineList = item.inlineImages ?? [];
        const nodes: React.ReactNode[] = [];
        let offset = item.charStart ?? 0;
        pieces.forEach((piece, index) => {
            if (piece) {
                const rendered = renderTextRun(piece, offset, item, `p${index}-`);
                // 可能是字符串，也可能是节点数组，两种都要摊平进来
                if (Array.isArray(rendered)) nodes.push(...rendered);
                else if (rendered) nodes.push(rendered);
            }
            offset += piece.length;
            if (index < pieces.length - 1) {
                nodes.push(renderInlineImage(inlineList[index] ?? -1, `inline-${index}`));
                offset += 1; // 占位字符本身
            }
        });
        return nodes;
    };

    /** 一段连续文字（不含行内小图）的渲染：把落在本段区间内的荧光笔/划线切成
     *  <mark> 片段；有行内强调时再逐字叠加样式。baseStart = 这段的起点在段落里的下标。 */
    const renderTextRun = (
        text: string,
        baseStart: number,
        item: Extract<TxtPageItem, { kind: "line" }>,
        /** 一行被行内小图切成多段时，各段都要有自己的 key 前缀——
         *  否则不同段里同名几组节点会撞 key，React 会复用错节点。 */
        keyPrefix: string,
    ): React.ReactNode => {
        const lineStart = baseStart;
        const lineEnd = lineStart + text.length;
        const hits = (marksByParagraph.get(`${item.chapterIndex}:${item.paragraphIndex}`) || [])
            .filter(mark => mark.start < lineEnd && mark.end > lineStart)
            .sort((a, b) => a.start - b.start);
        const spans = item.block?.spans ?? null;
        const hasEmphasis = Boolean(spans && spans.some(span => span.bold || span.italic || span.underline || span.strike || span.sup || span.sub));

        // 常见情况：正文没有行内强调。走原来那条路——纯文本，只在有荧光笔/划线时切片。
        if (!hasEmphasis) {
            if (hits.length === 0) return text;

            const nodes: React.ReactNode[] = [];
            let cursor = lineStart;
            hits.forEach((mark, i) => {
                const from = Math.max(cursor, mark.start);
                const to = Math.min(lineEnd, mark.end);
                if (from > cursor) nodes.push(text.slice(cursor - lineStart, from - lineStart));
                if (to > from) {
                    nodes.push(
                        <span
                            key={`${keyPrefix}${mark.id}-${i}`}
                            className="reading-mark"
                            data-style={mark.style}
                            data-author={mark.authorType === "character" ? "character" : "user"}
                            data-mark-id={mark.id}
                        >
                            {text.slice(from - lineStart, to - lineStart)}
                        </span>,
                    );
                    cursor = to;
                }
            });
            if (cursor < lineEnd) nodes.push(text.slice(cursor - lineStart));
            return nodes;
        }

        // 有行内强调：逐字算出「强调位 + 是否有荧光笔/划线」，同一种组合的连续字符合成一个
        // 节点。强调只加样式、不增删字符，所以按码元下标走的字符锚点仍然准确。
        //
        // 强调位先摊成一张逐字符标记表（1=加粗 2=斜体 4=下划线 8=删除线 16=上标 32=下标），
        // 再按「标记相同」合并节点。原来每个字都要扫一遍 spans、为每个字各建一个对象、
        // 再 JSON.stringify 两次来比较——这条路径每次重绘都要整页走一遍，很吃性能。
        type StyledRun = { text: string; flags: number; mark: ReadingMark | null };
        const flagOf = new Uint8Array(text.length);
        for (const span of spans!) {
            const bits = (span.bold ? 1 : 0) | (span.italic ? 2 : 0) | (span.underline ? 4 : 0)
                | (span.strike ? 8 : 0) | (span.sup ? 16 : 0) | (span.sub ? 32 : 0);
            if (bits === 0) continue;
            const from = Math.max(0, span.start - lineStart);
            const to = Math.min(text.length, span.end - lineStart);
            for (let i = from; i < to; i += 1) flagOf[i] |= bits;
        }

        const runs: StyledRun[] = [];
        let current: StyledRun | null = null;
        let charIndex = 0;
        for (const ch of Array.from(text)) {
            const absolute = lineStart + charIndex;
            const flags = flagOf[charIndex] || 0;
            const mark = hits.find(candidate => candidate.start <= absolute && candidate.end > absolute) || null;
            if (current && current.flags === flags && (current.mark?.id ?? "") === (mark?.id ?? "")) {
                current.text += ch;
            } else {
                current = { text: ch, flags, mark };
                runs.push(current);
            }
            charIndex += ch.length;
        }

        return runs.map((node, index) => {
            const style: CSSProperties = {};
            if (node.flags !== 0) {
                if (node.flags & 1) style.fontWeight = 700;
                if (node.flags & 2) style.fontStyle = "italic";
                const underline = (node.flags & 4) !== 0;
                const strike = (node.flags & 8) !== 0;
                // 下划线和删除线同时存在时合并成一条声明，否则后写的会把先写的盖掉
                if (underline && strike) style.textDecoration = "underline line-through";
                else if (underline) style.textDecoration = "underline";
                else if (strike) style.textDecoration = "line-through";
                // 上下标用 em 相对字号，跟着这一行的字号走（标题里的脚注编号也不会错位）
                if (node.flags & 16) { style.fontSize = "0.7em"; style.verticalAlign = "super"; }
                if (node.flags & 32) { style.fontSize = "0.7em"; style.verticalAlign = "sub"; }
            }
            if (!node.mark) {
                return Object.keys(style).length > 0
                    ? <span key={`${keyPrefix}${index}`} style={style}>{node.text}</span>
                    : node.text;
            }
            return (
                <span
                    key={`${keyPrefix}${index}`}
                    className="reading-mark"
                    data-style={node.mark.style}
                    data-author={node.mark.authorType === "character" ? "character" : "user"}
                    data-mark-id={node.mark.id}
                    style={Object.keys(style).length > 0 ? style : undefined}
                >
                    {node.text}
                </span>
            );
        });
    };

    const renderLine = (item: Extract<TxtPageItem, { kind: "line" }>, key: number) => {
        const block = item.block;
        const className = [
            "reading-line",
            item.indent ? "reading-line-indent" : "",
            item.segEnd ? "reading-line-seg-end" : "",
            block?.quote ? "reading-line-quote" : "",
            block?.footnote ? "reading-line-footnote" : "",
            block?.align ? `reading-line-${block.align}` : "",
        ].filter(Boolean).join(" ");

        const style: CSSProperties = {};
        if (block) {
            // 字号/行距按倍率缩放：翻页模式下分页就是按同一套数算的高度，
            // 所以渲染必须严格照它出（行距直接用 px，避免字体四舍五入差异）。
            if (Math.abs(block.scale - 1) > 0.001) {
                style.fontSize = `calc(var(--reading-font-size, 20px) * ${block.scale})`;
            }
            if (block.bold) style.fontWeight = 700;
            if (block.italic) style.fontStyle = "italic";
        }
        if (item.lineHeight && item.lineHeight > 0) style.lineHeight = `${item.lineHeight}px`;
        if (block && item.indent && item.block?.indentChars !== undefined) {
            style["--reading-block-indent" as "--reading-block-indent"] = `${block.indentChars}em`;
        }

        return (
            <p
                key={key}
                className={className}
                data-chapter={item.chapterIndex}
                data-paragraph={item.paragraphIndex}
                data-charstart={item.charStart ?? 0}
                style={Object.keys(style).length > 0 ? style : undefined}
            >
                {renderLineContent(item)}
                {item.annotationCount ? (
                    <button
                        type="button"
                        className="reading-annotation-bubble"
                        data-no-nav="true"
                        data-open={item.annotationsExpanded ? "" : undefined}
                        style={ANNOTATION_BUBBLE_STYLE}
                        aria-label={item.annotationsExpanded
                            ? "收起这一段的批注"
                            : `展开这一段的 ${item.annotationCount} 条批注`}
                        aria-expanded={Boolean(item.annotationsExpanded)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onPointerUp={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleParagraphAnnotations(item.chapterIndex, item.paragraphIndex);
                        }}
                    >
                        <AnnotationBubbleIcon filled={Boolean(item.annotationsExpanded)} />
                    </button>
                ) : null}
            </p>
        );
    };

    /** 滚动模式用的行样式：滚动模式下由浏览器自己排版，不需要量高度，
     *  只要把倍率、对齐、缩进和行内样式交给 CSS 就够了。
     *
     *  按章整表算好缓存起来：滚动时每个滚动帧都会把窗口内所有段落重渲染一遍，
     *  逐段现算的话每帧要为上百个段落重建对象（滚动卡顿的一大来源）。
     *  注意行内小图不在这里——它和「还原原书排版」无关，滚动模式那边单独取。 */
    const scrollBlockStyles = useMemo(() => {
        const map = new Map<number, (LineBlockStyle | null)[]>();
        if (!isScrollMode || readingConfig.restoreOriginalLayout === false) return map;
        for (const chapter of windowChapters) {
            const styles = chapter.paragraphStyles;
            // 长度对不上说明这份数据不完整（老数据 / 被裁错过），宁可不还原
            if (!Array.isArray(styles) || styles.length !== chapter.paragraphs.length) continue;
            const spansList = chapter.paragraphSpans;
            map.set(chapter.index, chapter.paragraphs.map((_, index) => {
                const style = styles[index] ?? null;
                const align = style?.align ?? (style?.epigraph ? "center" : undefined);
                const noIndent = Boolean(style?.align || style?.heading || style?.quote || style?.epigraph || style?.footnote);
                return {
                    scale: blockScaleFor(style),
                    bold: style?.bold ?? Boolean(style?.heading),
                    italic: style?.italic ?? false,
                    quote: Boolean(style?.quote),
                    footnote: Boolean(style?.footnote),
                    indentChars: noIndent ? 0 : (style?.indent ?? defaultIndentChars),
                    ...(align ? { align } : {}),
                    spans: spansList?.[index] ?? null,
                } satisfies LineBlockStyle;
            }));
        }
        return map;
    }, [defaultIndentChars, isScrollMode, readingConfig.restoreOriginalLayout, windowChapters]);

    /** 一张正文插图。图还没读出来时先占住位置（有原始尺寸就按比例占），
     *  否则图片加载完会把正文顶得一跳一跳。 */
    const renderImageItem = (image: ReadingImageRef, key: number | string) => {
        const url = inlineImageUrls[image.index];
        // 量不出原图尺寸时按正方形占位，和分页里的算法保持一致
        const ratio = image.width > 0 && image.height > 0 ? `${image.width} / ${image.height}` : "1 / 1";
        return (
            <div key={key} className="reading-inline-image" style={{ aspectRatio: ratio }}>
                {url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={url} alt="" />
                    : <span className="reading-inline-image-hint">插图</span>}
            </div>
        );
    };

    const renderStaticPage = (items: TxtPageItem[]) => (
        <div className="reading-page-content">
            {items.map((item, i) =>
                item.kind === "gap"
                    ? <div key={i} className="reading-line-gap" />
                    : item.kind === "annotation"
                        ? <div key={i} className="reading-annotation" data-author={item.annotation.authorType === "user" ? "user" : "character"}>
                            <span className="reading-annotation-name">
                                {item.annotation.authorType === "user" ? userDisplayName : item.annotation.characterName}
                            </span>
                            <span className="reading-annotation-text">{item.annotation.content}</span>
                        </div>
                        : item.kind === "image"
                            ? renderImageItem(item.image, i)
                            : renderLine(item, i)
            )}
        </div>
    );

    const totalParagraphs = useMemo(
        () => chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
        [chapters],
    );
    const charPickerBottom = showChat ? (chatExpanded ? 284 : 76) : 64;
    const paragraphRefs = useMemo(() => buildParagraphRefsFromChapters(chapters), [chapters]);
    const pdfRenderAnnotations = useMemo(() => {
        if (!isPdf) return annotations;
        const absoluteIndexMap = new Map(
            paragraphRefs.map((item) => [`${item.chapterIndex}:${item.paragraphIndex}`, item.absoluteIndex] as const),
        );
        return annotations
            .map((annotation) => {
                const absoluteIndex = absoluteIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
                if (absoluteIndex === undefined) return null;
                return {
                    ...annotation,
                    paragraphIndex: absoluteIndex,
                };
            })
            .filter((annotation): annotation is ReadingAnnotation => annotation !== null);
    }, [annotations, isPdf, paragraphRefs]);

    const pdfAnnotationChapter: BookChapter | undefined = useMemo(() => {
        if (!isPdf || chapters.length === 0) return undefined;
        return {
            id: `${book.id}_pdf_all`,
            bookId: book.id,
            index: 0,
            title: book.title,
            paragraphs: paragraphRefs.map((item) => item.text),
            paragraphPages: paragraphRefs.map((item) => item.pageNum ?? 1),
            paragraphYPositions: paragraphRefs.map((item) => item.yRatio ?? 0.5),
        };
    }, [book.id, book.title, chapters.length, isPdf, paragraphRefs]);

    const clampBatchSize = useCallback((value: number) => {
        const fallback = isPdf ? 5 : 50;
        if (!Number.isFinite(value)) return fallback;
        const min = 1;
        const max = isPdf ? 30 : 200;
        return Math.min(max, Math.max(min, Math.round(value)));
    }, [isPdf]);

    const isAnnotationTranslationExpanded = useCallback((annotationId: string) => {
        return annotationTranslationOverrides[annotationId] ?? defaultTranslationExpanded;
    }, [annotationTranslationOverrides, defaultTranslationExpanded]);

    const handleAnnotationTranslationToggle = useCallback((annotationId: string) => {
        setAnnotationTranslationOverrides((prev) => {
            const current = prev[annotationId] ?? defaultTranslationExpanded;
            return { ...prev, [annotationId]: !current };
        });
        if (!isPdf) {
            setTxtLayoutVersion((version) => version + 1);
        }
    }, [defaultTranslationExpanded, isPdf]);

    // Find or create chat session for companion
    const getSession = useCallback((): ChatSession | null => {
        if (!companionId) return null;
        // 找不到与角色的一对一会话时自动创建（否则发送会静默无响应）
        return createOrGetSession(companionId);
    }, [companionId]);


    // Load book data
    useEffect(() => {
        // 清空上一本书遗留的滚动定位状态
        initialScrollFractionRef.current = null;
        pendingScrollFractionRef.current = null;
        pendingScrollActionRef.current = null;
        shiftCooldownRef.current = false;
        scrollPositionedKeyRef.current = "";
        setChaptersLoaded(false);
        (async () => {
            let chs = await loadChapters(book.id);
            if (!isPdf && chs.length === 0) {
                const rawFile = await loadRawFileBlob(book.id);
                if (rawFile && rawFile.size > 0) {
                    try {
                        const parsed = book.format === "txt"
                            ? parseTxtContent(decodeTxtArrayBuffer(await rawFile.arrayBuffer(), loadReadingInteractionConfig().txtEncoding).text, book.title)
                            : book.format === "mobi"
                                ? await parseMobiFile(await rawFile.arrayBuffer(), book.title)
                                : await parseEpubFile(await rawFile.arrayBuffer(), book.title);
                        const rebuiltChapters: BookChapter[] = parsed.chapters.map((chapter, index) => ({
                            id: `${book.id}_ch${index}`,
                            bookId: book.id,
                            index,
                            title: chapter.title,
                            paragraphs: chapter.paragraphs,
                            // 从原始文件重建时也要带上原书排版，否则重建一次样式就丢了
                            ...(chapter.paragraphStyles ? { paragraphStyles: chapter.paragraphStyles } : {}),
                            ...(chapter.paragraphSpans ? { paragraphSpans: chapter.paragraphSpans } : {}),
                            ...(chapter.paragraphInlineImages ? { paragraphInlineImages: chapter.paragraphInlineImages } : {}),
                        }));
                        if (rebuiltChapters.length > 0) {
                            await saveChapters(book.id, rebuiltChapters);
                            await updateBook({
                                ...book,
                                title: parsed.title || book.title,
                                author: parsed.author,
                                totalChapters: rebuiltChapters.length,
                            });
                            chs = rebuiltChapters;
                        }
                    } catch (err) {
                        console.error("[Reading] Failed to rebuild text chapters from raw file:", err);
                    }
                }
            }
            setChapters(chs);
            const progress = await loadProgress(book.id);
            if (progress) {
                const safeChapterIndex = chs.length > 0
                    ? Math.max(0, Math.min(chs.length - 1, progress.chapterIndex))
                    : 0;
                setChapterIndex(safeChapterIndex);
                setCompanionId(progress.companionCharacterId || null);
                if (isPdf) {
                    // PDF 恢复：scrollPosition 存的是「当前页 - 1」。
                    // 同时设置 pdfCurrentPage（避免跳转前保存逻辑把它覆盖回第 1 页）
                    // 与 pdfJumpPage（让 PdfPageRenderer 渲染完成后滚到该页）。
                    const restoredPage = Math.max(1, Math.round((progress.scrollPosition ?? 0) + 1));
                    setPdfCurrentPage(restoredPage);
                    setPdfJumpPage(restoredPage);
                } else if (progress.readingMode === "scroll") {
                    // 滚动模式：scrollPosition 存的是章节内滚动比例(0-1)
                    initialScrollFractionRef.current = Math.max(0, Math.min(1, progress.scrollPosition || 0));
                } else {
                    setTxtPage(Math.max(0, progress.scrollPosition || 0));
                }
            }
            // Default companion: first contact
            if (!progress?.companionCharacterId && enrichedContacts.length > 0) {
                setCompanionId(enrichedContacts[0].characterId);
            }
            if (!progress && !isPdf) setTxtPage(0);
            setBookmarks(await loadBookmarks(book.id).catch(() => []));
            setChaptersLoaded(true);
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [book.id]);

    useEffect(() => {
        if (chapters.length === 0) return;
        if (chapterIndex >= 0 && chapterIndex < chapters.length) return;
        setChapterIndex(Math.max(0, Math.min(chapters.length - 1, chapterIndex)));
    }, [chapterIndex, chapters.length]);

    useEffect(() => {
        if (!isPdf || pdfTotalPages <= 0 || chapters.length === 0) return;
        const expectedCount = Math.max(1, Math.ceil(pdfTotalPages / PDF_PAGES_PER_CHAPTER));
        const needsSkeletonRefresh =
            chapters.length !== expectedCount ||
            chapters.some((chapter, index) => {
                const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
                const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
                return chapter.pageStart !== startPage || chapter.pageEnd !== endPage;
            });
        if (!needsSkeletonRefresh) return;

        const nextChapters: BookChapter[] = Array.from({ length: expectedCount }, (_, index) => {
            const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
            const existing = chapters.find((chapter) => chapter.index === index);
            return {
                id: existing?.id || `${book.id}_ch${index}`,
                bookId: book.id,
                index,
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: existing?.paragraphs || [],
                paragraphPages: existing?.paragraphPages,
                paragraphYPositions: existing?.paragraphYPositions,
                pageStart: startPage,
                pageEnd: endPage,
            };
        });

        void saveChapters(book.id, nextChapters).then(() => {
            setChapters(nextChapters);
        }).catch((err) => {
            console.error("[Reading] PDF chapter skeleton error:", err);
        });
    }, [book.id, chapters, isPdf, pdfTotalPages]);

    // Load annotations for current scope
    useEffect(() => {
        (async () => {
            if (isPdf) {
                const groups = await Promise.all(chapters.map((chapter) => loadAnnotations(book.id, chapter.index)));
                setAnnotations(groups.flat());
                return;
            }
            // 滚动模式：加载窗口内所有章节（上一章+当前章+下一章）的批注，
            // 否则交界处批注缺失，且窗口平移时整组替换导致批注「时有时无」
            const chapterIndexes = isScrollMode
                ? [...new Set(windowChapters.map((c) => c.index))]
                : [chapterIndex];
            const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
            setAnnotations(groups.flat());
        })();
    }, [book.id, isPdf, isScrollMode, windowChapters]);

    // Load reading-discuss chat messages
    const refreshChatMessages = useCallback(() => {
        const session = getSession();
        if (!session) { setChatMessages([]); return; }
        const msgs = loadChatMessages(session.id)
            .filter(isReadingDiscussMessage)
            .slice(-30);
        setChatMessages(msgs);
    }, [getSession]);

    useEffect(() => { refreshChatMessages(); }, [refreshChatMessages, companionId]);

    const [annotationError, setAnnotationError] = useState<string | null>(null);
    const loadExistingAnnotationsForItems = useCallback(async (items: ParagraphRef[]) => {
        const chapterIndexes = [...new Set(items.map((item) => item.chapterIndex))];
        const itemKeys = new Set(items.map((item) => `${item.chapterIndex}:${item.paragraphIndex}`));
        const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
        return groups
            .flat()
            .filter((annotation) => itemKeys.has(`${annotation.chapterIndex}:${annotation.paragraphIndex}`));
    }, [book.id]);

    const ensurePdfPageRangeParsed = useCallback(async (startPage: number, endPage: number): Promise<BookChapter[]> => {
        if (!isPdf || chapters.length === 0) return chapters;

        const targetStart = Math.max(1, startPage);
        const targetEnd = Math.max(targetStart, endPage);
        const missing = chapters.filter((chapter) => {
            const chapterStart = chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1);
            const chapterEnd = chapter.pageEnd ?? (chapterStart + PDF_PAGES_PER_CHAPTER - 1);
            return chapter.paragraphs.length === 0 && chapterEnd >= targetStart && chapterStart <= targetEnd;
        });
        if (missing.length === 0) return chapters;

        const rawData = await loadRawFileBlob(book.id);
        if (!rawData || rawData.size === 0) {
            throw new Error("PDF 文件未找到或为空");
        }

        const parseStart = Math.min(...missing.map((chapter) => chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1)));
        const parseEnd = Math.max(...missing.map((chapter) => chapter.pageEnd ?? ((chapter.index + 1) * PDF_PAGES_PER_CHAPTER)));
        const parsed = await parsePdfPageRange(rawData, {
            startPage: parseStart,
            endPage: parseEnd,
            fileName: book.title,
        });

        const updates: BookChapter[] = parsed.chunks.map((chunk) => {
            const chunkIndex = Math.floor((chunk.startPage - 1) / PDF_PAGES_PER_CHAPTER);
            const existing = chapters[chunkIndex];
            return {
                id: existing?.id || `${book.id}_ch${chunkIndex}`,
                bookId: book.id,
                index: chunkIndex,
                title: chunk.title,
                paragraphs: chunk.paragraphs,
                paragraphPages: chunk.pdfMeta.map((item) => item.pageNum),
                paragraphYPositions: chunk.pdfMeta.map((item) => item.yRatio),
                pageStart: chunk.startPage,
                pageEnd: chunk.endPage,
            };
        });

        await saveChapters(book.id, updates);
        const merged = chapters.map((chapter) => {
            const replacement = updates.find((item) => item.index === chapter.index);
            return replacement || chapter;
        });
        setChapters(merged);
        return merged;
    }, [book.id, chapters, isPdf]);

    const buildTxtBatchRequest = useCallback((size: number, mode: AnnotationBatchMode): AnnotationBatchRequest | null => {
        let minParagraphIndex: number;
        let maxParagraphIndex: number;

        if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算「正在阅读」的段落窗口
            const total = currentChapter?.paragraphs.length || 0;
            if (total === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (total - 1));
            const half = Math.max(1, Math.ceil(size / 2));
            minParagraphIndex = Math.max(0, center - half);
            maxParagraphIndex = Math.min(total - 1, center + half);
        } else {
            const pageItems = txtPages[txtPage] || [];
            const visibleParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
            if (visibleParagraphIndexes.length === 0) return null;
            minParagraphIndex = visibleParagraphIndexes[0];
            maxParagraphIndex = visibleParagraphIndexes[visibleParagraphIndexes.length - 1];
        }

        const visibleRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.paragraphIndex >= minParagraphIndex && item.paragraphIndex <= maxParagraphIndex);
        if (visibleRefs.length === 0) return null;

        const startCandidates: number[] = [];
        if (mode === "manual") {
            startCandidates.push(visibleRefs[0].absoluteIndex);
        } else if (mode === "auto-current") {
            startCandidates.push(Math.floor(visibleRefs[0].absoluteIndex / size) * size);
        } else {
            for (let start = Math.floor(visibleRefs[0].absoluteIndex / size) * size; start <= visibleRefs[visibleRefs.length - 1].absoluteIndex; start += size) {
                if (start >= visibleRefs[0].absoluteIndex && start <= visibleRefs[visibleRefs.length - 1].absoluteIndex) {
                    startCandidates.push(start);
                    break;
                }
            }
        }

        const startAbsoluteIndex = startCandidates[0];
        if (startAbsoluteIndex === undefined) return null;
        const items = paragraphRefs.slice(startAbsoluteIndex, startAbsoluteIndex + size).filter((item) => item.text.trim());
        if (items.length === 0) return null;

        return {
            key: `txt:${startAbsoluteIndex}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
    }, [chapterIndex, currentChapter, isScrollMode, paragraphRefs, scrollFraction, txtPage, txtPages]);

    const getPdfBatchWindow = useCallback((size: number, mode: AnnotationBatchMode) => {
        const chapterMaxPage = Math.max(0, ...chapters.map((chapter) => chapter.pageEnd ?? 0));
        const refMaxPage = Math.max(0, ...paragraphRefs.map((item) => item.pageNum || 0));
        const maxPage = pdfTotalPages || chapterMaxPage || refMaxPage;
        if (maxPage <= 0) return null;
        const startPage = mode === "manual" ? pdfCurrentPage : Math.floor((pdfCurrentPage - 1) / size) * size + 1;
        if (mode === "auto" && pdfCurrentPage !== startPage) return null;
        const endPage = Math.min(maxPage, startPage + size - 1);
        return {
            key: `pdf:${startPage}:${size}`,
            title: `第${startPage}-${endPage}页`,
            size,
            startPage,
            endPage,
        };
    }, [chapters, paragraphRefs, pdfCurrentPage, pdfTotalPages]);

    const buildPdfBatchRequest = useCallback((size: number, mode: AnnotationBatchMode, refs: ParagraphRef[] = paragraphRefs): AnnotationBatchRequest | null => {
        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;
        const items = refs.filter((item) => (item.pageNum || 0) >= windowInfo.startPage && (item.pageNum || 0) <= windowInfo.endPage && item.text.trim());
        if (items.length === 0) return null;

        return {
            key: windowInfo.key,
            title: windowInfo.title,
            size: windowInfo.size,
            items,
        };
    }, [getPdfBatchWindow, paragraphRefs]);

    const materializeBatchRequest = useCallback(async (size: number, mode: AnnotationBatchMode): Promise<AnnotationBatchRequest | null> => {
        if (!isPdf) return buildTxtBatchRequest(size, mode);

        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;

        const mergedChapters = await ensurePdfPageRangeParsed(windowInfo.startPage, windowInfo.endPage);
        const refs = buildParagraphRefsFromChapters(mergedChapters);
        return buildPdfBatchRequest(size, mode, refs);
    }, [buildPdfBatchRequest, buildTxtBatchRequest, ensurePdfPageRangeParsed, getPdfBatchWindow, isPdf]);

    /** 对话框里那行「本次范围」。用的就是真正生成时的那套算法（buildTxtBatchRequest /
     *  getPdfBatchWindow），不是另算一遍，免得显示的范围和实际批注的范围对不上。 */
    const annotationRangePreview = useMemo(() => {
        if (!annotationDialogMode) return "";
        const size = clampBatchSize(Number(annotationBatchInput));
        const mode: AnnotationBatchMode = annotationDialogMode === "manual" ? "manual" : "auto-current";
        if (isPdf) {
            const window = getPdfBatchWindow(size, mode);
            return window ? window.title : "";
        }
        const request = buildTxtBatchRequest(size, mode);
        if (!request) return "";
        const startChapter = chapters[request.items[0].chapterIndex]?.title;
        const endChapter = chapters[request.items[request.items.length - 1].chapterIndex]?.title;
        const chapterHint = startChapter && endChapter && startChapter !== endChapter
            ? `（${startChapter} → ${endChapter}）`
            : startChapter ? `（${startChapter}）` : "";
        return `${request.title}${chapterHint}`;
    }, [annotationBatchInput, annotationDialogMode, buildTxtBatchRequest, chapters, clampBatchSize, getPdfBatchWindow, isPdf]);

    const executeBatchAnnotation = useCallback(async (request: AnnotationBatchRequest, options?: { force?: boolean }): Promise<boolean> => {
        if (!companionId) return false;
        const batchKey = `${book.id}:${companionId}:${request.key}`;
        if (!options?.force && generatedBatchesRef.current.has(batchKey)) return false;
        // 同步锁：同一时间只允许一个批注生成任务（auto/prefetch 竞态时后面的请求直接跳过，
        // 避免闭包里的 generating 旧值放行并发请求，导致同一批被重复生成）
        if (annotationInFlightRef.current) return false;
        // 同一批已在生成中：跳过（生成完成前 generatedBatchesRef 尚未写入，需用 in-flight 集合兜底）
        if (!options?.force && inFlightBatchesRef.current.has(batchKey)) return false;
        annotationInFlightRef.current = true;
        inFlightBatchesRef.current.add(batchKey);
        setGenerating(true);
        setAnnotationError(null);

        try {
            // 历史已有批注仅作为生成参考传入（generateAnnotationBatch 接收 existingAnnotations），
            // 不用于跳过：重新开启自动批注/重读书籍时，用户期望生成新的批注。
            // 「本次阅读体验内不重复」由 generatedBatchesRef（内存）保证。
            const existing = await loadExistingAnnotationsForItems(request.items);

            const { annotations: newAnnotations, marks: newMarks } = await withAnnotationRetry(
                () => generateAnnotationBatch(
                    book,
                    request.title,
                    request.items.map((item) => ({
                        chapterIndex: item.chapterIndex,
                        paragraphIndex: item.paragraphIndex,
                        text: item.text,
                    })),
                    existing,
                    companionId,
                ),
                readingConfig.annotationRetryCount > 0 ? readingConfig.annotationRetryCount : 0,
            );

            generatedBatchesRef.current.add(batchKey);

            // 角色顺手划的重点：只划线不写批注也算这一批有产出
            if (newMarks.length > 0) {
                newMarks.forEach(saveReadingMark);
                setMarks((prev) => {
                    const seen = new Set(prev.map(mark => mark.id));
                    return [...prev, ...newMarks.filter(mark => !seen.has(mark.id))];
                });
            }

            if (newAnnotations.length > 0) {
                await saveAnnotations(newAnnotations);
                appendReadingAnnotationMemos(toAnnotationMemos(newAnnotations));
                setAnnotations((prev) => {
                    const merged = new Map(prev.map((annotation) => [annotation.id, annotation]));
                    for (const annotation of newAnnotations) merged.set(annotation.id, annotation);
                    return [...merged.values()];
                });
            } else if (newMarks.length === 0) {
                // 解析失败、预设缺条目、接口报错现在都会抛出带原因的错误（见 generateAnnotationBatch），
                // 能走到这里就只剩一种情况：模型看完了，但这一批它没什么想说的。
                setAnnotationError(`${companion?.name || "AI"}这一批没有想写的批注（模型返回了「无批注」），可以换个范围再试`);
            }
            return true;
        } catch (err) {
            console.error("[Reading] Annotation error:", err);
            setAnnotationError(`批注失败: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inFlightBatchesRef.current.delete(batchKey);
            annotationInFlightRef.current = false;
            setGenerating(false);
        }
    }, [book, companionId, loadExistingAnnotationsForItems, readingConfig.annotationRetryCount]);

    const openAnnotationDialog = (mode: AnnotationDialogMode) => {
        const nextSize = annotationBatchSize || (isPdf ? 5 : 50);
        setAnnotationBatchInput(String(nextSize));
        setAnnotationDialogMode(mode);
    };

    const handleAnnotationDialogConfirm = async () => {
        if (!annotationDialogMode) return;
        const size = clampBatchSize(Number(annotationBatchInput));
        setAnnotationBatchSize(size);
        setAnnotationBatchInput(String(size));

        if (annotationDialogMode === "auto") {
            setAnnotationDialogMode(null);
            if (autoAnnotate) {
                setAutoAnnotate(false);
                return;
            }
            setAutoAnnotate(true);
            generatedBatchesRef.current.clear();
            prefetchedBatchStartRef.current = -1; // 新的阅读体验：预生成触发标记一并重置
            const request = await materializeBatchRequest(size, "auto-current");
            if (request) await executeBatchAnnotation(request);
            return;
        }

        const request = await materializeBatchRequest(size, "manual");
        setAnnotationDialogMode(null);
        if (!request) return;
        generatedBatchesRef.current.delete(`${book.id}:${companionId || ""}:${request.key}`);
        await executeBatchAnnotation(request, { force: true });
    };

    /** 打开手动预批注对话框：默认预生成「当前页起一个批次」的范围 */
    const openPdfPrefetchDialog = () => {
        const start = Math.max(1, pdfCurrentPage || 1);
        const batch = Math.max(1, annotationBatchSize || 5);
        const end = Math.min(pdfTotalPages || (start + batch - 1), start + batch - 1);
        setAnnotationError(null);
        setPdfPrefetchStartInput(String(start));
        setPdfPrefetchEndInput(String(end));
        setPdfPrefetchDialogOpen(true);
    };

    /** 手动预批注：按用户自定义的页码范围，预解析文本层并立即生成批注 */
    const handlePdfManualPrefetch = async () => {
        if (!companionId) {
            setAnnotationError("请先选择共读角色");
            return;
        }
        const total = Math.max(1, pdfTotalPages || 1);
        const start = Math.max(1, Math.min(total, Math.round(Number(pdfPrefetchStartInput) || 1)));
        const end = Math.max(start, Math.min(total, Math.round(Number(pdfPrefetchEndInput) || start)));
        if (end - start + 1 > MAX_MANUAL_PDF_PREFETCH_PAGES) {
            setAnnotationError(`一次最多预批注 ${MAX_MANUAL_PDF_PREFETCH_PAGES} 页，请缩小页码范围`);
            return;
        }
        setAnnotationError(null);
        setPdfPrefetchDialogOpen(false);
        try {
            // 预解析指定范围的文本层（渲染已解耦，不会重建页面）
            const merged = await ensurePdfPageRangeParsed(start, end);
            const refs = buildParagraphRefsFromChapters(merged);
            const items = refs.filter((item) => (item.pageNum || 0) >= start && (item.pageNum || 0) <= end && item.text.trim());
            if (items.length === 0) {
                setAnnotationError("所选范围没有可批注的文本");
                return;
            }
            const request: AnnotationBatchRequest = {
                key: `pdf:${start}:${end}:manual`,
                title: `第${start}-${end}页`,
                size: end - start + 1,
                items,
            };
            await executeBatchAnnotation(request, { force: true });
        } catch (err) {
            console.error("[Reading] PDF manual prefetch error:", err);
            setAnnotationError(`预批注失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const openNavigationDialog = () => {
        setShowNavigationDialog(true);
    };

    const copyToClipboard = useCallback((text: string) => {
        const fallbackCopy = () => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand("copy"); } catch {}
            document.body.removeChild(ta);
        };
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(fallbackCopy);
        } else {
            fallbackCopy();
        }
    }, []);

    const closeReadingMessageMenu = useCallback(() => {
        setReadingMessageMenu(null);
        setActiveMessageId(null);
    }, []);

    const cancelReadingMessageLongPress = useCallback(() => {
        readingMessagePressStartRef.current = null;
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = undefined;
        }
    }, []);

    const handleReadingMessagePointerDown = useCallback((event: React.PointerEvent<HTMLElement>, msg: ChatMessage) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        readingMessagePressStartRef.current = { x: event.clientX, y: event.clientY };
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = setTimeout(() => {
            setActiveAnnotationId(null);
            setActiveMessageId(msg.id);
            setReadingMessageMenu({ messageId: msg.id, x: event.clientX, y: event.clientY });
            longPressTimer.current = undefined;
        }, 500);
    }, []);

    const handleReadingMessagePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const start = readingMessagePressStartRef.current;
        if (!start) return;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        if (dx > 10 || dy > 10) cancelReadingMessageLongPress();
    }, [cancelReadingMessageLongPress]);

    const getReadingMessageMenuStyle = useCallback((menu: { x: number; y: number }): React.CSSProperties => {
        const margin = 12;
        const estimatedWidth = 168;
        const estimatedHeight = 42;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const left = Math.min(
            Math.max(menu.x - estimatedWidth / 2, margin),
            Math.max(margin, viewportWidth - estimatedWidth - margin),
        );
        const top = menu.y > viewportHeight - estimatedHeight - 24
            ? Math.max(margin, menu.y - estimatedHeight - 12)
            : Math.min(menu.y + 12, viewportHeight - estimatedHeight - margin);

        return {
            left,
            top,
        };
    }, []);

    const handleEditDiscussMessageStart = useCallback((msg: ChatMessage) => {
        setEditingDiscussMessage(msg);
        setEditingDiscussContent(msg.content);
        closeReadingMessageMenu();
    }, [closeReadingMessageMenu]);

    const handleSaveDiscussMessageEdit = useCallback(() => {
        if (!editingDiscussMessage) return;
        const nextContent = editingDiscussContent.trim();
        if (!nextContent) return;
        editChatMessage(editingDiscussMessage.id, nextContent);
        setChatMessages((prev) => prev.map((msg) => msg.id === editingDiscussMessage.id ? { ...msg, content: nextContent } : msg));
        setEditingDiscussMessage(null);
        setEditingDiscussContent("");
    }, [editingDiscussContent, editingDiscussMessage]);

    useEffect(() => {
        if (!showChat || !chatExpanded) {
            setReadingMessageMenu(null);
            setActiveMessageId(null);
        }
    }, [showChat, chatExpanded]);

    // 共读讨论悬浮窗展开时自动滚动到最新消息。
    // 仅在「打开」时滚动一次、无持续吸附——用户随后自由滑动即可打断，不会被拉回。
    useEffect(() => {
        if (!showChat || !chatExpanded) return;
        if (readingConfig.chatAutoScrollOnOpen === false) return;
        const el = chatListRef.current;
        if (!el) return;
        let raf1 = 0;
        let raf2 = 0;
        // 等展开动画与内容渲染稳定后再滚到底
        raf1 = window.requestAnimationFrame(() => {
            raf2 = window.requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight;
            });
        });
        return () => {
            window.cancelAnimationFrame(raf1);
            window.cancelAnimationFrame(raf2);
        };
    }, [showChat, chatExpanded, readingConfig.chatAutoScrollOnOpen]);

    const handleDeleteReadingAnnotation = useCallback(async (annotationId: string) => {
        await deleteAnnotation(annotationId);
        deleteReadingAnnotationMemo(annotationId);
        setAnnotations((prev) => prev.filter((annotation) => annotation.id !== annotationId));
        setActiveAnnotationId(null);
    }, []);

    const handlePdfJumpComplete = useCallback(() => {
        setPdfJumpPage(undefined);
    }, []);

    const handleNavChapterClick = (index: number) => {
        if (isPdf) {
            const chapter = chapters[index];
            const firstPage = chapter?.pageStart ?? chapter?.paragraphPages?.[0] ?? 1;
            setChapterIndex(index);
            setPdfJumpPage(firstPage);
        } else {
            goToChapter(index);
        }
        setShowNavigationDialog(false);
    };

    const handleNavPageSlider = (value: number) => {
        if (isPdf) {
            setPdfJumpPage(value);
        } else {
            if (chapters.length === 0) return;

            // 滑块读数是全书比例，反解成「第几章 + 章内比例」——和显示的百分比同一套换算，
            // 所以拖到多少就跳到多少，读过的、跳过的都算在里面。
            const position = bookFractionToPosition(sliderValueToBookFraction(value), bookIndex);
            const targetChapterIndex = position.chapterIndex;
            const pageFraction = position.within;

            if (targetChapterIndex === chapterIndex) {
                if (isScrollMode) {
                    scrollToChapterFraction(pageFraction, chapterIndex);
                } else {
                    pendingTxtPageFractionRef.current = null;
                    setTxtPage(Math.round(pageFraction * Math.max(0, txtTotalPages - 1)));
                }
            } else {
                pendingTxtPageFractionRef.current = pageFraction;
                pendingScrollFractionRef.current = pageFraction;
                setChapterIndex(targetChapterIndex);
                setTxtPage(0);
            }
        }
    };

    const handleReadingSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest("button, input, select, textarea, a, [data-no-nav='true']")) return;
        if (activeMessageId || activeAnnotationId) {
            setActiveMessageId(null);
            setActiveAnnotationId(null);
            return;
        }

        if (!isPdf && !isScrollMode && currentChapter) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const w = rect.width;
            if (x < w * 0.3) { navigateWithFlip('backward'); return; }
            if (x > w * 0.7) { navigateWithFlip('forward'); return; }
        }

        setImmersive(prev => !prev);
    };

    useEffect(() => {
        // 自动批注：跟随阅读位置推进，为当前批生成批注。
        // 与开启时的 bootstrap 并发时由 executeBatchAnnotation 的同步锁去重；
        // 若 bootstrap 未拿到批次（书刚打开数据未就绪），本 effect 会随阅读位置变化持续兜底触发。
        if (!autoAnnotate || generating || !companionId) return;
        void (async () => {
            const request = await materializeBatchRequest(annotationBatchSize, "auto");
            if (!request) return;
            await executeBatchAnnotation(request);
        })();
    }, [annotationBatchSize, autoAnnotate, companionId, executeBatchAnnotation, generating, materializeBatchRequest]);

    // 批注预生成：当前批注批读到用户设置的阈值时，提前生成下一批，
    // 把生成时间差放在用户读上一批批注的时间里，避免用户读到下一批时批注还没生成完。不会重复批注（批次按 key 去重）。
    // TXT 按「段落」分批次（autoAnnotatePrefetch 控制）；PDF 按「页数」分批次（autoAnnotatePrefetchPdf 控制），
    // 两者各自独立开关，批次大小统一跟随自动批注的 annotationBatchSize。
    const prefetchedBatchStartRef = useRef(-1);
    useEffect(() => {
        if (!autoAnnotate) { prefetchedBatchStartRef.current = -1; return; }
        if (!companionId || generating) return;
        const size = Math.max(1, annotationBatchSize || (isPdf ? 5 : 50));
        const threshold = Math.max(0, Math.min(1, readingConfig.annotationPrefetchThreshold ?? 2 / 3));

        if (isPdf) {
            // PDF 预批注开关：关闭时不预生成
            if (!readingConfig.autoAnnotatePrefetchPdf) { prefetchedBatchStartRef.current = -1; return; }
            // PDF：按页分批次。当前页所在批次读到阈值时，预解析并预生成下一批批注。
            if (pdfTotalPages <= 0) return;
            const batchStartPage = Math.floor((pdfCurrentPage - 1) / size) * size + 1;
            const offsetInBatch = pdfCurrentPage - batchStartPage; // 0-based
            if ((offsetInBatch + 1) / size < threshold) return; // 本批还没读到阈值
            if (prefetchedBatchStartRef.current === batchStartPage) return;
            prefetchedBatchStartRef.current = batchStartPage;

            const nextStartPage = batchStartPage + size;
            if (nextStartPage > pdfTotalPages) return;
            const nextEndPage = Math.min(nextStartPage + size - 1, pdfTotalPages);
            void (async () => {
                try {
                    // 预解析下一批文本层（解析后 setChapters，但渲染已与文本层解耦，不会重建页面）
                    const merged = await ensurePdfPageRangeParsed(nextStartPage, nextEndPage);
                    const refs = buildParagraphRefsFromChapters(merged);
                    const items = refs.filter((item) => (item.pageNum || 0) >= nextStartPage && (item.pageNum || 0) <= nextEndPage && item.text.trim());
                    if (items.length === 0) { prefetchedBatchStartRef.current = -1; return; }
                    const request: AnnotationBatchRequest = {
                        key: `pdf:${nextStartPage}:${size}`,
                        title: `第${nextStartPage}-${nextEndPage}页`,
                        size,
                        items,
                    };
                    // 若被跳过，重置标记让下一轮滚动再试，避免预生成丢失
                    void executeBatchAnnotation(request).then((started) => {
                        if (!started) prefetchedBatchStartRef.current = -1;
                    });
                } catch (err) {
                    console.error("[Reading] PDF prefetch error:", err);
                    prefetchedBatchStartRef.current = -1;
                }
            })();
            return;
        }

        // TXT 预批注开关：关闭时不预生成
        if (!readingConfig.autoAnnotatePrefetch) { prefetchedBatchStartRef.current = -1; return; }

        // TXT：当前阅读位置 → 全书记绝对段落索引
        if (paragraphRefs.length === 0) return;
        let currentAbs = -1;
        if (isScrollMode) {
            const chapterRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.text.trim());
            if (chapterRefs.length > 0) {
                const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs.length - 1));
                currentAbs = chapterRefs[center].absoluteIndex;
            }
        } else {
            const pageItems = txtPages[txtPage] || [];
            const firstLine = pageItems.find((item): item is Extract<TxtPageItem, { kind: "line" }> => item.kind === "line");
            if (firstLine) {
                const ref = paragraphRefs.find((r) => r.chapterIndex === firstLine.chapterIndex && r.paragraphIndex === firstLine.paragraphIndex);
                if (ref) currentAbs = ref.absoluteIndex;
            }
        }
        if (currentAbs < 0) return;

        const batchStart = Math.floor(currentAbs / size) * size;
        if ((currentAbs - batchStart + 1) / size < threshold) return; // 本批还没读到用户设置的阈值
        if (prefetchedBatchStartRef.current === batchStart) return;       // 本批已触发过预生成
        prefetchedBatchStartRef.current = batchStart;

        const nextStart = batchStart + size;
        if (nextStart >= paragraphRefs.length) return;
        const items = paragraphRefs.slice(nextStart, nextStart + size).filter((item) => item.text.trim());
        if (items.length === 0) return;

        const request: AnnotationBatchRequest = {
            key: `txt:${nextStart}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
        // 若被跳过（自动批注正在生成/该批已生成），重置标记让下一轮滚动再试，避免预生成丢失
        void executeBatchAnnotation(request).then((started) => {
            if (!started) prefetchedBatchStartRef.current = -1;
        });
    }, [annotationBatchSize, autoAnnotate, chapterIndex, companionId, ensurePdfPageRangeParsed, executeBatchAnnotation, generating, isPdf, isScrollMode, paragraphRefs, pdfCurrentPage, pdfTotalPages, readingConfig.autoAnnotatePrefetch, readingConfig.autoAnnotatePrefetchPdf, readingConfig.annotationPrefetchThreshold, scrollFraction, txtPage, txtPages]);

    useEffect(() => {
        // 自动批注开启时，随滚动把当前 5 页的文本层预先解析好，让批注生成请求不用临时等待解析。
        // 手动写批注 / 共读讨论内部会自行 ensurePdfPageRangeParsed，关闭自动批注时纯阅读不预解析。
        // 渲染已与文本层解耦：此处 setChapters 只会触发批注钉局部更新，不会重建页面，无闪烁。
        if (!isPdf || !autoAnnotate || pdfCurrentPage <= 0 || chapters.length === 0) return;
        const chunkStart = Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages || chunkStart + PDF_PAGES_PER_CHAPTER - 1);
        void ensurePdfPageRangeParsed(chunkStart, chunkEnd).catch((err) => {
            console.error("[Reading] PDF lazy parse error:", err);
        });
    }, [autoAnnotate, chapters.length, ensurePdfPageRangeParsed, isPdf, pdfCurrentPage, pdfTotalPages]);

    // Chapter navigation
    const goToChapter = (idx: number, startFromEnd = false) => {
        if (idx < 0 || idx >= chapters.length) return;
        pendingTxtPageFractionRef.current = startFromEnd ? 1 : null;
        // 滚动模式：显式跳章后定位到新章节的起点（0）或终点（1），而非窗口顶部（可能是上一章）
        // 实际滚动位置由渲染后的 useLayoutEffect 依据章节块度量换算
        pendingScrollFractionRef.current = startFromEnd ? 1 : 0;
        setChapterIndex(idx);
        setTxtPage(0);
    };

    // ── 书签 ──
    // 位置统一折成章节内 0-1 的比例：翻页/滚动/PDF 三种模式都能用同一个数还原。
    const currentFraction = (): number => {
        if (isPdf) return pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
        if (isScrollMode) return Math.max(0, Math.min(1, scrollFraction));
        return txtTotalPages > 1 ? txtPage / (txtTotalPages - 1) : 0;
    };

    /** 当前位置附近的一句正文，列表里靠它认出是哪儿 */
    const bookmarkExcerpt = (chapterIdx: number, fraction: number): string => {
        const paragraphs = (chapters[chapterIdx]?.paragraphs || []).filter((text) => text.trim());
        if (paragraphs.length === 0) return "";
        const index = Math.min(paragraphs.length - 1, Math.floor(fraction * paragraphs.length));
        return paragraphs[index].trim().replace(/\s+/g, " ").slice(0, 40);
    };

    /** 同一页上已经有书签就算「这里有」，再点一下是取消 */
    const bookmarkHere = (): ReadingBookmark | undefined => {
        const fraction = currentFraction();
        return bookmarks.find((item) => {
            if (item.chapterIndex !== chapterIndex) return false;
            if (isPdf) return item.pdfPage === pdfCurrentPage;
            // 一页的宽度就是容差：翻页模式按页算，滚动模式给 2%
            const tolerance = isScrollMode ? 0.02 : 1 / Math.max(1, txtTotalPages) / 2;
            return Math.abs(item.fraction - fraction) <= tolerance;
        });
    };

    const toggleBookmark = async () => {
        const existing = bookmarkHere();
        if (existing) {
            await deleteBookmark(existing.id);
            setBookmarks(await loadBookmarks(book.id));
            return;
        }
        const fraction = currentFraction();
        const bookmark: ReadingBookmark = {
            id: `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            chapterIndex,
            chapterTitle: chapters[chapterIndex]?.title || `第${chapterIndex + 1}章`,
            fraction,
            pdfPage: isPdf ? pdfCurrentPage : undefined,
            excerpt: bookmarkExcerpt(chapterIndex, fraction),
            createdAt: new Date().toISOString(),
        };
        await saveBookmark(bookmark);
        setBookmarks(await loadBookmarks(book.id));
    };

    const jumpToBookmark = (bookmark: ReadingBookmark) => {
        setShowBookmarks(false);
        setShowReadingSettings(false);
        if (isPdf) {
            setChapterIndex(Math.min(Math.max(0, bookmark.chapterIndex), Math.max(0, chapters.length - 1)));
            setPdfJumpPage(Math.max(1, bookmark.pdfPage || 1));
            return;
        }
        const target = Math.min(Math.max(0, bookmark.chapterIndex), Math.max(0, chapters.length - 1));
        const fraction = Math.max(0, Math.min(1, bookmark.fraction));
        if (target === chapterIndex) {
            // 同章内：直接定位，不走换章那条路（换章会重置到章首）
            if (isScrollMode) scrollToChapterFraction(fraction, chapterIndex);
            else {
                pendingTxtPageFractionRef.current = null;
                setTxtPage(Math.round(fraction * Math.max(0, txtTotalPages - 1)));
            }
            return;
        }
        pendingTxtPageFractionRef.current = fraction;
        pendingScrollFractionRef.current = fraction;
        setChapterIndex(target);
        setTxtPage(0);
    };

    const removeBookmark = async (bookmarkId: string) => {
        await deleteBookmark(bookmarkId);
        setBookmarks(await loadBookmarks(book.id));
    };

    const buildDiscussContext = useCallback((sourceChapters: BookChapter[] = chapters): ReadingDiscussContext | null => {
        const sourceParagraphRefs = buildParagraphRefsFromChapters(sourceChapters);
        if (sourceParagraphRefs.length === 0) return null;

        let focusChapterIndex = chapterIndex;
        let focusParagraphIndexes: number[] = [];

        if (isPdf) {
            let focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && (item.pageNum || 0) === pdfCurrentPage);
            if (focusRefs.length === 0) {
                let nearestDistance = Number.POSITIVE_INFINITY;
                for (const item of sourceParagraphRefs) {
                    if (!item.text.trim() || !item.pageNum) continue;
                    nearestDistance = Math.min(nearestDistance, Math.abs(item.pageNum - pdfCurrentPage));
                }
                if (Number.isFinite(nearestDistance)) {
                    focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && item.pageNum && Math.abs(item.pageNum - pdfCurrentPage) === nearestDistance);
                }
            }
            if (focusRefs.length === 0) return null;

            const chapterCounts = new Map<number, number>();
            for (const item of focusRefs) {
                chapterCounts.set(item.chapterIndex, (chapterCounts.get(item.chapterIndex) || 0) + 1);
            }
            focusChapterIndex = [...chapterCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? chapterIndex;
            focusParagraphIndexes = [...new Set(
                focusRefs
                    .filter((item) => item.chapterIndex === focusChapterIndex)
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        } else if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算正在阅读的段落窗口
            const chapterRefs0 = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
            if (chapterRefs0.length === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs0.length - 1));
            const half = Math.max(1, Math.ceil(DISCUSS_MAX_PARAGRAPHS / 3));
            focusParagraphIndexes = chapterRefs0
                .slice(Math.max(0, center - half), Math.min(chapterRefs0.length, center + half + 1))
                .map((item) => item.paragraphIndex);
        } else {
            const pageItems = txtPages[txtPage] || [];
            focusParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        }

        if (focusParagraphIndexes.length === 0) return null;

        const chapterRefs = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
        if (chapterRefs.length === 0) return null;

        const focusStartParagraph = focusParagraphIndexes[0];
        const focusEndParagraph = focusParagraphIndexes[focusParagraphIndexes.length - 1];
        let startPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusStartParagraph);
        let endPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusEndParagraph);
        if (startPos === -1 || endPos === -1) return null;

        let usedChars = chapterRefs.slice(startPos, endPos + 1).reduce((sum, item) => sum + getParagraphLength(item.text), 0);
        while ((usedChars < DISCUSS_TARGET_CHARS || usedChars < DISCUSS_MIN_CHARS) && (startPos > 0 || endPos < chapterRefs.length - 1)) {
            if (endPos - startPos + 1 >= DISCUSS_MAX_PARAGRAPHS) break;

            const prevRef = startPos > 0 ? chapterRefs[startPos - 1] : null;
            const nextRef = endPos < chapterRefs.length - 1 ? chapterRefs[endPos + 1] : null;
            if (!prevRef && !nextRef) break;

            const prevChars = prevRef ? getParagraphLength(prevRef.text) : Number.POSITIVE_INFINITY;
            const nextChars = nextRef ? getParagraphLength(nextRef.text) : Number.POSITIVE_INFINITY;
            const pickPrev = prevRef && (!nextRef || prevChars <= nextChars);
            const candidate = pickPrev ? prevRef : nextRef;
            if (!candidate) break;

            const nextUsedChars = usedChars + getParagraphLength(candidate.text);
            if (usedChars >= DISCUSS_TARGET_CHARS && usedChars >= DISCUSS_MIN_CHARS && nextUsedChars > DISCUSS_MAX_CHARS) break;

            if (pickPrev) startPos -= 1;
            else endPos += 1;
            usedChars = nextUsedChars;
        }

        const contextRefs = chapterRefs.slice(startPos, endPos + 1);
        if (contextRefs.length === 0) return null;

        const contextStartParagraph = contextRefs[0].paragraphIndex;
        const contextEndParagraph = contextRefs[contextRefs.length - 1].paragraphIndex;
        const paragraphSet = new Set(contextRefs.map((item) => item.paragraphIndex));
        const contextAnnotations = annotations.filter(
            (annotation) => annotation.chapterIndex === focusChapterIndex && paragraphSet.has(annotation.paragraphIndex),
        );
        const chapterTitleText = chapters[focusChapterIndex]?.title || currentChapter?.title || book.title;
        const chapterContent = [
            `当前阅读中心：${formatParagraphRangeLabel(focusStartParagraph, focusEndParagraph)}`,
            `本次上下文范围：${formatParagraphRangeLabel(contextStartParagraph, contextEndParagraph)}`,
            "",
            contextRefs.map((item) => `[${item.paragraphIndex + 1}] ${item.text}`).join("\n\n"),
        ].join("\n");

        return {
            chapterTitle: chapterTitleText,
            chapterContent,
            annotations: contextAnnotations,
        };
    }, [annotations, book.title, chapterIndex, chapters, currentChapter?.title, isPdf, isScrollMode, pdfCurrentPage, scrollFraction, txtPage, txtPages]);

    // Chat send — parse AI response like chat-room does
    const handleSend = async () => {
        if (!chatInput.trim() || !companionId || chatting) return;
        const text = chatInput.trim();
        setChatInput("");

        const session = getSession();
        if (!session) return;

        // Save user message
        const userMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: text,
            origin: "reading_discuss",
            mediaData: { readingBookTitle: book.title },
        });
        setChatMessages(prev => [...prev, userMsg]);

        setChatting(true);
        try {
            const sourceChapters = isPdf
                ? await ensurePdfPageRangeParsed(
                    Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1,
                    Math.min(
                        Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                        pdfTotalPages || Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                    ) - 1,
                )
                : chapters;
            const discussContext = buildDiscussContext(sourceChapters);
            if (!discussContext) return;
            const rawReply = await generateReadingChat(session, book, discussContext, companionId);
            if (rawReply) {
                const { reply, actions } = parseReadingDiscussResponse(rawReply);
                // Parse like chat: split into parts, extract inner monologue, state values, media
                if (reply) {
                    const { parts, statusPanel, innerMonologue, stateValues, freshStateValues } = parseAIResponse(reply, []);
                    const newMsgs: ChatMessage[] = [];
                    const saveParts: typeof parts = parts.length > 0 || !(statusPanel || innerMonologue) ? parts : [{ content: "" }];
                    for (let i = 0; i < saveParts.length; i++) {
                        const msg = pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: saveParts[i].content,
                            mediaType: saveParts[i].mediaType,
                            origin: "reading_discuss",
                            mediaData: { ...saveParts[i].mediaData, readingBookTitle: book.title },
                            statusPanel: i === 0 && statusPanel ? statusPanel : undefined,
                            innerMonologue: i === 0 && innerMonologue ? innerMonologue : undefined,
                            stateValues: i === 0 && stateValues.length > 0 ? stateValues : undefined,
                            freshStateValues: i === 0 ? freshStateValues : undefined,
                        });
                        newMsgs.push(msg);
                    }
                    setChatMessages(prev => [...prev, ...newMsgs]);
                }
                if (actions.length > 0) {
                    await applyDiscussActions(actions);
                }
            }
        } catch (err) {
            console.error("[Reading] Chat error:", err);
        } finally {
            setChatting(false);
        }
    };

    const applyDiscussActions = useCallback(async (actions: ReadingDiscussAction[]) => {
        if (!currentChapter || !companionId || !companion) return;

        let nextAnnotations = annotations;

        for (const action of actions) {
            if (action.type === "add_annotation") {
                if (action.paragraphIndex < 0 || action.paragraphIndex >= currentChapter.paragraphs.length) continue;
                const annotation: ReadingAnnotation = {
                    id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    bookId: book.id,
                    chapterIndex,
                    paragraphIndex: action.paragraphIndex,
                    characterId: companionId,
                    characterName: companion.name,
                    content: action.content,
                    createdAt: new Date().toISOString(),
                };
                await saveAnnotation(annotation);
                nextAnnotations = [...nextAnnotations, annotation];
                continue;
            }

            const target = nextAnnotations.find((annotation) => annotation.id === action.annotationId && annotation.chapterIndex === chapterIndex);
            if (!target) continue;

            if (action.type === "delete_annotation") {
                await deleteAnnotation(action.annotationId);
                nextAnnotations = nextAnnotations.filter((annotation) => annotation.id !== action.annotationId);
                continue;
            }

            const updated: ReadingAnnotation = {
                ...target,
                content: action.content,
            };
            await saveAnnotation(updated);
            nextAnnotations = nextAnnotations.map((annotation) => annotation.id === updated.id ? updated : annotation);
        }

        setAnnotations(nextAnnotations);
    }, [annotations, book.id, chapterIndex, companion, companionId, currentChapter]);

    const handleOpenChat = () => {
        setShowChat(true);
        setChatExpanded(false);
        closeCharPicker();
    };

    const [chatClosing, setChatClosing] = useState(false);
    const handleCloseChat = () => {
        if (chatClosing) return;
        setChatClosing(true);
        setTimeout(() => {
            setShowChat(false);
            setChatExpanded(false);
            setChatClosing(false);
        }, 200);
    };

    const shouldIgnoreChatAction = () => {
        if (!chatMovedRef.current) return false;
        chatMovedRef.current = false;
        return true;
    };

    const handleChatDragStart = (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // 悬浮球自身就是一个 button，点击与拖拽靠 chatMovedRef 区分，必须允许拖拽；
        // 悬浮条/窗内部的交互元素（按钮/输入框/正文滚动区等）不参与拖拽，避免抢占点击。
        const target = e.target as HTMLElement;
        if (!target.closest(".reading-chat-launch") && target.closest("button, input, textarea, select, a, .reading-chat-float-body, .reading-char-picker")) return;
        setIsDragging(true);
        chatDragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: chatOffset.x,
            originY: chatOffset.y,
        };
        chatMovedRef.current = false;
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const handleChatDragMove = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        const nextX = drag.originX + (e.clientX - drag.startX);
        const nextY = drag.originY + (e.clientY - drag.startY);
        const dragThreshold = e.pointerType === "touch" ? 12 : 6;
        if (!chatMovedRef.current && (Math.abs(nextX - drag.originX) > dragThreshold || Math.abs(nextY - drag.originY) > dragThreshold)) {
            chatMovedRef.current = true;
        }
        if (chatMovedRef.current) {
            // 拖拽过程中就约束在屏幕内，悬浮元素永不滑出屏幕外
            setChatOffset(clampChatOffset({ x: nextX, y: nextY }));
        }
    };

    // 悬浮元素尺寸（按当前形态估算，用于边界约束/贴边吸附）
    const getChatFloatSize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (!showChat) return { width: 56, height: 56 };                                    // 悬浮球
        if (!chatExpanded) return { width: Math.min(280, w - CHAT_FLOAT_MARGIN * 2), height: 56 }; // 悬浮条
        return { width: Math.min(300, w - CHAT_FLOAT_MARGIN * 2), height: Math.min(380, h * 0.55) }; // 悬浮窗
    };

    // 把偏移量约束在可视范围内。CSS 基础位置为 left:12px / bottom:12px，
    // 偏移是相对该基础位置的 translate3d，正 Y 向下。
    const clampChatOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
        const { width, height } = getChatFloatSize();
        const w = window.innerWidth;
        const h = window.innerHeight;
        const maxX = w - CHAT_FLOAT_MARGIN * 2 - width;
        const maxY = height + CHAT_FLOAT_MARGIN * 2 - h; // 允许向上拖到接近顶边（负值表示可上移）
        return {
            x: Math.max(0, Math.min(maxX, offset.x)),
            y: Math.max(maxY, Math.min(0, offset.y)),
        };
    };

    const persistChatFloatPos = (offset: { x: number; y: number }) => {
        try {
            localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify(clampChatOffset(offset)));
        } catch {
            // ignore storage errors
        }
    };

    // 悬浮形态切换（球→条→窗 / 收起）后把位置约束回可视范围，防止越界丢失
    useEffect(() => {
        setChatOffset((prev) => {
            const clamped = clampChatOffset(prev);
            return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showChat, chatExpanded]);

    // 始终指向最新版本的 clampChatOffset（供一次性挂载的监听器使用）
    const clampChatOffsetRef = useRef(clampChatOffset);
    clampChatOffsetRef.current = clampChatOffset;

    // 窗口尺寸变化（旋转/分屏）后把悬浮元素约束回屏幕内；书架设置里的「重置位置」事件
    useEffect(() => {
        const onResize = () => {
            setChatOffset((prev) => {
                const clamped = clampChatOffsetRef.current(prev);
                return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
            });
        };
        const onResetPos = () => {
            setChatOffset({ x: 0, y: 0 });
            try {
                localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify({ x: 0, y: 0 }));
            } catch {
                // ignore storage errors
            }
        };
        window.addEventListener("resize", onResize);
        window.addEventListener("reading-chat-float-reset", onResetPos);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("reading-chat-float-reset", onResetPos);
        };
    }, []);

    const handleChatDragEnd = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        chatDragRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setIsDragging(false);

        // 纯点击（没拖动）不吸附、不改位置
        if (!chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        chatMovedRef.current = false;

        let target = clampChatOffset({ x: chatOffset.x, y: chatOffset.y });
        if (!chatExpanded) {
            // 悬浮球/悬浮条：横向吸附到最近的边缘（贴左或贴右）
            const { width } = getChatFloatSize();
            const maxX = window.innerWidth - CHAT_FLOAT_MARGIN * 2 - width;
            const leftDist = target.x;
            const rightDist = maxX - target.x;
            target = { x: leftDist <= rightDist ? 0 : maxX, y: target.y };
        }
        setChatOffset(target);
        persistChatFloatPos(target);
    };

    const handleChatLaunchClick = () => {
        if (chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        handleOpenChat();
    };

    const chatFloatingStyle = {
        transform: `translate3d(${chatOffset.x}px, ${chatOffset.y}px, 0)`,
        transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), width 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), border-radius 0.3s ease-out',
    };

    useEffect(() => {
        if (isPdf || !scrollRef.current) return;

        const body = scrollRef.current;
        const onResize = () => setTxtLayoutVersion((v) => v + 1);
        const resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(body);

        const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
        fontsReady?.then(onResize).catch(() => {});

        return () => resizeObserver.disconnect();
    }, [isPdf]);

    useEffect(() => {
        if (isPdf || !currentChapter) return;
        const rafId = window.requestAnimationFrame(() => {
            setTxtLayoutVersion((v) => v + 1);
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [annotations, chapterIndex, currentChapter, isPdf]);

    // TXT pagination — split by actual rendered width/height so each page fits one screen.
    // 滚动模式下不参与分页，直接渲染整章内容。
    useEffect(() => {
        if (isPdf || isScrollMode || !currentChapter || !scrollRef.current || !txtMeasureLineRef.current || !txtMeasureGapRef.current || !txtMeasureAnnotationRef.current) {
            setTxtPages([]);
            return;
        }

        const body = scrollRef.current;
        const bodyStyle = window.getComputedStyle(body);
        const bodyPaddingX = parseFloat(bodyStyle.paddingLeft || "0") + parseFloat(bodyStyle.paddingRight || "0");
        const bodyPaddingY = parseFloat(bodyStyle.paddingTop || "0") + parseFloat(bodyStyle.paddingBottom || "0");
        const surface = body.querySelector('.reading-page-surface') as HTMLElement | null;
        const surfacePadX = surface
            ? parseFloat(getComputedStyle(surface).paddingLeft || "0") + parseFloat(getComputedStyle(surface).paddingRight || "0")
            : 0;
        const maxWidth = Math.max(1, body.clientWidth - bodyPaddingX - surfacePadX);
        const bottomOverlayReserve = 40;
        const maxHeight = Math.max(1, body.clientHeight - bodyPaddingY - bottomOverlayReserve);

        const lineStyle = window.getComputedStyle(txtMeasureLineRef.current);
        const gapStyle = window.getComputedStyle(txtMeasureGapRef.current);
        const lineHeight = parseFloat(lineStyle.lineHeight || "0") || 30.4;
        const gapHeight = parseFloat(gapStyle.height || "0") || 20;
        const fontSize = parseFloat(lineStyle.fontSize || "0") || 16;
        const annotationMeasure = txtMeasureAnnotationRef.current;
        const annotationNameEl = annotationMeasure.querySelector(".reading-annotation-name") as HTMLElement | null;
        const annotationTextEl = annotationMeasure.querySelector(".reading-annotation-text") as HTMLElement | null;
        const annotationMeasureStyle = window.getComputedStyle(annotationMeasure);
        const annotationMarginY =
            parseFloat(annotationMeasureStyle.marginTop || "0") +
            parseFloat(annotationMeasureStyle.marginBottom || "0");
        const chapterAnnotations = annotations.filter((annotation) => annotation.chapterIndex === chapterIndex);
        const annotationSignature = chapterAnnotations
            .map((annotation) => `${annotation.id}:${annotation.content.length}:${isAnnotationTranslationExpanded(annotation.id) ? 1 : 0}`)
            .join("|");
        const paragraphCharCount = currentChapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const paginationSignature = [
            currentChapter.id,
            chapterIndex,
            currentChapter.paragraphs.length,
            paragraphCharCount,
            annotationSignature,
            // 哪几段的批注展开了：展开了才有卡片占高度，必须重排
            expandedAnnotationParagraphs.slice().sort().join(","),
            bilingualTranslationEnabled ? 1 : 0,
            // 切换「还原原书排版」会改变逐行高度，必须触发重新分页
            readingConfig.restoreOriginalLayout !== false ? 1 : 0,
            Math.round(maxWidth),
            Math.round(maxHeight),
            lineHeight,
            gapHeight,
            defaultIndentChars,
            fontSize,
            lineStyle.fontFamily,
            lineStyle.fontWeight,
            lineStyle.fontStyle,
        ].join("::");

        if (lastTxtPaginationSignatureRef.current === paginationSignature) return;

        const measureAnnotationHeight = (annotation: ReadingAnnotation) => {
            if (!annotationNameEl || !annotationTextEl) return lineHeight * 2;
            annotationNameEl.textContent = annotation.characterName;
            const bilingual = bilingualTranslationEnabled ? splitBilingualText(annotation.content) : null;
            if (!bilingual) {
                annotationTextEl.textContent = annotation.content;
            } else {
                const expanded = isAnnotationTranslationExpanded(annotation.id);
                annotationTextEl.textContent = expanded
                    ? `${bilingual.original}\n收起中文\n${bilingual.translated}`
                    : `${bilingual.original}\n中文`;
            }
            const blockHeight = annotationMeasure.offsetHeight || lineHeight * 2;
            return blockHeight + annotationMarginY;
        };

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            setTxtPages([[{ kind: "line", text: currentChapter.paragraphs.join(" "), chapterIndex, paragraphIndex: 0, indent: true }]]);
            return;
        }
        ctx.font = toCanvasFont(lineStyle);

        // 还原原书排版：这本书确实带样式数据、且用户没关掉这个开关时才走。
        // 只要求样式数组长度对得上段落数——对不上说明数据是旧的或被裁错了，宁可不还原。
        const restoreLayout = readingConfig.restoreOriginalLayout !== false
            && Array.isArray(currentChapter.paragraphStyles)
            && currentChapter.paragraphStyles.length === currentChapter.paragraphs.length;
        const chapterStyles: (ReadingBlockStyle | null)[] | undefined = restoreLayout
            ? currentChapter.paragraphStyles
            : undefined;
        const chapterSpans: (ReadingInlineSpan[] | null)[] | undefined = restoreLayout
            ? currentChapter.paragraphSpans
            : undefined;
        // 行内小图与「是否还原原书排版」无关：它是排版正确性问题（角标图不该变成大图），
        // 所以只要数据在就用，不受那个开关影响。
        const chapterInlineImages = Array.isArray(currentChapter.paragraphInlineImages)
            && currentChapter.paragraphInlineImages.length === currentChapter.paragraphs.length
            ? currentChapter.paragraphInlineImages
            : undefined;
        const fontParts = {
            style: lineStyle.fontStyle,
            variant: lineStyle.fontVariant,
            weight: lineStyle.fontWeight,
            family: lineStyle.fontFamily,
        };
        /** 第 index 段的排版参数。没还原时等价于改动前那一套（首行缩进两字、统一字号行距）。 */
        const metricsAt = (index: number): BlockMetrics => (
            restoreLayout
                ? resolveBlockMetrics(chapterStyles?.[index] ?? null, fontSize, lineHeight, defaultIndentChars)
                : {
                    fontSize, lineHeight, scale: 1, bold: false, italic: false,
                    indentChars: defaultIndentChars, quote: false, footnote: false,
                }
        );
        /** 第 index 段与下一段之间的空白。没还原时返回 undefined，渲染层用回原来的 gapHeight。 */
        const gapAfter = (index: number): number | undefined => (
            restoreLayout ? blockGapHeight(metricsAt(index), metricsAt(index + 1), gapHeight) : undefined
        );

        const tokens: TxtPageItem[] = [];
        const annotationMap = new Map<number, ReadingAnnotation[]>();
        for (const annotation of chapterAnnotations) {
            const list = annotationMap.get(annotation.paragraphIndex) || [];
            list.push(annotation);
            annotationMap.set(annotation.paragraphIndex, list);
        }

        currentChapter.paragraphs.forEach((paragraph, index) => {
            const imageMarker = parseReadingImageMarker(paragraph);
            const metrics = metricsAt(index);
            const pushGapAfter = () => {
                if (index >= currentChapter.paragraphs.length - 1) return;
                const height = gapAfter(index);
                tokens.push({
                    kind: "gap",
                    chapterIndex,
                    paragraphIndex: index,
                    ...(height !== undefined ? { height } : {}),
                });
            };

            if (imageMarker) {
                tokens.push({ kind: "image", image: imageMarker, chapterIndex, paragraphIndex: index });
                pushGapAfter();
                return;
            }

            const blockFont = canvasFontFor(metrics, fontParts);
            const spans = chapterSpans?.[index] ?? null;
            // 只有段落里真有加粗/斜体片段时才逐字量宽；纯正文走原来那条快路径
            const mixedEmphasis = Boolean(spans && spans.some((span) => span.bold || span.italic));
            // 引用块左侧留出竖线的位置，折行宽度要同步收窄，否则文字会钻到竖线底下
            const blockWidth = Math.max(1, maxWidth - (metrics.quote ? QUOTE_INSET_PX : 0));
            const paragraphInline = chapterInlineImages?.[index] ?? null;
            // 行内小图在段落里是第几个：按段落文字顺序推进，每行取走自己那一段
            let inlineCursor = 0;

            const segments = paragraph.split("\n");
            // 段落内的字符游标：折行函数不裁剪字符，各行拼接等于原段落，
            // 所以逐行累加长度就能得到每行在段落中的起始偏移（荧光笔/划线按此定位）。
            let charCursor = 0;
            segments.forEach((segment, segmentIndex) => {
                const shouldIndent = segmentIndex === 0 && metrics.indentChars > 0;
                const firstLineOffset = shouldIndent ? metrics.indentChars * metrics.fontSize : 0;
                ctx.font = blockFont;
                // 有行内强调时按「字体一致的片段」折行（charCursor = 这一段在整段里的起点）；
                // 纯正文走单字体快路径。
                const wrappedLines = mixedEmphasis
                    ? wrapFontRunsToLines(
                        buildEmphasisRuns(segment, spans, charCursor, blockFont, fontParts, metrics),
                        blockWidth,
                        ctx,
                        firstLineOffset,
                        metrics.fontSize,
                    )
                    : wrapTextToLines(segment, blockWidth, ctx, firstLineOffset, metrics.fontSize);
                wrappedLines.forEach((line, lineIndex) => {
                    const lineInlineCount = countInlineImageChars(line);
                    const lineInline = paragraphInline && lineInlineCount > 0
                        ? paragraphInline.slice(inlineCursor, inlineCursor + lineInlineCount)
                        : null;
                    inlineCursor += lineInlineCount;
                    tokens.push({
                        kind: "line",
                        text: line,
                        chapterIndex,
                        paragraphIndex: index,
                        indent: shouldIndent && lineIndex === 0,
                        segEnd: lineIndex === wrappedLines.length - 1,
                        charStart: charCursor,
                        ...(lineInline && lineInline.length > 0 ? { inlineImages: lineInline } : {}),
                        ...(restoreLayout
                            ? {
                                lineHeight: metrics.lineHeight,
                                block: {
                                    scale: metrics.scale,
                                    bold: metrics.bold,
                                    italic: metrics.italic,
                                    quote: metrics.quote,
                                    footnote: metrics.footnote,
                                    indentChars: metrics.indentChars,
                                    ...(metrics.align ? { align: metrics.align } : {}),
                                    spans,
                                },
                            }
                            : {}),
                    });
                    charCursor += line.length;
                });
                if (segmentIndex < segments.length - 1) charCursor += 1; // 被 split 掉的 \n
                if (segmentIndex < segments.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
            });
            const paragraphAnnotations = annotationMap.get(index) || [];
            if (paragraphAnnotations.length > 0) {
                // 批注默认收起：只在段落最后一行挂一个 💬 图标（图标在行内，不占额外高度），
                // 展开后才把批注卡片作为独立条目排进这一页，参与高度累加。
                const expanded = expandedAnnotationParagraphs.includes(`${chapterIndex}:${index}`);
                const lastToken = tokens[tokens.length - 1];
                if (lastToken && lastToken.kind === "line") {
                    lastToken.annotationCount = paragraphAnnotations.length;
                    lastToken.annotationsExpanded = expanded;
                }
                if (expanded) {
                    for (const annotation of paragraphAnnotations) {
                        tokens.push({ kind: "annotation", annotation, chapterIndex, paragraphIndex: index });
                    }
                }
            }
            pushGapAfter();
        });

        const pages: TxtPageItem[][] = [];
        let currentPage: TxtPageItem[] = [];
        let usedHeight = 0;

        /** 插图占多高：按原图比例铺满正文宽度，最高不超过一页能放下的高度。
         *  CSS 里用同一个数当 max-height，排版和实际渲染才对得上。 */
        const measureImageHeight = (image: ReadingImageRef) => {
            if (image.width > 0 && image.height > 0) {
                return Math.min(maxHeight, Math.round((maxWidth * image.height) / image.width));
            }
            // 量不出原始尺寸（SVG 等）：留一块方方正正的位置
            return Math.min(maxHeight, Math.round(maxWidth));
        };

        for (const token of tokens) {
            const tokenHeight = token.kind === "gap"
                ? (token.height ?? gapHeight)
                : token.kind === "annotation"
                    ? measureAnnotationHeight(token.annotation)
                    : token.kind === "image"
                        ? measureImageHeight(token.image)
                        : (token.lineHeight ?? lineHeight);
            if (token.kind === "gap" && currentPage.length === 0) continue;

            if (currentPage.length > 0 && usedHeight + tokenHeight > maxHeight) {
                pages.push(trimTrailingGaps(currentPage));
                currentPage = [];
                usedHeight = 0;
                if (token.kind === "gap") continue;
            }

            currentPage.push(token);
            usedHeight += tokenHeight;
        }

        const lastPage = trimTrailingGaps(currentPage);
        if (lastPage.length > 0) pages.push(lastPage);
        if (pages.length === 0) pages.push([{ kind: "line", text: "", chapterIndex, paragraphIndex: 0 }]);

        lastTxtPaginationSignatureRef.current = paginationSignature;
        setImageMaxHeight((prev) => (prev === maxHeight ? prev : maxHeight));
        setTxtPages(pages);
    }, [annotations, bilingualTranslationEnabled, chapterIndex, currentChapter, expandedAnnotationParagraphs, isAnnotationTranslationExpanded, isPdf, isScrollMode, readingConfig.restoreOriginalLayout, txtLayoutVersion]);

    const txtTotalPages = txtPagesReadyForCurrentChapter ? txtPages.length : 1;

    // 全书进度按字数加权：章节长度差距很大（几十字的版权页 vs 一万多字的正文章），
    // 用「第几章 / 总章数」会让进度条和实际读了多少完全对不上。
    /** 全书进度换算表（按字数加权）。百分比、进度条、书签、分享卡片共用这一份，
     *  换算规则见 lib/reading-progress.ts 开头那段说明。 */
    const bookIndex = useMemo(() => buildBookPositionIndex(chapters), [chapters]);
    /** 旧名字保留：分享卡片按「章节字符数」取用，与换算表是同一份数据 */
    const chapterCharStats = bookIndex;

    /** 章内比例 → 全书比例。字数统计不可用时回退到按章数平均，保持旧行为。 */
    const toBookFraction = useCallback(
        (targetChapterIndex: number, withinChapter: number) =>
            chapterToBookFraction(targetChapterIndex, withinChapter, bookIndex),
        [bookIndex],
    );

    const navigateWithFlip = useCallback((direction: 'forward' | 'backward') => {
        if (flipAnim || isPdf) return;
        // 正在选字时不要翻页，否则一松手就跳走
        if (selectionInfo) return;
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return;
        // 拿不到当前页（分页尚未算完、或 txtPage 暂时越界）只说明没法放翻页动画，
        // 不该把跳章也一起吞掉——否则读到章末会「翻不动」，只能手动点下一章。
        const currentItems = txtPages[txtPage];

        const canForward = txtPage < txtTotalPages - 1 || chapterIndex < chapters.length - 1;
        const canBackward = txtPage > 0 || chapterIndex > 0;
        if (direction === 'forward' && !canForward) return;
        if (direction === 'backward' && !canBackward) return;

        // 关掉动画就直接切页：flipAnim 是那层翻页覆盖物，不设它就没有动画
        if (flipAnimationEnabled && currentItems && currentItems.length > 0) {
            setFlipAnim({ direction, items: currentItems });
        }

        if (direction === 'forward') {
            if (txtPage < txtTotalPages - 1) setTxtPage(p => p + 1);
            else goToChapter(chapterIndex + 1);
        } else {
            if (txtPage > 0) setTxtPage(p => p - 1);
            else goToChapter(chapterIndex - 1, true);
        }
    }, [flipAnim, flipAnimationEnabled, isPdf, txtPages, txtPage, txtTotalPages, chapterIndex, chapters.length, selectionInfo]);

    /** 全书进度（0-1）。
     *  按字数加权算，不是「第几章 / 共几章」——一本里版权页几十字、正文一万多字，
     *  按章数算出来的百分比和实际读了多少完全对不上。这个数也是存进进度的那个值，
     *  界面上显示的百分比因此和「下次打开恢复到哪里」是同一套算法。 */
    const bookProgressFraction = (() => {
        if (chapters.length === 0) return 0;
        if (isPdf) return pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
        if (isScrollMode) return toBookFraction(chapterIndex, Math.max(0, Math.min(1, scrollFraction)));
        // 翻页模式：算到当前页的末尾（而不是页首），这样第一章第一页就不是 0%
        return toBookFraction(chapterIndex, txtTotalPages > 0 ? (txtPage + 1) / txtTotalPages : 0);
    })();
    const txtDisplayedPage = Math.min(txtPage + 1, txtTotalPages);
    const currentPageCount = isPdf ? Math.max(1, pdfTotalPages || 1) : Math.max(1, txtTotalPages);
    // 滑块刻度直接就是全书比例（0-1000），不再按「第几章 + 章内比例」铺开：
    // 按章等分时，章节长短不均的书里滑块位置和百分比必然错开。
    const txtBookSliderMax = chapters.length > 0 ? BOOK_SLIDER_STEPS + 1 : 1;
    const txtBookSliderValue = Math.max(1, Math.min(txtBookSliderMax, bookFractionToSliderValue(bookProgressFraction)));
    useEffect(() => {
        if (isPdf || isScrollMode) return;
        const pendingFraction = pendingTxtPageFractionRef.current;
        if (pendingFraction === null || txtPagesChapterIndex !== chapterIndex) return;

        setTxtPage(Math.round(pendingFraction * Math.max(0, txtTotalPages - 1)));
        pendingTxtPageFractionRef.current = null;
    }, [chapterIndex, isPdf, isScrollMode, txtPagesChapterIndex, txtTotalPages]);

    useEffect(() => {
        if (!chaptersLoaded || chapters.length === 0) return;

        let scrollPosition: number;
        let progressFraction: number;
        let progressCurrent: number;
        let progressTotal: number;
        let progressScope: "book" | "chapter";
        // 章内位置（翻页：第几页/共几页；滚动：本章百分比）。与全书百分比分开存：
        // 界面上「全书 62%」和「第 7 章 3/20 页」是两件事，混成一个数就会互相打架。
        let chapterPageCurrent = 0;
        let chapterPageTotal = 0;
        if (isPdf) {
            scrollPosition = Math.max(0, pdfCurrentPage - 1);
            progressFraction = pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
            progressCurrent = Math.max(1, pdfCurrentPage);
            progressTotal = Math.max(1, pdfTotalPages || 1);
            progressScope = "book";
        } else if (isScrollMode) {
            const fraction = Math.max(0, Math.min(1, scrollFraction));
            scrollPosition = fraction;
            progressFraction = toBookFraction(chapterIndex, fraction);
            // 全书口径：跳过的部分本来就在 chapterIndex 之前，按字数加权自然算进去了
            progressCurrent = Math.max(1, Math.round(progressFraction * 100));
            progressTotal = 100;
            progressScope = "book";
            chapterPageCurrent = Math.max(1, Math.round(fraction * 100));
            chapterPageTotal = 100;
        } else {
            chapterPageCurrent = Math.max(1, txtPage + 1);
            chapterPageTotal = Math.max(1, txtTotalPages);
            scrollPosition = txtPage;
            progressFraction = toBookFraction(chapterIndex, chapterPageCurrent / chapterPageTotal);
            // ── 这里以前存的是「本章第几页 / 本章共几页」，scope 又标成 chapter ──
            // 书架和进度文案照着它显示，于是跳到后面某一章时，前面跳过的部分一个数都不占：
            // 百分比（全书口径）说 62%，旁边的位置文案却说「第 7 章 · 3/20」，
            // 两者自然对不上。现在统一存全书口径，章内页码另存两个字段，两件事都说得清。
            progressCurrent = Math.max(1, Math.round(progressFraction * 100));
            progressTotal = 100;
            progressScope = "book";
        }

        const progress: ReadingProgress = {
            bookId: book.id,
            chapterIndex,
            scrollPosition,
            companionCharacterId: companionId || undefined,
            progressFraction,
            progressCurrent,
            progressTotal,
            progressScope,
            ...(isPdf ? {} : { chapterPageCurrent, chapterPageTotal }),
            readingMode: isPdf ? undefined : (isScrollMode ? "scroll" : "page"),
            lastReadAt: new Date().toISOString(),
        };
        saveProgress(progress);
    }, [book.id, chapterIndex, chapters.length, chaptersLoaded, companionId, isPdf, isScrollMode, pdfCurrentPage, pdfTotalPages, scrollFraction, toBookFraction, txtPage, txtTotalPages]);

    useEffect(() => {
        setTxtPage((prev) => Math.min(prev, Math.max(0, txtTotalPages - 1)));
    }, [txtTotalPages]);

    // Scroll to top when page changes (仅翻页模式；滚动模式的位置由 useLayoutEffect 统一管理)
    useEffect(() => {
        if (isScrollMode) return;
        scrollRef.current?.scrollTo(0, 0);
    }, [txtPage, isScrollMode]);

    // 滚动模式：监听滚动 —— 更新章节内滚动比例；无缝衔接（多章窗口平移，保持视觉连续）
    // 前向：当前章内容读完（章底滚到视口顶部/底部）→ 移除顶部章块 + 补偿滚动位置，自然过渡到下一章
    // 后向：滚到窗口顶部 → 顶部前插上一章块 + 补偿滚动位置，自然回到上一章（无需「上一章」按钮）
    useEffect(() => {
        if (!isScrollMode) return;
        const body = scrollRef.current;
        if (!body) return;
        let rafId = 0;
        const onScroll = () => {
            if (rafId) return;
            rafId = window.requestAnimationFrame(() => {
                rafId = 0;
                const ci = chapterIndexRef.current;
                const len = chaptersLenRef.current;
                const viewport = body.clientHeight;
                const maxScroll = Math.max(0, body.scrollHeight - viewport);
                const metrics = chapterMetricsRef.current.get(ci);
                let fraction = 0;
                if (metrics) {
                    const span = Math.max(1, metrics.height - viewport);
                    fraction = Math.min(1, Math.max(0, (body.scrollTop - metrics.top) / span));
                } else {
                    fraction = maxScroll > 0 ? Math.min(1, Math.max(0, body.scrollTop / maxScroll)) : 0;
                }
                commitScrollFraction(fraction);
                if (!metrics) return;

                // 离开顶部后解除平移冷却
                if (body.scrollTop > 2) shiftCooldownRef.current = false;

                const bottom = metrics.top + metrics.height;
                // 高章节（超一屏）：章底滚到视口底部即衔接下一章，header 同步更新；
                // 矮章节（不足一屏）：等章底滚到视口顶部再衔接，避免移除顶部章块后滚动位置为负导致跳动
                const triggerAt = metrics.height >= viewport ? bottom - viewport - 2 : bottom - 2;
                // 前向：当前章已读完 → 移除顶部章块，窗口后移
                if (!shiftCooldownRef.current && ci < len - 1 && body.scrollTop >= triggerAt) {
                    shiftCooldownRef.current = true;
                    const prevMetrics = chapterMetricsRef.current.get(ci - 1);
                    pendingScrollActionRef.current = {
                        kind: "shift-forward",
                        oldScrollTop: body.scrollTop,
                        removedHeight: prevMetrics ? prevMetrics.height : 0,
                    };
                    setChapterIndex(ci + 1);
                    return;
                }
                // 后向：已滚到窗口顶部 → 顶部前插上一章块，窗口前移
                if (!shiftCooldownRef.current && ci > 0 && body.scrollTop <= 2) {
                    shiftCooldownRef.current = true;
                    pendingScrollActionRef.current = { kind: "shift-backward", oldScrollTop: body.scrollTop };
                    setChapterIndex(ci - 1);
                    return;
                }
            });
        };
        body.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            body.removeEventListener("scroll", onScroll);
            if (rafId) window.cancelAnimationFrame(rafId);
        };
    }, [commitScrollFraction, isScrollMode]);

    // 滚动模式：渲染后测量各章块位置，并应用窗口平移补偿 / 显式定位（useLayoutEffect 保证在绘制前执行，无闪跳）
    useLayoutEffect(() => {
        if (!isScrollMode || !chaptersLoaded) return;
        const content = scrollContentRef.current;
        const body = scrollRef.current;
        if (!content || !body || windowChapters.length === 0) return;

        // 1. 测量窗口内各章块在滚动坐标系中的位置（top 与 body.scrollTop 同坐标系）
        const bodyRect = body.getBoundingClientRect();
        const metrics = new Map<number, { top: number; height: number }>();
        for (const chunk of content.querySelectorAll<HTMLElement>("[data-chapter-index]")) {
            const idx = Number(chunk.getAttribute("data-chapter-index"));
            if (!Number.isFinite(idx)) continue;
            const rect = chunk.getBoundingClientRect();
            metrics.set(idx, { top: rect.top - bodyRect.top + body.scrollTop, height: rect.height });
        }
        chapterMetricsRef.current = metrics;

        // 2. 窗口平移补偿（保持视觉位置不动，实现无缝衔接）
        const action = pendingScrollActionRef.current;
        if (action) {
            pendingScrollActionRef.current = null;
            if (action.kind === "shift-forward") {
                body.scrollTop = Math.max(0, action.oldScrollTop - action.removedHeight);
            } else {
                const newPrev = metrics.get(chapterIndex - 1);
                body.scrollTop = Math.max(0, action.oldScrollTop + (newPrev ? newPrev.height : 0));
            }
            return;
        }

        // 3. 显式跳章 / 打开恢复 / 默认定位到当前章起点
        const positionKey = `${book.id}:${isScrollMode}`;
        const pendingFraction = pendingScrollFractionRef.current;
        const initialFraction = initialScrollFractionRef.current;
        if (pendingFraction !== null) {
            pendingScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(pendingFraction, chapterIndex);
        } else if (initialFraction !== null) {
            initialScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(initialFraction, chapterIndex);
        } else if (scrollPositionedKeyRef.current !== positionKey) {
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(0, chapterIndex);
        }
    }, [isScrollMode, chapterIndex, windowChapters, chaptersLoaded, annotations, txtLayoutVersion, book.id]);

    // Swipe handlers for TXT
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        // 拖动选区手柄同样会走到这里：有活动选区就别翻页，否则刚选好就被翻走
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return;
        const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
        const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            navigateWithFlip(dx < 0 ? 'forward' : 'backward');
        }
    };

    const activeReadingMenuMessage = readingMessageMenu
        ? chatMessages.find((msg) => msg.id === readingMessageMenu.messageId) || null
        : null;

    /** PDF 渲染设置先在弹窗内暂存，确认时只重建一次，避免拖动滑块期间连续重渲染整本 PDF。 */
    const openRangeSummary = () => {
        setSummaryMemos(loadReadingSummaryMemos(book.id, book.title));
        setSummaryRange({ start: chapterIndex, end: chapterIndex });
        setSummaryDraft("");
        setSummaryLabel("");
        setSummaryNote("");
        setShowRangeSummary(true);
    };

    const runRangeSummary = async () => {
        const from = Math.min(summaryRange.start, summaryRange.end);
        const to = Math.max(summaryRange.start, summaryRange.end);
        const picked = chapters.filter(chapter => chapter.index >= from && chapter.index <= to);
        if (picked.length === 0) { setSummaryNote("这个范围里没有章节"); return; }
        setSummaryBusy(true);
        setSummaryNote("");
        try {
            const result = await summarizeReadingRange(book, picked);
            setSummaryDraft(result.summary);
            setSummaryLabel(result.rangeLabel);
            // 截断是真会漏内容的（只总结了前面一部分），不能不说，但要说清楚是怎么回事
            setSummaryNote(result.truncated ? "选的范围太长，只总结了前面一部分，建议分几次总结" : "");
        } catch (err) {
            setSummaryNote(err instanceof Error ? err.message : "总结失败");
        } finally {
            setSummaryBusy(false);
        }
    };

    const loadPanelAnnotations = async () => {
        const groups = await Promise.all(chapters.map(chapter => loadAnnotations(book.id, chapter.index)));
        setPanelAnnotations(groups.flat());
    };

    const openMyAnnotationsPanel = () => {
        setExportNote("");
        setShowMyMarksPanel(true);
        void loadPanelAnnotations();
    };

    const openCharAnnotationsPanel = () => {
        setShowCharAnnotationMenu(true);
        void loadPanelAnnotations();
    };

    const removeAnnotationEverywhere = async (annotationId: string) => {
        await deleteAnnotation(annotationId);
        deleteReadingAnnotationMemo(annotationId);
        setAnnotations(prev => prev.filter(item => item.id !== annotationId));
        setPanelAnnotations(prev => prev.filter(item => item.id !== annotationId));
    };

    const saveRangeSummary = () => {
        const content = summaryDraft.trim();
        if (!content || !companionId) return;
        const from = Math.min(summaryRange.start, summaryRange.end);
        appendReadingAnnotationMemos([{
            id: `rsum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId: companionId,
            bookId: book.id,
            bookTitle: book.title,
            chapterIndex: from,
            chapterTitle: chapters.find(chapter => chapter.index === from)?.title || "",
            authorType: "character",
            content,
            createdAt: new Date().toISOString(),
            kind: "summary",
            rangeLabel: summaryLabel,
        }]);
        setSummaryDraft("");
        setSummaryMemos(loadReadingSummaryMemos(book.id, book.title));
    };

    const openReadingSettings = () => {
        setPdfRenderDraft({
            pdfZoom: readingConfig.pdfZoom ?? 1,
            pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
            pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
        });
        setShowReadingSettings(true);
    };

    const handleReadingSettingsConfirm = () => {
        if (isPdf) {
            setReadingConfig((prev) => {
                const next = { ...prev, ...pdfRenderDraft };
                saveReadingInteractionConfig(next);
                return next;
            });
        }
        setShowReadingSettings(false);
    };

    // 根节点上的 data-reading-fonts：注入的三档字体规则挂在这个属性上，
    // 权重才不会和主题/插件那种 `.xxx *` 规则打平、被后注入的一方接管（见 reading-app.tsx）。
    return (
        <div ref={surfaceRef} className="reading-app-surface absolute inset-0 z-[100] flex flex-col bg-[var(--c-page-body-bg)]" data-reading-fonts="" data-immersive={immersive} style={{
            paddingTop: "var(--page-header-safe-top, 48px)",
            // 插图最高不超过一页能放下的高度，和分页算出来的那个数是同一个
            ...(imageMaxHeight > 0 ? { ["--reading-image-max-height" as "--reading-image-max-height"]: `${imageMaxHeight}px` } : {}),
        } as CSSProperties} onClick={handleSurfaceClick}>
            {/* Page flip overlay */}
            {flipAnim && (
                <>
                    <div
                        className={`reading-flip-overlay reading-flip-overlay--${flipAnim.direction}`}
                        onAnimationEnd={() => setFlipAnim(null)}
                    >
                        <div className="reading-flip-overlay-body">
                            {renderStaticPage(flipAnim.items)}
                        </div>
                    </div>
                    <div className={`reading-flip-shadow reading-flip-shadow--${flipAnim.direction}`} />
                </>
            )}

            {/* Header — chapter name + page info */}
            <header ref={headerRef} className={`reading-header ${immersive ? "reading-header--immersive" : "reading-header--revealed"}`} data-ui="header">
                <div className="reading-header-top">
                    <button onClick={onBack} className="page-back-btn reading-header-back">
                        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span className="reading-header-title">{isPdf ? book.title : (currentChapter?.title || book.title)}</span>
                    <div className="reading-header-right-group">
                        <button
                            type="button"
                            className="page-back-btn"
                            onClick={() => { void toggleBookmark(); }}
                            aria-label={bookmarkHere() ? "取消书签" : "加书签"}
                            aria-pressed={Boolean(bookmarkHere())}
                        >
                            <span className="reading-bookmark-icon" data-on={bookmarkHere() ? "" : undefined} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="page-back-btn"
                            onClick={openNavigationDialog}
                            aria-label="目录"
                        >
                            <Menu size={18} strokeWidth={1.7} />
                        </button>
                    </div>
                </div>
                {annotationError && (
                    <div className="reading-header-status" style={{ color: "var(--c-danger)" }}>{annotationError}</div>
                )}
                {splitNodeNote && (
                    <div className="reading-header-status">{splitNodeNote}</div>
                )}
            </header>

            {generating && (
                <div className="reading-status-float" aria-live="polite">
                    {companion?.name || "AI"} 正在批注中...
                </div>
            )}

            {/* Character picker dropdown — above bottom avatar */}
            {showCharPicker && (
                <div className="absolute inset-0 z-40" onClick={closeCharPicker} />
            )}
            {showCharPicker && (
                <div
                    className={`absolute left-3 z-50 g-card reading-char-picker ${charPickerClosing ? "reading-char-picker--closing" : ""}`}
                    style={{ minWidth: 160, bottom: `${charPickerBottom}px`, ...chatFloatingStyle, padding: "16px 16px 16px 24px" }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="chat-contact-list" style={{ padding: "4px 6px" }}>
                        {enrichedContacts.map(c => (
                            <div
                                key={c.characterId}
                                className="chat-contact-item"
                                onClick={() => { setCompanionId(c.characterId); closeCharPicker(); generatedBatchesRef.current.clear(); prefetchedBatchStartRef.current = -1; }}
                            >
                                <div className="chat-contact-avatar"
                                    style={companionId === c.characterId ? { outline: "3px solid var(--c-success)", outlineOffset: "2px" } : undefined}
                                >
                                    {c.char.avatar ? <img src={c.char.avatar} alt="" /> : <span className="chat-contact-avatar-fallback">{c.char.name[0]}</span>}
                                </div>
                                <span className="chat-contact-name">{c.char.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Reading content */}
            <div
                ref={scrollRef}
                className={`relative flex-1 min-h-0 px-4 pt-1 pb-3 ${(isPdf || isScrollMode) ? "overflow-auto" : "overflow-hidden"}`}
                data-ui="body"
                onClick={handleReadingSurfaceClick}
            >
                {isPdf ? (
                    <>
                        {/* PDF native rendering */}
                        <PdfPageRenderer
                            bookId={book.id}
                            chapter={pdfAnnotationChapter}
                            annotations={pdfRenderAnnotations}
                            bilingualTranslationEnabled={bilingualTranslationEnabled}
                            collapseBilingualTranslation={readingConfig.collapseBilingualTranslation === true}
                            onTotalPages={setPdfTotalPages}
                            onCurrentPage={setPdfCurrentPage}
                            jumpToPage={pdfJumpPage}
                            onJumpComplete={handlePdfJumpComplete}
                            onCopyAnnotation={copyToClipboard}
                            onDeleteAnnotation={handleDeleteReadingAnnotation}
                            zoom={readingConfig.pdfZoom ?? 1}
                            preloadRadius={readingConfig.pdfPreloadRadius ?? 3}
                            preloadEnabled={readingConfig.pdfPreloadEnabled !== false}
                        />
                    </>
                ) : !chaptersLoaded ? (
                    null
                ) : chapters.length === 0 ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：0</div>
                        <div className="reading-debug-line">总段落数：0</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}</div>
                        <div className="reading-debug-hint">这更像是这本书在本地 IndexedDB 里的章节数据已经空了，不是单纯分页卡住。</div>
                    </div>
                ) : !currentChapter ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：{chapters.length}</div>
                        <div className="reading-debug-line">总段落数：{totalParagraphs}</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}/{txtTotalPages}</div>
                        <div className="reading-debug-hint">章节数据存在，但当前索引取不到正文。这个状态不是“正在加载”，而是本地章节数据和进度状态不一致。</div>
                    </div>
                ) : isScrollMode ? (
                    <div ref={scrollContentRef} className="reading-scroll-content">
                        {windowChapters.map((chapter) => (
                            <div key={chapter.id} data-chapter-index={chapter.index}>
                                {chapter.paragraphs.map((paragraph, pIndex) => {
                                    const imageMarker = parseReadingImageMarker(paragraph);
                                    if (imageMarker) {
                                        return (
                                            <div key={pIndex} className="reading-scroll-block">
                                                {renderImageItem(imageMarker, `img-${chapter.index}-${pIndex}`)}
                                            </div>
                                        );
                                    }
                                    const segmentCount = paragraph.split("\n").length;
                                    // 还原原书排版时，首行缩进跟随这一段自己的档位（居中/引用/标题不缩进）
                                    const block = scrollBlockStyles.get(chapter.index)?.[pIndex] ?? null;
                                    const shouldIndent = block ? block.indentChars > 0 : true;
                                    const paragraphAnnotations = annotations.filter(
                                        (annotation) => annotation.chapterIndex === chapter.index && annotation.paragraphIndex === pIndex
                                    );
                                    // 批注默认收起，段末只挂一个 💬 图标（与翻页模式同一套交互）
                                    const paragraphExpanded = expandedAnnotationParagraphs.includes(`${chapter.index}:${pIndex}`);
                                    return (
                                        <div key={pIndex} className="reading-scroll-block">
                                            {(() => {
                                                let charCursor = 0;
                                                // 滚动模式下整段一次性交给浏览器排版，行内小图按整段给
                                                const paragraphInline = chapter.paragraphInlineImages?.[pIndex] ?? null;
                                                let inlineCursor = 0;
                                                return paragraph.split("\n").map((segment, sIndex) => {
                                                    const charStart = charCursor;
                                                    charCursor += segment.length + 1; // 被拆掉的 \n 也占一个字符
                                                    const inlineCount = countInlineImageChars(segment);
                                                    const lineInline = paragraphInline && inlineCount > 0
                                                        ? paragraphInline.slice(inlineCursor, inlineCursor + inlineCount)
                                                        : null;
                                                    inlineCursor += inlineCount;
                                                    return renderLine({
                                                        kind: "line",
                                                        text: segment,
                                                        chapterIndex: chapter.index,
                                                        paragraphIndex: pIndex,
                                                        indent: shouldIndent && sIndex === 0,
                                                        segEnd: sIndex === segmentCount - 1,
                                                        charStart,
                                                        ...(block ? { block } : {}),
                                                        ...(lineInline && lineInline.length > 0 ? { inlineImages: lineInline } : {}),
                                                        ...(sIndex === segmentCount - 1 && paragraphAnnotations.length > 0
                                                            ? {
                                                                annotationCount: paragraphAnnotations.length,
                                                                annotationsExpanded: paragraphExpanded,
                                                            }
                                                            : {}),
                                                    }, sIndex);
                                                });
                                            })()}
                                            {paragraphExpanded
                                                ? paragraphAnnotations.map((annotation) => renderAnnotationItem(annotation))
                                                : null}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        <div className="h-[72px]" aria-hidden="true" />
                    </div>
                ) : (
                    <>
                        <div
                            className="reading-page-stage"
                            onTouchStart={handleTouchStart}
                            onTouchEnd={handleTouchEnd}
                        >
                            <div className="reading-page-surface">
                                {txtPagesReadyForCurrentChapter ? renderTxtPage(txtPage) : null}
                            </div>
                        </div>

                        <div className="reading-page-measure" aria-hidden="true">
                            <p ref={txtMeasureLineRef} className="reading-line">测</p>
                            <div ref={txtMeasureGapRef} className="reading-line-gap" />
                            <div ref={txtMeasureAnnotationRef} className="reading-annotation">
                                <span className="reading-annotation-name">角色</span>
                                <span className="reading-annotation-text">批注内容</span>
                            </div>
                        </div>
                    </>
                )}

                {showTxtLoading && (
                    <ReadingLoadingView title="正在打开书页" subtitle="正在读取并排版当前章节" overlay />
                )}

                {isPdf && <div className="h-[88px]" />}
            </div>

            {/* Immersive Page Number */}
            <span className={`reading-immersive-page ${immersive ? 'opacity-35' : 'opacity-0'}`}>
                {/* 百分比一律是全书进度（按字数加权），不是本章读了百分之多少。
                    PDF 本来就是全书页码；翻页模式再补上「本章第几页」，信息不丢。 */}
                {isPdf
                    ? `${pdfCurrentPage}/${pdfTotalPages || "?"}`
                    : `${Math.round(bookProgressFraction * 100)}%${isScrollMode ? "" : ` · ${txtDisplayedPage}/${txtTotalPages}`}`}
            </span>

            {/* Bottom bar — mirrors header style */}
            <footer className="reading-footer" ref={footerRef}>
                <div className="reading-footer-inner">
                    <div className="reading-footer-slider-row">
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.max(0, chapterIndex - 1))}
                            disabled={chapterIndex <= 0}
                        >
                            上一章
                        </button>
                        <div className="reading-footer-slider">
                            {(() => {
                                const currentVal = isPdf ? pdfCurrentPage : txtBookSliderValue;
                                const maxVal = isPdf ? Math.max(1, currentPageCount) : txtBookSliderMax;
                                const progressPct = maxVal > 1 ? ((currentVal - 1) / (maxVal - 1)) * 100 : 0;
                                return (
                                    <input
                                        type="range"
                                        className="reading-custom-slider"
                                        min={1}
                                        max={maxVal}
                                        step={isPdf ? 1 : 0.001}
                                        value={currentVal}
                                        onChange={(e) => handleNavPageSlider(Number(e.target.value))}
                                        aria-label={isPdf ? "跳转页码" : "跳转阅读进度"}
                                        style={{ '--slider-progress': `${progressPct}%` } as React.CSSProperties}
                                    />
                                );
                            })()}
                        </div>
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.min(chapters.length - 1, chapterIndex + 1))}
                            disabled={chapterIndex >= chapters.length - 1}
                        >
                            下一章
                        </button>
                    </div>
                    <div className="reading-footer-actions">
                        <button
                            type="button"
                            className={`reading-footer-icon-btn ${autoAnnotate ? "is-active" : ""}`}
                            onClick={openCharAnnotationsPanel}
                        >
                            <Highlighter size={22} strokeWidth={1.7} />
                            <span>TA的批注</span>
                        </button>
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={openMyAnnotationsPanel}
                        >
                            <Highlighter size={22} strokeWidth={1.7} />
                            <span>我的批注</span>
                        </button>
                        {isPdf && (
                            <button
                                type="button"
                                className="reading-footer-icon-btn"
                                onClick={openPdfPrefetchDialog}
                                disabled={generating || !companionId}
                            >
                                <Rocket size={22} strokeWidth={1.7} />
                                <span>预批注</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={openReadingSettings}
                        >
                            <Languages size={22} strokeWidth={1.7} />
                            <span>设置</span>
                        </button>
                    </div>
                </div>
            </footer>

            {!showChat && (
                <button
                    onClick={handleChatLaunchClick}
                    className="reading-chat-launch"
                    aria-label="打开聊天悬浮窗"
                    title="打开聊天悬浮窗"
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {companion?.avatar ? (
                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                    ) : (
                        <span className="ts-13">{companion?.name?.[0] || "?"}</span>
                    )}
                </button>
            )}

            {showChat && (
                <div
                    className={`reading-chat-float ${chatExpanded ? "reading-chat-float-expanded" : ""}${chatClosing ? " reading-chat-float--closing" : ""}`}
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {!chatExpanded ? (
                        <div className="reading-chat-float-compact">
                            <button
                                type="button"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setShowCharPicker(!showCharPicker); }}
                                className="reading-bottom-avatar"
                            >
                                {companion?.avatar ? (
                                    <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                ) : (
                                    <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                )}
                            </button>
                            <button
                                type="button"
                                className="reading-chat-float-trigger"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(true); closeCharPicker(); }}
                                disabled={!companionId}
                            >
                                {companion ? `和${companion.name}讨论该章节...` : "选择陪读角色"}
                                {chatMessages.length > 0 && <span className="ml-1 ts-11 text-[var(--c-icon-active)]">({chatMessages.length})</span>}
                            </button>
                            <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><ChevronRight size={16} strokeWidth={2} /></button>
                        </div>
                    ) : (
                        <>
                            <div className="reading-chat-float-header">
                                <div className="reading-bottom-avatar">
                                    {companion?.avatar ? (
                                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                    ) : (
                                        <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                    )}
                                </div>
                                <div className="reading-chat-float-header-copy">
                                    <span className="reading-chat-float-title">和{companion?.name || "AI"}讨论该章节</span>
                                    <span className="reading-chat-float-subtitle">拖拽任意位置移动</span>
                                </div>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(false); }} className="reading-chat-float-close" aria-label="收起聊天窗口"><ChevronDown size={18} strokeWidth={2} /></button>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><Minus size={18} strokeWidth={2} /></button>
                            </div>
                            <div ref={chatListRef} className="reading-chat-float-body" onClick={() => {
                                if (activeMessageId || readingMessageMenu) closeReadingMessageMenu();
                                if (activeAnnotationId) setActiveAnnotationId(null);
                            }} onScroll={() => {
                                if (readingMessageMenu) closeReadingMessageMenu();
                            }}>
                                {chatMessages.length === 0 && (
                                    <div className="text-center ts-13 text-[var(--c-icon)] py-6">和{companion?.name}聊聊这章内容吧</div>
                                )}
                                {chatMessages.map(msg => (
                                    <div key={msg.id} className="chat-msg-wrapper" data-role={msg.role}
                                        onPointerDown={(e) => { e.stopPropagation(); handleReadingMessagePointerDown(e, msg); }}
                                        onPointerUp={(e) => { e.stopPropagation(); cancelReadingMessageLongPress(); }}
                                        onPointerCancel={cancelReadingMessageLongPress}
                                        onPointerLeave={cancelReadingMessageLongPress}
                                        onPointerMove={handleReadingMessagePointerMove}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            cancelReadingMessageLongPress();
                                            setActiveAnnotationId(null);
                                            setActiveMessageId(msg.id);
                                            setReadingMessageMenu({ messageId: msg.id, x: e.clientX, y: e.clientY });
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (readingMessageMenu && readingMessageMenu.messageId !== msg.id) closeReadingMessageMenu();
                                        }}
                                    >
                                        <div className={`chat-bubble-role-${msg.role} rounded-lg ${msg.mediaType && ["sticker", "red_packet", "transfer", "image", "location", "music_share", "xiaohongshu_note_share"].includes(msg.mediaType) ? "chat-bubble-media" : "max-w-[80%]"} break-words relative`}
                                            data-ui={msg.role === "user" ? "bubble-user" : "bubble-bot"}
                                            {...(activeMessageId === msg.id ? { "data-active": "" } : {})}>
                                            <MessageBubble
                                                msg={msg}
                                                charName={companion?.name}
                                                userName=""
                                                characterId={companionId || undefined}
                                                onUpdate={m => setChatMessages(prev => prev.map(p => p.id === m.id ? m : p))}
                                                defaultTranslationExpanded={defaultTranslationExpanded}
                                            />
                                        </div>
                                    </div>
                                ))}
                                {chatting && <div className="ts-13 text-[var(--c-icon)] py-1">{companion?.name} 正在思考...</div>}
                            </div>
                            <div className="reading-chat-float-input">
                                <input
                                    value={chatInput}
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                    placeholder="输入消息..."
                                    className="ui-input flex-1"
                                    disabled={chatting}
                                />
                                <button
                                    onClick={handleSend}
                                    disabled={!chatInput.trim() || chatting}
                                    className="reading-chat-send-btn"
                                    aria-label="发送"
                                ><SendHorizontal size={18} strokeWidth={1.8} /></button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {activeReadingMenuMessage && readingMessageMenu && (
                <div
                    className="ctx-menu chat-floating-ctx-menu reading-chat-context-menu flex py-[6px] px-0"
                    data-role={activeReadingMenuMessage.role}
                    style={getReadingMessageMenuStyle(readingMessageMenu)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            copyToClipboard(activeReadingMenuMessage.content);
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn"
                    >复制</button>
                    <button
                        type="button"
                        onClick={() => handleEditDiscussMessageStart(activeReadingMenuMessage)}
                        className="ctx-menu-btn"
                    >编辑</button>
                    <button
                        type="button"
                        onClick={() => {
                            deleteChatMessage(activeReadingMenuMessage.id);
                            setChatMessages((prev) => prev.filter((msg) => msg.id !== activeReadingMenuMessage.id));
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >删除</button>
                </div>
            )}

            {editingDiscussMessage && (
                <ContentDialog
                    title="编辑共读消息"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={handleSaveDiscussMessageEdit}
                    onCancel={() => {
                        setEditingDiscussMessage(null);
                        setEditingDiscussContent("");
                    }}
                >
                    <div className="reading-discuss-edit">
                        <textarea
                            className="ui-textarea reading-discuss-edit-textarea"
                            value={editingDiscussContent}
                            onChange={(event) => setEditingDiscussContent(event.target.value)}
                            rows={6}
                        />
                    </div>
                </ContentDialog>
            )}

            {annotationDialogMode && (
                <ContentDialog
                    title={annotationDialogMode === "manual" ? "生成批注" : autoAnnotate ? "关闭自动批注" : "开启自动批注"}
                    confirmLabel={annotationDialogMode === "manual" ? "生成" : autoAnnotate ? "关闭" : "开启"}
                    cancelLabel="取消"
                    onConfirm={() => { void handleAnnotationDialogConfirm(); }}
                    onCancel={() => setAnnotationDialogMode(null)}
                >
                    <div className="reading-settings-grid">
                        {annotationDialogMode === "auto" && autoAnnotate ? (
                            <>
                                <div className="reading-settings-inline-note">
                                    <span>当前状态</span>
                                    <span>自动批注已开启</span>
                                </div>
                                <div className="reading-settings-inline-note">
                                    <span>批注单位</span>
                                    <span>{annotationBatchSize}{isPdf ? " 页" : " 段"}</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <label className="reading-settings-label">
                                    <span>
                                        {annotationDialogMode === "manual"
                                            ? (isPdf
                                                ? `从当前页开始，往后几页交给${companion?.name || "AI"}批注`
                                                : `从这一屏的第一段开始，往后几段交给${companion?.name || "AI"}批注（读完本章会接着下一章）`)
                                            : (isPdf
                                                ? `每批几页。开启后先生成当前页所在的一批，之后翻到新一批的第一页时自动生成`
                                                : `每批几段。开启后先生成当前段落所在的一批，之后读到新一批时自动生成`)}
                                    </span>
                                    <input
                                        value={annotationBatchInput}
                                        onChange={(e) => setAnnotationBatchInput(e.target.value.replace(/[^\d]/g, ""))}
                                        className="ui-input"
                                        inputMode="numeric"
                                    />
                                </label>
                                <div className="reading-settings-inline-note">
                                    <span>本次范围</span>
                                    <span>{annotationRangePreview || "（翻到正文页后才能算范围）"}</span>
                                </div>
                                <div className="reading-settings-inline-note">
                                    <span>默认值</span>
                                    <span>{isPdf ? "5 页" : "50 段"}</span>
                                </div>
                            </>
                        )}
                    </div>
                </ContentDialog>
            )}
            {pdfPrefetchDialogOpen && (
                <ContentDialog
                    title="PDF 预批注"
                    confirmLabel="开始预批注"
                    cancelLabel="取消"
                    onConfirm={() => { void handlePdfManualPrefetch(); }}
                    onCancel={() => setPdfPrefetchDialogOpen(false)}
                >
                    <div className="reading-settings-grid">
                        <p className="reading-settings-inline-note">
                            <span>为指定页码范围提前生成批注（先解析文本层再生成，翻到那里就是现成的）。</span>
                        </p>
                        <div className="reading-settings-inline-note">
                            <span>起始页</span>
                            <input
                                value={pdfPrefetchStartInput}
                                onChange={(e) => setPdfPrefetchStartInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>结束页</span>
                            <input
                                value={pdfPrefetchEndInput}
                                onChange={(e) => setPdfPrefetchEndInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <p className="reading-settings-inline-note">
                            <span>当前第 {Math.max(1, pdfCurrentPage)} / {Math.max(1, pdfTotalPages)} 页。一次最多 {MAX_MANUAL_PDF_PREFETCH_PAGES} 页。</span>
                        </p>
                        {annotationError && (
                            <p className="reading-settings-inline-note" style={{ color: "var(--c-danger)" }}>
                                <span>{annotationError}</span>
                            </p>
                        )}
                    </div>
                </ContentDialog>
            )}
            {selectionInfo && (
                <div
                    className="reading-selection-menu"
                    style={selectionMenuStyle(selectionInfo.placeAtTop, selectionInfo.topOffset, footerHeight)}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button type="button" onClick={() => addMark("highlight")}>高亮</button>
                    <button type="button" onClick={() => addMark("underline")}>划线</button>
                    <button type="button" onClick={splitNodeAtSelection}>设为章节节点</button>
                    <button type="button" onClick={clearSelection}>取消</button>
                </div>
            )}
            {markMenu && (
                <div
                    className="reading-mark-menu"
                    style={{ left: markMenu.x, top: markMenu.y + 8 }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button type="button" onClick={() => openShareDialog(markMenu.mark)}>分享</button>
                    <button type="button" onClick={() => {
                        const group = readingMarkGroup(marks, markMenu.mark);
                        setPendingQuote({
                            // 跨段划选时整段引用，锚点落在第一段
                            text: group.map(item => item.text).join("\n"),
                            chapterIndex: group[0].chapterIndex,
                            paragraphIndex: group[0].paragraphIndex,
                        });
                        setMyAnnotationText("");
                        setMarkMenu(null);
                        setShowMyAnnotation(true);
                    }}>批注</button>
                    {/* 分章节点的入口就放在这儿：划线之后出现的菜单里，
                        而不是阅读页上到处摆按钮——设节点是「读到某一章该在这里开始」时才做的事 */}
                    <button type="button" onClick={() => markSplitNodeAt(markMenu.mark)}>设置节点</button>
                    <button type="button" onClick={() => removeMark(markMenu.mark)}>删除</button>
                    <button type="button" onClick={() => setMarkMenu(null)}>取消</button>
                </div>
            )}
            {shareTarget && shareTarget.length > 0 && (() => {
                const first = shareTarget[0];
                const chapter = chapters[first.chapterIndex];
                // 这段话在全书的位置：章内按「这一段之前有多少字」算，再换算到全书
                const charsBefore = (chapter?.paragraphs || [])
                    .slice(0, first.paragraphIndex)
                    .reduce((sum, paragraph) => sum + paragraph.length, 0) + first.start;
                const chapterChars = chapterCharStats.lengths[first.chapterIndex] || 0;
                const withinChapter = chapterChars > 0 ? charsBefore / chapterChars : 0;
                // 这几段上已有的批注也能一起带进图里
                const markedParagraphs = new Set(shareTarget.map(item => `${item.chapterIndex}:${item.paragraphIndex}`));
                const relatedAnnotations = annotations
                    .filter(annotation => markedParagraphs.has(`${annotation.chapterIndex}:${annotation.paragraphIndex}`))
                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.createdAt.localeCompare(b.createdAt))
                    .map(annotation => ({
                        name: isUserAnnotation(annotation) ? (userDisplayName || "我") : (annotation.characterName || "TA"),
                        content: annotation.content,
                        authorType: (isUserAnnotation(annotation) ? "user" : "character") as "user" | "character",
                    }));
                return (
                    <ReadingShareDialog
                        quoteParagraphs={shareTarget.map(item => item.text)}
                        bookTitle={book.title}
                        bookAuthor={book.author || ""}
                        chapterTitle={chapter?.title || ""}
                        progressPercent={toBookFraction(first.chapterIndex, withinChapter) * 100}
                        annotations={relatedAnnotations}
                        onClose={() => setShareTarget(null)}
                    />
                );
            })()}
            {showCharAnnotationMenu && (
                <ContentDialog
                    title="TA的批注"
                    confirmLabel="关闭"
                    cancelLabel=""
                    onConfirm={() => setShowCharAnnotationMenu(false)}
                    onCancel={() => setShowCharAnnotationMenu(false)}
                >
                    <div className="reading-settings-grid">
                        {(() => {
                            const theirs = panelAnnotations.filter(a => !isUserAnnotation(a));
                            const indexes = Array.from(new Set(theirs.map(a => a.chapterIndex))).sort((a, b) => a - b);
                            const sections = indexes.map(index => {
                                const rows = theirs
                                    .filter(a => a.chapterIndex === index)
                                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex);
                                return {
                                    index,
                                    count: rows.length,
                                    rows: (
                                        <>
                                            {rows.map(annotation => (
                                                <div key={annotation.id} className="reading-mark-row">
                                                    <span className="reading-my-annotation-row-body">
                                                        {annotation.quote && <span className="reading-my-annotation-row-quote">{annotation.quote.slice(0, 40)}</span>}
                                                        <span>{annotation.content}</span>
                                                    </span>
                                                    <button type="button" onClick={() => { void removeAnnotationEverywhere(annotation.id); }}>删除</button>
                                                </div>
                                            ))}
                                        </>
                                    ),
                                };
                            });
                            return renderChapterFoldList(sections, "TA 还没有在这本书上写批注");
                        })()}
                    </div>
                </ContentDialog>
            )}
            {showMyMarksPanel && (
                <ContentDialog
                    title="我的批注"
                    confirmLabel="关闭"
                    cancelLabel=""
                    onConfirm={() => setShowMyMarksPanel(false)}
                    onCancel={() => setShowMyMarksPanel(false)}
                >
                    <div className="reading-settings-grid">
                        {(() => {
                            const indexes = Array.from(new Set([
                                ...panelAnnotations.filter(isUserAnnotation).map(a => a.chapterIndex),
                                ...marks.map(m => m.chapterIndex),
                            ])).sort((a, b) => a - b);

                            const sections = indexes.map(index => {
                                const mine = panelAnnotations
                                    .filter(a => a.chapterIndex === index && isUserAnnotation(a))
                                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex);
                                // 跨段划选出来的几条是一次划选，这里按组合成一行，
                                // 否则一次跨三段的高亮会在列表里排成三条，看着像划了三次
                                const groupedMarks = new Map<string, ReadingMark[]>();
                                for (const mark of marks.filter(m => m.chapterIndex === index)) {
                                    const key = readingMarkGroupId(mark);
                                    const bucket = groupedMarks.get(key);
                                    if (bucket) bucket.push(mark);
                                    else groupedMarks.set(key, [mark]);
                                }
                                // 已经写了批注的标记不再单独列一条：批注那条里就带着这段原文
                                const annotatedQuotes = new Set(mine.map(a => (a.quote ?? "").replace(/\s+/g, "")));
                                const chapterMarks = [...groupedMarks.values()]
                                    .map(group => group.sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.start - b.start))
                                    .filter(group => !annotatedQuotes.has(group.map(m => m.text).join("").replace(/\s+/g, "")))
                                    .sort((a, b) => a[0].paragraphIndex - b[0].paragraphIndex || a[0].start - b[0].start);
                                return {
                                    index,
                                    count: mine.length + chapterMarks.length,
                                    rows: (
                                        <>
                                            {mine.map(annotation => (
                                                <div key={annotation.id} className="reading-mark-row">
                                                    <span className="reading-my-annotation-row-body">
                                                        {annotation.quote && <span className="reading-my-annotation-row-quote">{annotation.quote.slice(0, 40)}</span>}
                                                        <span>{annotation.content}</span>
                                                    </span>
                                                    <button type="button" onClick={() => { void removeAnnotationEverywhere(annotation.id); }}>删除</button>
                                                </div>
                                            ))}
                                            {chapterMarks.map(group => (
                                                <div key={group[0].id} className="reading-mark-row">
                                                    <span className="reading-mark" data-style={group[0].style}>
                                                        {group.map(mark => mark.text).join("").slice(0, 40)}
                                                    </span>
                                                    <button type="button" onClick={() => {
                                                        const ids = new Set(group.map(mark => mark.id));
                                                        group.forEach(mark => deleteReadingMark(book.id, mark.id));
                                                        setMarks(prev => prev.filter(item => !ids.has(item.id)));
                                                    }}>删除</button>
                                                </div>
                                            ))}
                                        </>
                                    ),
                                };
                            }).filter(section => section.count > 0);

                            return renderChapterFoldList(sections, "这本书还没有你的批注或标记");
                                                })()}
                    </div>
                </ContentDialog>
            )}
            {editingAnnotation && (
                <ContentDialog
                    title={isUserAnnotation(editingAnnotation) ? "编辑我的批注" : `编辑${editingAnnotation.characterName || "TA"}的批注`}
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={() => { void saveEditedAnnotation(); }}
                    onCancel={() => { setEditingAnnotation(null); setEditingText(""); }}
                >
                    <div className="reading-settings-grid">
                        {editingAnnotation.quote && (
                            <div className="reading-my-annotation-quote">{editingAnnotation.quote}</div>
                        )}
                        <textarea
                            className="reading-my-annotation-input"
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={5}
                            autoFocus
                        />
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>改完之后记忆区里那条也会跟着改。</span>
                        </div>
                    </div>
                </ContentDialog>
            )}
            {showMyAnnotation && pendingQuote && (
                <ContentDialog
                    title="我的批注"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={() => { void saveMyAnnotation(); }}
                    onCancel={() => { setShowMyAnnotation(false); setPendingQuote(null); }}
                >
                    <div className="reading-settings-grid">
                        <div className="reading-my-annotation-quote">{pendingQuote.text}</div>
                        <textarea
                            className="reading-my-annotation-input"
                            value={myAnnotationText}
                            onChange={(e) => setMyAnnotationText(e.target.value)}
                            placeholder="写下你对这一段的想法……"
                            rows={4}
                        />
                    </div>
                </ContentDialog>
            )}
            {showRangeSummary && (
                <ContentDialog
                    title="总结内容"
                    confirmLabel={summaryDraft.trim() ? "存进记忆" : "关闭"}
                    cancelLabel="取消"
                    onConfirm={() => { if (summaryDraft.trim()) saveRangeSummary(); else setShowRangeSummary(false); }}
                    onCancel={() => setShowRangeSummary(false)}
                >
                    <div className="reading-settings-grid">
                        <label className="reading-settings-label">
                            <span>从</span>
                            <Select
                                value={String(summaryRange.start)}
                                onChange={(e) => setSummaryRange(prev => ({ ...prev, start: Number(e.target.value) }))}
                            >
                                {chapters.map(chapter => (
                                    <option key={chapter.id} value={chapter.index}>
                                        {chapter.title?.trim() || `第${chapter.index + 1}章`}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <label className="reading-settings-label">
                            <span>到</span>
                            <Select
                                value={String(summaryRange.end)}
                                onChange={(e) => setSummaryRange(prev => ({ ...prev, end: Number(e.target.value) }))}
                            >
                                {chapters.map(chapter => (
                                    <option key={chapter.id} value={chapter.index}>
                                        {chapter.title?.trim() || `第${chapter.index + 1}章`}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { void runRangeSummary(); }}
                            disabled={summaryBusy || !companionId}
                        >
                            {summaryBusy ? "总结中…" : summaryDraft ? "重新总结" : "生成总结"}
                        </button>
                        {summaryDraft && (
                            <textarea
                                className="reading-my-annotation-input"
                                value={summaryDraft}
                                onChange={(e) => setSummaryDraft(e.target.value)}
                                rows={4}
                            />
                        )}
                        {summaryNote && (
                            <div className="reading-settings-inline-note"><span>{summaryNote}</span></div>
                        )}
                        {summaryMemos.length > 0 && (
                            <>
                                <div className="reading-settings-inline-note">
                                    <span>已存的摘要</span>
                                </div>
                                {summaryMemos.map(memo => (
                                    <div key={memo.id} className="reading-mark-row">
                                        <span className="reading-my-annotation-row-body">
                                            <span className="reading-my-annotation-row-quote">{memo.rangeLabel || memo.chapterTitle}</span>
                                            <span>{memo.content}</span>
                                        </span>
                                        <button type="button" onClick={() => {
                                            deleteReadingAnnotationMemo(memo.id);
                                            setSummaryMemos(prev => prev.filter(item => item.id !== memo.id));
                                        }}>删除</button>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showTranslationDialog && (
                <ContentDialog
                    title="批注翻译"
                    confirmLabel="完成"
                    cancelLabel="关闭"
                    onConfirm={() => setShowTranslationDialog(false)}
                    onCancel={() => setShowTranslationDialog(false)}
                >
                    <div className="reading-settings-grid">
                        <div className="reading-settings-inline-note">
                            <span>启用阅读双语翻译</span>
                            <Toggle
                                checked={bilingualTranslationEnabled}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, bilingualTranslationEnabled: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>折叠中文译文</span>
                            <Toggle
                                checked={readingConfig.collapseBilingualTranslation === true}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, collapseBilingualTranslation: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>只翻译 AI 讨论消息和 AI 批注，不翻书正文</span>
                        </div>
                        {bilingualTranslationEnabled && (
                            <div className="reading-settings-prompt">
                                <div className="reading-settings-prompt-head">
                                    <span>双语提示词</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = {
                                                ...readingConfig,
                                                bilingualTranslationPrompt: DEFAULT_READING_INTERACTION_CONFIG.bilingualTranslationPrompt,
                                            };
                                            setReadingConfig(next);
                                            saveReadingInteractionConfig(next);
                                        }}
                                    >
                                        恢复默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input"
                                    rows={7}
                                    value={readingConfig.bilingualTranslationPrompt}
                                    onChange={(event) => {
                                        const next = { ...readingConfig, bilingualTranslationPrompt: event.target.value };
                                        setReadingConfig(next);
                                        saveReadingInteractionConfig(next);
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showReadingSettings && (
                <ContentDialog
                    title="阅读设置"
                    confirmLabel="完成"
                    cancelLabel="关闭"
                    onConfirm={handleReadingSettingsConfirm}
                    onCancel={() => setShowReadingSettings(false)}
                >
                    <div className="reading-settings-grid">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openAnnotationDialog("manual"); }}
                            disabled={generating || !companionId}
                        >
                            现在批注
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openAnnotationDialog("auto"); }}
                        >
                            {autoAnnotate ? "自动批注：已开启" : "自动批注：已关闭"}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openRangeSummary(); }}
                            disabled={!companionId}
                        >
                            总结内容
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => setShowBookmarks(true)}
                        >
                            书签{bookmarks.length > 0 ? `（${bookmarks.length}）` : ""}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { void exportAnnotations(); }}
                        >
                            导出全书批注（Markdown）
                        </button>
                        {exportNote && (
                            <div className="reading-settings-inline-note"><span>{exportNote}</span></div>
                        )}
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); setShowTranslationDialog(true); }}
                        >
                            批注翻译
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); setShowBookSettings(true); }}
                        >
                            本书更多设置（排版 · 章节{isPdf ? "" : ` · 节点 ${splitNodes.length}`}）
                        </button>
                        <div className="reading-settings-inline-note">
                            <span>批注密度</span>
                            <span className="reading-interval-row">
                                每
                                <input
                                    className="reading-interval-input"
                                    type="number"
                                    min={0}
                                    max={999}
                                    step={1}
                                    inputMode="numeric"
                                    value={readingConfig.annotationInterval}
                                    onChange={(e) => {
                                        const parsed = Math.floor(Number(e.target.value));
                                        const next = {
                                            ...readingConfig,
                                            annotationInterval: Number.isFinite(parsed) ? Math.min(999, Math.max(0, parsed)) : 0,
                                        };
                                        setReadingConfig(next);
                                        saveReadingInteractionConfig(next);
                                    }}
                                />
                                段 1 条
                            </span>
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>批注密度填 0 表示不限，由角色自己决定写多少</span>
                        </div>
                        {isPdf && (
                            <section className="reading-settings-group">
                                <div className="reading-settings-heading">
                                    <ZoomIn size={15} />
                                    <span>PDF 渲染</span>
                                </div>
                                <div className="reading-settings-toggle-row">
                                    <span className="reading-settings-toggle-label">预加载后续页</span>
                                    <Toggle
                                        checked={pdfRenderDraft.pdfPreloadEnabled}
                                        onChange={(next) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadEnabled: next }))}
                                    />
                                </div>
                                <p className="reading-settings-inline-note">
                                    <span>开启后阅读时会提前渲染当前页之后的页面，滚动更平滑；关闭则只渲染屏幕内的页。</span>
                                </p>
                                <div className="reading-settings-inline-note">
                                    <span>页面缩放率</span>
                                    <span>{Math.round(pdfRenderDraft.pdfZoom * 100)}%</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={0.5}
                                    max={2}
                                    step={0.05}
                                    value={pdfRenderDraft.pdfZoom}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfZoom: Number(e.target.value) }))}
                                />
                                <div className="reading-settings-inline-note">
                                    <span>一次渲染页数（当前页前后各几页）</span>
                                    <span>{pdfRenderDraft.pdfPreloadRadius} 页</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={1}
                                    max={8}
                                    step={1}
                                    value={pdfRenderDraft.pdfPreloadRadius}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadRadius: Number(e.target.value) }))}
                                />
                                <p className="reading-settings-inline-note">
                                    <span>提示：一次渲染页数过少时，滑动到未渲染的页会反复渲染，造成闪烁卡顿；调大并开启预加载可缓解。缩放率调大后一页更接近一屏。</span>
                                </p>
                            </section>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showBookmarks && (
                <ContentDialog
                    title="书签"
                    confirmLabel=""
                    cancelLabel="关闭"
                    onConfirm={() => setShowBookmarks(false)}
                    onCancel={() => setShowBookmarks(false)}
                >
                    {bookmarks.length === 0 ? (
                        <p className="reading-bookmark-empty">还没有书签。读到想记住的地方，点右上角的书签图标。</p>
                    ) : (
                        <div className="reading-bookmark-list">
                            {bookmarks.map((bookmark) => (
                                <div key={bookmark.id} className="reading-bookmark-row">
                                    <button
                                        type="button"
                                        className="reading-bookmark-jump"
                                        onClick={() => jumpToBookmark(bookmark)}
                                    >
                                        <span className="reading-bookmark-where">
                                            {bookmark.chapterTitle}
                                            <span className="reading-bookmark-at">
                                                {bookmark.pdfPage ? `第${bookmark.pdfPage}页` : `${Math.round(bookmark.fraction * 100)}%`}
                                            </span>
                                        </span>
                                        {bookmark.excerpt && (
                                            <span className="reading-bookmark-excerpt">{bookmark.excerpt}</span>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        className="reading-bookmark-remove"
                                        onClick={() => { void removeBookmark(bookmark.id); }}
                                        aria-label={`删除书签 ${bookmark.chapterTitle}`}
                                    >
                                        <X size={15} strokeWidth={2} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </ContentDialog>
            )}

            {showBookSettings && (
                <ReadingBookSettings
                    book={book}
                    chapters={chapters}
                    current={{
                        chapterIndex,
                        within: isScrollMode
                            ? scrollFraction
                            : (txtTotalPages > 0 ? txtPage / txtTotalPages : 0),
                    }}
                    onClose={() => setShowBookSettings(false)}
                    onChaptersRenamed={(nextChapters) => {
                        // 只改了章名：章节对象换掉即可，阅读位置、分页、批注锚点都不受影响
                        setChapters(nextChapters);
                    }}
                    onJumpToNode={(targetChapterIndex) => {
                        setShowBookSettings(false);
                        goToChapter(targetChapterIndex);
                    }}
                    onApplied={(nextChapters, position) => {
                        setShowBookSettings(false);
                        setChapters(nextChapters);
                        // 划线与批注都换了锚点，内存里的副本必须重新读，否则会指着旧章号
                        setMarks(loadReadingMarks(book.id));
                        generatedBatchesRef.current.clear();
                        prefetchedBatchStartRef.current = -1;
                        const nextIndex = position ? position.chapterIndex : 0;
                        setChapterIndex(nextIndex);
                        setTxtPage(0);
                        if (isScrollMode) {
                            // 滚动模式按章内比例恢复位置
                            const within = position ? position.within : 0;
                            initialScrollFractionRef.current = within;
                            pendingScrollFractionRef.current = within;
                        }
                    }}
                />
            )}

            {showNavigationDialog && (
                <>
                    <div className="reading-nav-backdrop" onClick={() => setShowNavigationDialog(false)} />
                    <aside className="reading-nav-drawer">
                        <header className="reading-nav-header">
                            <span className="reading-nav-title">导航</span>
                            {!isPdf && (
                                <button
                                    type="button"
                                    className="reading-footer-text-btn"
                                    onClick={() => {
                                        setShowNavigationDialog(false);
                                        setShowBookSettings(true);
                                    }}
                                >
                                    更多设置
                                </button>
                            )}
                            <button type="button" className="reading-nav-close" onClick={() => setShowNavigationDialog(false)} aria-label="关闭">
                                <X size={18} strokeWidth={2} />
                            </button>
                        </header>
                        <div className="reading-nav-chapter-count">共{chapters.length}章</div>
                        <div className="reading-nav-chapter-list">
                            {chapters.map((chapter, index) => {
                                const charCount = chapter.paragraphs.reduce((sum, p) => sum + p.replace(/\s+/g, "").length, 0);
                                // 书自带目录里的层级：每深一层多缩进一点，最多缩三层
                                const navIndent = chapter.tocLevel
                                    ? { paddingLeft: `${16 + Math.min(chapter.tocLevel, 3) * 14}px` }
                                    : undefined;
                                const pageLabel = isPdf && chapter.pageStart ? chapter.pageStart : null;
                                return (
                                    <button
                                        key={chapter.id}
                                        type="button"
                                        className={`reading-nav-chapter-item${index === chapterIndex ? " is-active" : ""}`}
                                        onClick={() => handleNavChapterClick(index)}
                                        style={navIndent}
                                    >
                                        <div className="reading-nav-chapter-main">
                                            <span className="reading-nav-chapter-name">{chapter.title || `第${index + 1}章`}</span>
                                            <span className="reading-nav-chapter-meta">{charCount > 0 ? `${charCount}字` : ""}</span>
                                        </div>
                                        {pageLabel && <span className="reading-nav-chapter-page">{pageLabel}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </aside>
                </>
            )}
        </div>
    );
}
