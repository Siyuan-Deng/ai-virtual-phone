"use client";

// 剧情 App 的番外：每个角色一个番外窗口，单独绑定 API / 预设 / 世界书 / 正则，
// 读记忆区但不写进记忆区。用「番外模板」填几项，发出去的就是一条拼好的系统指令。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { StoryExtraBindings, StoryExtraConfig, StoryExtraPerson, StoryExtraTemplate, StoryMessage } from "./story-storage";

const PRESET_KEY = "ai_phone_story_extra_presets_v1";
registerKvMigration(PRESET_KEY);

const PERSONS: StoryExtraPerson[] = ["第一人称", "第二人称", "第三人称"];
export const STORY_EXTRA_PERSONS = PERSONS;

export const DEFAULT_STORY_EXTRA_TEMPLATE: StoryExtraTemplate = {
    content: "",
    ifLine: "",
    style: "",
    words: "",
    scenes: "",
    userPerson: "第二人称",
    charPerson: "第三人称",
    extra: "",
    includePrevious: false,
};

function person(value: unknown): StoryExtraPerson | undefined {
    return PERSONS.includes(value as StoryExtraPerson) ? value as StoryExtraPerson : undefined;
}

function text(value: unknown, max = 8000): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function ids(value: unknown): string[] | undefined {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;
}

export function normalizeStoryExtraTemplate(value: unknown): StoryExtraTemplate {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
        content: text(raw.content),
        ifLine: text(raw.ifLine, 4000),
        style: text(raw.style, 200),
        words: text(raw.words, 40),
        scenes: text(raw.scenes, 20),
        // 旧版只有一个 person（指 user 的人称）
        userPerson: person(raw.userPerson) ?? person(raw.person) ?? DEFAULT_STORY_EXTRA_TEMPLATE.userPerson,
        charPerson: person(raw.charPerson) ?? DEFAULT_STORY_EXTRA_TEMPLATE.charPerson,
        extra: text(raw.extra, 2000),
        includePrevious: raw.includePrevious === true,
    };
}

export function normalizeStoryExtraBindings(value: unknown): StoryExtraBindings {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const bindings: StoryExtraBindings = {};
    if (typeof raw.apiConfigId === "string" && raw.apiConfigId) bindings.apiConfigId = raw.apiConfigId;
    if (typeof raw.presetId === "string" && raw.presetId) bindings.presetId = raw.presetId;
    const worldBookIds = ids(raw.worldBookIds);
    if (worldBookIds) bindings.worldBookIds = worldBookIds;
    const regexIds = ids(raw.regexIds);
    if (regexIds) bindings.regexIds = regexIds;
    return bindings;
}

export function normalizeStoryExtraConfig(value: unknown): StoryExtraConfig {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
        template: normalizeStoryExtraTemplate(raw.template),
        bindings: normalizeStoryExtraBindings(raw.bindings),
    };
}

/** 句末没有标点就补个句号，免得几段话粘在一起 */
function asSentence(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /[。！？!?…」”’）)】]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/** 字数：用户可能写「4000」「4000字」「4000字以上」，统一成「4000」 */
function cleanWords(value: string): string {
    return value.trim().replace(/字(以上)?$/, "").trim();
}

/** 场景数：「3」「3个」「三个」都行，统一去掉「个」 */
export function cleanStoryExtraScenes(value: string): string {
    return value.trim().replace(/个(场景)?$/, "").trim();
}

/** 模板拼成发出去的那句指令，格式照用户给的范例：
 *  （$系统指令：现在暂停当前剧情，为我生成一个番外小剧场。不需要记忆区，标题自拟。这是一条if线：……。大概内容为……。
 *   内容要4000字以上，我需要3个不同的场景，文风……，以第二人称称呼{user}，以第三人称称呼{char}。其它要求）
 *  哪项没填就省掉那一句。剧情历史不走宏替换，所以名字在这里直接代入。 */
export function buildStoryExtraInstruction(template: StoryExtraTemplate, names: { user: string; char: string }): string {
    let body = "现在暂停当前剧情，为我生成一个番外小剧场。不需要记忆区，标题自拟。";
    if (template.ifLine.trim()) body += asSentence(`这是一条if线：${template.ifLine.trim()}`);
    if (template.content.trim()) body += asSentence(`大概内容为${template.content.trim()}`);
    const clauses: string[] = [];
    const words = cleanWords(template.words);
    if (words) clauses.push(`内容要${words}字以上`);
    const scenes = cleanStoryExtraScenes(template.scenes);
    if (scenes) clauses.push(`我需要${scenes}个不同的场景`);
    if (template.style.trim()) clauses.push(`文风${template.style.trim()}`);
    clauses.push(`以${template.userPerson}称呼${names.user}`);
    clauses.push(`以${template.charPerson}称呼${names.char}`);
    body += `${clauses.join("，")}。`;
    if (template.extra.trim()) body += asSentence(template.extra);
    return `（$系统指令：${body}）`;
}

/** 番外这一轮发给模型的历史：从最近一次用模板发出的指令开始（新的一篇）；
 *  那次勾了「带上之前的番外」就整个番外窗口都带上。还没用过模板就全带。 */
export function storyExtraHistory(messages: StoryMessage[]): StoryMessage[] {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const order = messages[index].extraOrder;
        if (!order) continue;
        return order.includePrevious ? messages : messages.slice(index);
    }
    return messages;
}

// ── 番外方案：模板 + 绑定成套保存，随时切换（和摘抄图配置一样，同名覆盖） ──

export type StoryExtraPreset = {
    id: string;
    name: string;
    config: StoryExtraConfig;
    createdAt: string;
};

const PRESET_LIMIT = 40;

export function loadStoryExtraPresets(): StoryExtraPreset[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(PRESET_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
                id: String(item.id || ""),
                name: text(item.name, 30) || "未命名",
                config: normalizeStoryExtraConfig(item.config),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
            }))
            .filter((item) => item.id);
    } catch {
        return [];
    }
}

function persistPresets(list: StoryExtraPreset[]): void {
    try {
        kvSet(PRESET_KEY, JSON.stringify(list.slice(-PRESET_LIMIT)));
    } catch {
        // 存不进去就只在这次打开里有效
    }
}

export function saveStoryExtraPreset(name: string, config: StoryExtraConfig): StoryExtraPreset {
    const trimmed = name.trim().slice(0, 30) || "未命名";
    const all = loadStoryExtraPresets();
    const existing = all.find((preset) => preset.name === trimmed);
    const preset: StoryExtraPreset = {
        id: existing?.id ?? `sxp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        config: normalizeStoryExtraConfig(config),
        createdAt: new Date().toISOString(),
    };
    persistPresets([...all.filter((item) => item.id !== preset.id), preset]);
    return preset;
}

export function deleteStoryExtraPreset(id: string): void {
    const all = loadStoryExtraPresets();
    const next = all.filter((preset) => preset.id !== id);
    if (next.length !== all.length) persistPresets(next);
}
