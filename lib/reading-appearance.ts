"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

/** 字体档位。song / kai 现在是网络字体（思源宋体 / 霞鹜文楷），id 沿用好让老配置直接生效；
 *  yuan 到 lanting 是只在 Mac 上有的系统字体、serif / sans 是更早的 id，都只为读得懂老配置，见 READING_FONT_OPTIONS。 */
export type ReadingFontFamilyId =
    | "system" | "song" | "kai"
    | "mashanzheng" | "zcoolxiaowei" | "zcoolkuaile" | "longcang" | "zhimangxing" | "liujianmaocao"
    | "yuan" | "hannotate" | "hanzipen"
    | "baoli" | "libian" | "weibei" | "xingkai" | "lanting"
    | "custom"
    | "serif" | "sans";

/** 批注字体可以单独指定，也可以跟随正文（默认）。 */
export type ReadingAnnotationFontFamilyId = "inherit" | ReadingFontFamilyId;

export type ReadingAppearance = {
    fontFamily: ReadingFontFamilyId;
    fontSize: number;
    textColor: string;
    lineHeight: number;
    customFontName?: string;
    /** 缺省即「跟随正文」，老配置读出来就是这个，行为与改动前一致。 */
    annotationFontFamily?: ReadingAnnotationFontFamilyId;
    annotationCustomFontName?: string;
    /** TA 的批注：字号 / 行距 / 颜色。缺省时用 READING_ANNOTATION_STYLE_DEFAULTS，
     *  也就是加这些设置之前 CSS 里写死的那套值。 */
    annotationFontSize?: number;
    annotationLineHeight?: number;
    annotationTextColor?: string;
    /** TA 的批注卡片底色 */
    annotationCardColor?: string;
    /** 用户自己写的批注再单独一档；缺省时跟随角色批注的字体。 */
    userAnnotationFontFamily?: ReadingAnnotationFontFamilyId;
    userAnnotationCustomFontName?: string;
    userAnnotationFontSize?: number;
    userAnnotationLineHeight?: number;
    userAnnotationTextColor?: string;
    userAnnotationCardColor?: string;
    /** 我划的高亮 / 划线颜色 */
    highlightColor?: string;
    underlineColor?: string;
    /** TA 划的高亮 / 划线颜色，和我的分开配 */
    charHighlightColor?: string;
    charUnderlineColor?: string;
    /** 背景图亮度：1 = 原图，<1 压暗，>1 提亮。缺省即 1（和加这个设置之前一样）。 */
    backgroundBrightness?: number;
};

/** 批注卡片的出厂配色和字号。这几个数原来写死在 chat.css 里，
 *  现在搬出来当默认值：用户没调过时渲染结果和以前一模一样。 */
export const READING_ANNOTATION_STYLE_DEFAULTS = {
    fontSize: 12,
    lineHeight: 1.72,
    textColor: "#4a3d1a",
    cardColor: "#fff1a8",
    userTextColor: "#1e3050",
    userCardColor: "#e7f0ff",
    highlightColor: "#ffe278",
    underlineColor: "#be8c3c",
    /** TA 划的默认换一个色系，和自己划的一眼分得开 */
    charHighlightColor: "#bfe3d0",
    charUnderlineColor: "#5c9b7a",
} as const;

export const READING_ANNOTATION_FONT_SIZE_MIN = 9;
export const READING_ANNOTATION_FONT_SIZE_MAX = 22;

/** 把十六进制颜色压暗一档，用来从批注卡片的底色推出划线的颜色。 */
export function darkenHex(hex: string, amount: number): string {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return hex;
    const value = parseInt(match[1], 16);
    const mix = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * (1 - amount))));
    const r = mix((value >> 16) & 255);
    const g = mix((value >> 8) & 255);
    const b = mix(value & 255);
    return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

/** 高亮和划线要留一点透明度，底下的背景图/底色还能透出来。
 *  颜色选择器给的是十六进制，这里补上原来 CSS 里那档透明度。 */
export function readingMarkColor(hex: string, alpha: number): string {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return hex;
    const value = parseInt(match[1], 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const READING_BG_BRIGHTNESS_MIN = 0.4;
export const READING_BG_BRIGHTNESS_MAX = 1.6;

/** 把亮度换成盖在背景图上的一层纯色。不用 filter: brightness()——那会
 *  连正文和按钮一起变暗，这里只想动背景。 */
export function readingBackgroundOverlay(brightness: number | undefined): string | null {
    const value = typeof brightness === "number" && Number.isFinite(brightness) ? brightness : 1;
    if (Math.abs(value - 1) < 0.001) return null;
    const alpha = Math.min(0.85, Math.abs(value - 1));
    const rgb = value < 1 ? "0, 0, 0" : "255, 255, 255";
    const layer = `rgba(${rgb}, ${alpha.toFixed(3)})`;
    return `linear-gradient(${layer}, ${layer})`;
}

export type ReadingFontOption = {
    id: ReadingFontFamilyId;
    label: string;
    cssValue: string;
    /** 网络字体的样式表（jsDelivr）。用到这一项时才加进页面；字体按字分片，只下载用到的字 */
    webCss?: string;
    /** 旧 id：不再出现在下拉里，但老配置选中它时仍然显示、仍然按原字体渲染。 */
    legacy?: true;
};

const FONTSOURCE = "https://cdn.jsdelivr.net/npm/@fontsource";

/** 可选字体。iPhone 上的网页只能用很少几个系统字体，「楷体」「圆体」这类名字写进 CSS
 *  在手机上会静默回落成系统默认、选了也白选，所以除了系统默认和自定义，下拉里全是网络字体：
 *  名字用字体本来的名字，CSS 里先写网络字体、后面跟同类的系统字体兜底（断网时不至于全变样）。
 *
 *  legacy 的都不再出现在下拉里，只为让老配置读得出来：
 *  - yuan 到 lanting：只有 Mac 上才有的系统字体，iPhone 上一律没效果；
 *  - sans「黑体」和系统默认在苹果设备上完全一样，serif「衬线」在 iOS 上落到通用 serif。 */
export const READING_FONT_OPTIONS: ReadingFontOption[] = [
    { id: "system", label: "系统默认", cssValue: "var(--app-font-family)" },
    {
        id: "kai", label: "霞鹜文楷", cssValue: "\"LXGW WenKai\", \"Kaiti SC\", \"STKaiti\", serif",
        webCss: "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css",
    },
    {
        id: "song", label: "思源宋体", cssValue: "\"Noto Serif SC\", \"Songti SC\", \"STSong\", serif",
        webCss: `${FONTSOURCE}/noto-serif-sc@5.2.5/index.css`,
    },
    { id: "mashanzheng", label: "马善政楷书", cssValue: "\"Ma Shan Zheng\", \"Kaiti SC\", serif", webCss: `${FONTSOURCE}/ma-shan-zheng@5.2.5/index.css` },
    { id: "zcoolxiaowei", label: "站酷小薇", cssValue: "\"ZCOOL XiaoWei\", \"Songti SC\", serif", webCss: `${FONTSOURCE}/zcool-xiaowei@5.2.5/index.css` },
    { id: "zcoolkuaile", label: "站酷快乐体", cssValue: "\"ZCOOL KuaiLe\", sans-serif", webCss: `${FONTSOURCE}/zcool-kuaile@5.2.5/index.css` },
    { id: "longcang", label: "龙藏体", cssValue: "\"Long Cang\", cursive", webCss: `${FONTSOURCE}/long-cang@5.2.5/index.css` },
    { id: "zhimangxing", label: "志莽行书", cssValue: "\"Zhi Mang Xing\", cursive", webCss: `${FONTSOURCE}/zhi-mang-xing@5.2.5/index.css` },
    { id: "liujianmaocao", label: "刘建毛草", cssValue: "\"Liu Jian Mao Cao\", cursive", webCss: `${FONTSOURCE}/liu-jian-mao-cao@5.2.5/index.css` },
    { id: "custom", label: "自定义字体", cssValue: "var(--app-font-family)" },
    { id: "yuan", label: "圆体（旧，只在 Mac 上有效）", cssValue: "\"Yuanti SC\", \"STYuanti\", sans-serif", legacy: true },
    { id: "hannotate", label: "手札体（旧，只在 Mac 上有效）", cssValue: "\"Hannotate SC\", \"HannotateSC\", sans-serif", legacy: true },
    { id: "hanzipen", label: "翩翩体（旧，只在 Mac 上有效）", cssValue: "\"HanziPen SC\", \"HanziPenSC\", sans-serif", legacy: true },
    { id: "baoli", label: "报隶（旧，只在 Mac 上有效）", cssValue: "\"Baoli SC\", \"BaoliSC\", serif", legacy: true },
    { id: "libian", label: "隶变（旧，只在 Mac 上有效）", cssValue: "\"Libian SC\", \"LibianSC\", serif", legacy: true },
    { id: "weibei", label: "魏碑（旧，只在 Mac 上有效）", cssValue: "\"Weibei SC\", \"WeibeiSC\", serif", legacy: true },
    { id: "xingkai", label: "行楷（旧，只在 Mac 上有效）", cssValue: "\"Xingkai SC\", \"XingkaiSC\", cursive", legacy: true },
    { id: "lanting", label: "兰亭黑（旧，只在 Mac 上有效）", cssValue: "\"Lantinghei SC\", \"LantingheiSC\", sans-serif", legacy: true },
    { id: "sans", label: "黑体（旧）", cssValue: "\"PingFang SC\", \"Hiragino Sans GB\", \"Noto Sans SC\", sans-serif", legacy: true },
    { id: "serif", label: "衬线（旧）", cssValue: "\"Source Han Serif SC\", \"Noto Serif SC\", serif", legacy: true },
];

/** 用到某个网络字体时把它的样式表加进页面（每个只加一次）。服务端渲染时什么都不做。 */
export function ensureReadingWebFont(id: ReadingFontFamilyId | ReadingAnnotationFontFamilyId | undefined): void {
    if (typeof document === "undefined" || !id) return;
    const href = READING_FONT_OPTIONS.find((option) => option.id === id)?.webCss;
    if (!href || document.querySelector(`link[data-reading-web-font="${id}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.readingWebFont = id;
    document.head.appendChild(link);
}

export const READING_ANNOTATION_FONT_OPTIONS: Array<{ id: ReadingAnnotationFontFamilyId; label: string; legacy?: true }> = [
    { id: "inherit", label: "跟随正文" },
    ...READING_FONT_OPTIONS.map((option) => ({
        id: option.id as ReadingAnnotationFontFamilyId,
        label: option.label,
        ...(option.legacy ? { legacy: option.legacy } : {}),
    })),
];

/** 下拉里该显示哪些项：常规项全给，legacy 项只在它正被选中时补进去，
 *  免得老配置打开设置发现自己选的那一项不见了、下拉却显示成别的字体。 */
export function listReadingFontOptions(current: ReadingFontFamilyId): ReadingFontOption[] {
    return READING_FONT_OPTIONS.filter((option) => !option.legacy || option.id === current);
}

export function listReadingAnnotationFontOptions(
    current: ReadingAnnotationFontFamilyId,
): Array<{ id: ReadingAnnotationFontFamilyId; label: string }> {
    return READING_ANNOTATION_FONT_OPTIONS.filter((option) => !option.legacy || option.id === current);
}

/** 设置里那行示例文字：中英文数字都有，换字体时一眼能看出变化。 */
export const READING_FONT_PREVIEW_TEXT = "春江花月夜 Reading 123";

const APPEARANCE_STORAGE_KEY = "ai_phone_reading_appearance_v1";
registerKvMigration(APPEARANCE_STORAGE_KEY);
const BG_DB_NAME = "reading-appearance-assets";
const BG_STORE_NAME = "assets";
const BG_KEY = "shared-background";
const FONT_KEY = "custom-font";
const ANNOTATION_FONT_KEY = "custom-font-annotation";
const USER_ANNOTATION_FONT_KEY = "custom-font-user-annotation";

export const DEFAULT_READING_APPEARANCE: ReadingAppearance = {
    fontFamily: "system",
    fontSize: 20,
    textColor: "#111111",
    lineHeight: 2.3,
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function canUseStorage(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** 这四个值曾经是写死的默认颜色，没有人「特意选过」它们。
 *  老配置里存着它们时按「没设过」处理，改成跟着批注卡片的颜色走。 */
const LEGACY_MARK_DEFAULTS = {
    highlight: "#ffe278",
    underline: "#be8c3c",
    charHighlight: "#bfe3d0",
    charUnderline: "#5c9b7a",
} as const;

function normalizeAppearance(raw: Partial<ReadingAppearance> | null | undefined): ReadingAppearance {
    const fontFamily = READING_FONT_OPTIONS.some((option) => option.id === raw?.fontFamily)
        ? raw!.fontFamily!
        : DEFAULT_READING_APPEARANCE.fontFamily;
    const fontSize = clamp(Number(raw?.fontSize ?? DEFAULT_READING_APPEARANCE.fontSize) || DEFAULT_READING_APPEARANCE.fontSize, 12, 30);
    const lineHeight = clamp(Number(raw?.lineHeight ?? DEFAULT_READING_APPEARANCE.lineHeight) || DEFAULT_READING_APPEARANCE.lineHeight, 1.2, 2.8);
    const textColor = typeof raw?.textColor === "string" && raw.textColor.trim()
        ? raw.textColor.trim()
        : DEFAULT_READING_APPEARANCE.textColor;
    const customFontName = typeof raw?.customFontName === "string" && raw.customFontName.trim()
        ? raw.customFontName.trim()
        : undefined;
    const annotationFontFamily = READING_ANNOTATION_FONT_OPTIONS.some((option) => option.id === raw?.annotationFontFamily)
        ? raw!.annotationFontFamily!
        : undefined;
    const annotationCustomFontName = typeof raw?.annotationCustomFontName === "string" && raw.annotationCustomFontName.trim()
        ? raw.annotationCustomFontName.trim()
        : undefined;

    const userAnnotationFontFamily = READING_ANNOTATION_FONT_OPTIONS.some((option) => option.id === raw?.userAnnotationFontFamily)
        ? raw!.userAnnotationFontFamily!
        : undefined;
    const userAnnotationCustomFontName = typeof raw?.userAnnotationCustomFontName === "string" && raw.userAnnotationCustomFontName.trim()
        ? raw.userAnnotationCustomFontName.trim()
        : undefined;

    const backgroundBrightness = clamp(
        Number(raw?.backgroundBrightness ?? 1) || 1,
        READING_BG_BRIGHTNESS_MIN,
        READING_BG_BRIGHTNESS_MAX,
    );

    // 批注的字号/行距/颜色：没存过就落到出厂值，存过就夹到合法区间
    const annotationSize = (value: unknown) => clamp(
        Number(value ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize) || READING_ANNOTATION_STYLE_DEFAULTS.fontSize,
        READING_ANNOTATION_FONT_SIZE_MIN,
        READING_ANNOTATION_FONT_SIZE_MAX,
    );
    const annotationLine = (value: unknown) => clamp(
        Number(value ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight) || READING_ANNOTATION_STYLE_DEFAULTS.lineHeight,
        1.1,
        2.6,
    );
    const color = (value: unknown, fallback: string) => (
        typeof value === "string" && value.trim() ? value.trim() : fallback
    );
    /** 没设过（或存的还是老的写死默认值）就从卡片颜色推：高亮用卡片色本身，划线压暗一档 */
    const markColor = (value: unknown, cardColor: string, legacy: string, darken: number) => {
        const stored = typeof value === "string" ? value.trim() : "";
        if (stored && stored.toLowerCase() !== legacy) return stored;
        return darken > 0 ? darkenHex(cardColor, darken) : cardColor;
    };

    const charCardColor = color(raw?.annotationCardColor, READING_ANNOTATION_STYLE_DEFAULTS.cardColor);
    const userCardColor = color(raw?.userAnnotationCardColor, READING_ANNOTATION_STYLE_DEFAULTS.userCardColor);

    return {
        fontFamily, fontSize, textColor, lineHeight, customFontName,
        annotationFontFamily, annotationCustomFontName,
        annotationFontSize: annotationSize(raw?.annotationFontSize),
        annotationLineHeight: annotationLine(raw?.annotationLineHeight),
        annotationTextColor: color(raw?.annotationTextColor, READING_ANNOTATION_STYLE_DEFAULTS.textColor),
        annotationCardColor: charCardColor,
        userAnnotationFontFamily, userAnnotationCustomFontName,
        userAnnotationFontSize: annotationSize(raw?.userAnnotationFontSize),
        userAnnotationLineHeight: annotationLine(raw?.userAnnotationLineHeight),
        userAnnotationTextColor: color(raw?.userAnnotationTextColor, READING_ANNOTATION_STYLE_DEFAULTS.userTextColor),
        userAnnotationCardColor: userCardColor,
        // 划线/高亮的颜色默认跟着各自那档批注卡片走：我的卡片是什么色，我划的线就是什么色。
        // 以前是写死的两组颜色，和卡片颜色对不上（TA 的卡片蓝的、线却是青绿的）。
        // 老配置里存的如果正好是那两组写死的默认值，一并按「没设过」处理，跟着卡片重算。
        highlightColor: markColor(raw?.highlightColor, userCardColor, LEGACY_MARK_DEFAULTS.highlight, 0),
        underlineColor: markColor(raw?.underlineColor, userCardColor, LEGACY_MARK_DEFAULTS.underline, 0.45),
        charHighlightColor: markColor(raw?.charHighlightColor, charCardColor, LEGACY_MARK_DEFAULTS.charHighlight, 0),
        charUnderlineColor: markColor(raw?.charUnderlineColor, charCardColor, LEGACY_MARK_DEFAULTS.charUnderline, 0.45),
        backgroundBrightness,
    };
}

export function resolveReadingFontFamily(fontFamily: ReadingFontFamilyId, customFontFamily?: string): string {
    if (fontFamily === "custom" && customFontFamily) return customFontFamily;
    ensureReadingWebFont(fontFamily);
    return READING_FONT_OPTIONS.find((option) => option.id === fontFamily)?.cssValue || READING_FONT_OPTIONS[0].cssValue;
}

/** 批注字体的 CSS 值；跟随正文（或没配）时返回 undefined，调用方据此不下发变量，
 *  让 CSS 自己回退到正文字体——与改动前的表现完全一致。 */
export function resolveReadingAnnotationFontFamily(
    annotationFontFamily: ReadingAnnotationFontFamilyId | undefined,
    annotationCustomFontFamily?: string,
): string | undefined {
    if (!annotationFontFamily || annotationFontFamily === "inherit") return undefined;
    if (annotationFontFamily === "custom") return annotationCustomFontFamily || undefined;
    ensureReadingWebFont(annotationFontFamily);
    return READING_FONT_OPTIONS.find((option) => option.id === annotationFontFamily)?.cssValue;
}

export function loadReadingAppearance(): ReadingAppearance {
    if (!canUseStorage()) return DEFAULT_READING_APPEARANCE;
    try {
        const raw = kvGet(APPEARANCE_STORAGE_KEY);
        return normalizeAppearance(raw ? JSON.parse(raw) : null);
    } catch {
        return DEFAULT_READING_APPEARANCE;
    }
}

export function saveReadingAppearance(appearance: ReadingAppearance): ReadingAppearance {
    const normalized = normalizeAppearance(appearance);
    if (!canUseStorage()) return normalized;
    try {
        kvSet(APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
        // Ignore quota or serialization failures and keep in-memory settings usable.
    }
    return normalized;
}

function ensureBackgroundStore(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(BG_STORE_NAME)) db.createObjectStore(BG_STORE_NAME);
}

async function openBackgroundDb(): Promise<IDBDatabase> {
    // Open at >= 1: a backup restore may have bumped the stored version higher,
    // and opening at a fixed lower version would throw a VersionError.
    const db = await openIndexedDbAtLeast(BG_DB_NAME, 1, ensureBackgroundStore);
    if (db.objectStoreNames.contains(BG_STORE_NAME)) return db;

    // 库已存在但没有这个 store：这个库注册在备份模块里（data-management/modules.ts），
    // 恢复时会按 spec 建库并抬高版本号。若恢复时快照里没有 assets，就会留下一个
    // 版本号高于 1、却缺 store 的库——此时 openIndexedDbAtLeast 走的是「以现有版本
    // 直接打开」那条分支，upgradeneeded 不触发，store 永远补不上，之后每次
    // transaction 都抛 "One of the specified object stores was not found."。
    // 显式升一个版本把 store 补建出来。
    const staleVersion = db.version;
    const nextVersion = staleVersion + 1;
    db.close();
    const repaired = await openIndexedDbAtLeast(BG_DB_NAME, nextVersion, ensureBackgroundStore)
        .catch((err: unknown) => {
            // 升版本会被任何仍然开着的连接 block 住（别的标签页、或本页泄漏的连接）
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`阅读资源库补建失败：${BG_DB_NAME} v${staleVersion} → v${nextVersion} 被占用或中断（${detail}）`);
        });
    if (repaired.objectStoreNames.contains(BG_STORE_NAME)) return repaired;

    // 补建完还是没有，说明升版本那一步没真正跑到 onupgradeneeded。把库名/版本号带出去，
    // 免得只剩一句没有主语的 "One of the specified object stores was not found."。
    const existing = Array.from(repaired.objectStoreNames).join(", ") || "（空）";
    repaired.close();
    throw new Error(
        `阅读资源库缺少「${BG_STORE_NAME}」：${BG_DB_NAME} v${staleVersion} → 已尝试补建到 v${nextVersion}，`
        + `现有 store = ${existing}`,
    );
}

/** 统一收口资源库的读写：无论成功失败都关闭连接。
 *  连接泄漏会让后续需要升版本补建 store 的修复被自己 block 住。 */
async function withBackgroundDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openBackgroundDb();
    try {
        return await run(db);
    } finally {
        db.close();
    }
}

function putAsset(db: IDBDatabase, key: string, blob: Blob | null): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readwrite");
        const store = tx.objectStore(BG_STORE_NAME);
        if (blob) store.put(blob, key);
        else store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getAsset(db: IDBDatabase, key: string): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readonly");
        const req = tx.objectStore(BG_STORE_NAME).get(key);
        req.onsuccess = () => resolve((req.result as Blob) || null);
        req.onerror = () => reject(req.error);
    });
}

async function loadAsset(key: string): Promise<Blob | null> {
    try {
        return await withBackgroundDb((db) => getAsset(db, key));
    } catch {
        return null;
    }
}

export async function saveReadingBackground(blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, BG_KEY, blob));
}

export async function loadReadingBackground(): Promise<Blob | null> {
    return loadAsset(BG_KEY);
}

export async function saveReadingCustomFont(blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, FONT_KEY, blob));
}

export async function loadReadingCustomFont(): Promise<Blob | null> {
    return loadAsset(FONT_KEY);
}

export async function saveReadingAnnotationFont(blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, ANNOTATION_FONT_KEY, blob));
}

export async function loadReadingAnnotationFont(): Promise<Blob | null> {
    return loadAsset(ANNOTATION_FONT_KEY);
}

/** 通用出入口：其它模块（比如阅读账号头像）往同一个资源库里存东西，
 *  不必各自再开一个 IndexedDB。 */
export async function saveReadingAsset(key: string, blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, key, blob));
}

export async function loadReadingAsset(key: string): Promise<Blob | null> {
    return loadAsset(key);
}

/** 按前缀批量删：删书时要把这本书的插图一起清掉，
 *  否则图片会永远留在资源库里，用户也看不见、删不掉。 */
export async function deleteReadingAssetsByPrefix(prefix: string): Promise<void> {
    await withBackgroundDb((db) => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readwrite");
        const store = tx.objectStore(BG_STORE_NAME);
        const request = store.openKeyCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) store.delete(cursor.key);
            cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

/** 每本书一张封面图。和背景/字体共用同一个资源库，不新开 IndexedDB。 */
function coverKey(bookId: string): string {
    return `cover:${bookId}`;
}

export async function saveReadingCover(bookId: string, blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, coverKey(bookId), blob));
}

export async function loadReadingCover(bookId: string): Promise<Blob | null> {
    return loadAsset(coverKey(bookId));
}

export async function saveReadingUserAnnotationFont(blob: Blob | null): Promise<void> {
    await withBackgroundDb((db) => putAsset(db, USER_ANNOTATION_FONT_KEY, blob));
}

export async function loadReadingUserAnnotationFont(): Promise<Blob | null> {
    return loadAsset(USER_ANNOTATION_FONT_KEY);
}
