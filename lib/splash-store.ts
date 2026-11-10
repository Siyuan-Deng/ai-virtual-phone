"use client";

// 开屏库：保存的多套开屏、每个搭配的随机池。
// 开屏比 IndexedDB 先出来，所以整份配置在 localStorage 另存一份（图片和字体只存 id，文件在主题素材库），
// 打开 App 时靠这份决定放哪一套。float 原版不是一条配置，是兜底：随机池里什么都没有时放它。

import { useSyncExternalStore } from "react";
import { kvGet, kvSet, kvSetAsync } from "./kv-db";
import { DAY_SET_ID, lookSetAtBoot } from "./night-mode";
import { SPLASH_BOOT_PICK_GLOBAL, SPLASH_LAST_PICK_KEY, SPLASH_MIRROR_KEY, SPLASH_TONE_KEY } from "./splash-first-paint";
import { deleteThemeAsset, getThemeAssetDataUrl } from "./theme-storage";
import { splashUploadedFamily, type SplashMotion, type SplashStageConfig, type SplashTextLayer } from "./splash-effects";

const LIBRARY_KEY = "ai_phone_splash_library_v1";
const MIRROR_KEY = SPLASH_MIRROR_KEY;
const LAST_PICK_KEY = SPLASH_LAST_PICK_KEY;
/** 存了但还没确认写进 IndexedDB：这时候 App 被杀，下次以 localStorage 那份为准 */
const PENDING_KEY = "ai_phone_splash_library_pending_v1";

export const SPLASH_FLOAT_ID = "float";
export const SPLASH_MAX_TEXTS = 3;

export type SplashConfig = SplashStageConfig & {
    id: string;
    name: string;
    imageAssetId: string | null;
    updatedAt: string;
};

export type SplashFontFile = { id: string; name: string; assetId: string };

export type SplashLibrary = {
    splashes: SplashConfig[];
    /** float 原版从开屏库里删掉了（没有可选的时候还是放它） */
    floatRemoved: boolean;
    /** 搭配 id → 随机池；没有这一项就是跟随日间 */
    pools: Record<string, string[]>;
    autoEnter: boolean;
    fonts: SplashFontFile[];
};

export type SplashBootPlan =
    | { kind: "float"; autoEnter: boolean }
    | { kind: "custom"; autoEnter: boolean; config: SplashConfig; fonts: SplashFontFile[] };

const MOTIONS: SplashMotion[] = ["none", "fade", "zoom", "settle", "bright"];

function emptyLibrary(): SplashLibrary {
    return { splashes: [], floatRemoved: false, pools: { [DAY_SET_ID]: [SPLASH_FLOAT_ID] }, autoEnter: false, fonts: [] };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function str(value: unknown, fallback: string): string {
    return typeof value === "string" && value ? value : fallback;
}

function cleanText(raw: Partial<SplashTextLayer>, index: number): SplashTextLayer {
    return {
        id: str(raw.id, `text_${index}`),
        text: typeof raw.text === "string" ? raw.text.slice(0, 40) : "",
        x: clamp(raw.x, 0, 100, 50),
        y: clamp(raw.y, 0, 100, 45),
        size: clamp(raw.size, 12, 120, 40),
        color: str(raw.color, "#ffffff"),
        font: str(raw.font, "song"),
        effect: str(raw.effect, "blur"),
        start: clamp(raw.start, 0, 6, 0),
        dir: raw.dir === "v" ? "v" : "h",
        speed: clamp(raw.speed, 0.5, 2, 1),
    };
}

function cleanSplash(raw: Partial<SplashConfig>, index: number): SplashConfig {
    return {
        id: str(raw.id, `splash_${index}`),
        name: str(raw.name, "开屏"),
        imageAssetId: typeof raw.imageAssetId === "string" && raw.imageAssetId ? raw.imageAssetId : null,
        bgColor: str(raw.bgColor, "#174BFF"),
        motion: MOTIONS.includes(raw.motion as SplashMotion) ? raw.motion as SplashMotion : "fade",
        shade: clamp(raw.shade, 0, 70, 0),
        texts: Array.isArray(raw.texts) ? raw.texts.slice(0, SPLASH_MAX_TEXTS).map(cleanText) : [],
        updatedAt: str(raw.updatedAt, ""),
    };
}

function parseLibrary(json: string | null): SplashLibrary {
    if (!json) return emptyLibrary();
    try {
        const raw = JSON.parse(json) as Partial<SplashLibrary>;
        const pools: Record<string, string[]> = {};
        if (raw.pools && typeof raw.pools === "object") {
            for (const [setId, ids] of Object.entries(raw.pools)) {
                if (Array.isArray(ids)) pools[setId] = ids.filter((id): id is string => typeof id === "string");
            }
        }
        if (!pools[DAY_SET_ID]) pools[DAY_SET_ID] = [];
        return {
            splashes: Array.isArray(raw.splashes) ? raw.splashes.map(cleanSplash) : [],
            floatRemoved: raw.floatRemoved === true,
            pools,
            autoEnter: raw.autoEnter === true,
            fonts: Array.isArray(raw.fonts) ? raw.fonts.filter((font) => font && typeof font.id === "string" && typeof font.assetId === "string") : [],
        };
    } catch {
        return emptyLibrary();
    }
}

function readMirror(): string | null {
    try {
        return window.localStorage.getItem(MIRROR_KEY);
    } catch {
        return null;
    }
}

function writeMirror(json: string | null): void {
    try {
        if (json === null) window.localStorage.removeItem(MIRROR_KEY);
        else window.localStorage.setItem(MIRROR_KEY, json);
    } catch {
        // 存不进去也没关系，只是这次打开先放原版
    }
}

function setPending(pending: boolean): void {
    try {
        if (pending) window.localStorage.setItem(PENDING_KEY, "1");
        else window.localStorage.removeItem(PENDING_KEY);
    } catch {
        // 记不下来也没关系，只是最后一次保存可能丢
    }
}

function isPending(): boolean {
    try {
        return window.localStorage.getItem(PENDING_KEY) === "1";
    } catch {
        return false;
    }
}

export function loadSplashLibrary(): SplashLibrary {
    if (typeof window === "undefined") return emptyLibrary();
    return parseLibrary(kvGet(LIBRARY_KEY) || readMirror());
}

let revision = 0;
const listeners = new Set<() => void>();

function saveLibrary(library: SplashLibrary): void {
    const json = JSON.stringify(library);
    setPending(true);
    writeMirror(json);
    void kvSetAsync(LIBRARY_KEY, json).then(() => {
        if (readMirror() === json) setPending(false);
    }).catch((error) => console.warn("[Splash] 保存失败", error));
    revision += 1;
    listeners.forEach((listener) => listener());
}

/** 在 IndexedDB 读出来以后调一次。平时以 IndexedDB 为准（恢复备份后下次打开就按备份放）；
 *  上次没写完就被杀了的话，localStorage 那份才是新的，补写回去，不能拿旧的把它盖掉 */
export function syncSplashMirror(): void {
    const stored = kvGet(LIBRARY_KEY);
    const mirror = readMirror();
    if ((isPending() || !stored) && mirror) {
        if (mirror !== stored) kvSet(LIBRARY_KEY, mirror);
        setPending(false);
        revision += 1;
        return;
    }
    writeMirror(stored);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSplashLibrary(): SplashLibrary {
    useSyncExternalStore(subscribe, () => revision, () => 0);
    return loadSplashLibrary();
}

// ── 随机池 ──

export function followsDayPool(library: SplashLibrary, setId: string): boolean {
    return setId !== DAY_SET_ID && !library.pools[setId];
}

function validIds(library: SplashLibrary, ids: string[]): string[] {
    return ids.filter((id) => (id === SPLASH_FLOAT_ID ? !library.floatRemoved : library.splashes.some((splash) => splash.id === id)));
}

export function splashPool(library: SplashLibrary, setId: string): string[] {
    return validIds(library, library.pools[setId] ?? library.pools[DAY_SET_ID] ?? []);
}

export function toggleSplashInPool(setId: string, splashId: string): void {
    const library = loadSplashLibrary();
    const pool = library.pools[setId] ?? [];
    const next = pool.includes(splashId) ? pool.filter((id) => id !== splashId) : [...pool, splashId];
    saveLibrary({ ...library, pools: { ...library.pools, [setId]: next } });
}

export function setSplashFollowDay(setId: string, follow: boolean): void {
    const library = loadSplashLibrary();
    const pools = { ...library.pools };
    if (follow) delete pools[setId];
    else pools[setId] = splashPool(library, setId);
    saveLibrary({ ...library, pools });
}

export function setSplashAutoEnter(autoEnter: boolean): void {
    saveLibrary({ ...loadSplashLibrary(), autoEnter });
}

/** 搭配配置页那一行右边的字 */
export function splashPoolSummary(library: SplashLibrary, setId: string): string {
    if (followsDayPool(library, setId)) return "跟随日间";
    const pool = splashPool(library, setId);
    if (pool.length === 0) return "float 原版";
    if (pool.length > 1) return `${pool.length} 套随机`;
    return pool[0] === SPLASH_FLOAT_ID ? "float 默认" : library.splashes.find((splash) => splash.id === pool[0])?.name ?? "float 原版";
}

// ── 增删改 ──

function makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function makeSplashTextLayer(y: number, start: number): SplashTextLayer {
    return { id: makeId("text"), text: "写点什么", x: 50, y, size: 40, color: "#ffffff", font: "song", effect: "ml6", start, dir: "h", speed: 1 };
}

export function makeSplashConfig(): SplashConfig {
    const count = loadSplashLibrary().splashes.length;
    return {
        id: makeId("splash"),
        name: `开屏 ${count + 1}`,
        imageAssetId: null,
        bgColor: "#174BFF",
        motion: "fade",
        shade: 0,
        texts: [makeSplashTextLayer(42, 0.4)],
        updatedAt: "",
    };
}

/** 保存；新的一套自动放进 poolSet 的随机池（跟随日间的搭配不动） */
export function saveSplashConfig(config: SplashConfig, poolSet?: string): void {
    const library = loadSplashLibrary();
    const saved = { ...config, updatedAt: new Date().toISOString() };
    const exists = library.splashes.some((splash) => splash.id === config.id);
    const splashes = exists ? library.splashes.map((splash) => (splash.id === config.id ? saved : splash)) : [...library.splashes, saved];
    const pools = { ...library.pools };
    if (!exists && poolSet && !followsDayPool(library, poolSet)) pools[poolSet] = [...(pools[poolSet] ?? []), saved.id];
    saveLibrary({ ...library, splashes, pools });
}

export function renameSplash(id: string, name: string): void {
    const library = loadSplashLibrary();
    saveLibrary({ ...library, splashes: library.splashes.map((splash) => (splash.id === id ? { ...splash, name } : splash)) });
}

export function copySplash(id: string): void {
    const library = loadSplashLibrary();
    const index = library.splashes.findIndex((splash) => splash.id === id);
    if (index < 0) return;
    const source = library.splashes[index];
    const copy: SplashConfig = { ...source, id: makeId("splash"), name: `${source.name} 副本`, texts: source.texts.map((text) => ({ ...text })), updatedAt: new Date().toISOString() };
    const splashes = [...library.splashes];
    splashes.splice(index + 1, 0, copy);
    saveLibrary({ ...library, splashes });
}

function withoutId(pools: Record<string, string[]>, id: string): Record<string, string[]> {
    return Object.fromEntries(Object.entries(pools).map(([setId, ids]) => [setId, ids.filter((item) => item !== id)]));
}

/** 这张图还有没有别的开屏在用（复制出来的共用一张），没有才删 */
export async function releaseSplashImage(assetId: string | null, library: SplashLibrary = loadSplashLibrary()): Promise<void> {
    if (!assetId || library.splashes.some((splash) => splash.imageAssetId === assetId)) return;
    await deleteThemeAsset(assetId).catch(() => undefined);
}

export async function deleteSplash(id: string): Promise<void> {
    const library = loadSplashLibrary();
    if (id === SPLASH_FLOAT_ID) {
        saveLibrary({ ...library, floatRemoved: true, pools: withoutId(library.pools, id) });
        return;
    }
    const target = library.splashes.find((splash) => splash.id === id);
    const next = { ...library, splashes: library.splashes.filter((splash) => splash.id !== id), pools: withoutId(library.pools, id) };
    saveLibrary(next);
    await releaseSplashImage(target?.imageAssetId ?? null, next);
}

export function restoreFloatSplash(): void {
    saveLibrary({ ...loadSplashLibrary(), floatRemoved: false });
}

// ── 上传字体 ──

export function addSplashFont(font: Omit<SplashFontFile, "id">): SplashFontFile {
    const saved = { ...font, id: makeId("font") };
    const library = loadSplashLibrary();
    saveLibrary({ ...library, fonts: [...library.fonts, saved] });
    return saved;
}

export async function removeSplashFont(id: string): Promise<void> {
    const library = loadSplashLibrary();
    const font = library.fonts.find((item) => item.id === id);
    saveLibrary({ ...library, fonts: library.fonts.filter((item) => item.id !== id) });
    if (font) await deleteThemeAsset(font.assetId).catch(() => undefined);
}

const loadedFonts = new Map<string, Promise<void>>();

/** 把上传的字体注册进 document.fonts；读不出来就用宋体兜底，不报错 */
export function ensureSplashFonts(fonts: SplashFontFile[]): Promise<void> {
    return Promise.all(fonts.map((font) => {
        const existing = loadedFonts.get(font.id);
        if (existing) return existing;
        const loading = (async () => {
            const url = await getThemeAssetDataUrl(font.assetId);
            if (!url) return;
            // 字体文件常有十几 MB，整段 dataURL 塞进 CSS 的 url() 里解析很慢，转成二进制给它
            const buffer = await (await fetch(url)).arrayBuffer();
            document.fonts.add(await new FontFace(splashUploadedFamily(font.id), buffer).load());
        })().catch((error) => console.warn("[Splash] 字体读取失败", error));
        loadedFonts.set(font.id, loading);
        return loading;
    })).then(() => undefined);
}

// ── 这次打开放哪一套 ──

function readLastPick(): string | null {
    try {
        return window.localStorage.getItem(LAST_PICK_KEY);
    } catch {
        return null;
    }
}

function writeLastPick(id: string): void {
    try {
        window.localStorage.setItem(LAST_PICK_KEY, id);
    } catch {
        // 记不住上一次也没关系，只是可能连着两次放同一套
    }
}

let bootPlan: SplashBootPlan | null = null;
let bootImage: Promise<string | null> | null = null;

/** 一次启动只抽一次：开发模式下组件挂两遍也是同一套 */
export function splashBootPlan(): SplashBootPlan {
    if (bootPlan) return bootPlan;
    const library = loadSplashLibrary();
    const pool = splashPool(library, lookSetAtBoot());
    // <head> 里的脚本已经挑过了，第一帧的底色就是按它铺的：照着放，不然底色和开屏对不上
    const preset = (window as unknown as Record<string, unknown>)[SPLASH_BOOT_PICK_GLOBAL];
    const last = readLastPick();
    const choices = pool.length > 1 ? pool.filter((id) => id !== last) : pool;
    const picked = typeof preset === "string" && pool.includes(preset) ? preset : choices[Math.floor(Math.random() * choices.length)];
    if (picked) writeLastPick(picked);
    const config = library.splashes.find((splash) => splash.id === picked);
    bootPlan = config
        ? { kind: "custom", autoEnter: library.autoEnter, config, fonts: library.fonts.filter((font) => config.texts.some((text) => text.font === font.id)) }
        : { kind: "float", autoEnter: library.autoEnter };
    return bootPlan;
}

/** 原图的平均色存下来，下次开屏第一帧先铺这个颜色（splash-first-paint） */
function rememberImageTone(assetId: string, image: HTMLImageElement): void {
    try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(image, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
        }
        const n = data.length / 4;
        const tone = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
        const saved = JSON.parse(window.localStorage.getItem(SPLASH_TONE_KEY) || "{}") as Record<string, string>;
        if (saved[assetId] === tone) return;
        // 只留现在还在用的图
        const inUse = new Set(loadSplashLibrary().splashes.map((splash) => splash.imageAssetId));
        const next: Record<string, string> = { [assetId]: tone };
        for (const [id, color] of Object.entries(saved)) if (inUse.has(id) && id !== assetId) next[id] = color;
        window.localStorage.setItem(SPLASH_TONE_KEY, JSON.stringify(next));
    } catch {
        // 算不出来就还用背景色
    }
}

async function readBootImage(assetId: string): Promise<string | null> {
    const url = await getThemeAssetDataUrl(assetId).catch(() => null);
    if (url) {
        const image = new Image();
        image.src = url;
        await image.decode().catch(() => undefined);
        rememberImageTone(assetId, image);
    }
    return url;
}

/** 这次开屏的原图。第一次调的时候开始读，之后都是同一份 */
export function splashBootImage(): Promise<string | null> {
    if (bootImage) return bootImage;
    const plan = splashBootPlan();
    const assetId = plan.kind === "custom" ? plan.config.imageAssetId : null;
    bootImage = assetId ? readBootImage(assetId) : Promise.resolve(null);
    return bootImage;
}
