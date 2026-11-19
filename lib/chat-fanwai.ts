"use client";

// 聊天 App 的番外：暂停正篇，让模型一次写完一整段 {{user}} 和 {{char}} 的手机聊天记录，
// 单独一个界面（像线下），但气泡、长按菜单、多选收藏和美化都和正篇聊天共用。
// 番外消息挂在一个单独的会话 id（fanwai:正篇会话id）下，和正篇存在同一个消息库：
// 不进会话列表、不进正篇的提示词和记忆，也不触发追问、日历这些。

import { kvGet, kvSet } from "./kv-db";
import { CHAT_FANWAI_SESSION_PREFIX, type ChatMessage } from "./chat-storage";
import { formatRichMediaForHistory } from "./llm-prompt-assembler";

export { CHAT_FANWAI_SESSION_PREFIX };

export function chatFanwaiSessionId(sessionId: string): string {
    return `${CHAT_FANWAI_SESSION_PREFIX}${sessionId}`;
}

export function isChatFanwaiSessionId(sessionId: string | undefined | null): boolean {
    return typeof sessionId === "string" && sessionId.startsWith(CHAT_FANWAI_SESSION_PREFIX);
}

// ── 番外模板：照剧情 App 的番外模板来，去掉聊天记录用不上的人称和场景数，字数（以上）换成至少多少条 ──

export type ChatFanwaiTemplate = {
    /** 梗概：这篇番外大概写什么 */
    content: string;
    /** if线设定：如果……会怎样 */
    ifLine: string;
    /** 文风 / 语气 */
    style: string;
    /** 至少多少条消息 */
    count: string;
    /** 其它要求 */
    extra: string;
    /** 带上正篇最近的聊天（让语气和人物关系接得上） */
    includeMain: boolean;
    /** 带上之前的番外（同一个平行世界接着写时用） */
    includePrevious: boolean;
};

export const DEFAULT_CHAT_FANWAI_TEMPLATE: ChatFanwaiTemplate = {
    content: "",
    ifLine: "",
    style: "",
    count: "",
    extra: "",
    includeMain: true,
    includePrevious: false,
};

const TEMPLATE_KEY_PREFIX = "chat-fanwai-template:";

function text(value: unknown, max = 8000): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

export function normalizeChatFanwaiTemplate(value: unknown): ChatFanwaiTemplate {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
        content: text(raw.content),
        ifLine: text(raw.ifLine, 4000),
        style: text(raw.style, 200),
        count: text(raw.count, 20),
        extra: text(raw.extra, 2000),
        includeMain: raw.includeMain !== false,
        includePrevious: raw.includePrevious === true,
    };
}

export function loadChatFanwaiTemplate(sessionId: string): ChatFanwaiTemplate {
    try {
        const raw = kvGet(TEMPLATE_KEY_PREFIX + sessionId);
        return raw ? normalizeChatFanwaiTemplate(JSON.parse(raw)) : { ...DEFAULT_CHAT_FANWAI_TEMPLATE };
    } catch {
        return { ...DEFAULT_CHAT_FANWAI_TEMPLATE };
    }
}

export function saveChatFanwaiTemplate(sessionId: string, template: ChatFanwaiTemplate): void {
    try {
        kvSet(TEMPLATE_KEY_PREFIX + sessionId, JSON.stringify(normalizeChatFanwaiTemplate(template)));
    } catch {
        // 存不进去就只在这次打开里有效
    }
}

/** 句末没有标点就补个句号，免得几段话粘在一起 */
function asSentence(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /[。！？!?…」”’）)】]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/** 条数：「20」「20条」「至少20条」都行，统一成「20」 */
export function cleanChatFanwaiCount(value: string): string {
    return value.trim().replace(/^(至少|最少|大约|约)/, "").replace(/条(消息)?(以上)?$/, "").trim();
}

/** 模板拼成番外指令卡上那段话（格式照剧情 App 的番外指令：if线 / 梗概 / 条数 / 文风 / 其它要求，哪项没填就省掉） */
export function buildChatFanwaiInstruction(template: ChatFanwaiTemplate): string {
    let body = "";
    if (template.ifLine.trim()) body += asSentence(`这是一条if线：${template.ifLine.trim()}`);
    if (template.content.trim()) body += asSentence(`大概内容为${template.content.trim()}`);
    const clauses: string[] = [];
    const count = cleanChatFanwaiCount(template.count);
    if (count) clauses.push(`至少${count}条消息`);
    if (template.style.trim()) clauses.push(`文风${template.style.trim()}`);
    if (clauses.length > 0) body += `${clauses.join("，")}。`;
    if (template.extra.trim()) body += asSentence(template.extra);
    return body;
}

// ── 番外指令消息上记的东西 ──

export type ChatFanwaiMeta = NonNullable<ChatMessage["fanwai"]>;

export function isChatFanwaiInstruction(msg: Pick<ChatMessage, "mediaType" | "fanwai">): boolean {
    return msg.mediaType === "system_instruction" && !!msg.fanwai;
}

// ── 发给模型的那段：开头照剧情 App 的番外提示词，后面说明番外是什么和输出格式 ──

const INSTRUCTION_HEAD = "现在暂停当前剧情，为我生成一段番外，标题自拟。";
/** 勾了「带上之前的番外」：不然「暂停当前剧情」会让模型把前面的番外也一起撇开 */
const INCLUDE_PREVIOUS_LINE = "前面是之前写过的番外，人物关系和已经发生的事以它们为准，这一篇可以是新的故事。";

export function buildChatFanwaiRequestText(
    instruction: string,
    options: { includePrevious: boolean; userName: string; charName: string },
): string {
    const { userName, charName } = options;
    let body = INSTRUCTION_HEAD;
    if (options.includePrevious) body += INCLUDE_PREVIOUS_LINE;
    body += asSentence(instruction);
    return [
        `（$系统指令：${body}）`,
        "",
        "【番外是什么】",
        `番外是正篇之外的一段小故事：可以是平行世界、if线、以前或以后的某一天。它不改变正篇的剧情和关系进展，写完就回到正篇。`,
        `这段番外用${userName}和${charName}之间的手机聊天记录来呈现：一次写完一整段，双方的消息都由你来写，${userName}的消息也由你写。`,
        "",
        "【输出格式】",
        "只输出下面这样的聊天记录，前后不要加任何别的内容：",
        `<chatlog title="番外标题">`,
        `<msg from="char" time="23:41">${charName}发的一条消息</msg>`,
        `<msg from="user">${userName}发的一条消息</msg>`,
        "</chatlog>",
        "",
        `- from 只写 char（${charName}）或 user（${userName}），不写名字。`,
        "- 一个 <msg> 就是一个气泡，一个人连发几条就写几个 <msg>。",
        "- time 可以不写；时间跳开的时候在那条消息上标一下，用 24 小时制 HH:MM。",
        "- 撤回的消息加上 recalled=\"true\"。",
        "- 消息里可以用正篇聊天里的格式（语音条、表情包、图片、位置等），写法和平时一样。",
        "- 不写旁白、动作和心理描写，所有内容都靠聊天消息本身来表现。",
    ].join("\n");
}

/** 「重试以下」点在一篇番外中间：前面的留着发回去，让模型从那里接着写 */
export const CHAT_FANWAI_CONTINUE_TEXT = "（$系统指令：上面这段番外聊天记录写到一半，从最后一条消息之后接着往下写。格式不变，只输出新的 <msg>，已经写过的不要重复。）";

// ── 解析模型输出 ──

export type ChatFanwaiItem = {
    from: "user" | "char";
    time?: string;
    recalled: boolean;
    content: string;
};

export type ParsedChatFanwai = {
    title: string;
    items: ChatFanwaiItem[];
    /** 没按格式写：整段当成 TA 的一条消息 */
    malformed: boolean;
};

function attr(attrs: string, name: string): string {
    const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|([^\\s>]+))`, "i").exec(attrs);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

function normalizeTime(value: string): string | undefined {
    const match = /^(\d{1,2})[:：](\d{2})$/.exec(value.trim());
    if (!match) return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return undefined;
    return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function resolveFrom(value: string, names: { user: string; char: string }): "user" | "char" {
    const v = value.trim().toLowerCase();
    if (!v) return "char";
    if (v === "user" || v === "{{user}}" || v === "我" || v === "你") return "user";
    if (names.user && value.trim() === names.user) return "user";
    return "char";
}

/** 思考过程不该出现在聊天记录里：常见的几种思考标签整块去掉 */
function stripThinking(raw: string): string {
    return raw.replace(/<(thinking|think|thought)>[\s\S]*?<\/\1>/gi, "");
}

/** 流式时只认已经写完的 <msg>（闭合了的），没写完的那条等下一段再出 */
export function parseChatFanwaiOutput(
    raw: string,
    names: { user: string; char: string },
    options?: { partial?: boolean },
): ParsedChatFanwai {
    const cleaned = stripThinking(raw);
    const titleMatch = /<chatlog\b([^>]*)>/i.exec(cleaned);
    const title = titleMatch ? attr(titleMatch[1], "title") : "";
    const items: ChatFanwaiItem[] = [];
    const msgRe = /<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi;
    let match: RegExpExecArray | null;
    while ((match = msgRe.exec(cleaned))) {
        const content = match[2].trim();
        if (!content) continue;
        items.push({
            from: resolveFrom(attr(match[1], "from"), names),
            time: normalizeTime(attr(match[1], "time")),
            recalled: /^(true|1|yes)$/i.test(attr(match[1], "recalled")),
            content,
        });
    }
    if (items.length > 0 || options?.partial) return { title, items, malformed: false };
    const fallback = cleaned
        .replace(/<\/?chatlog\b[^>]*>/gi, "")
        .replace(/<\/?msg\b[^>]*>/gi, "")
        .trim();
    return {
        title,
        items: fallback ? [{ from: "char", recalled: false, content: fallback }] : [],
        malformed: true,
    };
}

/** 已经存下来的一篇番外拼回聊天记录格式（模型原文丢了时用），带之前的番外时发回去 */
export function formatChatFanwaiEpisode(
    title: string | undefined,
    messages: ChatMessage[],
    names: { user: string; char: string },
): string {
    const lines = [`<chatlog title="${(title || "").replace(/"/g, "'")}">`];
    for (const msg of messages) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const from = msg.role === "user" ? "user" : "char";
        const recalled = msg.isRetracted ? ` recalled="true"` : "";
        const body = msg.mediaType ? formatRichMediaForHistory(msg, names.user, names.char) : msg.content;
        if (!body.trim()) continue;
        lines.push(`<msg from="${from}"${recalled}>${body}</msg>`);
    }
    lines.push("</chatlog>");
    return lines.join("\n");
}
