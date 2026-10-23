"use client";

// 搭配（原来叫一键夜间）。日间是底子，就是各处平常改的那一份；另外每一套搭配（自带的夜间，
// 加上自己建的雨天、节日……）都可以给 App 里每一处美化（下面叫「一格」：聊天窗的 CSS、
// 剧情某个角色的美化、日历 CSS……）另配一份；切到哪套，配了的格子就一起换，切回日间原样回来。
// 日间的数据一个字不动，各套搭配那份单独存在这里。
//
// 函数名里的「夜间」是早先只有夜间一套时起的，现在指「当前用的那套（不是日间的）搭配」。
//
// 一格在某套搭配里用什么（NightBinding）：
//   没配         → 跟日间一样
//   scheme       → 用一个存过的方案（css-scheme-storage，就是各编辑框左下角「存方案」存的）
//   own          → 这套单独一份
// 正则另算：角色在聊天 / 剧情里绑另一套（own 存正则 id 列表），只换显示，不碰提示词。
//
// 自动切换：按时间点（到几点开始用哪套，可以加好几个），或者跟着手机系统的深浅色（浅色 / 深色各用哪套）。
// 自动开着时手动点了，按时间的到下一个时间点之前听手动的；跟系统的到系统下次切换之前听手动的。

import { useSyncExternalStore } from "react";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { findScheme } from "./css-scheme-storage";
import type { RegexConfig } from "./settings-types";

const STATE_KEY = "ai_phone_night_mode_v1";
/** 夜间那套的各格（早先就存在这里，夜间一直用它） */
const SET_KEY = "ai_phone_night_set_v1";
/** 自己建的搭配（名字、颜色、各格）和所有搭配的顺序 */
const SETS_KEY = "ai_phone_look_sets_v1";
registerKvMigration(STATE_KEY);
registerKvMigration(SET_KEY);
registerKvMigration(SETS_KEY);

/** 换了一套搭配（手动或自动）；detail: { night, set, source }，night = 用的不是日间 */
export const NIGHT_MODE_CHANGED_EVENT = "night-mode-changed";
/** 搭配里某一格改了、搭配建了 / 删了 / 改名了；detail: { key } */
export const NIGHT_SET_CHANGED_EVENT = "night-set-changed";

export const DAY_SET_ID = "day";
export const NIGHT_SET_ID = "night";

export type LookSet = {
    id: string;
    name: string;
    /** 外观卡上小手机的颜色（只管预览，不影响美化） */
    color: string;
    /** 日间、夜间是自带的，不能删、不能改名 */
    builtin: boolean;
};

/** 新建搭配时挑的方案颜色 */
export const LOOK_SET_COLORS = ["#9fb1c4", "#e79a8c", "#f2bfd2", "#a7c9a0", "#c9b6e4", "#e8cf8f"];

export type NightAutoKind = "off" | "time" | "system";

/** 按时间：到这个点开始用哪套，一直用到下一个点 */
export type AutoPoint = { time: string; set: string };

export type NightModeState = {
    /** 现在用的是哪套搭配 */
    active: string;
    auto: NightAutoKind;
    points: AutoPoint[];
    /** 跟随系统：手机浅色时用哪套 */
    systemLight: string;
    /** 跟随系统：手机深色时用哪套 */
    systemDark: string;
    /** 上次开着时用的是哪种，关了再开还用它 */
    lastAuto?: "time" | "system";
    /** 按时间：手动切了以后，到这个时刻（下一个时间点）之前不自动切 */
    manualUntil?: number;
    /** 跟系统：手动切的那一刻系统是不是深色；系统还是这个状态就不自动切 */
    manualSystemDark?: boolean;
};

export type NightBinding =
    | { kind: "scheme"; schemeId: string }
    | { kind: "own"; value: string };

const DEFAULT_POINTS: AutoPoint[] = [{ time: "07:00", set: DAY_SET_ID }, { time: "22:30", set: NIGHT_SET_ID }];

/** 换搭配、自动切换设置、哪套里的格子改了、搭配列表改了，都加一：页面靠它知道要重画 */
let revision = 0;

/** 状态在 localStorage 另存一份：App 刚打开、IndexedDB 还没读出来时也知道用的哪套，
 *  不会先闪一下日间再变回去 */
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

function bump(key = ""): void {
    revision += 1;
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_SET_CHANGED_EVENT, { detail: { key } }));
    }
}

// ── 搭配列表 ──

type StoredSet = { id: string; name: string; color: string; bindings: Record<string, NightBinding> };
type SetsDoc = { order: string[]; sets: StoredSet[] };

function cleanBindings(raw: unknown): Record<string, NightBinding> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // 早先「某个正则夜里换成另一个」的配法已经不用了，读的时候跳过
    const result: Record<string, NightBinding> = {};
    for (const [key, binding] of Object.entries(raw as Record<string, { kind?: string }>)) {
        if (binding?.kind === "scheme" || binding?.kind === "own") result[key] = binding as NightBinding;
    }
    return result;
}

function loadSetsDoc(): SetsDoc {
    if (typeof window === "undefined") return { order: [], sets: [] };
    try {
        const raw = JSON.parse(kvGet(SETS_KEY) || "{}") as { order?: unknown; sets?: unknown };
        const sets = Array.isArray(raw.sets)
            ? raw.sets
                .filter((item): item is StoredSet => Boolean(item) && typeof item.id === "string" && typeof item.name === "string")
                .map((item) => ({ id: item.id, name: item.name, color: typeof item.color === "string" ? item.color : LOOK_SET_COLORS[0], bindings: cleanBindings(item.bindings) }))
            : [];
        const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === "string") : [];
        return { order, sets };
    } catch {
        return { order: [], sets: [] };
    }
}

function saveSetsDoc(doc: SetsDoc): void {
    kvSet(SETS_KEY, JSON.stringify(doc));
    bump();
}

const BUILTIN_SETS: LookSet[] = [
    { id: DAY_SET_ID, name: "日间", color: "#d8e3f6", builtin: true },
    { id: NIGHT_SET_ID, name: "夜间", color: "#1f2536", builtin: true },
];

/** 所有搭配，按管理页排的顺序；日间、夜间总在里面 */
export function listLookSets(): LookSet[] {
    const doc = loadSetsDoc();
    const all: LookSet[] = [...BUILTIN_SETS, ...doc.sets.map((set) => ({ id: set.id, name: set.name, color: set.color, builtin: false }))];
    const rank = (id: string) => {
        const index = doc.order.indexOf(id);
        return index === -1 ? doc.order.length + all.findIndex((set) => set.id === id) : index;
    };
    return all.sort((a, b) => rank(a.id) - rank(b.id));
}

export function findLookSet(id: string): LookSet | undefined {
    return listLookSets().find((set) => set.id === id);
}

export function lookSetName(id: string): string {
    return findLookSet(id)?.name ?? "日间";
}

/** 删掉的搭配当日间 */
function existingSet(id: string | undefined): string {
    if (!id) return DAY_SET_ID;
    if (id === DAY_SET_ID || id === NIGHT_SET_ID) return id;
    return loadSetsDoc().sets.some((set) => set.id === id) ? id : DAY_SET_ID;
}

/** 新建一套：copyFrom 是从哪套复制格子（日间 = 全部跟随日间） */
export function createLookSet(input: { name: string; color: string; copyFrom: string }): string {
    const doc = loadSetsDoc();
    const id = `look_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const bindings = input.copyFrom === DAY_SET_ID ? {} : { ...loadNightSet(existingSet(input.copyFrom)) };
    doc.sets.push({ id, name: input.name.trim() || "新搭配", color: input.color, bindings });
    if (doc.order.length) doc.order.push(id);
    saveSetsDoc(doc);
    return id;
}

export function updateLookSet(id: string, patch: { name?: string; color?: string }): void {
    const doc = loadSetsDoc();
    const set = doc.sets.find((item) => item.id === id);
    if (!set) return;
    if (patch.name !== undefined) set.name = patch.name.trim() || set.name;
    if (patch.color !== undefined) set.color = patch.color;
    saveSetsDoc(doc);
}

/** 删一套：正在用它就回到日间；自动切换里指着它的时间点也改成日间 */
export function deleteLookSet(id: string): void {
    if (id === DAY_SET_ID || id === NIGHT_SET_ID) return;
    const doc = loadSetsDoc();
    doc.sets = doc.sets.filter((set) => set.id !== id);
    doc.order = doc.order.filter((item) => item !== id);
    saveSetsDoc(doc);
    const state = loadNightModeState();
    const swap = (set: string) => (set === id ? DAY_SET_ID : set);
    const next: NightModeState = {
        ...state,
        points: state.points.map((point) => ({ ...point, set: swap(point.set) })),
        systemLight: swap(state.systemLight),
        systemDark: swap(state.systemDark),
    };
    if (state.active === id) apply(next, DAY_SET_ID, "manual");
    else {
        saveState(next);
        bump();
    }
}

export function reorderLookSets(ids: string[]): void {
    const doc = loadSetsDoc();
    doc.order = ids;
    saveSetsDoc(doc);
}

// ── 现在用哪套、自动切换 ──

export function loadNightModeState(): NightModeState {
    const fallback: NightModeState = { active: DAY_SET_ID, auto: "off", points: DEFAULT_POINTS, systemLight: DAY_SET_ID, systemDark: NIGHT_SET_ID };
    if (typeof window === "undefined") return fallback;
    try {
        const raw = JSON.parse(kvGet(STATE_KEY) || readMirror() || "{}") as Partial<NightModeState> & { night?: unknown; start?: unknown; end?: unknown };
        // 早先只存了 night 和 start / end 两个时间：换成「用哪套」和两个时间点
        const points = Array.isArray(raw.points)
            ? raw.points.filter((point): point is AutoPoint => Boolean(point) && isTime(point.time) && typeof point.set === "string")
            : [];
        const legacyPoints: AutoPoint[] = [
            { time: isTime(raw.end) ? raw.end : DEFAULT_POINTS[0].time, set: DAY_SET_ID },
            { time: isTime(raw.start) ? raw.start : DEFAULT_POINTS[1].time, set: NIGHT_SET_ID },
        ];
        return {
            active: existingSet(typeof raw.active === "string" ? raw.active : raw.night === true ? NIGHT_SET_ID : DAY_SET_ID),
            auto: raw.auto === "time" || raw.auto === "system" ? raw.auto : "off",
            points: points.length ? points : legacyPoints,
            systemLight: typeof raw.systemLight === "string" ? raw.systemLight : DAY_SET_ID,
            systemDark: typeof raw.systemDark === "string" ? raw.systemDark : NIGHT_SET_ID,
            ...(raw.lastAuto === "time" || raw.lastAuto === "system" ? { lastAuto: raw.lastAuto } : {}),
            ...(typeof raw.manualUntil === "number" ? { manualUntil: raw.manualUntil } : {}),
            ...(typeof raw.manualSystemDark === "boolean" ? { manualSystemDark: raw.manualSystemDark } : {}),
        };
    } catch {
        return fallback;
    }
}

function saveState(state: NightModeState): void {
    const json = JSON.stringify(state);
    kvSet(STATE_KEY, json);
    mirrorCache = json;
    try {
        window.localStorage.setItem(STATE_MIRROR_KEY, json);
    } catch {
        // 存不进去也没关系，只是刚打开那一下可能先按日间画
    }
    revision += 1;
}

/** IndexedDB 读出来以后调一次：让已经画出来的页面按读到的状态重画（不弹提示） */
export function announceNightHydrated(): void {
    bump();
}

/** 现在用的哪套搭配 */
export function activeLookSet(): string {
    return loadNightModeState().active;
}

/** 现在用的是不是日间以外的某套搭配 */
export function isNightActive(): boolean {
    return activeLookSet() !== DAY_SET_ID;
}

/** 编辑框里「日间模式」右边那个默认是哪套：现在用的那套；现在是日间就夜间 */
export function defaultEditSet(): string {
    const active = activeLookSet();
    return active === DAY_SET_ID ? NIGHT_SET_ID : active;
}

function minutesOf(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

export function sortPoints(points: AutoPoint[]): AutoPoint[] {
    return [...points].sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
}

/** 按时间点，现在该用哪套：今天最后一个已经过了的点；一个都还没到就是昨天最后那个 */
function setAt(now: Date, points: AutoPoint[]): string {
    const sorted = sortPoints(points);
    if (!sorted.length) return DAY_SET_ID;
    const m = now.getHours() * 60 + now.getMinutes();
    let current = sorted[sorted.length - 1].set;
    for (const point of sorted) if (minutesOf(point.time) <= m) current = point.set;
    return existingSet(current);
}

/** 下一个时间点的时间戳 */
function nextBoundary(now: Date, points: AutoPoint[]): number {
    const at = (hhmm: string) => {
        const d = new Date(now);
        const minutes = minutesOf(hhmm);
        d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        return d.getTime();
    };
    return Math.min(...points.map((point) => at(point.time)));
}

export function systemPrefersDark(): boolean | null {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    // 不认这个查询的浏览器 media 会是 "not all"；深浅两个都不匹配也算读不到
    if (dark.media === "not all") return null;
    if (dark.matches) return true;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? false : null;
}

function apply(state: NightModeState, active: string, source: "manual" | "auto"): void {
    const changed = state.active !== active;
    saveState({ ...state, active });
    if (changed && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_MODE_CHANGED_EVENT, { detail: { night: active !== DAY_SET_ID, set: active, source } }));
    }
}

/** 手动换一套（外观里那排小手机）。自动开着时，记下手动管到什么时候 */
export function setActiveLookSet(id: string): void {
    const state = loadNightModeState();
    const next: NightModeState = { ...state };
    delete next.manualUntil;
    delete next.manualSystemDark;
    if (state.auto === "time" && state.points.length) next.manualUntil = nextBoundary(new Date(), state.points);
    if (state.auto === "system") {
        const dark = systemPrefersDark();
        if (dark !== null) next.manualSystemDark = dark;
    }
    apply(next, existingSet(id), "manual");
}

/** 改自动切换的设置：改完马上按新设置对一次 */
export function updateNightAuto(patch: Partial<Pick<NightModeState, "auto" | "points" | "systemLight" | "systemDark">>): void {
    const state = loadNightModeState();
    const next: NightModeState = { ...state, ...patch };
    if (next.auto === "time" || next.auto === "system") next.lastAuto = next.auto;
    delete next.manualUntil;
    delete next.manualSystemDark;
    saveState(next);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(NIGHT_MODE_CHANGED_EVENT, { detail: { night: next.active !== DAY_SET_ID, set: next.active, source: "settings" } }));
    }
    tickNightAuto();
}

/** 自动切换对一次表：桌面每半分钟、回到前台、系统深浅色变了都调 */
export function tickNightAuto(): void {
    const state = loadNightModeState();
    if (state.auto === "time") {
        if (state.manualUntil && Date.now() < state.manualUntil) return;
        const want = setAt(new Date(), state.points);
        const next = { ...state };
        delete next.manualUntil;
        if (want !== state.active || state.manualUntil) apply(next, want, "auto");
        return;
    }
    if (state.auto === "system") {
        const dark = systemPrefersDark();
        if (dark === null) return;
        if (state.manualSystemDark !== undefined && state.manualSystemDark === dark) return;
        const next = { ...state };
        delete next.manualSystemDark;
        const want = existingSet(dark ? state.systemDark : state.systemLight);
        if (want !== state.active || state.manualSystemDark !== undefined) apply(next, want, "auto");
    }
}

// ── 各套搭配里的格子 ──

/** 这套搭配配了的所有格子；setId 不传就是编辑默认的那套（现在用的那套，日间时是夜间） */
export function loadNightSet(setId: string = defaultEditSet()): Record<string, NightBinding> {
    if (typeof window === "undefined" || setId === DAY_SET_ID) return {};
    if (setId !== NIGHT_SET_ID) return loadSetsDoc().sets.find((set) => set.id === setId)?.bindings ?? {};
    try {
        return cleanBindings(JSON.parse(kvGet(SET_KEY) || "{}"));
    } catch {
        return {};
    }
}

export function getNightBinding(key: string, setId: string = defaultEditSet()): NightBinding | undefined {
    return loadNightSet(setId)[key];
}

/** null = 回到「跟随日间」 */
export function setNightBinding(key: string, binding: NightBinding | null, setId: string = defaultEditSet()): void {
    if (setId === DAY_SET_ID) return;
    if (setId === NIGHT_SET_ID) {
        const set = loadNightSet(NIGHT_SET_ID);
        if (binding) set[key] = binding;
        else delete set[key];
        kvSet(SET_KEY, JSON.stringify(set));
    } else {
        const doc = loadSetsDoc();
        const target = doc.sets.find((set) => set.id === setId);
        if (!target) return;
        if (binding) target.bindings[key] = binding;
        else delete target.bindings[key];
        kvSet(SETS_KEY, JSON.stringify(doc));
    }
    bump(key);
}

/** 这一格在这套搭配里是什么（不管现在用的哪套；编辑框、总表用） */
export function nightTextFor(key: string, dayValue: string, setId: string = defaultEditSet()): string {
    const binding = getNightBinding(key, setId);
    if (!binding) return dayValue;
    if (binding.kind === "own") return binding.value;
    if (binding.kind === "scheme") return findScheme(binding.schemeId)?.css ?? dayValue;
    return dayValue;
}

/** 渲染用：现在用的不是日间就换成那套的那份，否则原样 */
export function resolveNightText(key: string, dayValue: string): string {
    return isNightActive() ? nightTextFor(key, dayValue, activeLookSet()) : dayValue;
}

/** 状态栏的方案存的是「契约 + 渲染 + 示例」一整包 JSON，只取渲染那段 */
export function resolveNightStatusRender(sessionId: string, dayRender: string): string {
    if (!isNightActive()) return dayRender;
    const binding = getNightBinding(nightSlotKeys.chatStatus(sessionId), activeLookSet());
    if (!binding) return dayRender;
    if (binding.kind === "own") return binding.value;
    if (binding.kind === "scheme") {
        try {
            const parsed = JSON.parse(findScheme(binding.schemeId)?.css || "") as { renderHtml?: unknown };
            if (typeof parsed.renderHtml === "string" && parsed.renderHtml.trim()) return parsed.renderHtml;
        } catch {
            // 方案坏了就照日间
        }
    }
    return dayRender;
}

/** 正则：这个角色在聊天 / 剧情里这套搭配绑的另一套（存的是正则 id 列表）；没配就是 null */
export function nightRegexIds(key: string, setId: string = defaultEditSet()): string[] | null {
    const binding = getNightBinding(key, setId);
    if (binding?.kind !== "own") return null;
    try {
        const ids = JSON.parse(binding.value) as unknown;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
    } catch {
        return null;
    }
}

/** 显示 / 剧情渲染用的正则：现在这套搭配里这个角色配了另一套就换成它（提示词照日间那套） */
export function resolveNightRegexes(key: string | undefined, dayRegexes: RegexConfig[], all: RegexConfig[]): RegexConfig[] {
    if (!key || !isNightActive()) return dayRegexes;
    const ids = nightRegexIds(key, activeLookSet());
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
    /** 日历的主题（默认 / 深色 / 奶油……），这套搭配单独选一个 */
    calendarTheme: "calendar.theme",
    music: "music.css",
    reading: "reading.css",
    mascot: "mascot.css",
    chatSession: (sessionId: string) => `chatSession.css:${sessionId}`,
    chatStatus: (sessionId: string) => `chatSession.status:${sessionId}`,
    /** 聊天背景：这套搭配单独一张图（聊天图片库的 id） */
    chatBg: (sessionId: string) => `chatSession.bg:${sessionId}`,
    /** 聊天里这套搭配绑的另一套正则 */
    chatRegex: (sessionId: string) => `chatSession.regex:${sessionId}`,
    story: (sessionId: string) => `story.css:${sessionId}`,
    /** 剧情（正篇 / 番外各自）这套搭配绑的另一套正则 */
    storyRegex: (sessionId: string) => `story.regex:${sessionId}`,
    /** 剧情显示选项（主题、背景、亮度、纸张、字体、文字颜色）：这套搭配改过的那几项，JSON */
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

/** 用的是不是日间以外的搭配 */
export function useNightActive(): boolean {
    return useSyncExternalStore(subscribeMode, isNightActive, () => false);
}

/** 现在用的哪套搭配的 id */
export function useActiveLookSet(): string {
    return useSyncExternalStore(subscribeMode, activeLookSet, () => DAY_SET_ID);
}

/** 换搭配、自动切换设置改了、哪套里的格子改了、搭配列表改了都会变：拿它当依赖，让用到搭配值的地方重算 */
export function useNightRevision(): number {
    return useSyncExternalStore(subscribeAll, () => revision, () => 0);
}

/** 渲染一格 CSS：自动跟着换搭配、搭配里的格子变 */
export function useNightText(key: string | undefined, dayValue: string): string {
    useNightRevision();
    return key ? resolveNightText(key, dayValue) : dayValue;
}
