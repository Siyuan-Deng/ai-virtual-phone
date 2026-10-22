"use client";

// 外观（主题）的夜间那份。外观里的东西按组配：主题色 / 全局 CSS / 壁纸 / 图标 / Dock / 文字，
// 每组夜里要么跟白天，要么单独一份（存在夜间套装里，全局 CSS 也能用存过的方案）。
// 夜间模式开着时在外观 App 里改的，改到哪组就只改那组的夜间那份；壁纸库、图标方案库、
// 状态栏开关这些不分白天夜间。

import { findScheme } from "./css-scheme-storage";
import { getNightBinding, setNightBinding } from "./night-mode";
import type { ThemeProfile } from "./theme-types";

export const NIGHT_THEME_GROUPS = {
    "theme.vars": ["cssOverrides", "enableGlobalShadows", "enableGlobalBorder", "globalBorderColor"],
    "theme.css": ["globalCustomCSS"],
    "theme.wallpaper": ["wallpaperAssetId", "wallpaperBlur", "wallpaperOpacity", "wallpaperScale", "wallpaperX", "wallpaperY"],
    "theme.icons": ["iconSkins", "activeIconSchemeId"],
    "theme.dock": ["dockSkinAssetId"],
    "theme.font": ["fontAssetId", "fontFamily"],
} as const satisfies Record<string, ReadonlyArray<keyof ThemeProfile>>;

export type NightThemeGroup = keyof typeof NIGHT_THEME_GROUPS;

export const NIGHT_THEME_GROUP_LABELS: Record<NightThemeGroup, string> = {
    "theme.vars": "主题色",
    "theme.css": "全局 CSS",
    "theme.wallpaper": "壁纸",
    "theme.icons": "图标",
    "theme.dock": "Dock 背景",
    "theme.font": "文字",
};

const GROUP_KEYS = Object.keys(NIGHT_THEME_GROUPS) as NightThemeGroup[];

function pick(profile: ThemeProfile, group: NightThemeGroup): Partial<ThemeProfile> {
    const result: Record<string, unknown> = {};
    for (const field of NIGHT_THEME_GROUPS[group]) result[field] = profile[field];
    return result as Partial<ThemeProfile>;
}

function sameGroup(a: ThemeProfile, b: ThemeProfile, group: NightThemeGroup): boolean {
    return NIGHT_THEME_GROUPS[group].every((field) => JSON.stringify(a[field]) === JSON.stringify(b[field]));
}

/** 这组夜里的值；没配就是 null（跟白天） */
function nightGroupValue(group: NightThemeGroup): Partial<ThemeProfile> | null {
    const binding = getNightBinding(group);
    if (!binding) return null;
    if (group === "theme.css") {
        if (binding.kind === "own") return { globalCustomCSS: binding.value };
        if (binding.kind === "scheme") {
            const css = findScheme(binding.schemeId)?.css;
            return css === undefined ? null : { globalCustomCSS: css };
        }
        return null;
    }
    if (binding.kind !== "own") return null;
    try {
        const parsed = JSON.parse(binding.value) as Partial<ThemeProfile>;
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** 白天的主题叠上配了的夜间组 */
export function overlayNightTheme(day: ThemeProfile): ThemeProfile {
    let result = day;
    for (const group of GROUP_KEYS) {
        const value = nightGroupValue(group);
        if (value) result = { ...result, ...value };
    }
    return result;
}

/** 夜间模式里在外观 App 改了东西：分成「改到了哪几组的夜间那份」和「不分白天夜间、直接改白天的」 */
export function splitNightThemeChange(
    before: ThemeProfile,
    next: ThemeProfile,
): { nightPatch: Partial<ThemeProfile>; dayPatch: Partial<ThemeProfile>; groups: NightThemeGroup[] } {
    const groupFields = new Set<string>(GROUP_KEYS.flatMap((group) => [...NIGHT_THEME_GROUPS[group]]));
    const groups = GROUP_KEYS.filter((group) => !sameGroup(before, next, group));
    const nightPatch = Object.assign({}, ...groups.map((group) => pick(next, group))) as Partial<ThemeProfile>;
    const dayPatch: Record<string, unknown> = {};
    for (const field of Object.keys(next) as Array<keyof ThemeProfile>) {
        if (groupFields.has(field) || field === "updatedAt") continue;
        if (JSON.stringify(before[field]) !== JSON.stringify(next[field])) dayPatch[field] = next[field];
    }
    return { nightPatch, dayPatch: dayPatch as Partial<ThemeProfile>, groups };
}

/** 把这几组存成夜间单独一份 */
export function saveNightThemeGroups(next: ThemeProfile, groups: NightThemeGroup[]): void {
    for (const group of groups) {
        if (group === "theme.css") {
            setNightBinding(group, { kind: "own", value: next.globalCustomCSS || "" });
        } else {
            setNightBinding(group, { kind: "own", value: JSON.stringify(pick(next, group)) });
        }
    }
}
