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

    return { fontFamily, fontSize, textColor, lineHeight, customFontName, annotationFontFamily, annotationCustomFontName };
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

async function openBackgroundDb(): Promise<IDBDatabase> {
    // Open at >= 1: a backup restore may have bumped the stored version higher,
    // and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(BG_DB_NAME, 1, (db) => {
        if (!db.objectStoreNames.contains(BG_STORE_NAME)) db.createObjectStore(BG_STORE_NAME);
    });
}

export async function saveReadingBackground(blob: Blob | null): Promise<void> {
    const db = await openBackgroundDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readwrite");
        const store = tx.objectStore(BG_STORE_NAME);
        if (blob) store.put(blob, BG_KEY);
        else store.delete(BG_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

export async function loadReadingBackground(): Promise<Blob | null> {
    try {
        const db = await openBackgroundDb();
        const blob = await new Promise<Blob | null>((resolve, reject) => {
            const tx = db.transaction(BG_STORE_NAME, "readonly");
            const req = tx.objectStore(BG_STORE_NAME).get(BG_KEY);
            req.onsuccess = () => resolve((req.result as Blob) || null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return blob;
    } catch {
        return null;
    }
}

export async function saveReadingCustomFont(blob: Blob | null): Promise<void> {
    const db = await openBackgroundDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readwrite");
        const store = tx.objectStore(BG_STORE_NAME);
        if (blob) store.put(blob, FONT_KEY);
        else store.delete(FONT_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

export async function loadReadingCustomFont(): Promise<Blob | null> {
    try {
        const db = await openBackgroundDb();
        const blob = await new Promise<Blob | null>((resolve, reject) => {
            const tx = db.transaction(BG_STORE_NAME, "readonly");
            const req = tx.objectStore(BG_STORE_NAME).get(FONT_KEY);
            req.onsuccess = () => resolve((req.result as Blob) || null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return blob;
    } catch {
        return null;
    }
}

export async function saveReadingAnnotationFont(blob: Blob | null): Promise<void> {
    const db = await openBackgroundDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BG_STORE_NAME, "readwrite");
        const store = tx.objectStore(BG_STORE_NAME);
        if (blob) store.put(blob, ANNOTATION_FONT_KEY);
        else store.delete(ANNOTATION_FONT_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

export async function loadReadingAnnotationFont(): Promise<Blob | null> {
    try {
        const db = await openBackgroundDb();
        const blob = await new Promise<Blob | null>((resolve, reject) => {
            const tx = db.transaction(BG_STORE_NAME, "readonly");
            const req = tx.objectStore(BG_STORE_NAME).get(ANNOTATION_FONT_KEY);
            req.onsuccess = () => resolve((req.result as Blob) || null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return blob;
    } catch {
        return null;
    }
}
