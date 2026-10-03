"use client";

// 重复日程：规则和行为照搬「用户日历增强版」插件。
// 一个重复系列 = extras.series 里的一条规则 + 一批普通日程条目（附加信息里记着 seriesId）。
// 每一次都是真实存在的普通日程，角色读日历、提醒、横幅都不用特殊处理；
// 「永远」的系列先铺两年，之后每次开机 / 打开日历往后补。
//
// 和插件不同的地方只有写入方式：插件得先让宿主保存第一条、再轮询去「认」出它，
// 这里直接拿 id 操作，整个 owner 的日程一次落盘。

import type { CalendarColorKey, CalendarScheduleItem, CalendarWeekPlan } from "./calendar-types";
import { loadOwnerCalendarPlansRaw, replaceOwnerCalendarPlans } from "./calendar-storage";
import {
    formatIsoDate,
    getWeekStartIso,
    getWeekdayLabel,
    pickScheduleColorKey,
    sanitizeScheduleEmoji,
} from "./calendar-utils";
import {
    loadCalendarExtras,
    normalizeCalendarTodos,
    reportEventTodosChanged,
    saveCalendarExtras,
    type CalendarEventDetails,
    type CalendarExtras,
    type CalendarRecurrenceFrequency,
    type CalendarRecurrenceSeries,
    type CalendarTodo,
} from "./calendar-extras";

const USER = { ownerType: "user", ownerId: "self" } as const;
const WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
/** 「永远」一次往后铺多少天 */
const FOREVER_HORIZON_DAYS = 730;

export type RecurrenceRule = {
    /** weekly：0=周日 … 6=周六 */
    weekdays?: number[];
    monthDay?: number;
    monthLastDay?: boolean;
};

// ── 日期小工具 ──

function parseLocal(iso: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const date = new Date(`${iso}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** 按日历天加减。用 setDate，夏令时那天 24 小时不等于一天 */
export function addDaysIso(iso: string, days: number): string {
    const date = parseLocal(iso);
    if (!date) return iso;
    date.setDate(date.getDate() + days);
    return formatIsoDate(date);
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

function makeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function oneLine(value: unknown, fallback = "", max = 300): string {
    const text = String(value ?? "").replace(/\r/g, "").trim().slice(0, max);
    return (text || fallback).replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

// ── 规则 ──

/** 从 startDate 到 untilDate（含）之间所有符合规则的日期 */
export function recurrenceDates(
    startDate: string,
    untilDate: string,
    frequency: CalendarRecurrenceFrequency,
    rule: RecurrenceRule = {},
): string[] {
    const dates: string[] = [];
    const start = parseLocal(startDate);
    if (!start || !parseLocal(untilDate) || untilDate < startDate) return dates;

    if (frequency === "daily") {
        let cursor = startDate;
        while (cursor <= untilDate && dates.length < 5000) {
            dates.push(cursor);
            cursor = addDaysIso(cursor, 1);
        }
        return dates;
    }

    if (frequency === "weekly") {
        const selected = new Set(
            (Array.isArray(rule.weekdays) ? rule.weekdays : [start.getDay()])
                .map(Number)
                .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        );
        if (selected.size === 0) selected.add(start.getDay());
        let cursor = startDate;
        let inspected = 0;
        while (cursor <= untilDate && dates.length < 5000 && inspected < 37000) {
            const date = parseLocal(cursor);
            if (date && selected.has(date.getDay())) dates.push(cursor);
            cursor = addDaysIso(cursor, 1);
            inspected += 1;
        }
        return dates;
    }

    if (frequency === "monthly") {
        const monthDay = clampInt(rule.monthDay, start.getDate(), 1, 31);
        for (let offset = 0; offset < 5000; offset += 1) {
            const candidate = rule.monthLastDay === true
                ? new Date(start.getFullYear(), start.getMonth() + offset + 1, 0)
                : new Date(start.getFullYear(), start.getMonth() + offset, monthDay);
            // 31 号在小月里会滚到下个月，跳过这个月
            if (rule.monthLastDay !== true && candidate.getDate() !== monthDay) continue;
            const cursor = formatIsoDate(candidate);
            if (cursor < startDate) continue;
            if (cursor > untilDate) break;
            dates.push(cursor);
        }
        return dates;
    }

    if (frequency === "yearly") {
        const month = start.getMonth();
        const day = start.getDate();
        for (let offset = 0; offset < 5000; offset += 1) {
            const candidate = new Date(start.getFullYear() + offset, month, day);
            // 2 月 29 号只在闰年出现
            if (candidate.getMonth() !== month || candidate.getDate() !== day) continue;
            const cursor = formatIsoDate(candidate);
            if (cursor < startDate) continue;
            if (cursor > untilDate) break;
            dates.push(cursor);
        }
    }
    return dates;
}

export function recurrenceRuleLabel(series: Pick<CalendarRecurrenceSeries, "frequency" | "weekdays" | "monthDay" | "monthLastDay">): string {
    if (series.frequency === "weekly") {
        const weekdays = (Array.isArray(series.weekdays) ? series.weekdays : [])
            .map(Number)
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
            // 周一排最前、周日排最后
            .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
        return weekdays.length ? `每周${weekdays.map((day) => WEEKDAY_SHORT[day]).join("、")}` : "每周";
    }
    if (series.frequency === "monthly") {
        if (series.monthLastDay === true) return "每月最后一天";
        return series.monthDay ? `每月${clampInt(series.monthDay, 1, 1, 31)}号` : "每月";
    }
    return ({ daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年" } as const)[series.frequency] ?? "不重复";
}

function ruleOf(series: CalendarRecurrenceSeries): RecurrenceRule {
    return { weekdays: series.weekdays, monthDay: series.monthDay, monthLastDay: series.monthLastDay === true };
}

// ── 写入 ──

type ItemFields = {
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    emoji: string;
    colorKey?: CalendarColorKey;
};

type DetailsDraft = { note: string; allDay: boolean; todos: CalendarTodo[] };

function buildItem(id: string, date: string, fields: ItemFields, now: string): CalendarScheduleItem {
    return {
        id,
        date,
        weekday: getWeekdayLabel(date),
        startTime: fields.startTime,
        endTime: fields.endTime,
        location: oneLine(fields.location, "", 300),
        title: oneLine(fields.title, "未命名事项", 300),
        emoji: sanitizeScheduleEmoji(fields.emoji),
        colorKey: fields.colorKey || pickScheduleColorKey(fields.startTime),
        source: "manual",
        createdAt: now,
        updatedAt: now,
    };
}

/** 附加信息拷一份挂到某一次上。resetTodos：新铺出来的每一次，待办重新编号、都是没勾的 */
function cloneDetails(details: DetailsDraft, seriesId: string, resetTodos: boolean, now: string): CalendarEventDetails {
    return {
        note: String(details.note || "").replace(/\r/g, "").trim().slice(0, 5000),
        allDay: details.allDay === true,
        todos: normalizeCalendarTodos(details.todos).map((todo) => ({
            ...todo,
            id: resetTodos ? makeId("todo") : todo.id,
            done: resetTodos ? false : todo.done,
        })),
        seriesId,
        updatedAt: now,
    };
}

function placeItems(plans: CalendarWeekPlan[], items: CalendarScheduleItem[], now: string): void {
    for (const item of items) {
        const weekStart = getWeekStartIso(new Date(`${item.date}T00:00:00`));
        let plan = plans.find((entry) => entry.weekStart === weekStart);
        if (!plan) {
            plan = { id: makeId("calendar_week"), ...USER, weekStart, items: [], updatedAt: now };
            plans.push(plan);
        }
        plan.items.push(item);
        plan.updatedAt = now;
    }
}

function commit(plans: CalendarWeekPlan[], extras: CalendarExtras): void {
    replaceOwnerCalendarPlans(USER.ownerType, USER.ownerId, plans.filter((plan) => plan.items.length > 0));
    saveCalendarExtras(extras);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("calendar-updated"));
}

export type SeriesResult = { ok: true; count: number; message: string } | { ok: false; error: string };

/** 新建重复日程；existingItemId 有值时是把一条已有的单次日程改成重复，它就是第一次 */
export function createRecurringSeries(input: {
    fields: ItemFields;
    details: DetailsDraft;
    frequency: CalendarRecurrenceFrequency;
    rule: RecurrenceRule;
    startDate: string;
    untilDate: string;
    forever: boolean;
    existingItemId?: string;
}): SeriesResult {
    const { frequency, rule, startDate, forever } = input;
    if (!startDate || (!forever && (!input.untilDate || input.untilDate < startDate))) {
        return { ok: false, error: "重复结束日期不能早于开始日期" };
    }
    if (frequency === "weekly" && !(rule.weekdays && rule.weekdays.length > 0)) {
        return { ok: false, error: "请至少选择一个每周重复日" };
    }
    const through = forever ? addDaysIso(startDate, FOREVER_HORIZON_DAYS) : input.untilDate;
    const allDates = recurrenceDates(startDate, through, frequency, rule);
    if (allDates.length === 0) {
        if (frequency === "monthly") {
            const ruleName = rule.monthLastDay ? "每月最后一天" : `每月${rule.monthDay}号`;
            return { ok: false, error: `所选日期范围内没有“${ruleName}”，请调整结束日期或重复日期` };
        }
        return { ok: false, error: "所选日期范围内没有符合重复规则的日期" };
    }

    const now = new Date().toISOString();
    const seriesId = makeId("series");
    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId)
        .map((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== input.existingItemId) }));
    const extras = loadCalendarExtras();
    const eventDetails = { ...extras.eventDetails };
    const items = allDates.map((date, index) => {
        const id = index === 0 && input.existingItemId ? input.existingItemId : makeId("calendar_item");
        // 第一次保留编辑框里待办的勾选状态，后面每一次都是新的、没勾的
        eventDetails[id] = cloneDetails(input.details, seriesId, index > 0, now);
        return buildItem(id, date, input.fields, now);
    });
    placeItems(plans, items, now);

    const series: CalendarRecurrenceSeries = {
        id: seriesId,
        frequency,
        startDate: allDates[0],
        untilDate: forever ? "" : input.untilDate,
        forever,
        materializedUntil: through,
        weekdays: frequency === "weekly" ? [...(rule.weekdays ?? [])].sort((a, b) => a - b) : undefined,
        monthDay: frequency === "monthly" ? rule.monthDay : undefined,
        monthLastDay: frequency === "monthly" ? rule.monthLastDay === true : undefined,
        title: oneLine(input.fields.title, "", 300),
        createdAt: now,
    };
    commit(plans, { ...extras, eventDetails, series: { ...extras.series, [seriesId]: series } });
    return { ok: true, count: allDates.length, message: `已创建${recurrenceRuleLabel(series)}日程，共 ${allDates.length} 次` };
}

/** 编辑系列里的一次后选「修改整个重复日程」：已有的每一次都改成新内容；
 *  改了重复结束日期就相应缩短或延长（延长只补新区间，之前单独删掉的那几次不会复活）。 */
export function updateEntireSeries(input: {
    seriesId: string;
    currentItemId: string;
    fields: ItemFields;
    details: DetailsDraft;
    /** 编辑框里的「重复结束日期」 */
    untilDate: string;
}): SeriesResult {
    const extras = loadCalendarExtras();
    const series = extras.series[input.seriesId];
    if (!series) return { ok: false, error: "重复日程系列已经不存在" };
    const title = oneLine(input.fields.title, "", 300);
    if (!title) return { ok: false, error: "请填写事项" };
    if (!/^\d{2}:\d{2}$/.test(input.fields.startTime) || !/^\d{2}:\d{2}$/.test(input.fields.endTime)
        || input.fields.endTime <= input.fields.startTime) {
        return { ok: false, error: "结束时间需要晚于开始时间" };
    }

    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId);
    const related = plans
        .flatMap((plan) => plan.items)
        .filter((item) => extras.eventDetails[item.id]?.seriesId === input.seriesId)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
    if (related.length === 0) return { ok: false, error: "没有找到这个重复日程的实例" };

    const lastExistingDate = related[related.length - 1].date;
    const untilDate = series.forever ? "" : (input.untilDate || series.untilDate || "");
    if (!series.forever && (!untilDate || untilDate < series.startDate)) {
        return { ok: false, error: "重复结束日期不能早于系列开始日期" };
    }
    const materializedThrough = series.forever ? (series.materializedUntil || lastExistingDate) : untilDate;
    const allowedDates = new Set(recurrenceDates(series.startDate, materializedThrough, series.frequency, ruleOf(series)));
    if (allowedDates.size === 0) return { ok: false, error: "当前日期范围内没有符合重复规则的日期" };

    const oldUntil = series.untilDate || lastExistingDate;
    const now = new Date().toISOString();
    const fields = { ...input.fields, title };
    const eventDetails = { ...extras.eventDetails };
    const keptIds = new Set<string>();
    const existingDates = new Set<string>();

    for (const plan of plans) {
        plan.items = plan.items.flatMap((item) => {
            const previous = extras.eventDetails[item.id];
            if (previous?.seriesId !== input.seriesId) return [item];
            plan.updatedAt = now;
            if (!allowedDates.has(item.date)) {
                delete eventDetails[item.id];
                return [];
            }
            keptIds.add(item.id);
            existingDates.add(item.date);
            const edited = normalizeCalendarTodos(input.details.todos);
            const before = normalizeCalendarTodos(previous.todos);
            eventDetails[item.id] = {
                ...cloneDetails(input.details, input.seriesId, false, now),
                // 按位置对上原来那一次的待办：保留它自己的 id 和勾选状态；
                // 只有正在编辑的这一次用编辑框里的勾选状态
                todos: edited.map((todo, index) => ({
                    ...todo,
                    id: before[index]?.id || makeId("todo"),
                    done: item.id === input.currentItemId ? todo.done : before[index]?.done === true,
                    createdAt: before[index]?.createdAt || todo.createdAt || now,
                })),
            };
            return [{
                ...item,
                startTime: fields.startTime,
                endTime: fields.endTime,
                title,
                location: oneLine(fields.location, "", 300),
                emoji: sanitizeScheduleEmoji(fields.emoji),
                colorKey: fields.colorKey || pickScheduleColorKey(fields.startTime),
                updatedAt: now,
            }];
        });
    }

    const extensionDates = series.forever ? [] : Array.from(allowedDates)
        .filter((date) => !existingDates.has(date) && date > oldUntil)
        .sort();
    placeItems(plans, extensionDates.map((date) => {
        const id = makeId("calendar_item");
        eventDetails[id] = cloneDetails(input.details, input.seriesId, true, now);
        return buildItem(id, date, fields, now);
    }), now);

    const nextSeries: CalendarRecurrenceSeries = { ...series, untilDate, materializedUntil: materializedThrough, title, updatedAt: now };
    commit(plans, { ...extras, eventDetails, series: { ...extras.series, [input.seriesId]: nextSeries } });
    // 只有正在编辑的这一次用编辑框里的勾选状态，所以也只有它可能「刚完成」
    reportEventTodosChanged(input.currentItemId, extras.eventDetails[input.currentItemId]?.todos, eventDetails[input.currentItemId]?.todos);
    const count = keptIds.size + extensionDates.length;
    return { ok: true, count, message: `已修改整个重复日程，共 ${count} 次` };
}

/** 「永远」的系列往后补到今天 + 两年。系列里一次都不剩了就把规则也删掉，不凭空复活。
 *  平时是空操作（materializedUntil 够远就直接跳过），开机和打开日历时各调一次。 */
export function ensureForeverSeries(): boolean {
    const extras = loadCalendarExtras();
    const forever = Object.values(extras.series).filter((series) => series.forever);
    if (forever.length === 0) return false;
    const through = addDaysIso(formatIsoDate(new Date()), FOREVER_HORIZON_DAYS);
    if (forever.every((series) => series.materializedUntil && series.materializedUntil >= through)) return false;

    const now = new Date().toISOString();
    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId);
    const allItems = plans.flatMap((plan) => plan.items);
    const eventDetails = { ...extras.eventDetails };
    const seriesStore = { ...extras.series };
    const added: CalendarScheduleItem[] = [];

    for (const series of forever) {
        if (series.materializedUntil && series.materializedUntil >= through) continue;
        const related = allItems
            .filter((item) => eventDetails[item.id]?.seriesId === series.id)
            .sort((a, b) => a.date.localeCompare(b.date));
        const template = related[0];
        if (!template) {
            delete seriesStore[series.id];
            continue;
        }
        const lastDate = related.reduce((latest, item) => (item.date > latest ? item.date : latest), series.startDate || template.date);
        const existing = new Set(related.map((item) => item.date));
        // 始终从系列的起点推日期：「每年」要是从最后一次的下一天推，9 月 16 号会漂成 17 号
        const dates = recurrenceDates(series.startDate || template.date, through, series.frequency, ruleOf(series))
            .filter((date) => date > lastDate && !existing.has(date));
        const templateDetails = eventDetails[template.id] ?? { note: "", allDay: false, todos: [] };
        for (const date of dates) {
            const id = makeId("calendar_item");
            eventDetails[id] = cloneDetails(templateDetails, series.id, true, now);
            added.push(buildItem(id, date, { ...template, emoji: template.emoji ?? "" }, now));
        }
        seriesStore[series.id] = { ...series, materializedUntil: through };
    }

    placeItems(plans, added, now);
    commit(plans, { ...extras, eventDetails, series: seriesStore });
    return true;
}

/** 删掉一次之后顺手清理：系列一次都不剩了，规则也没必要留着 */
export function pruneEmptySeries(): void {
    const extras = loadCalendarExtras();
    const used = new Set(Object.values(extras.eventDetails).map((details) => details.seriesId).filter(Boolean));
    const series = Object.fromEntries(Object.entries(extras.series).filter(([id]) => used.has(id)));
    if (Object.keys(series).length !== Object.keys(extras.series).length) saveCalendarExtras({ ...extras, series });
}
