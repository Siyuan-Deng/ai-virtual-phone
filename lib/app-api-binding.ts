"use client";

// 某个角色在某个应用里单独绑的 API（设置 → 绑定 → 角色 → 应用 → API 那一项）。
// 剧情侧栏、聊天设置里直接改的也是这一份，所以两边永远一致。

import {
    getCharacterBinding,
    loadApiConfigs,
    loadBindingConfig,
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
