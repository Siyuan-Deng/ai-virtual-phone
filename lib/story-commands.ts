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
