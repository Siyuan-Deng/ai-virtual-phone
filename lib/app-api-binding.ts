"use client";

// 某个角色在某个应用里单独绑的 API（设置 → 绑定 → 角色 → 应用 → API 那一项）。
// 剧情侧栏、聊天设置里直接改的也是这一份，所以两边永远一致。

import type { BindingSlot } from "./settings-types";
import {
    getCharacterBinding,
    loadApiConfigs,
    loadBindingConfig,
    loadWorldBooks,
    resolveBinding,
    saveBindingConfig,
    setCharacterBinding,
} from "./settings-storage";

/** 单独绑的那个；没单独绑（或绑的已经删了）就是 undefined */
export function loadCharacterAppApiId(characterId: string, appId: string): string | undefined {
    const id = getCharacterBinding(loadBindingConfig(), characterId).appOverrides[appId]?.apiConfigId;
    return id && loadApiConfigs().some(config => config.id === id) ? id : undefined;
}

/** 传 undefined 就是取消单独绑定，回到继承 */
export function saveCharacterAppApiId(characterId: string, appId: string, apiConfigId: string | undefined): void {
    const config = loadBindingConfig();
    const binding = getCharacterBinding(config, characterId);
    const slot = { ...(binding.appOverrides[appId] || {}), apiConfigId: apiConfigId || undefined };
    saveBindingConfig(setCharacterBinding(config, { ...binding, appOverrides: { ...binding.appOverrides, [appId]: slot } }));
}

/** 不单独绑时实际会用的那个（全局 → 角色默认 → 应用默认）的名字 */
export function inheritedCharacterAppApiName(characterId: string, appId: string): string | undefined {
    const config = loadBindingConfig();
    const binding = getCharacterBinding(config, characterId);
    const own = binding.appOverrides[appId];
    const withoutOwn = setCharacterBinding(config, {
        ...binding,
        appOverrides: { ...binding.appOverrides, [appId]: own ? { ...own, apiConfigId: undefined } : undefined },
    });
    const id = resolveBinding(withoutOwn, characterId, appId).apiConfigId;
    const api = id ? loadApiConfigs().find(config => config.id === id) : undefined;
    return api ? api.name || api.provider : undefined;
}

/** 「继承：xx」；什么都没绑就是「继承默认」 */
export function inheritedCharacterAppApiLabel(characterId: string, appId: string): string {
    const name = inheritedCharacterAppApiName(characterId, appId);
    return name ? `继承：${name}` : "继承默认";
}

// ── 同一格里的其它几项（预设、世界书、正则）：剧情侧栏改的也是设置 → 绑定 → 角色 → 应用 里那一格 ──

export type CharacterAppSlotField = "apiConfigId" | "presetId" | "worldBookIds" | "regexIds";

/** 这个角色在这个应用里单独绑的那一格（没绑的项是 undefined） */
export function loadCharacterAppSlot(characterId: string, appId: string): BindingSlot {
    return { ...(getCharacterBinding(loadBindingConfig(), characterId).appOverrides[appId] || {}) };
}

/** 改一项，和设置页一样：空值（多选一个都不勾）就是不单独绑、回到继承 */
export function saveCharacterAppSlotField(
    characterId: string,
    appId: string,
    field: CharacterAppSlotField,
    value: string | string[] | undefined,
): void {
    const config = loadBindingConfig();
    const binding = getCharacterBinding(config, characterId);
    const empty = Array.isArray(value) ? value.length === 0 : !value;
    const slot = { ...(binding.appOverrides[appId] || {}), [field]: empty ? undefined : value };
    saveBindingConfig(setCharacterBinding(config, { ...binding, appOverrides: { ...binding.appOverrides, [appId]: slot } }));
}

/** 这一格整格不算时会继承到什么（全局 → 角色默认 → 应用默认） */
export function inheritedCharacterAppSlot(characterId: string, appId: string): BindingSlot {
    const config = loadBindingConfig();
    const binding = getCharacterBinding(config, characterId);
    const overrides = { ...binding.appOverrides };
    delete overrides[appId];
    return resolveBinding(setCharacterBinding(config, { ...binding, appOverrides: overrides }), characterId, appId);
}

// ── 世界书：聊天侧边栏里直接改「这个角色在这个应用里勾哪几本」，和设置 → 绑定 → 角色 → 应用 → 世界书是同一项 ──

function worldBookNames(ids: string[] | undefined): string[] {
    if (!ids?.length) return [];
    const books = loadWorldBooks();
    return ids.map(id => books.find(book => book.id === id)?.name).filter((name): name is string => Boolean(name));
}

/** 一本写名字，多本写「N 项已选」：和设置页的写法一样 */
function worldBookSummary(names: string[]): string {
    return names.length === 1 ? names[0] : `${names.length} 项已选`;
}

/** 这个角色在这个应用里单独勾的世界书（删掉的不算）；没单独勾是空的 */
export function loadCharacterAppWorldBookIds(characterId: string, appId: string): string[] {
    const ids = loadCharacterAppSlot(characterId, appId).worldBookIds || [];
    const books = loadWorldBooks();
    return ids.filter(id => books.some(book => book.id === id));
}

/** 「继承：xx」；上一级也没有就是「继承上级绑定」 */
export function inheritedCharacterAppWorldBookLabel(characterId: string, appId: string): string {
    const names = worldBookNames(inheritedCharacterAppSlot(characterId, appId).worldBookIds);
    return names.length > 0 ? `继承：${worldBookSummary(names)}` : "继承上级绑定";
}

/** 侧边栏那一行右边写的：自己勾了就是那几本，没勾就是继承那句 */
export function characterAppWorldBookLabel(characterId: string, appId: string): string {
    const names = worldBookNames(loadCharacterAppWorldBookIds(characterId, appId));
    return names.length > 0 ? worldBookSummary(names) : inheritedCharacterAppWorldBookLabel(characterId, appId);
}
