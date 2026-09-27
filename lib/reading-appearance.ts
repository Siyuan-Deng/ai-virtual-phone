"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

export type ReadingFontFamilyId = "system" | "song" | "serif" | "sans" | "custom";

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
    /** 用户自己写的批注再单独一档；缺省时跟随角色批注的字体。 */
    userAnnotationFontFamily?: ReadingAnnotationFontFamilyId;
    userAnnotationCustomFontName?: string;
};

export const READING_FONT_OPTIONS: Array<{ id: ReadingFontFamilyId; label: string; cssValue: string }> = [
    { id: "system", label: "系统阅读", cssValue: "var(--app-font-family)" },
    { id: "song", label: "宋体", cssValue: "\"Songti SC\", \"STSong\", \"Noto Serif SC\", serif" },
    { id: "serif", label: "衬线", cssValue: "\"Source Han Serif SC\", \"Noto Serif SC\", serif" },
    { id: "sans", label: "黑体", cssValue: "\"PingFang SC\", \"Hiragino Sans GB\", \"Noto Sans SC\", sans-serif" },
    { id: "custom", label: "自定义上传", cssValue: "var(--app-font-family)" },
];

export const READING_ANNOTATION_FONT_OPTIONS: Array<{ id: ReadingAnnotationFontFamilyId; label: string }> = [
    { id: "inherit", label: "跟随正文" },
    ...READING_FONT_OPTIONS.map((option) => ({ id: option.id as ReadingAnnotationFontFamilyId, label: option.label })),
];

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

    return {
        fontFamily, fontSize, textColor, lineHeight, customFontName,
        annotationFontFamily, annotationCustomFontName,
        userAnnotationFontFamily, userAnnotationCustomFontName,
    };
}

export function resolveReadingFontFamily(fontFamily: ReadingFontFamilyId, customFontFamily?: string): string {
    if (fontFamily === "custom" && customFontFamily) return customFontFamily;
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
