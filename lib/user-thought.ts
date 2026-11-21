// {{user}}思维链：发消息时顺带写下的、没说出口的想法。
// 看不看由角色上一条回复里的隐藏标记决定，不多发请求；决定不看时内容完全不进提示词和记忆。
// 给模型的两段话都是用户在聊天主页自己写的，留空就什么都不发。

import type { ChatMessage } from "./chat-storage";
import { kvGet, kvRemove, kvSet } from "./kv-db";

export const USER_THOUGHT_PROMPTS_KEY = "ai_phone_chat_user_thought_prompts_v1";
export const USER_THOUGHT_PEEK_PREFIX = "ai_phone_chat_user_thought_peek:";
export const USER_THOUGHT_OPEN = "<user_thought>";
export const USER_THOUGHT_CLOSE = "</user_thought>";
export const USER_THOUGHT_PEEK_TAG = "user_thought_peek";

export type UserThoughtPrompts = {
    /** 角色看的那一轮才发，放在思维链前面 */
    prefix: string;
    /** 每轮都发，角色靠它决定下一条看不看 */
    decision: string;
};

export function userThoughtLabel(userName?: string | null): string {
    return `${userName || "用户"}思维链`;
}

export function loadUserThoughtPrompts(): UserThoughtPrompts {
    try {
        const parsed = JSON.parse(kvGet(USER_THOUGHT_PROMPTS_KEY) || "{}") as Partial<UserThoughtPrompts>;
        return { prefix: String(parsed.prefix ?? ""), decision: String(parsed.decision ?? "") };
    } catch {
        return { prefix: "", decision: "" };
    }
}

export function saveUserThoughtPrompts(prompts: UserThoughtPrompts): void {
    if (prompts.prefix.trim() || prompts.decision.trim()) kvSet(USER_THOUGHT_PROMPTS_KEY, JSON.stringify(prompts));
    else kvRemove(USER_THOUGHT_PROMPTS_KEY);
}

/** 这个聊天的角色上一次决定：下一条看不看。规则留空时一律不看 */
export function isUserThoughtPeeking(sessionId: string): boolean {
    return Boolean(loadUserThoughtPrompts().decision.trim()) && kvGet(USER_THOUGHT_PEEK_PREFIX + sessionId) === "1";
}

export function saveUserThoughtPeek(sessionId: string, peek: boolean): void {
    kvSet(USER_THOUGHT_PEEK_PREFIX + sessionId, peek ? "1" : "0");
}

/** 模型收到的样子：思维链包一层放在消息前面，分得清哪句是想的、哪句是说出口的 */
export function formatUserThought(thought: string, content: string, prefix = ""): string {
    return [prefix, USER_THOUGHT_OPEN, thought, USER_THOUGHT_CLOSE, content].filter(Boolean).join("\n");
}

/**
 * 和聊天界面一样按「一串」给：连着发的几条用户消息算一串，这一串里角色看了的想法合在一起（一条一行），
 * 只放在这一串第一条前面，不标哪个想法是跟着哪句话的。没看的不带。
 * 按顺序把要进提示词的消息一条条交给返回的函数；不是用户的消息就把这一串断开。
 */
export function createUserThoughtRunAttacher(
    messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "userThought" | "userThoughtSeen">>,
    prefix = "",
): (msg: Pick<ChatMessage, "id">, content: string) => string {
    const runOf = new Map<string, number>();
    const thoughts: string[][] = [];
    let run = -1;
    for (const msg of messages) {
        if (msg.role !== "user") {
            run = -1;
            continue;
        }
        if (run < 0) {
            run = thoughts.length;
            thoughts.push([]);
        }
        runOf.set(msg.id, run);
        const thought = msg.userThoughtSeen ? msg.userThought?.trim() : "";
        if (thought) thoughts[run].push(thought);
    }
    const attached = new Set<number>();
    return (msg, content) => {
        const index = runOf.get(msg.id);
        if (index === undefined || attached.has(index)) return content;
        attached.add(index);
        return thoughts[index].length > 0 ? formatUserThought(thoughts[index].join("\n"), content, prefix) : content;
    };
}
