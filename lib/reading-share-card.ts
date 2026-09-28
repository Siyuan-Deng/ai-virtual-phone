"use client";

import type { ReadingMarkStyle } from "./reading-types";
import { readingMarkColor } from "./reading-appearance";

/** 摘抄图的排版模板。差别只在配色和「正文怎么摆」，画法是同一套。 */
export type ReadingShareTemplate = "paper" | "note" | "night" | "minimal";

export const READING_SHARE_TEMPLATES: Array<{ id: ReadingShareTemplate; label: string; hint: string }> = [
    { id: "paper", label: "素笺", hint: "米色纸面，左对齐" },
    { id: "note", label: "便签", hint: "和书里的批注卡片一个样子" },
    { id: "night", label: "夜读", hint: "深色底，浅色字" },
    { id: "minimal", label: "留白", hint: "白底居中，只留必要信息" },
];

export type ReadingShareAnnotation = { name: string; content: string };

export type ReadingShareCardInput = {
    template: ReadingShareTemplate;
    /** 摘抄正文，一段一条 */
    quoteParagraphs: string[];
    bookTitle: string;
    chapterTitle: string;
    /** 阅读账号里的 ID；空着就不画署名那一行 */
    userName: string;
    avatar: CanvasImageSource | null;
    /** 这段话在全书的位置，0-100 */
    progressPercent: number;
    annotations: ReadingShareAnnotation[];
    /** 正文字体，跟阅读设置走 */
    fontFamily: string;
    markStyle: ReadingMarkStyle;
    markColor: string;
};

type Palette = {
    background: string;
    ink: string;
    sub: string;
    accent: string;
    /** 正文是否画在一张卡片上（便签模板） */
    card?: string;
    align: "left" | "center";
    /** 正文首尾的引号装饰 */
    quoteMark: boolean;
};

const PALETTES: Record<ReadingShareTemplate, Palette> = {
    paper: { background: "#f5efe1", ink: "#33291d", sub: "#8b7c66", accent: "#bb9b5e", align: "left", quoteMark: true },
    note: { background: "#ece3d0", ink: "#3a3120", sub: "#857349", accent: "#c3a45c", card: "#fff1a8", align: "left", quoteMark: false },
    night: { background: "#17171c", ink: "#eae6dd", sub: "#8b857a", accent: "#c9a768", align: "left", quoteMark: true },
    minimal: { background: "#ffffff", ink: "#1b1b1b", sub: "#a2a2a2", accent: "#1b1b1b", align: "center", quoteMark: false },
};

const WIDTH = 1080;
const PADDING = 88;
const QUOTE_SIZE = 40;
const QUOTE_LINE = 1.9;
const META_SIZE = 25;
const NAME_SIZE = 30;
const ANNOTATION_SIZE = 26;
const AVATAR = 84;
const META_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif';

/** 不该出现在行首的标点。中文排版里把它们拽回上一行，比断在行首好看得多。 */
const NO_LINE_START = "，。、；：？！）】》」』”’…—·,.;:?!)]}>";
/** 不该出现在行尾的标点 */
const NO_LINE_END = "（【《「『“‘([{<";

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const char of Array.from(text)) {
        const candidate = current + char;
        if (current && ctx.measureText(candidate).width > maxWidth) {
            let line = current;
            let carry = char;
            // 行首禁则：把标点留在上一行
            if (NO_LINE_START.includes(char)) {
                line = candidate;
                carry = "";
            } else if (line.length > 1 && NO_LINE_END.includes(line[line.length - 1])) {
                // 行尾禁则：把开引号一类的符号挪到下一行
                carry = line[line.length - 1] + carry;
                line = line.slice(0, -1);
            }
            lines.push(line);
            current = carry;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

type Block =
    | { kind: "quote"; lines: string[] }
    | { kind: "annotation"; name: string; lines: string[] };

/** 先排一遍版算出总高度，再真正开画——画布高度必须在画之前定下来。 */
function layout(ctx: CanvasRenderingContext2D, input: ReadingShareCardInput, innerWidth: number) {
    const palette = PALETTES[input.template];
    const cardPadding = palette.card ? 40 : 0;
    const quoteWidth = innerWidth - cardPadding * 2;

    ctx.font = `${QUOTE_SIZE}px ${input.fontFamily}`;
    const quoteBlocks: Block[] = input.quoteParagraphs
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => ({ kind: "quote" as const, lines: wrapText(ctx, paragraph, quoteWidth) }));

    ctx.font = `${ANNOTATION_SIZE}px ${META_FONT}`;
    const annotationBlocks: Block[] = input.annotations
        .filter((annotation) => annotation.content.trim())
        .map((annotation) => ({
            kind: "annotation" as const,
            name: annotation.name,
            lines: wrapText(ctx, annotation.content.trim(), innerWidth - 40),
        }));

    const quoteLineHeight = Math.round(QUOTE_SIZE * QUOTE_LINE);
    const annotationLineHeight = Math.round(ANNOTATION_SIZE * 1.7);

    let height = PADDING;
    height += META_SIZE + 44;                                    // 书名 / 章节
    if (palette.quoteMark) height += 46;                         // 开引号
    height += cardPadding;
    quoteBlocks.forEach((block, index) => {
        height += block.lines.length * quoteLineHeight;
        if (index < quoteBlocks.length - 1) height += Math.round(quoteLineHeight * 0.45);
    });
    height += cardPadding;
    if (palette.quoteMark) height += 24;
    if (annotationBlocks.length > 0) {
        height += 52;                                            // 分隔线
        annotationBlocks.forEach((block) => {
            height += ANNOTATION_SIZE + 18;                       // 署名
            height += block.lines.length * annotationLineHeight;
            height += 30;
        });
    }
    height += 56;                                                // 页脚上方留白
    height += Math.max(AVATAR, NAME_SIZE + META_SIZE + 10);      // 页脚
    height += PADDING;

    return { palette, quoteBlocks, annotationBlocks, quoteLineHeight, annotationLineHeight, cardPadding, height: Math.round(height) };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** 画出摘抄图。返回的 canvas 已经是最终像素，直接 toBlob 就能存。 */
export function renderReadingShareCard(input: ReadingShareCardInput): HTMLCanvasElement {
    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) throw new Error("当前浏览器不支持生成图片");

    const innerWidth = WIDTH - PADDING * 2;
    const plan = layout(measureCtx, input, innerWidth);
    const { palette } = plan;

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持生成图片");

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, WIDTH, plan.height);
    ctx.textBaseline = "alphabetic";

    const centerX = WIDTH / 2;
    const left = PADDING;
    const alignX = palette.align === "center" ? centerX : left;
    ctx.textAlign = palette.align === "center" ? "center" : "left";

    let y = PADDING + META_SIZE;

    // ── 书名 · 章节 ──
    ctx.font = `${META_SIZE}px ${META_FONT}`;
    ctx.fillStyle = palette.sub;
    const heading = [input.bookTitle, input.chapterTitle].filter(Boolean).join(" · ");
    ctx.fillText(heading, alignX, y);
    y += 44;

    // ── 正文 ──
    if (palette.quoteMark) {
        ctx.font = `64px ${META_FONT}`;
        ctx.fillStyle = palette.accent;
        ctx.globalAlpha = 0.5;
        ctx.fillText("“", alignX, y + 30);
        ctx.globalAlpha = 1;
        y += 46;
    }

    if (palette.card) {
        const cardTop = y;
        const cardHeight = plan.cardPadding * 2 + plan.quoteBlocks.reduce(
            (sum, block, index) => sum + block.lines.length * plan.quoteLineHeight
                + (index < plan.quoteBlocks.length - 1 ? Math.round(plan.quoteLineHeight * 0.45) : 0),
            0,
        );
        ctx.fillStyle = palette.card;
        roundedRect(ctx, left, cardTop, innerWidth, cardHeight, 6);
        ctx.fill();
        // 卡片顶上那截胶带，和阅读界面里的批注卡片保持一致
        ctx.fillStyle = readingMarkColor(palette.card, 0.55);
        ctx.save();
        ctx.translate(left + 56, cardTop - 10);
        ctx.rotate(0.02);
        ctx.fillRect(0, 0, 120, 26);
        ctx.restore();
    }

    y += plan.cardPadding;
    ctx.font = `${QUOTE_SIZE}px ${input.fontFamily}`;
    plan.quoteBlocks.forEach((block, blockIndex) => {
        block.lines.forEach((line) => {
            const lineWidth = ctx.measureText(line).width;
            const lineLeft = palette.align === "center" ? centerX - lineWidth / 2 : left + plan.cardPadding;
            const baseline = y + QUOTE_SIZE;
            if (input.markStyle === "highlight") {
                ctx.fillStyle = readingMarkColor(input.markColor, 0.45);
                ctx.fillRect(lineLeft - 6, baseline - QUOTE_SIZE + 4, lineWidth + 12, QUOTE_SIZE + 10);
            } else {
                ctx.fillStyle = readingMarkColor(input.markColor, 0.85);
                ctx.fillRect(lineLeft, baseline + 12, lineWidth, 3);
            }
            ctx.fillStyle = palette.ink;
            ctx.fillText(line, palette.align === "center" ? centerX : left + plan.cardPadding, baseline);
            y += plan.quoteLineHeight;
        });
        if (blockIndex < plan.quoteBlocks.length - 1) y += Math.round(plan.quoteLineHeight * 0.45);
    });
    y += plan.cardPadding;
    if (palette.quoteMark) y += 24;

    // ── 批注 ──
    if (plan.annotationBlocks.length > 0) {
        y += 26;
        ctx.strokeStyle = palette.sub;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(WIDTH - PADDING, y);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        y += 26;

        plan.annotationBlocks.forEach((block) => {
            if (block.kind !== "annotation") return;
            ctx.font = `600 ${ANNOTATION_SIZE}px ${META_FONT}`;
            ctx.fillStyle = palette.accent;
            ctx.fillText(block.name, alignX, y + ANNOTATION_SIZE);
            y += ANNOTATION_SIZE + 18;
            ctx.font = `${ANNOTATION_SIZE}px ${META_FONT}`;
            ctx.fillStyle = palette.sub;
            block.lines.forEach((line) => {
                ctx.fillText(line, alignX, y + ANNOTATION_SIZE);
                y += plan.annotationLineHeight;
            });
            y += 30;
        });
    }

    // ── 页脚：头像 + ID + 进度 ──
    // 刚开头的那几句算出来是 0%，「读到全书 0%」读起来像没读，最少给 1%
    const progressText = `读到全书 ${Math.min(100, Math.max(1, Math.round(input.progressPercent)))}%`;
    y = plan.height - PADDING - Math.max(AVATAR, NAME_SIZE + META_SIZE + 10);
    const footerCenterY = y + AVATAR / 2;
    const hasAvatarSlot = Boolean(input.userName || input.avatar);

    // 居中模板里页脚也要居中，不然正文居中、署名贴左，看着像没排完
    ctx.font = `${NAME_SIZE}px ${META_FONT}`;
    const nameWidth = input.userName ? ctx.measureText(input.userName).width : 0;
    ctx.font = `${META_SIZE}px ${META_FONT}`;
    const progressWidth = ctx.measureText(progressText).width;
    const textWidth = Math.max(nameWidth, progressWidth);
    const footerWidth = (hasAvatarSlot ? AVATAR + 24 : 0) + textWidth;
    const footerLeft = palette.align === "center" ? Math.round(centerX - footerWidth / 2) : left;

    if (hasAvatarSlot) {
        if (input.avatar) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(footerLeft + AVATAR / 2, footerCenterY, AVATAR / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(input.avatar, footerLeft, y, AVATAR, AVATAR);
            ctx.restore();
        } else {
            ctx.beginPath();
            ctx.arc(footerLeft + AVATAR / 2, footerCenterY, AVATAR / 2, 0, Math.PI * 2);
            ctx.fillStyle = readingMarkColor(palette.accent, 0.25);
            ctx.fill();
            ctx.textAlign = "center";
            ctx.font = `${NAME_SIZE}px ${META_FONT}`;
            ctx.fillStyle = palette.accent;
            ctx.fillText(Array.from(input.userName || "读")[0], footerLeft + AVATAR / 2, footerCenterY + NAME_SIZE / 3);
        }
    }

    const textLeft = footerLeft + (hasAvatarSlot ? AVATAR + 24 : 0);
    ctx.textAlign = "left";
    if (input.userName) {
        ctx.font = `${NAME_SIZE}px ${META_FONT}`;
        ctx.fillStyle = palette.ink;
        ctx.fillText(input.userName, textLeft, footerCenterY - 4);
        ctx.font = `${META_SIZE}px ${META_FONT}`;
        ctx.fillStyle = palette.sub;
        ctx.fillText(progressText, textLeft, footerCenterY + META_SIZE + 4);
    } else {
        ctx.font = `${META_SIZE}px ${META_FONT}`;
        ctx.fillStyle = palette.sub;
        ctx.fillText(progressText, textLeft, footerCenterY + META_SIZE / 3);
    }

    return canvas;
}

export function readingShareCardToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("图片生成失败"))),
            "image/png",
        );
    });
}
