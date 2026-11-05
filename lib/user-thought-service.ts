// {{user}}思维链和模型之间的事：请求里带上用户写的规则，回复里摘掉隐藏标记并记下决定。
// 挂在和日历同一条 llm.request / llm.response 总线上，只管线上私聊。

import { loadCharacters } from "./character-storage";
import { getChatPluginHookBus } from "./chat-plugin-hooks";
import type { LlmRequestPayload, LlmResponsePayload } from "./chat-plugin-types";
import { loadChatSessions } from "./chat-storage";
import { MacroEngine } from "./macro-engine";
import { resolveUserIdentity } from "./settings-storage";
import { USER_THOUGHT_PEEK_TAG, loadUserThoughtPrompts, saveUserThoughtPeek } from "./user-thought";

const NATIVE_USER_THOUGHT_ID = "__native_user_thought__";
const PEEK_RE = new RegExp(`<${USER_THOUGHT_PEEK_TAG}>\\s*(yes|no)?\\s*</${USER_THOUGHT_PEEK_TAG}>`, "gi");
// 写了一半的标记也不能漏进气泡
const UNCLOSED_PEEK_RE = new RegExp(`<${USER_THOUGHT_PEEK_TAG}>[^<]*$`, "i");

function handleLlmRequest(payload: LlmRequestPayload): LlmRequestPayload {
    const decision = loadUserThoughtPrompts().decision.trim();
    if (!decision || !Array.isArray(payload?.messages) || payload.purpose !== "chat" || !payload.sessionId) return payload;
    if (payload.appTags?.includes("offline") || payload.appTags?.includes("story_extra")) return payload;
    const session = loadChatSessions().find((item) => item.id === payload.sessionId);
    if (!session || session.isGroup || !session.contactId) return payload;
    const character = loadCharacters().find((item) => String(item.id) === String(session.contactId));
    const userName = resolveUserIdentity(session.contactId, "chat")?.name || "用户";
    const content = new MacroEngine(character?.name || "角色", userName).expand(decision);
    const messages = [...payload.messages];
    let index = 0;
    while (index < messages.length && messages[index]?.role === "system") index += 1;
    messages.splice(index, 0, { role: "system", content });
    return { ...payload, messages };
}

function handleLlmResponse(payload: LlmResponsePayload): LlmResponsePayload {
    const text = String(payload?.text || "");
    if (!text.includes(`<${USER_THOUGHT_PEEK_TAG}>`)) return payload;
    let peek: boolean | null = null;
    const cleaned = text
        .replace(PEEK_RE, (_match, value?: string) => {
            peek = value?.toLowerCase() === "yes";
            return "";
        })
        .replace(UNCLOSED_PEEK_RE, "")
        .trim();
    // 没写决定就沿用上一次的
    if (peek !== null && payload.sessionId) saveUserThoughtPeek(payload.sessionId, peek);
    return { ...payload, text: cleaned };
}

let disposeRequestHook: (() => void) | null = null;
let disposeResponseHook: (() => void) | null = null;

export function startUserThoughtService(): void {
    if (typeof window === "undefined" || disposeRequestHook) return;
    const bus = getChatPluginHookBus();
    disposeRequestHook = bus.registerTransform(NATIVE_USER_THOUGHT_ID, "llm.request", handleLlmRequest as (payload: unknown) => unknown, 80, 8000);
    disposeResponseHook = bus.registerTransform(NATIVE_USER_THOUGHT_ID, "llm.response", handleLlmResponse as (payload: unknown) => unknown, 80, 12000);
}

export function stopUserThoughtService(): void {
    disposeRequestHook?.();
    disposeResponseHook?.();
    disposeRequestHook = null;
    disposeResponseHook = null;
}
