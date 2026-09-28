"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** 阅读里几处「存一档随时调回来」的东西，共用一个存储：
 *  - share：摘抄图的模板 + 配色 + 对齐
 *  - annotationPrompt / summaryPrompt：两段提示词的不同版本 */
export type ReadingPresetKind = "share" | "annotationPrompt" | "summaryPrompt";

export type ReadingPreset<T = unknown> = {
    id: string;
    kind: ReadingPresetKind;
    name: string;
    payload: T;
    createdAt: string;
};

const PRESET_KEY = "ai_phone_reading_presets_v1";
registerKvMigration(PRESET_KEY);

/** 每类最多存这么多，免得无限长 */
const LIMIT_PER_KIND = 40;

function loadAll(): ReadingPreset[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(PRESET_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed as ReadingPreset[] : [];
    } catch {
        return [];
    }
}

function persist(list: ReadingPreset[]): void {
    try {
        kvSet(PRESET_KEY, JSON.stringify(list));
    } catch {
        // 写不进去就只在本次会话里有效，不打断用户
    }
}

export function loadReadingPresets<T>(kind: ReadingPresetKind): Array<ReadingPreset<T>> {
    return loadAll().filter(preset => preset.kind === kind) as Array<ReadingPreset<T>>;
}

/** 同名的直接覆盖——「再存一次」通常是想更新那一档，而不是留两个同名的 */
export function saveReadingPreset<T>(kind: ReadingPresetKind, name: string, payload: T): ReadingPreset<T> {
    const trimmed = name.trim().slice(0, 30) || "未命名";
    const all = loadAll();
    const existing = all.find(preset => preset.kind === kind && preset.name === trimmed);
    const preset: ReadingPreset<T> = existing
        ? { ...existing, payload, createdAt: new Date().toISOString() } as ReadingPreset<T>
        : {
            id: `rp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            kind,
            name: trimmed,
            payload,
            createdAt: new Date().toISOString(),
        };
    const rest = all.filter(item => item.id !== preset.id);
    const sameKind = rest.filter(item => item.kind === kind).slice(-(LIMIT_PER_KIND - 1));
    const others = rest.filter(item => item.kind !== kind);
    persist([...others, ...sameKind, preset as ReadingPreset]);
    return preset;
}

export function deleteReadingPreset(id: string): void {
    const all = loadAll();
    const next = all.filter(preset => preset.id !== id);
    if (next.length !== all.length) persist(next);
}
