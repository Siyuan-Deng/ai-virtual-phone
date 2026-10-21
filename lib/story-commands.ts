"use client";

// 剧情 App 的系统指令：输入栏左边「指令」按钮切成指令模式，发出去的是一条 system 消息（不算用户说的话）。
// 快捷指令和按钮显不显示都在侧栏里管，所有角色共用一套。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const QUICK_COMMANDS_KEY = "ai_phone_story_quick_commands_v1";
const BUTTON_HIDDEN_KEY = "ai_phone_story_command_button_hidden_v1";
registerKvMigration(QUICK_COMMANDS_KEY);
registerKvMigration(BUTTON_HIDDEN_KEY);

const MAX_COMMANDS = 40;
const MAX_COMMAND_LENGTH = 1000;

export function loadStoryQuickCommands(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(QUICK_COMMANDS_KEY) || "[]") as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, MAX_COMMANDS)
            : [];
    } catch {
        return [];
    }
}

export function saveStoryQuickCommands(commands: string[]): string[] {
    const seen = new Set<string>();
    const next = commands
        .map((item) => item.trim().slice(0, MAX_COMMAND_LENGTH))
        .filter((item) => item && !seen.has(item) && seen.add(item))
        .slice(0, MAX_COMMANDS);
    kvSet(QUICK_COMMANDS_KEY, JSON.stringify(next));
    return next;
}

/** 点快捷指令：接在已经写的后面（另起一行），不替换；可以把几条组合起来发 */
export function appendStoryCommand(current: string, command: string): string {
    const head = current.trimEnd();
    return head ? `${head}\n${command}` : command;
}

/** 输入栏的「指令」按钮显不显示（默认显示） */
export function loadStoryCommandButtonVisible(): boolean {
    if (typeof window === "undefined") return true;
    return kvGet(BUTTON_HIDDEN_KEY) !== "1";
}

export function saveStoryCommandButtonVisible(visible: boolean): void {
    kvSet(BUTTON_HIDDEN_KEY, visible ? "0" : "1");
}

// ── 续写提示词：回复写到一半断了，长按「续写」时接在上下文最后发 ──
// 现在用的那段单独存；另外可以存几档、随时切换（同名覆盖）

const CONTINUE_PROMPT_KEY = "ai_phone_story_continue_prompt_v1";
const CONTINUE_PROMPT_PRESETS_KEY = "ai_phone_story_continue_prompt_presets_v1";
registerKvMigration(CONTINUE_PROMPT_KEY);
registerKvMigration(CONTINUE_PROMPT_PRESETS_KEY);

const MAX_CONTINUE_PRESETS = 40;
const MAX_CONTINUE_PROMPT_LENGTH = 4000;

export const DEFAULT_STORY_CONTINUE_PROMPT =
    "上一条回复写到一半断了。请从断开的地方直接接着往下写：不要重复已经写过的内容，不要从头写，也不要加任何说明；断在句子中间就从那个字接着写。写完按原来的格式收尾，没闭合的标签记得闭合。";

export type StoryContinuePromptPreset = {
    id: string;
    name: string;
    text: string;
    createdAt: string;
};

/** 没改过就是默认那段；清空了发的时候也用默认的 */
export function loadStoryContinuePrompt(): string {
    if (typeof window === "undefined") return DEFAULT_STORY_CONTINUE_PROMPT;
    const stored = kvGet(CONTINUE_PROMPT_KEY);
    return stored === null ? DEFAULT_STORY_CONTINUE_PROMPT : stored;
}

export function saveStoryContinuePrompt(text: string): void {
    kvSet(CONTINUE_PROMPT_KEY, text.slice(0, MAX_CONTINUE_PROMPT_LENGTH));
}

export function loadStoryContinuePromptPresets(): StoryContinuePromptPreset[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(CONTINUE_PROMPT_PRESETS_KEY) || "[]") as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((item): item is StoryContinuePromptPreset =>
                Boolean(item) && typeof item.id === "string" && typeof item.name === "string" && typeof item.text === "string")
            : [];
    } catch {
        return [];
    }
}

/** 同名的直接覆盖——再存一次通常是想更新那一档 */
export function saveStoryContinuePromptPreset(name: string, text: string): StoryContinuePromptPreset {
    const trimmed = name.trim().slice(0, 30) || "未命名";
    const all = loadStoryContinuePromptPresets();
    const existing = all.find((preset) => preset.name === trimmed);
    const preset: StoryContinuePromptPreset = {
        id: existing?.id ?? `scp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        text: text.slice(0, MAX_CONTINUE_PROMPT_LENGTH),
        createdAt: new Date().toISOString(),
    };
    const rest = all.filter((item) => item.id !== preset.id).slice(-(MAX_CONTINUE_PRESETS - 1));
    kvSet(CONTINUE_PROMPT_PRESETS_KEY, JSON.stringify([...rest, preset]));
    return preset;
}

export function deleteStoryContinuePromptPreset(id: string): void {
    const all = loadStoryContinuePromptPresets();
    const next = all.filter((preset) => preset.id !== id);
    if (next.length !== all.length) kvSet(CONTINUE_PROMPT_PRESETS_KEY, JSON.stringify(next));
}
