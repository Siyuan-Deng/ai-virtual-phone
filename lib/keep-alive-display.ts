"use client";

// 后台保活放静音时，锁屏和灵动岛上显示什么（设置 → 后台保活那一格点进去改）。
// 没改过就什么都不填，照系统默认。
//   自己填：封面图 + 标题 + 副标题（都可以放好几个，各自随机换；多久换一次自己选：半小时 / 一小时 / 一天 / 自定义 / 不换）
//   跟着角色：最近聊天那个角色的头像和名字（聊天里改了备注就用备注），副标题自己写；还没聊过天就用自己填的
// 进度条两边的时间也能填：左边已播放、右边还剩多少；锁屏上就停在这两个数，不往前走

import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import { loadChatContacts, loadChatSessions } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import type { NowPlaying } from "./now-playing";

const KEY = "ai_phone_keepalive_display_v1";
registerKvMigration(KEY);

/** 改了就广播，保活开着时马上换掉锁屏上的 */
export const KEEP_ALIVE_DISPLAY_CHANGED_EVENT = "keep-alive-display-changed";

/** 好几个的时候多久随机换一次；never：不换，一直用第一个 */
export type KeepAliveRotation = "halfHour" | "hour" | "day" | "custom" | "never";
export const KEEP_ALIVE_ROTATIONS: KeepAliveRotation[] = ["halfHour", "hour", "day", "custom", "never"];

export type KeepAliveDisplay = {
    mode: "custom" | "character";
    /** 标题可以填好几个，随机换 */
    titles: string[];
    /** 副标题也一样 */
    subtitles: string[];
    /** 封面图（压成方图的 data URL），可以放好几张随机换；空数组就是没有 */
    covers: string[];
    rotation: KeepAliveRotation;
    /** 自定义时：每几分钟 / 几小时换一次 */
    rotationEvery: number;
    rotationUnit: "minute" | "hour";
    /** 进度条左边（已播放）、右边（还剩）的时间，「分:秒」或「时:分:秒」；空就照系统默认 */
    elapsed: string;
    remaining: string;
};

export const MAX_KEEP_ALIVE_COVERS = 12;
const MAX_ROTATION_EVERY = 999;

export const EMPTY_KEEP_ALIVE_DISPLAY: KeepAliveDisplay = {
    mode: "custom",
    titles: [""],
    subtitles: [""],
    covers: [],
    rotation: "hour",
    rotationEvery: 20,
    rotationUnit: "minute",
    elapsed: "",
    remaining: "",
};

/** 没改过是 null */
export function loadKeepAliveDisplay(): KeepAliveDisplay | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = JSON.parse(kvGet(KEY) || "null") as (Partial<KeepAliveDisplay> & { title?: unknown; subtitle?: unknown; cover?: unknown }) | null;
        if (!raw || typeof raw !== "object") return null;
        // 早先标题、副标题都只有一个
        const list = (many: unknown, one: unknown) => {
            const items = Array.isArray(many)
                ? many.filter((item): item is string => typeof item === "string")
                : typeof one === "string" ? [one] : [];
            return items.length ? items : [""];
        };
        // 早先时间框按不出冒号，存下来的是 1314 这样的纯数字：当成 13:14
        const clock = (value: unknown) => typeof value !== "string" ? "" : /[:：]/.test(value) ? value : formatClockInput(value);
        // 早先封面只有一张（cover）
        const covers = Array.isArray(raw.covers)
            ? raw.covers.filter((item): item is string => typeof item === "string" && item !== "")
            : typeof raw.cover === "string" && raw.cover ? [raw.cover] : [];
        const every = Math.round(Number(raw.rotationEvery));
        return {
            mode: raw.mode === "character" ? "character" : "custom",
            titles: list(raw.titles, raw.title),
            subtitles: list(raw.subtitles, raw.subtitle),
            covers: covers.slice(0, MAX_KEEP_ALIVE_COVERS),
            // 早先没得选，都是每小时换
            rotation: KEEP_ALIVE_ROTATIONS.includes(raw.rotation as KeepAliveRotation) ? raw.rotation as KeepAliveRotation : "hour",
            rotationEvery: every >= 1 ? Math.min(every, MAX_ROTATION_EVERY) : EMPTY_KEEP_ALIVE_DISPLAY.rotationEvery,
            rotationUnit: raw.rotationUnit === "hour" ? "hour" : "minute",
            elapsed: clock(raw.elapsed),
            remaining: clock(raw.remaining),
        };
    } catch {
        return null;
    }
}

/** null = 恢复系统默认 */
export function saveKeepAliveDisplay(display: KeepAliveDisplay | null): void {
    if (display) kvSet(KEY, JSON.stringify(display));
    else kvRemove(KEY);
    window.dispatchEvent(new CustomEvent(KEEP_ALIVE_DISPLAY_CHANGED_EVENT));
}

function timeOf(iso: string | undefined): number {
    const time = Date.parse(iso || "");
    return Number.isFinite(time) ? time : 0;
}

/** 最近聊天的那个角色（单聊，按会话最后一条消息的时间）；名字和聊天列表里显示的一样，有备注用备注 */
export function latestChatCharacter(): { name: string; avatar: string } | null {
    const contacts = loadChatContacts();
    const characters = loadCharacters();
    const sessions = loadChatSessions()
        .filter((session) => !session.isGroup)
        .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
    for (const session of sessions) {
        const contact = contacts.find((item) => item.id === session.contactId);
        const character = contact ? characters.find((item) => item.id === contact.characterId) : undefined;
        if (!character) continue;
        const avatar = character.avatar && character.avatar !== "none" ? character.avatar : "";
        return { name: session.alias?.trim() || contact?.nickname || character.name || "", avatar };
    }
    return null;
}

/** 按种子出的伪随机数（mulberry32）：同一个种子每次都一样 */
function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 第几轮的出场顺序：n 个洗一次牌；salt 让标题和副标题各洗各的 */
function shuffledOrder(round: number, n: number, salt: number): number[] {
    const order = Array.from({ length: n }, (_, i) => i);
    const random = seededRandom(round * 7919 + n + salt * 104729);
    for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

const MINUTE = 60_000;

/** 按选的频率，现在是第几段、下一段什么时候开始；不换是 null。每天是按手机上的零点分 */
function rotationSlot(display: KeepAliveDisplay, now: number): { index: number; nextAt: number } | null {
    if (display.rotation === "never") return null;
    if (display.rotation === "day") {
        const offset = new Date(now).getTimezoneOffset() * MINUTE;
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        return { index: Math.floor((now - offset) / (1440 * MINUTE)), nextAt: next.getTime() };
    }
    const minutes = display.rotation === "halfHour" ? 30
        : display.rotation === "hour" ? 60
        : Math.max(1, display.rotationEvery) * (display.rotationUnit === "hour" ? 60 : 1);
    const period = minutes * MINUTE;
    const index = Math.floor(now / period);
    return { index, nextAt: (index + 1) * period };
}

/** 这一段用哪一个。像随机播放的歌单：每 n 段一轮，一轮里每个出现一次、顺序打乱；
 *  轮和轮接上的地方也不会连着两段同一个。同一段里不变；不换就一直用第一个 */
function pickForSlot<T>(items: T[], slot: number | null, salt: number): T | undefined {
    const n = items.length;
    if (n <= 1 || slot === null) return items[0];
    // 只有两个就轮流来，不然下面那步换位会把上一轮最后一个也换掉，接缝处会重复
    if (n === 2) return items[(slot + salt) % 2];
    const round = Math.floor(slot / n);
    const order = shuffledOrder(round, n, salt);
    if (order[0] === shuffledOrder(round - 1, n, salt)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
    return items[order[slot % n]];
}

/** 「分:秒」「时:分:秒」换成秒；填得不对（比如秒数过了 59）是 null */
export function parseClock(text: string): number | null {
    const parts = text.trim().replace(/^-/, "").split(/[:：]/);
    if (!parts[0] || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
    if (parts.slice(1).some((part) => Number(part) > 59)) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** 时间框里只按数字，冒号自己补上：520 → 5:20，1314 → 13:14，11314 → 1:13:14 */
export function formatClockInput(text: string): string {
    const digits = text.replace(/\D/g, "").slice(0, 6);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, -2)}:${digits.slice(-2)}`;
    return `${digits.slice(0, -4)}:${digits.slice(-4, -2)}:${digits.slice(-2)}`;
}

/** 离下一次换标题 / 副标题 / 封面还有多久；不换（或者没设过）是 null */
export function msUntilNextRotation(display = loadKeepAliveDisplay(), now = Date.now()): number | null {
    const slot = display ? rotationSlot(display, now) : null;
    return slot ? slot.nextAt - now + 1_000 : null;
}

/** 按现在的设置，锁屏上该显示什么；没改过是 null（照系统默认） */
export function resolveKeepAliveNowPlaying(display = loadKeepAliveDisplay(), now = Date.now()): NowPlaying | null {
    if (!display) return null;
    const slot = rotationSlot(display, now)?.index ?? null;
    const pick = (items: string[], salt: number) => pickForSlot(items.map((item) => item.trim()).filter(Boolean), slot, salt) ?? "";
    const character = display.mode === "character" ? latestChatCharacter() : null;
    const artist = pick(display.subtitles, 1);
    const elapsed = parseClock(display.elapsed);
    const remaining = parseClock(display.remaining);
    const position = elapsed !== null || remaining !== null
        ? { elapsed: elapsed ?? 0, total: (elapsed ?? 0) + (remaining ?? 0) }
        : undefined;
    if (character) return { title: character.name, artist, artwork: character.avatar || undefined, position };
    return {
        title: pick(display.titles, 0) || (typeof document !== "undefined" ? document.title : ""),
        artist,
        artwork: pick(display.covers, 2) || undefined,
        position,
    };
}
