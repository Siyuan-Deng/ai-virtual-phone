"use client";

// 日详情顶部的横幅：全天日程、节假日、日程待办、备忘录里当天截止的待办。
// 分组、排序、文案逐条照搬「用户日历与备忘录增强」插件的 groupBannerEntries /
// bannerEntryText；外观沿用原生经期那一行（calendar-cycle-line）的版式。

import type { CSSProperties } from "react";
import type { CalendarColorKey, CalendarScheduleItem } from "@/lib/calendar-types";
import type { CalendarConfig } from "@/lib/calendar-storage";
import { activeCalendarMemos, normalizeCalendarTodos, type CalendarExtras, type CalendarTodo } from "@/lib/calendar-extras";
import { DEFAULT_CHINA_HOLIDAY_COLOR, DEFAULT_ONTARIO_HOLIDAY_COLOR, holidaysForDate } from "@/lib/calendar-holidays";
import { pickScheduleColorKey } from "@/lib/calendar-utils";

/** 插件里同色横幅的排列顺序；hex 颜色排在这些之后 */
const BANNER_COLOR_ORDER: CalendarColorKey[] = ["blue", "green", "amber", "rose", "violet", "teal", "slate", "lilac"];

type BannerEntry =
    | {
        kind: "allDay";
        source: "event" | "holiday";
        key: string;
        title: string;
        location: string;
        item?: CalendarScheduleItem;
        color: string;
        createdAt: string;
        order: number;
    }
    | {
        kind: "todo";
        source: "event" | "memo";
        key: string;
        todo: CalendarTodo;
        item?: CalendarScheduleItem;
        eventTitle?: string;
        eventNote?: string;
        location?: string;
        startTime?: string;
        endTime?: string;
        allDay?: boolean;
        memoId?: string;
        memoTitle?: string;
        color: string;
        createdAt: string;
        order: number;
    };

type BannerGroup = { kind: "allDay" | "todo"; color: string; entries: BannerEntry[] };

function isHexColor(value: string): boolean {
    return /^#[0-9a-f]{3,8}$/i.test(value.trim());
}

function holidayColor(value: string, fallback: string): string {
    const color = String(value || "auto").trim();
    if (color === "auto") return fallback;
    if (isHexColor(color)) return color;
    if ((BANNER_COLOR_ORDER as string[]).includes(color)) return color;
    return fallback;
}

/** 备忘录待办的颜色：选了具体颜色就用它，「自动」按截止时间挑（没填时间按中午） */
export function memoColor(bannerColor: string, todo: CalendarTodo): string {
    if (bannerColor && bannerColor !== "auto" && (BANNER_COLOR_ORDER as string[]).includes(bannerColor)) return bannerColor;
    return pickScheduleColorKey(todo.dueTime || "12:00");
}

function oneLine(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function compareEntries(a: BannerEntry, b: BannerEntry): number {
    const aTime = String(a.createdAt || "");
    const bTime = String(b.createdAt || "");
    if (aTime && bTime && aTime !== bTime) return aTime.localeCompare(bTime);
    if (aTime && !bTime) return 1;
    if (!aTime && bTime) return -1;
    return a.order - b.order;
}

export function buildBannerGroups(
    date: string,
    items: CalendarScheduleItem[],
    extras: CalendarExtras,
    config: Pick<CalendarConfig, "chinaHolidays" | "ontarioHolidays" | "chinaHolidayColor" | "ontarioHolidayColor">,
): BannerGroup[] {
    const allDay: BannerEntry[] = [];
    const todos: BannerEntry[] = [];
    let order = 0;

    const seen = new Set<string>();
    for (const item of items) {
        if (item.date !== date || seen.has(item.id)) continue;
        seen.add(item.id);
        const details = extras.eventDetails[item.id];
        const color = item.colorKey || pickScheduleColorKey(item.startTime);
        const itemTodos = normalizeCalendarTodos(details?.todos);
        // 全天日程有待办时，待办横幅已经带上了日程信息，不再重复出一条全天横幅
        if (details?.allDay === true && itemTodos.length === 0) {
            allDay.push({
                kind: "allDay", source: "event", key: `event:${item.id}`,
                title: item.title, location: item.location, item, color,
                createdAt: item.createdAt || "", order: order++,
            });
        }
        for (const todo of itemTodos) {
            todos.push({
                kind: "todo", source: "event", key: `event:${item.id}:${todo.id}`,
                todo, item, eventTitle: item.title, eventNote: details?.note, location: item.location,
                startTime: item.startTime, endTime: item.endTime, allDay: details?.allDay === true,
                color, createdAt: todo.createdAt || item.createdAt || details?.updatedAt || "", order: order++,
            });
        }
    }

    for (const holiday of holidaysForDate(date, { china: config.chinaHolidays, ontario: config.ontarioHolidays })) {
        allDay.push({
            kind: "allDay", source: "holiday", key: `holiday:${holiday.id}`,
            title: holiday.title, location: "",
            color: holiday.region === "cn"
                ? holidayColor(config.chinaHolidayColor, DEFAULT_CHINA_HOLIDAY_COLOR)
                : holidayColor(config.ontarioHolidayColor, DEFAULT_ONTARIO_HOLIDAY_COLOR),
            createdAt: "", order: order++,
        });
    }

    let memoOrder = 0;
    for (const memo of activeCalendarMemos(extras.memos)) {
        for (const todo of normalizeCalendarTodos(memo.checklist)) {
            if (todo.dueDate !== date) continue;
            todos.push({
                kind: "todo", source: "memo", key: `memo:${memo.id}:${todo.id}`,
                todo, memoId: memo.id, memoTitle: memo.title || "无标题备忘录",
                color: memoColor(memo.bannerColor, todo),
                createdAt: todo.createdAt || memo.createdAt || memo.updatedAt || "",
                order: order + memoOrder++,
            });
        }
    }

    const groups: BannerGroup[] = [];
    for (const [kind, entries] of [["allDay", allDay], ["todo", todos]] as const) {
        const byColor = new Map<string, BannerEntry[]>();
        for (const entry of entries) {
            const list = byColor.get(entry.color) || [];
            list.push(entry);
            byColor.set(entry.color, list);
        }
        const colors = [...byColor.keys()].sort((a, b) => {
            const aRank = BANNER_COLOR_ORDER.indexOf(a as CalendarColorKey);
            const bRank = BANNER_COLOR_ORDER.indexOf(b as CalendarColorKey);
            return (aRank < 0 ? 999 : aRank) - (bRank < 0 ? 999 : bRank) || a.localeCompare(b);
        });
        for (const color of colors) {
            groups.push({ kind, color, entries: (byColor.get(color) || []).sort(compareEntries) });
        }
    }
    return groups;
}

/** 横幅上那一句：全天「标题 · 地点」；待办「待办 · 日程 · 时段 · 地点 · 备注」，重复的去掉 */
export function bannerEntryText(entry: BannerEntry): string {
    if (entry.kind === "allDay") {
        return [oneLine(entry.title) || "未命名事项", oneLine(entry.location)].filter(Boolean).join(" · ");
    }
    const parts: string[] = [entry.todo.text];
    if (entry.source === "memo") {
        if (entry.memoTitle && entry.memoTitle !== entry.todo.text) parts.push(entry.memoTitle);
        parts.push(entry.todo.dueTime ? `截止 ${entry.todo.dueTime}` : "今天截止");
    } else {
        parts.push(
            entry.eventTitle || "",
            entry.allDay ? "" : [entry.startTime, entry.endTime].filter(Boolean).join("–"),
            entry.location || "",
            entry.eventNote || "",
        );
    }
    return parts
        .map((part) => oneLine(part))
        .filter((part, index, all) => part && all.indexOf(part) === index)
        .join(" · ");
}

export function CalendarScheduleBanners({
    groups,
    onOpenItem,
    onToggleEventTodo,
    onToggleMemoTodo,
}: {
    groups: BannerGroup[];
    onOpenItem: (item: CalendarScheduleItem) => void;
    onToggleEventTodo: (itemId: string, todoId: string, done: boolean) => void;
    onToggleMemoTodo: (memoId: string, todoId: string, done: boolean) => void;
}) {
    if (groups.length === 0) return null;
    return (
        <>
            {groups.map((group) => {
                const hex = isHexColor(group.color);
                // 色键交给原生的 [data-color] 规则；节假日默认是 hex，直接写变量
                const style = hex
                    ? ({
                        "--ev-fg": group.color,
                        "--ev-bg": `color-mix(in srgb, ${group.color} 14%, var(--c-calendar-surface))`,
                    } as CSSProperties)
                    : undefined;
                return (
                    <div
                        key={`${group.kind}:${group.color}`}
                        className={`calendar-cycle-line calendar-banner-line calendar-banner-line--${group.kind === "allDay" ? "all-day" : "todo"}`}
                        data-color={hex ? undefined : group.color}
                        style={style}
                    >
                        <div className="calendar-banner-items">
                            {group.entries.map((entry) => {
                                const done = entry.kind === "todo" && entry.todo.done;
                                const linkedItem = entry.source === "event" ? entry.item : undefined;
                                const text = bannerEntryText(entry);
                                const body = (
                                    <>
                                        <i className="calendar-event-dot calendar-banner-dot" aria-hidden="true" />
                                        <span className="calendar-banner-copy">{text}</span>
                                    </>
                                );
                                return (
                                    <div
                                        key={entry.key}
                                        className={`calendar-banner-item${done ? " is-done" : ""}${linkedItem ? " is-event-link" : ""}`}
                                        role={linkedItem ? "button" : undefined}
                                        tabIndex={linkedItem ? 0 : undefined}
                                        aria-label={linkedItem ? `编辑日程：${oneLine(linkedItem.title) || "未命名事项"}` : undefined}
                                        onClick={linkedItem ? () => onOpenItem(linkedItem) : undefined}
                                        onKeyDown={linkedItem ? (event) => {
                                            if (event.key !== "Enter" && event.key !== " ") return;
                                            event.preventDefault();
                                            onOpenItem(linkedItem);
                                        } : undefined}
                                    >
                                        {body}
                                        {entry.kind === "todo" ? (
                                            <input
                                                type="checkbox"
                                                checked={entry.todo.done}
                                                aria-label={`${entry.todo.text}标为${entry.todo.done ? "未完成" : "已完成"}`}
                                                onClick={(event) => event.stopPropagation()}
                                                onChange={(event) => {
                                                    event.stopPropagation();
                                                    if (entry.source === "memo" && entry.memoId) {
                                                        onToggleMemoTodo(entry.memoId, entry.todo.id, event.target.checked);
                                                    } else if (entry.item) {
                                                        onToggleEventTodo(entry.item.id, entry.todo.id, event.target.checked);
                                                    }
                                                }}
                                            />
                                        ) : (
                                            <span className="calendar-banner-spacer" aria-hidden="true" />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </>
    );
}
