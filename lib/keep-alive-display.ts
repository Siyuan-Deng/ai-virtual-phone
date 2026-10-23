"use client";

// 后台保活放静音时，锁屏和灵动岛上显示什么（设置 → 后台保活那一格点进去改）。
// 没改过就什么都不填，照系统默认。
//   自己填：封面图 + 标题（可以填好几个，每小时随机换一个）+ 副标题
//   跟着角色：最近聊天那个角色的头像和名字，副标题自己写；还没聊过天就用自己填的

import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import { loadChatContacts, loadChatSessions } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import type { NowPlaying } from "./now-playing";

const KEY = "ai_phone_keepalive_display_v1";
registerKvMigration(KEY);

/** 改了就广播，保活开着时马上换掉锁屏上的 */
export const KEEP_ALIVE_DISPLAY_CHANGED_EVENT = "keep-alive-display-changed";

export type KeepAliveDisplay = {
    mode: "custom" | "character";
    /** 标题可以填好几个，每小时随机换一个 */
    titles: string[];
    subtitle: string;
    /** 封面图（压成方图的 data URL），空就是没有 */
    cover: string;
};

export const EMPTY_KEEP_ALIVE_DISPLAY: KeepAliveDisplay = { mode: "custom", titles: [""], subtitle: "", cover: "" };

/** 没改过是 null */
export function loadKeepAliveDisplay(): KeepAliveDisplay | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = JSON.parse(kvGet(KEY) || "null") as (Partial<KeepAliveDisplay> & { title?: unknown }) | null;
        if (!raw || typeof raw !== "object") return null;
        // 早先只有一个 title
        const titles = Array.isArray(raw.titles)
            ? raw.titles.filter((title): title is string => typeof title === "string")
            : typeof raw.title === "string" ? [raw.title] : [];
        return {
            mode: raw.mode === "character" ? "character" : "custom",
            titles: titles.length ? titles : [""],
            subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "",
            cover: typeof raw.cover === "string" ? raw.cover : "",
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

/** 最近聊天的那个角色（单聊，按会话最后更新时间） */
export function latestChatCharacter(): { name: string; avatar: string } | null {
    const contacts = loadChatContacts();
    const characters = loadCharacters();
    const sessions = loadChatSessions()
        .filter((session) => !session.isGroup)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    for (const session of sessions) {
        const contact = contacts.find((item) => item.id === session.contactId);
        const character = contact ? characters.find((item) => item.id === contact.characterId) : undefined;
        if (!character) continue;
        const avatar = character.avatar && character.avatar !== "none" ? character.avatar : "";
        return { name: contact?.nickname || character.name || "", avatar };
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

/** 第几轮的出场顺序：n 个标题洗一次牌 */
function shuffledOrder(round: number, n: number): number[] {
    const order = Array.from({ length: n }, (_, i) => i);
    const random = seededRandom(round * 7919 + n);
    for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

/** 这个小时用哪个标题。像随机播放的歌单：每 n 个小时一轮，一轮里每个标题出现一次、顺序打乱；
 *  轮和轮接上的地方也不会连着两个小时同一个。同一个小时里不变 */
export function titleForThisHour(titles: string[], now = Date.now()): string {
    const filled = titles.map((title) => title.trim()).filter(Boolean);
    if (filled.length <= 1) return filled[0] ?? "";
    const n = filled.length;
    const hour = Math.floor(now / 3_600_000);
    // 只有两个就轮流来，不然下面那步换位会把上一轮最后一个也换掉，接缝处会重复
    if (n === 2) return filled[hour % 2];
    const round = Math.floor(hour / n);
    const order = shuffledOrder(round, n);
    if (order[0] === shuffledOrder(round - 1, n)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
    return filled[order[hour % n]];
}

/** 下一个整点（换标题的时候）还有多久 */
export function msUntilNextHour(now = Date.now()): number {
    return 3_600_000 - (now % 3_600_000) + 1_000;
}

/** 按现在的设置，锁屏上该显示什么；没改过是 null（照系统默认） */
export function resolveKeepAliveNowPlaying(display = loadKeepAliveDisplay()): NowPlaying | null {
    if (!display) return null;
    const character = display.mode === "character" ? latestChatCharacter() : null;
    if (character) return { title: character.name, artist: display.subtitle, artwork: character.avatar || undefined };
    return {
        title: titleForThisHour(display.titles) || (typeof document !== "undefined" ? document.title : ""),
        artist: display.subtitle,
        artwork: display.cover || undefined,
    };
}
