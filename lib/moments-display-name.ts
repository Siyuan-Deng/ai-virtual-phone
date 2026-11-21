"use client";

// 朋友圈和聊天主页上显示的名字。只改显示：存下来的帖子内容、@提醒和进提示词的都是原名。
// - 角色备注：朋友圈互动设置开了「显示角色备注」，角色名换成私聊里给 TA 起的备注。
// - 网名：聊天主页点名字可以设一个「主页网名」；每个聊天的聊天信息里也能设「我的网名」。
//   开了「朋友圈显示网名」，朋友圈顶上用主页网名，在哪个角色的帖子下面就用那个聊天里的网名，
//   自己发的帖子用发的时候选的那个。

import { kvGet, kvSet, kvRemove } from "./kv-db";
import { loadChatSessions } from "./chat-storage";
import { loadMomentsConfig } from "./moments-storage";

/** 角色 id → 备注；没开「显示角色备注」时是空表 */
export function loadMomentsCharacterAliases(): Map<string, string> {
    const aliases = new Map<string, string>();
    if (!loadMomentsConfig().showCharacterAlias) return aliases;
    for (const session of loadChatSessions()) {
        if (session.isGroup || !session.contactId) continue;
        const alias = session.alias?.trim();
        if (alias && !aliases.has(session.contactId)) aliases.set(session.contactId, alias);
    }
    return aliases;
}

// ── 主页网名 ──

const HOME_NICKNAME_KEY = "ai_phone_chat_home_nickname_v1";

export function loadChatHomeNickname(): string {
    try {
        return (kvGet(HOME_NICKNAME_KEY) || "").trim();
    } catch {
        return "";
    }
}

export function saveChatHomeNickname(nickname: string): void {
    const value = nickname.trim();
    try {
        if (value) kvSet(HOME_NICKNAME_KEY, value);
        else kvRemove(HOME_NICKNAME_KEY);
    } catch {
        // 存不进去就只在这次打开里有效
    }
}

// ── 朋友圈里我的名字 ──

export type MomentsUserNicknames = {
    /** 开了「朋友圈显示网名」 */
    enabled: boolean;
    /** 主页网名（没设是空） */
    home: string;
    /** 角色 id → 那个聊天里的「我的网名」 */
    byCharacter: Map<string, string>;
};

export function loadMomentsUserNicknames(): MomentsUserNicknames {
    const enabled = loadMomentsConfig().showUserNickname === true;
    const byCharacter = new Map<string, string>();
    if (!enabled) return { enabled, home: "", byCharacter };
    for (const session of loadChatSessions()) {
        if (session.isGroup || !session.contactId) continue;
        const nickname = session.userNickname?.trim();
        if (nickname && !byCharacter.has(session.contactId)) byCharacter.set(session.contactId, nickname);
    }
    return { enabled, home: loadChatHomeNickname(), byCharacter };
}

/**
 * 一条帖子下面我叫什么（帖子作者、我的评论和回复、别人「回复 我」都用这一个）：
 * 角色的帖子 → 那个聊天里的网名；自己的帖子 → 发的时候选的网名。都没有就退到主页网名、人设名。
 */
export function momentsUserNameForPost(
    nicknames: MomentsUserNicknames,
    post: { authorType: "user" | "character"; authorId: string; authorNickname?: string },
    identityName: string,
): string {
    if (!nicknames.enabled) return identityName;
    if (post.authorType === "character") return nicknames.byCharacter.get(post.authorId) || nicknames.home || identityName;
    return post.authorNickname?.trim() || nicknames.home || identityName;
}

/** 发朋友圈时能选的网名：主页网名、各个聊天里的网名、人设名（同一个名字只列一次） */
export function momentsNicknameChoices(nicknames: MomentsUserNicknames, identityName: string): string[] {
    const choices = [nicknames.home, ...nicknames.byCharacter.values(), identityName].filter(Boolean);
    return Array.from(new Set(choices));
}
