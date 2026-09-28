"use client";

import { readingMarkColor } from "./reading-appearance";

/** 摘抄图的排版模板。每个模板是一套完整的版面，不是同一套版面换配色。 */
export type ReadingShareTemplate =
    | "poster"    // 大字报：首段放大成主视觉，底部色带压住
    | "bookmark"  // 书签条：窄长一条，像夹在书里的那张纸
    | "magazine"  // 杂志双栏：分栏正文 + 巨大的百分比
    | "minimal"   // 极简留白：居中，大量留白
    | "collage"   // 色块拼贴：不对称色块压字
    | "letter"    // 横格信笺：正文压在格线上
    | "sticky";   // 便利贴：白纸 + 两张贴上去的批注

export const READING_SHARE_TEMPLATES: Array<{ id: ReadingShareTemplate; label: string }> = [
    { id: "poster", label: "大字报" },
    { id: "bookmark", label: "书签条" },
    { id: "magazine", label: "杂志" },
    { id: "minimal", label: "留白" },
    { id: "collage", label: "色块" },
    { id: "letter", label: "信笺" },
    { id: "sticky", label: "便利贴" },
];

export type ReadingShareAnnotation = {
    name: string;
    content: string;
    /** 自己写的和角色写的各用各自配置的字体和便签色 */
    authorType: "user" | "character";
};

export type ReadingShareFonts = {
    /** 正文——以及除批注外的一切文字 */
    body: string;
    userAnnotation: string;
    charAnnotation: string;
};

export type ReadingSharePalette = {
    background: string;
    ink: string;
    sub: string;
    accent: string;
};

export type ReadingShareCardInput = {
    template: ReadingShareTemplate;
    /** 摘抄正文，一段一条 */
    quoteParagraphs: string[];
    bookTitle: string;
    bookAuthor: string;
    chapterTitle: string;
    /** 阅读账号里的 ID；空着就写「读者」，署名位始终在 */
    userName: string;
    avatar: CanvasImageSource | null;
    /** 这段话在全书的位置，0-100 */
    progressPercent: number;
    annotations: ReadingShareAnnotation[];
    /** 批注便签的底色，和阅读界面里的批注卡片一致 */
    annotationColors: { user: string; character: string };
    fonts: ReadingShareFonts;
    timestamp: Date;
    /** 用户在分享界面上改过的配色；没改就用模板自己的 */
    palette?: Partial<ReadingSharePalette>;
    /** 正文对齐；没给就用模板默认 */
    align?: "left" | "center";
};

/** 每个模板的出厂配色和默认对齐 */
export const READING_SHARE_TEMPLATE_PRESETS: Record<
    ReadingShareTemplate,
    ReadingSharePalette & { align: "left" | "center" }
> = {
    poster: { background: "#141414", ink: "#f4f1ea", sub: "#b0aa9d", accent: "#e4c15a", align: "left" },
    bookmark: { background: "#ded8cc", ink: "#2f2a20", sub: "#9b8f78", accent: "#c0a463", align: "left" },
    magazine: { background: "#ffffff", ink: "#161616", sub: "#8f8f8f", accent: "#161616", align: "left" },
    minimal: { background: "#fcfcfc", ink: "#171717", sub: "#a8a8a8", accent: "#cfcfcf", align: "center" },
    collage: { background: "#f4f1ec", ink: "#f3efe7", sub: "#4a453c", accent: "#2b4a6f", align: "left" },
    letter: { background: "#fdfcf7", ink: "#2b2720", sub: "#9b8f78", accent: "#e4dcc8", align: "left" },
    sticky: { background: "#efeae1", ink: "#262119", sub: "#8a8071", accent: "#b9a98c", align: "left" },
};

const WIDTH = 1080;

/** 不该出现在行首 / 行尾的标点。中文排版的基本禁则。 */
const NO_LINE_START = "，。、；：？！）】》」』”’…—·,.;:?!)]}>";
const NO_LINE_END = "（【《「『“‘([{<";

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const char of Array.from(text)) {
        const candidate = current + char;
        if (current && ctx.measureText(candidate).width > maxWidth) {
            let line = current;
            let carry = char;
            if (NO_LINE_START.includes(char)) {
                line = candidate;
                carry = "";
            } else if (line.length > 1 && NO_LINE_END.includes(line[line.length - 1])) {
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

/** 画布笔。dry = true 时只走版面计算不落笔——用同一段代码量高度再画，
 *  所以「量出来的高度」和「画出来的内容」不可能对不上。 */
class Pen {
    constructor(readonly ctx: CanvasRenderingContext2D, readonly dry: boolean) {}

    font(size: number, family: string, weight = ""): void {
        this.ctx.font = `${weight ? `${weight} ` : ""}${size}px ${family}`;
    }

    measure(text: string): number {
        return this.ctx.measureText(text).width;
    }

    text(content: string, x: number, baseline: number, color: string, align: CanvasTextAlign = "left"): void {
        if (this.dry) return;
        this.ctx.fillStyle = color;
        this.ctx.textAlign = align;
        this.ctx.fillText(content, x, baseline);
        this.ctx.textAlign = "left";
    }

    rect(x: number, y: number, w: number, h: number, color: string): void {
        if (this.dry) return;
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, y, w, h);
    }

    roundRect(x: number, y: number, w: number, h: number, r: number, color: string): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    }

    circleText(cx: number, cy: number, radius: number, label: string, fill: string, color: string, family: string): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.font = `${Math.round(radius)}px ${family}`;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(label, cx, cy + radius / 3);
        ctx.textAlign = "left";
    }

    avatar(image: CanvasImageSource, x: number, y: number, size: number): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(image, x, y, size, size);
        ctx.restore();
    }

    dashedLine(x1: number, y: number, x2: number, color: string): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y + 0.5);
        ctx.lineTo(x2, y + 0.5);
        ctx.stroke();
        ctx.restore();
    }

    circleOutline(cx: number, cy: number, radius: number, color: string): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    rotated(cx: number, cy: number, radians: number, draw: () => void): void {
        if (this.dry) { draw(); return; }
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(radians);
        ctx.translate(-cx, -cy);
        draw();
        ctx.restore();
    }

    /** 把已经画好的内容垫底色/垫白纸：等内容画完再补一层在下面 */
    underlay(x: number, y: number, w: number, h: number, color: string): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }
}

type Ctx = {
    pen: Pen;
    input: ReadingShareCardInput;
    palette: ReadingSharePalette;
    align: "left" | "center";
    fonts: ReadingShareFonts;
};

function annotationFont(ctx: Ctx, annotation: ReadingShareAnnotation): string {
    return annotation.authorType === "user" ? ctx.fonts.userAnnotation : ctx.fonts.charAnnotation;
}

function metaLine(input: ReadingShareCardInput): string {
    return [input.bookTitle, input.bookAuthor, input.chapterTitle].filter(Boolean).join(" · ");
}

function stampText(input: ReadingShareCardInput): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const t = input.timestamp;
    return `${t.getFullYear()}.${pad(t.getMonth() + 1)}.${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function percentValue(input: ReadingShareCardInput): number {
    return Math.min(100, Math.max(1, Math.round(input.progressPercent)));
}

function progressText(input: ReadingShareCardInput): string {
    return `读到全书 ${percentValue(input)}%`;
}

function displayName(input: ReadingShareCardInput): string {
    return input.userName.trim() || "读者";
}

/** 正文段落，返回落笔后的 y */
function drawQuote(
    ctx: Ctx,
    x: number,
    y: number,
    width: number,
    size: number,
    lineHeight: number,
    color: string,
    align: "left" | "center" = ctx.align,
): number {
    const { pen, input } = ctx;
    pen.font(size, ctx.fonts.body);
    let cursor = y;
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        for (const line of wrapText(pen.ctx, paragraph, width)) {
            pen.text(
                line,
                align === "center" ? x + width / 2 : x,
                cursor + size,
                color,
                align === "center" ? "center" : "left",
            );
            cursor += lineHeight;
        }
        if (index < paragraphs.length - 1) cursor += Math.round(lineHeight * 0.4);
    });
    return cursor;
}

/** 批注区。style 决定长相：plain 纯文字 / rule 左侧竖线 / strip 整条底色 */
function drawAnnotations(
    ctx: Ctx,
    x: number,
    y: number,
    width: number,
    style: "plain" | "rule" | "strip",
): number {
    const { pen, input, palette } = ctx;
    if (input.annotations.length === 0) return y;
    const size = 25;
    const lineHeight = Math.round(size * 1.8);
    const inset = style === "plain" ? 0 : 24;
    const centered = ctx.align === "center" && style === "plain";
    let cursor = y;

    for (const annotation of input.annotations) {
        const font = annotationFont(ctx, annotation);
        pen.font(size, font);
        const lines = wrapText(pen.ctx, annotation.content.trim(), width - inset * (style === "strip" ? 2 : 1));
        const blockHeight = size + 12 + lines.length * lineHeight;

        if (style === "strip") {
            const tint = annotation.authorType === "user" ? input.annotationColors.user : input.annotationColors.character;
            pen.rect(x, cursor - 16, width, blockHeight + 24, readingMarkColor(tint, 0.45));
            pen.rect(x, cursor - 16, 5, blockHeight + 24, readingMarkColor(tint, 1));
        } else if (style === "rule") {
            pen.rect(x, cursor - 4, 3, blockHeight + 4, palette.accent);
        }

        const textX = centered ? x + width / 2 : x + inset;
        const textAlign: CanvasTextAlign = centered ? "center" : "left";
        pen.font(size, font, "600");
        pen.text(annotation.name, textX, cursor + size, palette.accent, textAlign);
        cursor += size + 12;
        pen.font(size, font);
        for (const line of lines) {
            pen.text(line, textX, cursor + size, palette.sub, textAlign);
            cursor += lineHeight;
        }
        cursor += style === "strip" ? 34 : 26;
    }
    return cursor;
}

/** 头像 + ID。没设 ID 就写「读者」——署名位每个模板都有。 */
function drawSignature(
    ctx: Ctx,
    x: number,
    centerY: number,
    size: number,
    nameColor: string,
    subColor: string,
    subline: string | null,
    avatarFallbackInk = ctx.palette.accent,
): void {
    const { pen, input } = ctx;
    const name = displayName(input);
    if (input.avatar) {
        pen.avatar(input.avatar, x, centerY - size / 2, size);
    } else {
        pen.circleText(
            x + size / 2, centerY, size / 2, Array.from(name)[0],
            readingMarkColor(avatarFallbackInk, 0.3), avatarFallbackInk, ctx.fonts.body,
        );
    }

    const textX = x + size + 20;
    pen.font(28, ctx.fonts.body);
    if (subline) {
        pen.text(name, textX, centerY - 2, nameColor);
        pen.font(21, ctx.fonts.body);
        pen.text(subline, textX, centerY + 28, subColor);
    } else {
        pen.text(name, textX, centerY + 10, nameColor);
    }
}

// ── 模板 ────────────────────────────────────────────────

function renderPoster(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 72;
    const inner = WIDTH - pad * 2;
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    const [lead, ...rest] = paragraphs;
    let y = pad;

    pen.font(21, ctx.fonts.body);
    pen.text(metaLine(input), pad, y + 21, palette.sub);
    y += 62;

    if (lead) {
        pen.font(50, ctx.fonts.body, "600");
        for (const line of wrapText(pen.ctx, lead, inner)) {
            pen.text(line, pad, y + 50, palette.ink);
            y += 76;
        }
    }
    if (rest.length > 0) {
        y += 20;
        pen.font(26, ctx.fonts.body);
        for (const paragraph of rest) {
            for (const line of wrapText(pen.ctx, paragraph, inner)) {
                pen.text(line, pad, y + 26, palette.sub);
                y += 50;
            }
            y += 16;
        }
    }

    if (input.annotations.length > 0) {
        y += 26;
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, inner, "rule");
    }

    y += 46;
    const barHeight = 120;
    pen.rect(0, y, WIDTH, barHeight, palette.accent);
    const centerY = y + barHeight / 2;
    drawSignature(
        { ...ctx, palette: { ...palette, accent: palette.background } },
        pad, centerY, 58, palette.background, readingMarkColor(palette.background, 0.7), null, palette.background,
    );
    pen.font(21, ctx.fonts.body);
    pen.text(`${progressText(input)} · ${stampText(input)}`, WIDTH - pad, centerY + 8, palette.background, "right");
    return y + barHeight;
}

function renderBookmark(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const outer = 58;
    const cardWidth = 660;
    const cardX = (WIDTH - cardWidth) / 2;
    const pad = 54;
    const inner = cardWidth - pad * 2;
    const cardTop = outer;
    let y = cardTop + pad;

    pen.rect(cardX + cardWidth / 2 - 22, y + 6, 44, 3, palette.accent);
    y += 42;
    y = drawQuote(ctx, cardX + pad, y, inner, 26, 56, palette.ink, "left");

    if (input.annotations.length > 0) {
        y += 24;
        y = drawAnnotations({ ...ctx, align: "left" }, cardX + pad, y, inner, "rule");
    }

    y += 22;
    pen.dashedLine(cardX + pad, y, cardX + cardWidth - pad, palette.sub);
    y += 40;

    const avatarSize = 62;
    if (input.avatar) pen.avatar(input.avatar, cardX + cardWidth / 2 - avatarSize / 2, y, avatarSize);
    else pen.circleText(cardX + cardWidth / 2, y + avatarSize / 2, avatarSize / 2, Array.from(displayName(input))[0], readingMarkColor(palette.accent, 0.3), palette.accent, ctx.fonts.body);
    y += avatarSize + 20;

    pen.font(25, ctx.fonts.body);
    pen.text(displayName(input), cardX + cardWidth / 2, y + 25, palette.ink, "center");
    y += 42;
    pen.font(19, ctx.fonts.body);
    pen.text(metaLine(input), cardX + cardWidth / 2, y + 19, palette.sub, "center");
    y += 30;
    pen.text(`${progressText(input)} · ${stampText(input)}`, cardX + cardWidth / 2, y + 19, palette.sub, "center");
    y += 40;
    pen.circleOutline(cardX + cardWidth / 2, y + 8, 7, palette.sub);
    y += 30;

    pen.underlay(cardX, cardTop, cardWidth, y - cardTop, "#fbf7ee");
    return y + outer;
}

function renderMagazine(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 66;
    const inner = WIDTH - pad * 2;
    let y = pad;

    pen.font(19, ctx.fonts.body);
    pen.text(input.bookTitle, pad, y + 19, palette.sub);
    if (input.bookAuthor) pen.text(input.bookAuthor, WIDTH / 2, y + 19, palette.sub, "center");
    if (input.chapterTitle) pen.text(input.chapterTitle, WIDTH - pad, y + 19, palette.sub, "right");
    y += 34;
    pen.rect(pad, y, inner, 3, palette.ink);
    y += 44;

    // 两栏：先把行排完，再对半分到左右两栏
    const gap = 44;
    const columnWidth = (inner - gap) / 2;
    const size = 25;
    const lineHeight = 50;
    pen.font(size, ctx.fonts.body);
    const allLines: string[] = [];
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        allLines.push(...wrapText(pen.ctx, paragraph, columnWidth));
        if (index < paragraphs.length - 1) allLines.push("");
    });
    const half = Math.max(1, Math.ceil(allLines.length / 2));
    [allLines.slice(0, half), allLines.slice(half)].forEach((lines, columnIndex) => {
        let cursor = y;
        const x = pad + columnIndex * (columnWidth + gap);
        for (const line of lines) {
            if (line) pen.text(line, x, cursor + size, palette.ink);
            cursor += lineHeight;
        }
    });
    y += half * lineHeight + 20;

    if (input.annotations.length > 0) {
        pen.rect(pad, y, inner, 1, readingMarkColor(palette.sub, 0.45));
        y += 34;
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, inner, "plain");
    }

    pen.rect(pad, y, inner, 1, readingMarkColor(palette.sub, 0.45));
    y += 42;
    const footerHeight = 112;
    const centerY = y + 40;
    drawSignature(ctx, pad, centerY, 58, palette.ink, palette.sub, stampText(input));
    pen.font(94, ctx.fonts.body, "300");
    const percent = String(percentValue(input));
    const percentWidth = pen.measure(percent);
    pen.font(26, ctx.fonts.body);
    const unitWidth = pen.measure("%");
    pen.font(94, ctx.fonts.body, "300");
    pen.text(percent, WIDTH - pad - unitWidth - 6, y + 86, palette.ink, "right");
    pen.font(26, ctx.fonts.body);
    pen.text("%", WIDTH - pad, y + 86, palette.ink, "right");
    void percentWidth;
    return y + footerHeight + 30;
}

function renderMinimal(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 108;
    const inner = WIDTH - pad * 2;
    let y = pad + 24;

    y = drawQuote(ctx, pad, y, inner, 28, 66, palette.ink);
    if (input.annotations.length > 0) {
        y += 36;
        y = drawAnnotations(ctx, pad, y, inner, "plain");
    }

    y += 36;
    pen.rect(WIDTH / 2, y, 1, 56, palette.accent);
    y += 96;

    const avatarSize = 58;
    if (input.avatar) pen.avatar(input.avatar, WIDTH / 2 - avatarSize / 2, y, avatarSize);
    else pen.circleText(WIDTH / 2, y + avatarSize / 2, avatarSize / 2, Array.from(displayName(input))[0], readingMarkColor(palette.accent, 0.5), palette.sub, ctx.fonts.body);
    y += avatarSize + 22;

    pen.font(25, ctx.fonts.body);
    pen.text(displayName(input), WIDTH / 2, y + 25, palette.ink, "center");
    y += 42;
    pen.font(19, ctx.fonts.body);
    pen.text(metaLine(input), WIDTH / 2, y + 19, palette.sub, "center");
    y += 30;
    pen.text(`${progressText(input)} · ${stampText(input)}`, WIDTH / 2, y + 19, palette.sub, "center");
    return y + 30 + pad;
}

function renderCollage(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 64;
    const blockLeft = 156;
    const blockWidth = WIDTH - blockLeft;
    const quotePad = 54;
    const blockTop = 122;

    pen.font(26, ctx.fonts.body);
    const quoteWidth = blockWidth - quotePad * 2;
    const lines: string[] = [];
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        lines.push(...wrapText(pen.ctx, paragraph, quoteWidth));
        if (index < paragraphs.length - 1) lines.push("");
    });
    const lineHeight = 54;
    const blockHeight = quotePad * 2 + lines.length * lineHeight;

    pen.rect(blockLeft, blockTop, blockWidth, blockHeight, palette.accent);
    pen.rect(pad, blockTop + 84, 128, 128, readingMarkColor(palette.accent, 0.3));

    let y = blockTop + quotePad;
    for (const line of lines) {
        if (line) pen.text(line, blockLeft + quotePad, y + 26, palette.ink);
        y += lineHeight;
    }
    y = blockTop + blockHeight + 52;

    if (input.annotations.length > 0) {
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, WIDTH - pad * 2, "rule");
        y += 10;
    }

    const centerY = y + 30;
    drawSignature(ctx, pad, centerY, 58, palette.sub, palette.sub, null, palette.accent);
    pen.font(20, ctx.fonts.body);
    pen.text(metaLine(input), pad, centerY + 62, palette.sub);
    pen.text(`${progressText(input)} · ${stampText(input)}`, pad, centerY + 92, palette.sub);
    pen.font(56, ctx.fonts.body, "300");
    pen.text(`${percentValue(input)}%`, WIDTH - pad, centerY + 92, palette.accent, "right");
    return centerY + 92 + pad;
}

function renderLetter(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 72;
    const inner = WIDTH - pad * 2;
    const ruleGap = 56;
    let y = pad;

    pen.font(20, ctx.fonts.body);
    pen.text(metaLine(input), pad, y + 20, palette.sub);
    y += 54;

    pen.font(26, ctx.fonts.body);
    const lines: string[] = [];
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        lines.push(...wrapText(pen.ctx, paragraph, inner));
        if (index < paragraphs.length - 1) lines.push("");
    });
    for (const line of lines) {
        pen.rect(pad, y + ruleGap - 10, inner, 1, palette.accent);
        if (line) pen.text(line, pad, y + 34, palette.ink);
        y += ruleGap;
    }

    if (input.annotations.length > 0) {
        y += 38;
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, inner, "strip");
    }

    y += 26;
    const centerY = y + 30;
    drawSignature(ctx, pad, centerY, 58, palette.ink, palette.sub, `${progressText(input)} · ${stampText(input)}`);
    return centerY + 40 + pad;
}

function renderSticky(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const outer = 46;
    const paperX = outer;
    const paperWidth = WIDTH - outer * 2;
    const pad = 48;
    const inner = paperWidth - pad * 2;
    const paperTop = outer;

    let y = paperTop + pad;
    y = drawQuote(ctx, paperX + pad, y, inner, 26, 54, palette.ink, "left");

    // 批注做成贴上去的便签，用的就是阅读界面里那两张卡片的颜色
    if (input.annotations.length > 0) {
        y += 36;
        const noteGap = 20;
        const perRow = input.annotations.length > 1 ? 2 : 1;
        const noteWidth = perRow > 1 ? (inner - noteGap) / 2 : inner;
        const heights = input.annotations.map((annotation) => {
            pen.font(24, annotationFont(ctx, annotation));
            const lines = wrapText(pen.ctx, annotation.content.trim(), noteWidth - 36);
            return { lines, height: 36 + lines.length * 40 + 26 };
        });

        let rowTop = y;
        for (let index = 0; index < input.annotations.length; index += perRow) {
            const row = input.annotations.slice(index, index + perRow);
            const rowHeight = Math.max(...row.map((_, i) => heights[index + i].height));
            row.forEach((annotation, column) => {
                const plan = heights[index + column];
                const x = paperX + pad + column * (noteWidth + noteGap);
                const tint = annotation.authorType === "user" ? input.annotationColors.user : input.annotationColors.character;
                const font = annotationFont(ctx, annotation);
                pen.rotated(x + noteWidth / 2, rowTop + rowHeight / 2, (column === 0 ? -1 : 1) * 0.012, () => {
                    pen.roundRect(x, rowTop, noteWidth, rowHeight, 4, tint);
                    pen.font(19, font, "600");
                    pen.text(annotation.name, x + 18, rowTop + 34, readingMarkColor(palette.ink, 0.7));
                    pen.font(24, font);
                    let cursor = rowTop + 56;
                    for (const line of plan.lines) {
                        pen.text(line, x + 18, cursor + 24, palette.ink);
                        cursor += 40;
                    }
                });
            });
            rowTop += rowHeight + noteGap;
        }
        y = rowTop - noteGap;
    }

    y += 42;
    const centerY = y + 28;
    drawSignature(ctx, paperX + pad, centerY, 54, palette.ink, palette.sub, metaLine(input));
    pen.font(20, ctx.fonts.body);
    pen.text(`${progressText(input)} · ${stampText(input)}`, paperX + paperWidth - pad, centerY + 10, palette.sub, "right");
    y = centerY + 40 + pad;

    pen.underlay(paperX, paperTop, paperWidth, y - paperTop, "#ffffff");
    return y + outer;
}

const RENDERERS: Record<ReadingShareTemplate, (ctx: Ctx) => number> = {
    poster: renderPoster,
    bookmark: renderBookmark,
    magazine: renderMagazine,
    minimal: renderMinimal,
    collage: renderCollage,
    letter: renderLetter,
    sticky: renderSticky,
};

/** 画出摘抄图。返回的 canvas 已经是最终像素，直接 toBlob 就能存。 */
export function renderReadingShareCard(input: ReadingShareCardInput): HTMLCanvasElement {
    const preset = READING_SHARE_TEMPLATE_PRESETS[input.template];
    const palette: ReadingSharePalette = {
        background: input.palette?.background || preset.background,
        ink: input.palette?.ink || preset.ink,
        sub: input.palette?.sub || preset.sub,
        accent: input.palette?.accent || preset.accent,
    };
    const align = input.align || preset.align;

    const measureCanvas = document.createElement("canvas");
    measureCanvas.width = WIDTH;
    measureCanvas.height = 10;
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) throw new Error("当前浏览器不支持生成图片");
    measureCtx.textBaseline = "alphabetic";

    const render = RENDERERS[input.template];
    const base = { input, palette, align, fonts: input.fonts };
    const height = Math.max(420, Math.round(render({ ...base, pen: new Pen(measureCtx, true) })));

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持生成图片");
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, WIDTH, height);
    render({ ...base, pen: new Pen(ctx, false) });
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
