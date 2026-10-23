"use client";

// 一键夜间。App 里每一处美化（下面叫「一格」：聊天窗的 CSS、剧情某个角色的美化、日历 CSS……）
// 都可以另配一份夜间用的；切到夜间时配了的格子一起换，切回白天原样回来。
// 白天的数据一个字不动，夜间那份单独存在这里。
//
// 一格夜里用什么（NightBinding）：
//   没配         → 跟白天一样
//   scheme       → 用一个存过的方案（css-scheme-storage，就是各编辑框左下角「存方案」存的）
//   own          → 夜间单独一份
// 正则另算：角色在聊天 / 剧情里夜里绑另一套（own 存正则 id 列表），只换显示，不碰提示词。
//
// 自动切换：按时间段，或者跟着手机系统的深色模式。自动开着时手动点了，
// 按时间的到下一个切换点之前听手动的；跟系统的到系统下次切换之前听手动的。

import { useSyncExternalStore } from "react";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { findScheme } from "./css-scheme-storage";
import type { RegexConfig } from "./settings-types";

const STATE_KEY = "ai_phone_night_mode_v1";
const SET_KEY = "ai_phone_night_set_v1";
registerKvMigration(STATE_KEY);
registerKvMigration(SET_KEY);

/** 白天 / 夜间切了（手动或自动）；detail: { night, source } */
export const NIGHT_MODE_CHANGED_EVENT = "night-mode-changed";
/** 夜间套装里某一格改了；detail: { key } */
export const NIGHT_SET_CHANGED_EVENT = "night-set-changed";

export type NightAutoKind = "off" | "time" | "system";

export type NightModeState = {
    night: boolean;
    auto: NightAutoKind;
    /** HH:MM，按时间时夜间从几点开始 */
    start: string;
    /** HH:MM，几点回到白天 */
    end: string;
    /** 上次开着时用的是哪种，关了再开还用它 */
    lastAuto?: "time" | "system";
    /** 按时间：手动切了以后，到这个时刻（下一个切换点）之前不自动切 */
    manualUntil?: number;
    /** 跟系统：手动切的那一刻系统是不是深色；系统还是这个状态就不自动切 */
    manualSystemDark?: boolean;
};

export type NightBinding =
    | { kind: "scheme"; schemeId: string }
    | { kind: "own"; value: string };

const DEFAULT_STATE: NightModeState = { night: false, auto: "off", start: "22:30", end: "07:00" };

/** 白天 / 夜间、自动切换设置、夜间套装，哪个改了都加一：页面靠它知道要重画 */
let revision = 0;

/** 状态在 localStorage 另存一份：App 刚打开、IndexedDB 还没读出来时也知道是不是夜间，
 *  不会先闪一下白天再变回夜间 */
const STATE_MIRROR_KEY = "ai_phone_night_mode_mirror_v1";
let mirrorCache: string | null | undefined;

function readMirror(): string | null {
    if (mirrorCache !== undefined) return mirrorCache;
    try {
        mirrorCache = window.localStorage.getItem(STATE_MIRROR_KEY);
    } catch {
        mirrorCache = null;
    }
    return mirrorCache;
}

function isTime(value: unknown): value is string {
    return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

export function loadNightModeState(): NightModeState {
    if (typeof window === "undefined") return { ...DEFAULT_STATE };
    try {
        const raw = JSON.parse(kvGet(STATE_KEY) || readMirror() || "{}") as Partial<NightModeState>;
        return {
            night: raw.night === true,
            auto: raw.auto === "time" || raw.auto === "system" ? raw.auto : "off",
            start: isTime(raw.start) ? raw.start : DEFAULT_STATE.start,
            end: isTime(raw.end) ? raw.end : DEFAULT_STATE.end,
            ...(raw.lastAuto === "time" || raw.lastAuto === "system" ? { lastAuto: raw.lastAuto } : {}),
            ...(typeof raw.manualUntil === "number" ? { manualUntil: raw.manualUntil } : {}),
            ...(typeof raw.manualSystemDark === "boolean" ? { manualSystemDark: raw.manualSystemDark } : {}),
        };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

function saveState(state: NightModeState): void {
    const json = JSON.stringify(state);
    kvSet(STATE_KEY, json);
    mirrorCache = json;
    try {
        window.localStorage.setItem(STATE_MIRROR_KEY, json);
    } catch {
        // 存不进去也没关系，只是刚打开那一下可能先按白天画
    }
    revision += 1;
}

/** IndexedDB 读出来以后调一次：让已经画出来的页面按读到的状态重画（不弹提示） */
export function announceNightHydrated(): void {
    revision += 1;
    window.dispatchEvent(new CustomEvent(NIGHT_SET_CHANGED_EVENT, { detail: { key: "" } }));
}

export function isNightActive(): boolean {
    return loadNightModeState().night;
}

function minutesOf(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

/** 现在在不在夜间时段里（时段可以跨过零点） */
export function inNightWindow(now: Date, start: string, end: string): boolean {
    const m = now.getHours() * 60 + now.getMinutes();
    const s = minutesOf(start);
    const e = minutesOf(end);
    if (s === e) return false;
    return s < e ? m >= s && m < e : m >= s || m < e;
}

/** 下一个切换点（开始或结束，哪个先到）的时间戳 */
function nextBoundary(now: Date, start: string, end: string): number {
    const at = (hhmm: string) => {
        const d = new Date(now);
        const minutes = minutesOf(hhmm);
        d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        return d.getTime();
    };
    return Math.min(at(start), at(end));
}

export function systemPrefersDark(): boolean | null {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    // 不认这个查询的浏览器 media 会是 "not all"；深浅两个都不匹配也算读不到
    if (dark.media === "not all") return null;
    if (dark.matches) return true;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? false : null;
}

function apply(state: NightModeState, night: boolean, source: "manual" | "auto"): void {
    const changed = state.night !== night;
    saveState({ ...state, night });
    if (changed && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_MODE_CHANGED_EVENT, { detail: { night, source } }));
    }
}

/** 手动切（外观里那张卡）。自动开着时，记下手动管到什么时候 */
export function setNightModeManual(night: boolean): void {
    const state = loadNightModeState();
    const next: NightModeState = { ...state };
    delete next.manualUntil;
    delete next.manualSystemDark;
    if (state.auto === "time") next.manualUntil = nextBoundary(new Date(), state.start, state.end);
    if (state.auto === "system") {
        const dark = systemPrefersDark();
        if (dark !== null) next.manualSystemDark = dark;
    }
    apply(next, night, "manual");
}

/** 改自动切换的设置：改完马上按新设置对一次 */
export function updateNightAuto(patch: Partial<Pick<NightModeState, "auto" | "start" | "end">>): void {
    const state = loadNightModeState();
    const next: NightModeState = { ...state, ...patch };
    if (next.auto === "time" || next.auto === "system") next.lastAuto = next.auto;
    delete next.manualUntil;
    delete next.manualSystemDark;
    saveState(next);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_MODE_CHANGED_EVENT, { detail: { night: next.night, source: "settings" } }));
    }
    tickNightAuto();
}

/** 自动切换对一次表：桌面每分钟、回到前台、系统深浅色变了都调 */
export function tickNightAuto(): void {
    const state = loadNightModeState();
    if (state.auto === "time") {
        if (state.manualUntil && Date.now() < state.manualUntil) return;
        const want = inNightWindow(new Date(), state.start, state.end);
        const next = { ...state };
        delete next.manualUntil;
        if (want !== state.night || state.manualUntil) apply(next, want, "auto");
        return;
    }
    if (state.auto === "system") {
        const dark = systemPrefersDark();
        if (dark === null) return;
        if (state.manualSystemDark !== undefined && state.manualSystemDark === dark) return;
        const next = { ...state };
        delete next.manualSystemDark;
        if (dark !== state.night || state.manualSystemDark !== undefined) apply(next, dark, "auto");
    }
}

// ── 夜间套装 ──

export function loadNightSet(): Record<string, NightBinding> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(SET_KEY) || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        // 早先「某个正则夜里换成另一个」的配法已经不用了，读的时候跳过
        const result: Record<string, NightBinding> = {};
        for (const [key, binding] of Object.entries(parsed as Record<string, { kind?: string }>)) {
            if (binding?.kind === "scheme" || binding?.kind === "own") result[key] = binding as NightBinding;
        }
        return result;
    } catch {
        return {};
    }
}

export function getNightBinding(key: string): NightBinding | undefined {
    return loadNightSet()[key];
}

/** null = 回到「跟白天一样」 */
export function setNightBinding(key: string, binding: NightBinding | null): void {
    const set = loadNightSet();
    if (binding) set[key] = binding;
    else delete set[key];
    kvSet(SET_KEY, JSON.stringify(set));
    revision += 1;
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_SET_CHANGED_EVENT, { detail: { key } }));
    }
}

/** 这一格夜里是什么（不管现在是不是夜间；编辑框、总表用） */
export function nightTextFor(key: string, dayValue: string): string {
    const binding = getNightBinding(key);
    if (!binding) return dayValue;
    if (binding.kind === "own") return binding.value;
    if (binding.kind === "scheme") return findScheme(binding.schemeId)?.css ?? dayValue;
    return dayValue;
}

/** 渲染用：现在是夜间就换成夜间那份，否则原样 */
export function resolveNightText(key: string, dayValue: string): string {
    return isNightActive() ? nightTextFor(key, dayValue) : dayValue;
}

/** 状态栏的方案存的是「契约 + 渲染 + 示例」一整包 JSON，夜里只取渲染那段 */
export function resolveNightStatusRender(sessionId: string, dayRender: string): string {
    if (!isNightActive()) return dayRender;
    const binding = getNightBinding(nightSlotKeys.chatStatus(sessionId));
    if (!binding) return dayRender;
    if (binding.kind === "own") return binding.value;
    if (binding.kind === "scheme") {
        try {
            const parsed = JSON.parse(findScheme(binding.schemeId)?.css || "") as { renderHtml?: unknown };
            if (typeof parsed.renderHtml === "string" && parsed.renderHtml.trim()) return parsed.renderHtml;
        } catch {
            // 方案坏了就照白天
        }
    }
    return dayRender;
}

/** 正则：这个角色在聊天 / 剧情里夜里绑的另一套（存的是正则 id 列表）；没配就是 null */
export function nightRegexIds(key: string): string[] | null {
    const binding = getNightBinding(key);
    if (binding?.kind !== "own") return null;
    try {
        const ids = JSON.parse(binding.value) as unknown;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
    } catch {
        return null;
    }
}

/** 显示 / 剧情渲染用的正则：夜间模式里这个角色配了另一套就换成它（提示词照日间那套） */
export function resolveNightRegexes(key: string | undefined, dayRegexes: RegexConfig[], all: RegexConfig[]): RegexConfig[] {
    if (!key || !isNightActive()) return dayRegexes;
    const ids = nightRegexIds(key);
    if (!ids) return dayRegexes;
    return ids
        .map((id) => all.find((regex) => regex.id === id))
        .filter((regex): regex is RegexConfig => Boolean(regex));
}

/** 各格的 key */
export const nightSlotKeys = {
    themeCss: "theme.css",
    chatApp: "chatApp.css",
    calendar: "calendar.css",
    /** 日历的主题（默认 / 深色 / 奶油……），夜间单独选一个 */
    calendarTheme: "calendar.theme",
    music: "music.css",
    reading: "reading.css",
    mascot: "mascot.css",
    chatSession: (sessionId: string) => `chatSession.css:${sessionId}`,
    chatStatus: (sessionId: string) => `chatSession.status:${sessionId}`,
    /** 聊天背景：夜间单独一张图（聊天图片库的 id） */
    chatBg: (sessionId: string) => `chatSession.bg:${sessionId}`,
    /** 聊天里夜间绑的另一套正则 */
    chatRegex: (sessionId: string) => `chatSession.regex:${sessionId}`,
    story: (sessionId: string) => `story.css:${sessionId}`,
    /** 剧情（正篇 / 番外各自）夜间绑的另一套正则 */
    storyRegex: (sessionId: string) => `story.regex:${sessionId}`,
    /** 剧情显示选项（主题、背景、亮度、纸张、字体、文字颜色）：夜间改过的那几项，JSON */
    storyLook: (sessionId: string) => `story.look:${sessionId}`,
};

// ── React ──

function subscribeMode(callback: () => void): () => void {
    window.addEventListener(NIGHT_MODE_CHANGED_EVENT, callback);
    return () => window.removeEventListener(NIGHT_MODE_CHANGED_EVENT, callback);
}

function subscribeAll(callback: () => void): () => void {
    window.addEventListener(NIGHT_MODE_CHANGED_EVENT, callback);
    window.addEventListener(NIGHT_SET_CHANGED_EVENT, callback);
    return () => {
        window.removeEventListener(NIGHT_MODE_CHANGED_EVENT, callback);
        window.removeEventListener(NIGHT_SET_CHANGED_EVENT, callback);
    };
}

export function useNightActive(): boolean {
    return useSyncExternalStore(subscribeMode, isNightActive, () => false);
}

/** 白天 / 夜间切了、自动切换设置改了、套装改了都会变：拿它当依赖，让用到夜间值的地方重算 */
export function useNightRevision(): number {
    return useSyncExternalStore(subscribeAll, () => revision, () => 0);
}

/** 渲染一格 CSS：自动跟着白天 / 夜间、套装变 */
export function useNightText(key: string | undefined, dayValue: string): string {
    useNightRevision();
    return key ? resolveNightText(key, dayValue) : dayValue;
}
