"use client";

// 后台保活放静音时，锁屏和灵动岛上显示什么（设置 → 后台保活那一格点进去改）。
// 没改过就什么都不填，照系统默认。
//   自己填：封面图 + 标题 + 副标题
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
    title: string;
    subtitle: string;
    /** 封面图（压成方图的 data URL），空就是没有 */
    cover: string;
};

export const EMPTY_KEEP_ALIVE_DISPLAY: KeepAliveDisplay = { mode: "custom", title: "", subtitle: "", cover: "" };

/** 没改过是 null */
export function loadKeepAliveDisplay(): KeepAliveDisplay | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = JSON.parse(kvGet(KEY) || "null") as Partial<KeepAliveDisplay> | null;
        if (!raw || typeof raw !== "object") return null;
        return {
            mode: raw.mode === "character" ? "character" : "custom",
            title: typeof raw.title === "string" ? raw.title : "",
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

/** 按现在的设置，锁屏上该显示什么；没改过是 null（照系统默认） */
export function resolveKeepAliveNowPlaying(display = loadKeepAliveDisplay()): NowPlaying | null {
    if (!display) return null;
    const character = display.mode === "character" ? latestChatCharacter() : null;
    if (character) return { title: character.name, artist: display.subtitle, artwork: character.avatar || undefined };
    return {
        title: display.title.trim() || (typeof document !== "undefined" ? document.title : ""),
        artist: display.subtitle,
        artwork: display.cover || undefined,
    };
}
