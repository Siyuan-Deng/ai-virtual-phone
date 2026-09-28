"use client";

import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

/** 阅读 app 的自定义 CSS。和日历那套一样：kv 里存一份，阅读 app 渲染时
 *  塞进一个 <style>；具名方案的保存/切换走通用的 CSSSchemeBar（target: "reading"）。 */
const CUSTOM_CSS_KEY = "reading-custom-css";
registerKvMigration(CUSTOM_CSS_KEY);

/** CSSSchemeBar 用来归类方案的 target 名 */
export const READING_CSS_SCHEME_TARGET = "reading";

export function loadReadingCustomCss(): string {
    if (typeof window === "undefined") return "";
    try {
        return kvGet(CUSTOM_CSS_KEY) || "";
    } catch {
        return "";
    }
}

export function saveReadingCustomCss(css: string): string {
    const trimmed = css.trim();
    if (typeof window === "undefined") return trimmed;
    try {
        if (trimmed) kvSet(CUSTOM_CSS_KEY, trimmed);
        else kvRemove(CUSTOM_CSS_KEY);
    } catch {
        // 写不进去就只在本次会话生效，不打断用户
    }
    return trimmed;
}
