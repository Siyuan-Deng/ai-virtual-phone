"use client";

import { darkenHex, readingMarkColor } from "./reading-appearance";

/** 摘抄图的排版模板。每个模板是一套完整的版面，不是同一套版面换配色。 */
export type ReadingShareTemplate =
    | "poster"    // 大字报：首段放大成主视觉，底部色带压住
    | "bookmark"  // 书签条：窄长一条，像夹在书里的那张纸
    | "magazine"  // 杂志双栏：分栏正文 + 巨大的百分比
    | "minimal"   // 极简留白：居中，大量留白
    | "collage"   // 色块拼贴：不对称色块压字
    | "letter"    // 横格信笺：正文压在格线上
    | "sticky"    // 便利贴：白纸 + 两张贴上去的批注
    | "notecard"  // 笔记卡：署名在上，大字正文，出处在下
    | "quotemark" // 满版引号：巨大的引号水印压底
    | "coverband" // 封面带：顶上一条色带放书名，下面全给正文
    | "centered"; // 全居中：上下小记号夹着居中的大字

export const READING_SHARE_TEMPLATES: Array<{ id: ReadingShareTemplate; label: string }> = [
    { id: "poster", label: "大字报" },
    { id: "bookmark", label: "书签条" },
    { id: "magazine", label: "杂志" },
    { id: "minimal", label: "留白" },
    { id: "collage", label: "色块" },
    { id: "letter", label: "信笺" },
    { id: "sticky", label: "便利贴" },
    { id: "notecard", label: "笔记卡" },
    { id: "quotemark", label: "满版引号" },
    { id: "coverband", label: "封面带" },
    { id: "centered", label: "全居中" },
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

export type ReadingShareAlign = "left" | "center" | "right";

export type ReadingShareAvatarShape = "circle" | "square";

/** 出图比例。auto = 内容多高就多高（原来唯一的那种）。 */
export type ReadingShareRatio = "auto" | "square" | "story";

export const READING_SHARE_RATIOS: Array<{ id: ReadingShareRatio; label: string }> = [
    { id: "auto", label: "自适应" },
    { id: "square", label: "1:1" },
    { id: "story", label: "9:16" },
];
/** 方形头像的圆角。版面按 1080 宽算，落到手机上差不多就是 3px。 */
const AVATAR_CORNER = 8;

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
    align?: ReadingShareAlign;
    /** 头像形状：圆形或者圆角方形 */
    avatarShape?: ReadingShareAvatarShape;
    /** 出图比例；没给就是 auto */
    ratio?: ReadingShareRatio;
};

/** 每个模板的出厂配色和默认对齐 */
export const READING_SHARE_TEMPLATE_PRESETS: Record<
    ReadingShareTemplate,
    ReadingSharePalette & { align: ReadingShareAlign }
> = {
    poster: { background: "#141414", ink: "#f4f1ea", sub: "#b0aa9d", accent: "#e4c15a", align: "left" },
    bookmark: { background: "#ded8cc", ink: "#2f2a20", sub: "#9b8f78", accent: "#c0a463", align: "left" },
    magazine: { background: "#ffffff", ink: "#161616", sub: "#8f8f8f", accent: "#161616", align: "left" },
    minimal: { background: "#fcfcfc", ink: "#171717", sub: "#a8a8a8", accent: "#cfcfcf", align: "center" },
    collage: { background: "#f4f1ec", ink: "#f3efe7", sub: "#4a453c", accent: "#2b4a6f", align: "left" },
    letter: { background: "#fdfcf7", ink: "#2b2720", sub: "#9b8f78", accent: "#e4dcc8", align: "left" },
    sticky: { background: "#efeae1", ink: "#262119", sub: "#8a8071", accent: "#b9a98c", align: "left" },
    notecard: { background: "#2a3566", ink: "#f2f4fb", sub: "#a9b3d8", accent: "#8c9bd8", align: "left" },
    quotemark: { background: "#14161b", ink: "#f0eee9", sub: "#8a8f99", accent: "#c9c4ba", align: "left" },
    coverband: { background: "#ffffff", ink: "#1c1b1a", sub: "#8e8b86", accent: "#3c4a7a", align: "left" },
    centered: { background: "#3a1f26", ink: "#f6efea", sub: "#c09e95", accent: "#c89a86", align: "center" },
};

/** 每个模板几套配色。第一套就是模板的出厂配色。
 *  注意「色块」模板里 ink 是压在色块上的字（浅），sub 是压在背景上的字（深）。 */
export const READING_SHARE_PALETTES: Record<
    ReadingShareTemplate,
    Array<{ name: string; palette: ReadingSharePalette }>
> = {
    poster: [
        { name: "墨夜", palette: { background: "#141414", ink: "#f4f1ea", sub: "#b0aa9d", accent: "#e4c15a" } },
        { name: "绛", palette: { background: "#2a0f12", ink: "#f7ece6", sub: "#bfa199", accent: "#c8503f" } },
        { name: "靛", palette: { background: "#101f36", ink: "#eef2f8", sub: "#9aa8be", accent: "#d8a24a" } },
        { name: "雪", palette: { background: "#f5f4f0", ink: "#16181c", sub: "#77787c", accent: "#16181c" } },
    ],
    bookmark: [
        { name: "素笺", palette: { background: "#ded8cc", ink: "#2f2a20", sub: "#9b8f78", accent: "#c0a463" } },
        { name: "青瓷", palette: { background: "#cfdcd6", ink: "#24322c", sub: "#7e948a", accent: "#4f8172" } },
        { name: "藕荷", palette: { background: "#e0d4dd", ink: "#342a31", sub: "#96828f", accent: "#9a5f86" } },
        { name: "松烟", palette: { background: "#cfcfc8", ink: "#22231f", sub: "#82837c", accent: "#5a6b4e" } },
    ],
    magazine: [
        { name: "黑白", palette: { background: "#ffffff", ink: "#161616", sub: "#8f8f8f", accent: "#161616" } },
        { name: "米白", palette: { background: "#f7f3ea", ink: "#1d1a16", sub: "#8d8577", accent: "#b4462f" } },
        { name: "石板", palette: { background: "#e8eaec", ink: "#14181c", sub: "#7d858d", accent: "#1f5f8b" } },
        { name: "夜刊", palette: { background: "#14161a", ink: "#f1f0ec", sub: "#8a8f98", accent: "#e0b355" } },
    ],
    minimal: [
        { name: "纸白", palette: { background: "#fcfcfc", ink: "#171717", sub: "#a8a8a8", accent: "#cfcfcf" } },
        { name: "米", palette: { background: "#f6f2e9", ink: "#262019", sub: "#a99e8b", accent: "#d9cdb6" } },
        { name: "雾蓝", palette: { background: "#eef1f4", ink: "#1b2229", sub: "#98a3ad", accent: "#c3ced7" } },
        { name: "墨", palette: { background: "#17181a", ink: "#ededed", sub: "#8b8d91", accent: "#4a4e55" } },
    ],
    collage: [
        { name: "深蓝", palette: { background: "#f4f1ec", ink: "#f3efe7", sub: "#4a453c", accent: "#2b4a6f" } },
        { name: "砖红", palette: { background: "#f2ece3", ink: "#fbf6ee", sub: "#4b4239", accent: "#b1512f" } },
        { name: "墨绿", palette: { background: "#f0f0e8", ink: "#f4f6ef", sub: "#414437", accent: "#2f4f3a" } },
        { name: "紫", palette: { background: "#f2eef4", ink: "#f6f1f7", sub: "#453d4a", accent: "#5b3b7a" } },
    ],
    letter: [
        { name: "米黄", palette: { background: "#fdfcf7", ink: "#2b2720", sub: "#9b8f78", accent: "#e4dcc8" } },
        { name: "格纹蓝", palette: { background: "#f7fafc", ink: "#1e2733", sub: "#8b98a6", accent: "#d2e0ea" } },
        { name: "旧稿", palette: { background: "#f6efe2", ink: "#3b3226", sub: "#a3937a", accent: "#e0d2b6" } },
        { name: "夜灯", palette: { background: "#1b1d20", ink: "#e9e6df", sub: "#8b8b86", accent: "#33373c" } },
    ],
    sticky: [
        { name: "原木", palette: { background: "#efeae1", ink: "#262119", sub: "#8a8071", accent: "#b9a98c" } },
        { name: "灰蓝板", palette: { background: "#dde4e9", ink: "#1f262b", sub: "#7b8893", accent: "#93a6b3" } },
        { name: "薄荷", palette: { background: "#e3efe6", ink: "#1f2a22", sub: "#7b8b7f", accent: "#8fae97" } },
        { name: "深木", palette: { background: "#2b2621", ink: "#f0ebe2", sub: "#9a9187", accent: "#6d6053" } },
    ],
    notecard: [
        { name: "藏青", palette: { background: "#2a3566", ink: "#f2f4fb", sub: "#a9b3d8", accent: "#8c9bd8" } },
        { name: "墨绿", palette: { background: "#1e3028", ink: "#eef4ef", sub: "#9db5a6", accent: "#79b094" } },
        { name: "奶油", palette: { background: "#f6f1e6", ink: "#231f19", sub: "#8b8070", accent: "#b07b45" } },
        { name: "炭", palette: { background: "#1c1c1e", ink: "#f0f0f0", sub: "#97979b", accent: "#d0a35e" } },
    ],
    quotemark: [
        { name: "深墨", palette: { background: "#14161b", ink: "#f0eee9", sub: "#8a8f99", accent: "#c9c4ba" } },
        { name: "赭", palette: { background: "#f3ece2", ink: "#241d16", sub: "#8c8073", accent: "#b5693b" } },
        { name: "普鲁士蓝", palette: { background: "#121d2b", ink: "#eaf0f6", sub: "#8795a5", accent: "#5f93bf" } },
        { name: "棠梨", palette: { background: "#f7eceb", ink: "#2d1e1f", sub: "#96807f", accent: "#b2554f" } },
    ],
    coverband: [
        { name: "靛蓝", palette: { background: "#ffffff", ink: "#1c1b1a", sub: "#8e8b86", accent: "#3c4a7a" } },
        { name: "橄榄", palette: { background: "#fbfaf6", ink: "#1f201b", sub: "#8b8b80", accent: "#4f5c36" } },
        { name: "砖", palette: { background: "#fdf8f4", ink: "#231c18", sub: "#948278", accent: "#a84d33" } },
        { name: "夜", palette: { background: "#17181b", ink: "#eeeeea", sub: "#8c8e93", accent: "#2f6f6a" } },
    ],
    centered: [
        { name: "酒红", palette: { background: "#3a1f26", ink: "#f6efea", sub: "#c09e95", accent: "#c89a86" } },
        { name: "宣纸", palette: { background: "#f7f4ec", ink: "#201d17", sub: "#948b7a", accent: "#b09560" } },
        { name: "深海", palette: { background: "#111f2a", ink: "#eaf1f5", sub: "#8ea2ad", accent: "#6fa3ae" } },
        { name: "紫竹", palette: { background: "#2b2436", ink: "#f0ecf5", sub: "#a79ab5", accent: "#a98ac4" } },
    ],
};

const WIDTH = 1080;
/** 输出放大倍数。版面坐标不变，只是画布更密。 */
const SCALE = 2;

/** 固定比例的目标高度。auto 由内容决定，所以是 null。 */
const RATIO_HEIGHT: Record<ReadingShareRatio, number | null> = {
    auto: null,
    square: WIDTH,
    story: Math.round((WIDTH * 16) / 9),
};
/** 每种比例自己的正文字号倍率。1:1 用设计值；9:16 是满屏竖图，
 *  看的距离远一点，字略放大。这是「设计值」，不是撑满用的橡皮筋。 */
const RATIO_TYPE_SCALE: Record<ReadingShareRatio, number> = {
    auto: 1,
    square: 1,
    story: 1.1,
};
/** 内容塞不下时最多缩到设计值的几成。再小就不像给人看的了。 */
const MIN_FIT_RATIO = 0.62;
/** 内容少时最多放大到设计值的几倍。封顶是关键：不封顶短摘抄会被
 *  撑成一张大字报，正文顶到页脚上。 */
const MAX_GROW_RATIO = 1.35;

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

    circleText(cx: number, cy: number, radius: number, label: string, fill: string, color: string, family: string, shape: ReadingShareAvatarShape = "circle"): void {
        if (this.dry) return;
        const ctx = this.ctx;
        if (shape === "square") this.tracePath(cx - radius, cy - radius, radius * 2, radius * 2, AVATAR_CORNER);
        else {
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.font = `${Math.round(radius)}px ${family}`;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(label, cx, cy + radius / 3);
        ctx.textAlign = "left";
    }

    avatar(image: CanvasImageSource, x: number, y: number, size: number, shape: ReadingShareAvatarShape): void {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.save();
        if (shape === "square") this.tracePath(x, y, size, size, AVATAR_CORNER);
        else {
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx.closePath();
        }
        ctx.clip();
        ctx.drawImage(image, x, y, size, size);
        ctx.restore();
    }

    /** 圆角矩形的路径，clip 和 fill 都用它 */
    tracePath(x: number, y: number, w: number, h: number, r: number): void {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
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

}

type Ctx = {
    pen: Pen;
    input: ReadingShareCardInput;
    palette: ReadingSharePalette;
    align: ReadingShareAlign;
    avatarShape: ReadingShareAvatarShape;
    fonts: ReadingShareFonts;
    /** 整张图的高度。量版面那一遍还不知道，是 0；真正落笔那一遍才有。
     *  「先铺纸再写字」的模板（书签条、便利贴）靠它先画底。 */
    totalHeight: number;
    /** 固定比例下正文和批注的字号倍率。只会 ≤ 该比例的设计值：
     *  内容多就缩小塞下，内容少绝不放大——放大会把正文顶成大字报。 */
    typeScale: number;
    /** 版面没排满时多出来的高度，分成正文之前和之后两段留白，
     *  让正文块视觉居中，页脚照旧压在底边。
     *  绝对不能摊进行距：行距一松排版就散了。 */
    padTop: number;
    fillGap: number;
};

/** 正文/批注的字号和行距按比例缩放。行距跟着字号等比走，不额外加。 */
function scaleType(ctx: Ctx, size: number, lineHeight: number): { size: number; lineHeight: number } {
    return {
        size: Math.max(13, Math.round(size * ctx.typeScale)),
        lineHeight: Math.max(16, Math.round(lineHeight * ctx.typeScale)),
    };
}

function annotationFont(ctx: Ctx, annotation: ReadingShareAnnotation): string {
    return annotation.authorType === "user" ? ctx.fonts.userAnnotation : ctx.fonts.charAnnotation;
}

/** 书名带上书名号 */
function bookTitleText(input: ReadingShareCardInput): string {
    const title = input.bookTitle.trim();
    if (!title) return "";
    return /^《.*》$/.test(title) ? title : `《${title}》`;
}

function metaLine(input: ReadingShareCardInput): string {
    return [bookTitleText(input), input.bookAuthor, input.chapterTitle].filter(Boolean).join(" · ");
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

/** 颜色深浅：用来决定纸该是白的还是深的 */
function isDarkColor(hex: string): boolean {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return false;
    const value = parseInt(match[1], 16);
    const r = ((value >> 16) & 255) / 255;
    const g = ((value >> 8) & 255) / 255;
    const b = (value & 255) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

/** 两个颜色按比例混一混：t=0 全取 a，t=1 全取 b */
function mixHex(a: string, b: string, t: number): string {
    const parse = (hex: string) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
        return match ? parseInt(match[1], 16) : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (left === null || right === null) return a;
    const ratio = Math.max(0, Math.min(1, t));
    const channel = (shift: number) => Math.round(
        ((left >> shift) & 255) * (1 - ratio) + ((right >> shift) & 255) * ratio,
    );
    return `#${[channel(16), channel(8), channel(0)].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

function lightenHex(hex: string, amount: number): string {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return hex;
    const value = parseInt(match[1], 16);
    const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
    const r = mix((value >> 16) & 255);
    const g = mix((value >> 8) & 255);
    const b = mix(value & 255);
    return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

/** 对齐方式换算成落笔点和 textAlign */
function anchor(x: number, width: number, align: ReadingShareAlign): { x: number; textAlign: CanvasTextAlign } {
    if (align === "center") return { x: x + width / 2, textAlign: "center" };
    if (align === "right") return { x: x + width, textAlign: "right" };
    return { x, textAlign: "left" };
}

/** 一段文字按当前对齐方式逐行落笔，返回落笔后的 y */
function drawLines(
    ctx: Ctx,
    lines: string[],
    x: number,
    y: number,
    width: number,
    size: number,
    lineHeight: number,
    color: string,
    align: ReadingShareAlign = ctx.align,
): number {
    const spot = anchor(x, width, align);
    let cursor = y;
    for (const line of lines) {
        if (line) ctx.pen.text(line, spot.x, cursor + size, color, spot.textAlign);
        cursor += lineHeight;
    }
    return cursor;
}

/** 正文段落，返回落笔后的 y */
function drawQuote(
    ctx: Ctx,
    x: number,
    y: number,
    width: number,
    rawSize: number,
    rawLineHeight: number,
    color: string,
    align: ReadingShareAlign = ctx.align,
): number {
    const { pen, input } = ctx;
    const { size, lineHeight } = scaleType(ctx, rawSize, rawLineHeight);
    pen.font(size, ctx.fonts.body);
    let cursor = y;
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        cursor = drawLines(ctx, wrapText(pen.ctx, paragraph, width), x, cursor, width, size, lineHeight, color, align);
        if (index < paragraphs.length - 1) cursor += Math.round(lineHeight * 0.4);
    });
    return cursor;
}

/** 放不下就截断加省略号——长书名撞上右边的进度文字太难看 */
function truncateToWidth(pen: Pen, text: string, maxWidth: number): string {
    if (pen.measure(text) <= maxWidth) return text;
    const chars = Array.from(text);
    let result = "";
    for (const char of chars) {
        if (pen.measure(`${result}${char}…`) > maxWidth) break;
        result += char;
    }
    return `${result}…`;
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
    const { size, lineHeight } = scaleType(ctx, 25, 45);
    const inset = style === "plain" ? 0 : 24;
    const followAlign = style === "plain" ? ctx.align : "left";
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

        const spot = anchor(x + inset, width - inset, followAlign);
        const textX = spot.x;
        const textAlign = spot.textAlign;
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
    /** 文字最多占多宽；超了截断加省略号，免得撞上右边的东西 */
    maxTextWidth = Infinity,
): void {
    const { pen, input } = ctx;
    const name = displayName(input);
    if (input.avatar) {
        pen.avatar(input.avatar, x, centerY - size / 2, size, ctx.avatarShape);
    } else {
        pen.circleText(
            x + size / 2, centerY, size / 2, Array.from(name)[0],
            readingMarkColor(avatarFallbackInk, 0.3), avatarFallbackInk, ctx.fonts.body, ctx.avatarShape,
        );
    }

    const textX = x + size + 20;
    pen.font(28, ctx.fonts.body);
    if (subline) {
        pen.text(truncateToWidth(pen, name, maxTextWidth), textX, centerY - 2, nameColor);
        pen.font(21, ctx.fonts.body);
        pen.text(truncateToWidth(pen, subline, maxTextWidth), textX, centerY + 28, subColor);
    } else {
        pen.text(truncateToWidth(pen, name, maxTextWidth), textX, centerY + 10, nameColor);
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
    pen.text(truncateToWidth(pen, metaLine(input), inner), pad, y + 21, palette.sub);
    y += 62;

    y += ctx.padTop;
    const leadType = scaleType(ctx, 50, 76);
    if (lead) {
        pen.font(leadType.size, ctx.fonts.body, "600");
        y = drawLines(ctx, wrapText(pen.ctx, lead, inner), pad, y, inner, leadType.size, leadType.lineHeight, palette.ink);
    }
    if (rest.length > 0) {
        const restType = scaleType(ctx, 26, 50);
        y += 20;
        pen.font(restType.size, ctx.fonts.body);
        for (const paragraph of rest) {
            y = drawLines(ctx, wrapText(pen.ctx, paragraph, inner), pad, y, inner, restType.size, restType.lineHeight, palette.sub);
            y += 16;
        }
    }

    y += ctx.fillGap;

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
    // 整张图就是那张书签：不再在外面套一圈底色。左右留得多、正文窄一条，
    // 才是书签那个瘦长比例——铺满整宽会变成一张方图。
    const padX = 206;
    const padY = 96;
    const cardWidth = WIDTH;
    const cardX = 0;
    const inner = cardWidth - padX * 2;
    let y = padY;

    pen.rect(cardX + cardWidth / 2 - 22, y + 6, 44, 3, palette.accent);
    y += 42;
    y += ctx.padTop;
    y = drawQuote(ctx, cardX + padX, y, inner, 26, 56, palette.ink);
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        y += 24;
        y = drawAnnotations({ ...ctx, align: "left" }, cardX + padX, y, inner, "rule");
    }

    y += 22;
    pen.dashedLine(cardX + padX, y, cardX + cardWidth - padX, palette.sub);
    y += 40;

    const avatarSize = 62;
    if (input.avatar) pen.avatar(input.avatar, cardX + cardWidth / 2 - avatarSize / 2, y, avatarSize, ctx.avatarShape);
    else pen.circleText(cardX + cardWidth / 2, y + avatarSize / 2, avatarSize / 2, Array.from(displayName(input))[0], readingMarkColor(palette.accent, 0.3), palette.accent, ctx.fonts.body, ctx.avatarShape);
    y += avatarSize + 20;

    pen.font(25, ctx.fonts.body);
    pen.text(displayName(input), cardX + cardWidth / 2, y + 25, palette.ink, "center");
    y += 42;
    pen.font(19, ctx.fonts.body);
    pen.text(truncateToWidth(pen, metaLine(input), inner), cardX + cardWidth / 2, y + 19, palette.sub, "center");
    y += 30;
    pen.text(`${progressText(input)} · ${stampText(input)}`, cardX + cardWidth / 2, y + 19, palette.sub, "center");
    y += 40;
    pen.circleOutline(cardX + cardWidth / 2, y + 8, 7, palette.sub);
    return y + 38 + padY;
}

function renderMagazine(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 66;
    const inner = WIDTH - pad * 2;
    let y = pad;

    pen.font(19, ctx.fonts.body);
    pen.text(bookTitleText(input), pad, y + 19, palette.sub);
    if (input.bookAuthor) pen.text(input.bookAuthor, WIDTH / 2, y + 19, palette.sub, "center");
    if (input.chapterTitle) pen.text(input.chapterTitle, WIDTH - pad, y + 19, palette.sub, "right");
    y += 34;
    pen.rect(pad, y, inner, 3, palette.ink);
    y += 44;

    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 27, 56, palette.ink);
    y += 24;
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        pen.rect(pad, y, inner, 1, readingMarkColor(palette.sub, 0.45));
        y += 34;
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, inner, "plain");
    }

    pen.rect(pad, y, inner, 1, readingMarkColor(palette.sub, 0.45));
    y += 42;
    const footerHeight = 112;
    const centerY = y + 40;
    drawSignature(ctx, pad, centerY, 58, palette.ink, palette.sub, stampText(input), palette.accent, inner * 0.55);
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

    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 28, 66, palette.ink);
    y += ctx.fillGap;
    if (input.annotations.length > 0) {
        y += 36;
        y = drawAnnotations(ctx, pad, y, inner, "plain");
    }

    y += 36;
    pen.rect(WIDTH / 2, y, 1, 56, palette.accent);
    y += 96;

    const avatarSize = 58;
    if (input.avatar) pen.avatar(input.avatar, WIDTH / 2 - avatarSize / 2, y, avatarSize, ctx.avatarShape);
    else pen.circleText(WIDTH / 2, y + avatarSize / 2, avatarSize / 2, Array.from(displayName(input))[0], readingMarkColor(palette.accent, 0.5), palette.sub, ctx.fonts.body, ctx.avatarShape);
    y += avatarSize + 22;

    pen.font(25, ctx.fonts.body);
    pen.text(displayName(input), WIDTH / 2, y + 25, palette.ink, "center");
    y += 42;
    pen.font(19, ctx.fonts.body);
    pen.text(truncateToWidth(pen, metaLine(input), inner), WIDTH / 2, y + 19, palette.sub, "center");
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
    const blockTop = 122 + ctx.padTop;

    const collageType = scaleType(ctx, 26, 54);
    pen.font(collageType.size, ctx.fonts.body);
    const quoteWidth = blockWidth - quotePad * 2;
    const lines: string[] = [];
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        lines.push(...wrapText(pen.ctx, paragraph, quoteWidth));
        if (index < paragraphs.length - 1) lines.push("");
    });
    const lineHeight = collageType.lineHeight;
    const blockHeight = quotePad * 2 + lines.length * lineHeight;

    pen.rect(blockLeft, blockTop, blockWidth, blockHeight, palette.accent);
    pen.rect(pad, blockTop + 84, 128, 128, readingMarkColor(palette.accent, 0.3));

    let y = blockTop + quotePad;
    drawLines(ctx, lines, blockLeft + quotePad, y, quoteWidth, collageType.size, lineHeight, palette.ink);
    y = blockTop + blockHeight + 52 + ctx.fillGap;

    if (input.annotations.length > 0) {
        y = drawAnnotations({ ...ctx, align: "left" }, pad, y, WIDTH - pad * 2, "rule");
        y += 10;
    }

    const centerY = y + 30;
    drawSignature(ctx, pad, centerY, 58, palette.sub, palette.sub, null, palette.accent);
    pen.font(20, ctx.fonts.body);
    pen.text(truncateToWidth(pen, metaLine(input), WIDTH - pad * 2), pad, centerY + 62, palette.sub);
    pen.text(`${progressText(input)} · ${stampText(input)}`, pad, centerY + 92, palette.sub);
    pen.font(56, ctx.fonts.body, "300");
    pen.text(`${percentValue(input)}%`, WIDTH - pad, centerY + 92, palette.accent, "right");
    return centerY + 92 + pad;
}

function renderLetter(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 72;
    const inner = WIDTH - pad * 2;
    const letterType = scaleType(ctx, 26, 56);
    const ruleGap = letterType.lineHeight;
    let y = pad;

    pen.font(20, ctx.fonts.body);
    pen.text(truncateToWidth(pen, metaLine(input), inner), pad, y + 20, palette.sub);
    y += 54;

    y += ctx.padTop;
    pen.font(letterType.size, ctx.fonts.body);
    const lines: string[] = [];
    const paragraphs = input.quoteParagraphs.map(p => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
        lines.push(...wrapText(pen.ctx, paragraph, inner));
        if (index < paragraphs.length - 1) lines.push("");
    });
    const letterSpot = anchor(pad, inner, ctx.align);
    for (const line of lines) {
        pen.rect(pad, y + ruleGap - 10, inner, 1, palette.accent);
        if (line) pen.text(line, letterSpot.x, y + letterType.size + 8, palette.ink, letterSpot.textAlign);
        y += ruleGap;
    }

    y += ctx.fillGap;

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
    // 纸跟着配色走：浅色方案提亮成一张「比底色更白的纸」，深色方案只提一点点。
    // 以前浅色方案一律纯白，换配色时只有深木看得出变化。
    const paperColor = isDarkColor(palette.background)
        ? lightenHex(palette.background, 0.10)
        : lightenHex(palette.background, 0.72);
    if (ctx.totalHeight > 0) {
        pen.rect(paperX, paperTop, paperWidth, ctx.totalHeight - outer * 2, paperColor);
    }

    let y = paperTop + pad;
    y += ctx.padTop;
    y = drawQuote(ctx, paperX + pad, y, inner, 26, 54, palette.ink);
    y += ctx.fillGap;

    // 批注做成贴上去的便签，用的就是阅读界面里那两张卡片的颜色
    if (input.annotations.length > 0) {
        y += 36;
        const noteGap = 20;
        const perRow = input.annotations.length > 1 ? 2 : 1;
        const noteWidth = perRow > 1 ? (inner - noteGap) / 2 : inner;
        const noteType = scaleType(ctx, 24, 40);
        const heights = input.annotations.map((annotation) => {
            pen.font(noteType.size, annotationFont(ctx, annotation));
            const lines = wrapText(pen.ctx, annotation.content.trim(), noteWidth - 36);
            return { lines, height: 36 + lines.length * noteType.lineHeight + 26 };
        });

        let rowTop = y;
        for (let index = 0; index < input.annotations.length; index += perRow) {
            const row = input.annotations.slice(index, index + perRow);
            const rowHeight = Math.max(...row.map((_, i) => heights[index + i].height));
            row.forEach((annotation, column) => {
                const plan = heights[index + column];
                const x = paperX + pad + column * (noteWidth + noteGap);
                // 便签色 = 阅读界面里那张卡片的颜色，再往当前配色里调一调：
                // user / char 的色相差别留着，整体跟着方案走，不会一套深色配色里
                // 还贴两张亮黄亮蓝。
                const baseTint = annotation.authorType === "user" ? input.annotationColors.user : input.annotationColors.character;
                const tint = mixHex(baseTint, palette.background, isDarkColor(palette.background) ? 0.62 : 0.3);
                const font = annotationFont(ctx, annotation);
                pen.rotated(x + noteWidth / 2, rowTop + rowHeight / 2, (column === 0 ? -1 : 1) * 0.012, () => {
                    pen.roundRect(x, rowTop, noteWidth, rowHeight, 4, tint);
                    // 顶上那截半透明胶带，和阅读界面里的批注卡片、书架封面一个做法。
                    // 颜色比便签本身深一档：同色半透明压在同色便签上等于没有。
                    pen.rotated(x + 46 + 44, rowTop - 10, 0.04, () => {
                        pen.rect(x + 46, rowTop - 14, 88, 24, readingMarkColor(darkenHex(tint, 0.18), 0.55));
                    });
                    // 便签上的字跟着便签深浅走：深色便签上写黑字就看不清了
                    const noteInk = isDarkColor(tint) ? "#f2efe9" : "#241f18";
                    pen.font(19, font, "600");
                    pen.text(annotation.name, x + 18, rowTop + 34, readingMarkColor(noteInk, 0.72));
                    pen.font(noteType.size, font);
                    let cursor = rowTop + 56;
                    for (const line of plan.lines) {
                        pen.text(line, x + 18, cursor + noteType.size, noteInk);
                        cursor += noteType.lineHeight;
                    }
                });
            });
            rowTop += rowHeight + noteGap;
        }
        y = rowTop - noteGap;
    }

    y += 42;
    const centerY = y + 28;
    // 右边两行竖着放，左边署名按剩下的宽度截断——以前两边挤在一行上会叠字
    pen.font(20, ctx.fonts.body);
    const rightWidth = Math.max(
        pen.measure(progressText(input)),
        pen.measure(stampText(input)),
    );
    const rightEdge = paperX + paperWidth - pad;
    pen.text(progressText(input), rightEdge, centerY - 2, palette.sub, "right");
    pen.text(stampText(input), rightEdge, centerY + 26, palette.sub, "right");
    drawSignature(
        ctx, paperX + pad, centerY, 54, palette.ink, palette.sub, metaLine(input),
        palette.accent, inner - 54 - 20 - rightWidth - 28,
    );
    y = centerY + 40 + pad;

    return y + outer;
}

/** 笔记卡：顶上署名一行，中间大字正文，底下出处。参考小红书那种摘抄卡。 */
function renderNotecard(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 76;
    const inner = WIDTH - pad * 2;
    let y = pad;

    drawSignature(
        ctx, pad, y + 30, 60, palette.ink, palette.sub,
        `摘录于 ${stampText(input)}`, palette.accent, inner - 80,
    );
    y += 96;

    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 44, 78, palette.ink);
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        y += 34;
        y = drawAnnotations(ctx, pad, y, inner, "rule");
    }

    y += 44;
    pen.rect(pad, y, 56, 2, palette.accent);
    y += 26;
    const foot = anchor(pad, inner, ctx.align);
    pen.font(23, ctx.fonts.body);
    pen.text(
        truncateToWidth(pen, `/ ${[bookTitleText(input), input.chapterTitle].filter(Boolean).join(" · ")}`, inner),
        foot.x, y + 23, palette.sub, foot.textAlign,
    );
    y += 34;
    if (input.bookAuthor) {
        pen.font(21, ctx.fonts.body);
        pen.text(truncateToWidth(pen, input.bookAuthor, inner), foot.x, y + 21, palette.sub, foot.textAlign);
        y += 32;
    }
    pen.font(19, ctx.fonts.body);
    pen.text(progressText(input), foot.x, y + 19, readingMarkColor(palette.sub, 0.75), foot.textAlign);
    return y + 19 + pad;
}

/** 满版引号：一个巨大的引号压在背景上，正文盖在它上面，出处收在右下。 */
function renderQuotemark(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 76;
    const inner = WIDTH - pad * 2;

    // 水印引号先画，正文才压得上去
    pen.font(300, ctx.fonts.body, "700");
    pen.text("\u201C", pad - 10, pad + 210, readingMarkColor(palette.accent, isDarkColor(palette.background) ? 0.28 : 0.2));

    let y = pad + 120;
    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 45, 80, palette.ink);
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        y += 36;
        y = drawAnnotations(ctx, pad, y, inner, "rule");
    }

    y += 52;
    pen.font(25, ctx.fonts.body, "600");
    pen.text(
        truncateToWidth(pen, [bookTitleText(input), input.bookAuthor].filter(Boolean).join(" "), inner),
        WIDTH - pad, y + 25, palette.ink, "right",
    );
    y += 38;
    pen.font(20, ctx.fonts.body);
    pen.text(
        truncateToWidth(pen, [input.chapterTitle, progressText(input), stampText(input)].filter(Boolean).join(" · "), inner),
        WIDTH - pad, y + 20, palette.sub, "right",
    );
    y += 34;

    const sigY = y + 34;
    drawSignature(ctx, pad, sigY, 48, palette.sub, palette.sub, null, palette.accent, inner - 120);
    return sigY + 24 + pad;
}

/** 封面带：顶上一条色带放书名作者，下面整块留给大字正文。 */
function renderCoverband(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 76;
    const inner = WIDTH - pad * 2;
    const bandHeight = 268;
    const onBand = isDarkColor(palette.accent) ? "#f6f4ef" : "#1b1a17";

    pen.rect(0, 0, WIDTH, bandHeight, palette.accent);
    // 书脊：没有封面图也要有个东西占住右上角，不然色带空荡荡的
    pen.rect(WIDTH - pad - 76, 54, 76, 108, readingMarkColor(onBand, 0.16));
    pen.rect(WIDTH - pad - 76, 54, 76, 108, readingMarkColor(onBand, 0.0));
    pen.font(34, ctx.fonts.body, "600");
    pen.text(truncateToWidth(pen, bookTitleText(input), inner - 120), pad, bandHeight - 104, onBand);
    pen.font(22, ctx.fonts.body);
    pen.text(
        truncateToWidth(pen, [input.bookAuthor, input.chapterTitle].filter(Boolean).join(" · "), inner - 120),
        pad, bandHeight - 58, readingMarkColor(onBand, 0.78),
    );

    let y = bandHeight + 62;
    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 44, 78, palette.ink);
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        y += 34;
        y = drawAnnotations(ctx, pad, y, inner, "strip");
    }

    y += 48;
    pen.rect(pad, y, inner, 1, readingMarkColor(palette.sub, 0.4));
    y += 28;
    const centerY = y + 24;
    drawSignature(ctx, pad, centerY, 48, palette.ink, palette.sub, null, palette.accent, inner - 260);
    pen.font(19, ctx.fonts.body);
    pen.text(`${progressText(input)} · ${stampText(input)}`, WIDTH - pad, centerY + 7, palette.sub, "right");
    return centerY + 24 + pad;
}

/** 全居中：上下各一个小记号，正文居中，出处也居中。 */
function renderCentered(ctx: Ctx): number {
    const { pen, input, palette } = ctx;
    const pad = 84;
    const inner = WIDTH - pad * 2;
    let y = pad;

    pen.font(22, ctx.fonts.body);
    pen.text("\u2726", WIDTH / 2, y + 22, palette.accent, "center");
    y += 76;

    y += ctx.padTop;
    y = drawQuote(ctx, pad, y, inner, 43, 82, palette.ink);
    y += ctx.fillGap;

    if (input.annotations.length > 0) {
        y += 40;
        y = drawAnnotations(ctx, pad, y, inner, "plain");
    }

    y += 46;
    pen.rect(WIDTH / 2 - 26, y, 52, 1, palette.accent);
    y += 32;

    pen.font(25, ctx.fonts.body);
    pen.text(truncateToWidth(pen, bookTitleText(input), inner), WIDTH / 2, y + 25, palette.ink, "center");
    y += 38;
    const sub = [input.bookAuthor, input.chapterTitle].filter(Boolean).join(" · ");
    if (sub) {
        pen.font(20, ctx.fonts.body);
        pen.text(truncateToWidth(pen, sub, inner), WIDTH / 2, y + 20, palette.sub, "center");
        y += 32;
    }
    pen.font(18, ctx.fonts.body);
    pen.text(
        `${displayName(input)} 摘录于 ${stampText(input)} · ${progressText(input)}`,
        WIDTH / 2, y + 18, readingMarkColor(palette.sub, 0.8), "center",
    );
    return y + 18 + pad;
}

const RENDERERS: Record<ReadingShareTemplate, (ctx: Ctx) => number> = {
    poster: renderPoster,
    bookmark: renderBookmark,
    magazine: renderMagazine,
    minimal: renderMinimal,
    collage: renderCollage,
    letter: renderLetter,
    sticky: renderSticky,
    notecard: renderNotecard,
    quotemark: renderQuotemark,
    coverband: renderCoverband,
    centered: renderCentered,
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
    const avatarShape = input.avatarShape || "circle";

    const measureCanvas = document.createElement("canvas");
    measureCanvas.width = WIDTH;
    measureCanvas.height = 10;
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) throw new Error("当前浏览器不支持生成图片");
    measureCtx.textBaseline = "alphabetic";

    const render = RENDERERS[input.template];
    const base = { input, palette, align, avatarShape, fonts: input.fonts };
    const measure = (typeScale: number, padTop: number, fillGap: number) =>
        Math.round(render({ ...base, totalHeight: 0, typeScale, padTop, fillGap, pen: new Pen(measureCtx, true) }));

    // 固定比例不是把自适应那张拉长或裁一刀，而是各自有一套版面：
    //   1) 这个比例的设计字号先定下来（9:16 满屏看，字略大）
    //   2) 排不下才按比例缩小字号，最多缩到设计值的 MIN_FIT_RATIO
    //   3) 排不满剩下的高度，整块变成正文和页脚之间的一段留白
    // 余量绝不进行距——行距一松，整张图就散了。
    const target = RATIO_HEIGHT[input.ratio || "auto"];
    const designScale = RATIO_TYPE_SCALE[input.ratio || "auto"];
    let typeScale = designScale;
    let padTop = 0;
    let fillGap = 0;
    if (target) {
        // 在[缩到最小, 放大封顶]之间二分，取放得下的最大字号
        let lo = designScale * MIN_FIT_RATIO;
        let hi = designScale * MAX_GROW_RATIO;
        for (let i = 0; i < 20; i += 1) {
            const mid = (lo + hi) / 2;
            if (measure(mid, 0, 0) <= target) lo = mid;
            else hi = mid;
        }
        typeScale = lo;
        // 视觉重心略高于正中，所以上面给得比下面少一点
        const slack = target - measure(typeScale, 0, 0);
        if (slack > 0) {
            padTop = Math.round(slack * 0.42);
            fillGap = slack - padTop;
        }
    }

    // 摘抄太长、缩到最小也塞不进目标比例时，宁可让图变高也不裁掉正文——
    // 裁掉是看不见的损失，变高用户一眼就能发现。
    const natural = Math.max(420, measure(typeScale, padTop, fillGap));
    const height = target && natural <= target ? target : natural;

    // 版面按 1080 宽来算，真正的画布放大 SCALE 倍再画：手机屏幕是 3 倍像素密度，
    // 1080 的图铺满屏幕会被拉伸，存下来看就是糊的。
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持生成图片");
    ctx.scale(SCALE, SCALE);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, WIDTH, height);
    render({ ...base, totalHeight: height, typeScale, padTop, fillGap, pen: new Pen(ctx, false) });
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
