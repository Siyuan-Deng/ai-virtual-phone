"use client";

// 日历的「附加信息」：原生日历条目只有日期/起止时间/地点/标题/emoji/颜色，
// 全天、永久、重复系列、备注、待办、备忘录、逐角色权限这些都挂在这里，
// 按条目 id 关联。字段结构刻意和「用户日历增强版」插件完全一致——那边的
// 数据要原样搬进来，形状对不上就得写转换，转换就有丢字段的风险。

import { kvGet, kvKeysWithPrefix, kvSet, registerKvMigration } from "./kv-db";
import { loadCalendarConfig, normalizeCalendarConfig, saveCalendarConfig } from "./calendar-storage";

const EXTRAS_KEY = "ai_phone_calendar_extras_v1";
registerKvMigration(EXTRAS_KEY);

/** 插件把私有数据存在这个前缀下，一个插件一个桶。迁移时按内容找，不写死插件 id。 */
const PLUGIN_DATA_PREFIX = "chat_plugin_data_v1:";

export type CalendarTodo = {
    id: string;
    text: string;
    done: boolean;
    /** YYYY-MM-DD；空串表示跟随所属日程当天 */
    dueDate: string;
    /** HH:MM */
    dueTime: string;
    createdAt: string;
};

/** 一条日程的附加信息，key 是日程条目的 id */
export type CalendarEventDetails = {
    note: string;
    allDay: boolean;
    todos: CalendarTodo[];
    /** 属于哪个重复系列；单次日程为 null */
    seriesId: string | null;
    updatedAt: string;
};

export type CalendarRecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export type CalendarRecurrenceSeries = {
    id: string;
    frequency: CalendarRecurrenceFrequency;
    startDate: string;
    untilDate: string;
    /** 永久重复：没有结束日期，按需向后铺 */
    forever: boolean;
    /** 已经铺到哪一天 */
    materializedUntil: string;
    /** weekly：0=周日 … 6=周六 */
    weekdays?: number[];
    /** monthly：几号 */
    monthDay?: number;
    /** monthly：每月最后一天 */
    monthLastDay?: boolean;
    title: string;
    createdAt: string;
    updatedAt?: string;
};

export type CalendarMemoPage = {
    id: string;
    title: string;
    body: string;
    /** auto 或具体色键 */
    bannerColor: string;
    checklist: CalendarTodo[];
    createdAt: string;
    updatedAt: string;
};

export type CalendarReminderSentRecord = { at: number; status: "sending" | "sent" };

export type CalendarExtras = {
    /** 条目 id → 附加信息 */
    eventDetails: Record<string, CalendarEventDetails>;
    /** 系列 id → 重复规则 */
    series: Record<string, CalendarRecurrenceSeries>;
    memos: CalendarMemoPage[];
    /** 允许读日历并接收提醒的角色 id；null = 还没配置过（视为全部允许） */
    characterAccess: string[] | null;
    /** 角色 id → 待办完成后的回应方式 */
    todoReactions: Record<string, string>;
    todoCompletionQueue: unknown[];
    /** `${角色id}:${提醒key}` → 发送状态，用来保证每条只提醒一次 */
    reminderSent: Record<string, CalendarReminderSentRecord>;
    /** 「清空全部」的时间水位：早于它的条目不再复活 */
    clearBarrier: { clearedAt: string } | null;
    /** 从哪个插件桶迁移来的；有值就不再迁移第二次 */
    migratedFrom?: string;
    migratedAt?: string;
};

export const EMPTY_CALENDAR_EXTRAS: CalendarExtras = {
    eventDetails: {},
    series: {},
    memos: [],
    characterAccess: null,
    todoReactions: {},
    todoCompletionQueue: [],
    reminderSent: {},
    clearBarrier: null,
};

// ── 规范化：插件数据是 JS 写的，字段可能缺或类型不对，进来先过一遍 ──

function text(value: unknown, max: number): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function oneLine(value: unknown, max: number): string {
    return text(value, max).replace(/\s+/g, " ").trim();
}

export function normalizeCalendarTodos(value: unknown): CalendarTodo[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((raw) => {
            const todo = raw as Record<string, unknown>;
            return {
                id: String(todo?.id || `todo_${Math.random().toString(36).slice(2, 10)}`),
                text: oneLine(todo?.text, 240),
                done: todo?.done === true,
                dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(todo?.dueDate || "")) ? String(todo.dueDate) : "",
                dueTime: /^\d{2}:\d{2}$/.test(String(todo?.dueTime || "")) ? String(todo.dueTime) : "",
                createdAt: typeof todo?.createdAt === "string" ? todo.createdAt : "",
            };
        })
        .filter((todo) => todo.text);
}

function normalizeDetails(value: unknown): CalendarEventDetails | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    return {
        note: text(raw.note, 5000),
        allDay: raw.allDay === true,
        todos: normalizeCalendarTodos(raw.todos),
        seriesId: typeof raw.seriesId === "string" && raw.seriesId ? raw.seriesId : null,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
}

const FREQUENCIES = new Set(["daily", "weekly", "monthly", "yearly"]);

function normalizeSeries(value: unknown): CalendarRecurrenceSeries | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const id = String(raw.id || "");
    const frequency = String(raw.frequency || "");
    if (!id || !FREQUENCIES.has(frequency)) return null;
    return {
        id,
        frequency: frequency as CalendarRecurrenceFrequency,
        startDate: String(raw.startDate || ""),
        untilDate: String(raw.untilDate || ""),
        forever: raw.forever === true,
        materializedUntil: String(raw.materializedUntil || raw.untilDate || ""),
        weekdays: Array.isArray(raw.weekdays)
            ? raw.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
            : undefined,
        monthDay: Number.isInteger(raw.monthDay) ? Number(raw.monthDay) : undefined,
        monthLastDay: raw.monthLastDay === true ? true : undefined,
        title: oneLine(raw.title, 300),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
}

function normalizeMemo(value: unknown): CalendarMemoPage | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const id = String(raw.id || "");
    if (!id) return null;
    return {
        id,
        title: oneLine(raw.title, 200),
        body: text(raw.body, 20000),
        bannerColor: typeof raw.bannerColor === "string" && raw.bannerColor ? raw.bannerColor : "auto",
        checklist: normalizeCalendarTodos(raw.checklist),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
}

/** 把任意来源的一坨数据收成 CalendarExtras。缺的字段用空值补，不认识的字段丢掉。 */
export function normalizeCalendarExtras(value: unknown): CalendarExtras {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

    const eventDetails: Record<string, CalendarEventDetails> = {};
    const detailsSource = (raw.eventDetails ?? raw.eventDetailsV2) as Record<string, unknown> | undefined;
    if (detailsSource && typeof detailsSource === "object") {
        for (const [id, detail] of Object.entries(detailsSource)) {
            const normalized = normalizeDetails(detail);
            if (normalized) eventDetails[id] = normalized;
        }
    }

    const series: Record<string, CalendarRecurrenceSeries> = {};
    const seriesSource = (raw.series ?? raw.recurrenceSeriesV1) as Record<string, unknown> | undefined;
    if (seriesSource && typeof seriesSource === "object") {
        for (const [id, entry] of Object.entries(seriesSource)) {
            const normalized = normalizeSeries(entry);
            if (normalized) series[id] = normalized;
        }
    }

    const memosSource = (raw.memos ?? raw.memoPagesV1) as unknown;
    const memos = Array.isArray(memosSource)
        ? memosSource.map(normalizeMemo).filter((memo): memo is CalendarMemoPage => memo !== null)
        : [];

    const accessSource = (raw.characterAccess ?? raw.characterAccessV1) as unknown;
    const characterAccess = Array.isArray(accessSource) ? accessSource.map(String) : null;

    const reactionsSource = (raw.todoReactions ?? raw.todoReactionsV1) as Record<string, unknown> | undefined;
    const todoReactions: Record<string, string> = {};
    if (reactionsSource && typeof reactionsSource === "object") {
        for (const [id, mode] of Object.entries(reactionsSource)) todoReactions[id] = String(mode);
    }

    const queueSource = (raw.todoCompletionQueue ?? raw.todoCompletionQueueV1) as unknown;
    const todoCompletionQueue = Array.isArray(queueSource) ? queueSource : [];

    const sentSource = (raw.reminderSent ?? raw.reminderSentV1) as Record<string, unknown> | undefined;
    const reminderSent: Record<string, CalendarReminderSentRecord> = {};
    if (sentSource && typeof sentSource === "object") {
        for (const [key, record] of Object.entries(sentSource)) {
            // 插件早期版本这里直接存时间戳数字，后来才改成对象
            const at = typeof record === "object" && record
                ? Number((record as Record<string, unknown>).at)
                : Number(record);
            if (!Number.isFinite(at)) continue;
            const status = typeof record === "object" && record
                && (record as Record<string, unknown>).status === "sending" ? "sending" : "sent";
            reminderSent[key] = { at, status };
        }
    }

    const barrierSource = (raw.clearBarrier ?? raw.calendarClearBarrierV1) as Record<string, unknown> | undefined;
    const clearedAt = typeof barrierSource?.clearedAt === "string" ? barrierSource.clearedAt : "";

    return {
        eventDetails,
        series,
        memos,
        characterAccess,
        todoReactions,
        todoCompletionQueue,
        reminderSent,
        clearBarrier: clearedAt ? { clearedAt } : null,
        migratedFrom: typeof raw.migratedFrom === "string" ? raw.migratedFrom : undefined,
        migratedAt: typeof raw.migratedAt === "string" ? raw.migratedAt : undefined,
    };
}

// ── 读写 ──

export function loadCalendarExtras(): CalendarExtras {
    if (typeof window === "undefined") return { ...EMPTY_CALENDAR_EXTRAS };
    try {
        const raw = kvGet(EXTRAS_KEY);
        if (!raw) return { ...EMPTY_CALENDAR_EXTRAS };
        return normalizeCalendarExtras(JSON.parse(raw));
    } catch {
        return { ...EMPTY_CALENDAR_EXTRAS };
    }
}

export function saveCalendarExtras(extras: CalendarExtras): void {
    if (typeof window === "undefined") return;
    kvSet(EXTRAS_KEY, JSON.stringify(extras));
    window.dispatchEvent(new CustomEvent(CALENDAR_EXTRAS_UPDATED_EVENT));
}

export const CALENDAR_EXTRAS_UPDATED_EVENT = "calendar-extras-updated";

/** 改一部分，其余原样保留 */
export function updateCalendarExtras(patch: Partial<CalendarExtras>): CalendarExtras {
    const next = { ...loadCalendarExtras(), ...patch };
    saveCalendarExtras(next);
    return next;
}

// ── 从插件搬家 ──

export type CalendarMigrationResult =
    | { status: "already" | "nothing" }
    | { status: "migrated"; from: string; events: number; series: number; memos: number };

/** 这个桶看起来是不是日历插件的？按内容认，不认插件 id——
 *  插件 id 是作者定的，写死就成了「硬编码名字」。 */
function looksLikeCalendarBucket(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return keys.includes("memoPagesV1")
        || keys.includes("eventDetailsV2")
        || keys.includes("recurrenceSeriesV1");
}

/**
 * 一次性把日历插件的私有数据搬进原生存储。
 *
 * 只读不删：插件那份原样留着。用户要先停用插件、确认原生这边数据都在，
 * 再自己去卸载——卸载会清掉插件私有数据，提前删就没有退路了。
 * 已经搬过就什么都不做，所以每次启动调用都是安全的。
 */
export function migrateCalendarExtrasFromPlugin(): CalendarMigrationResult {
    if (typeof window === "undefined") return { status: "nothing" };
    const current = loadCalendarExtras();
    if (current.migratedFrom) return { status: "already" };

    for (const key of kvKeysWithPrefix(PLUGIN_DATA_PREFIX)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(kvGet(key) || "null");
        } catch {
            continue;
        }
        if (!looksLikeCalendarBucket(parsed)) continue;

        const migrated = normalizeCalendarExtras(parsed);
        migrated.migratedFrom = key;
        migrated.migratedAt = new Date().toISOString();
        saveCalendarExtras(migrated);
        return {
            status: "migrated",
            from: key,
            events: Object.keys(migrated.eventDetails).length,
            series: Object.keys(migrated.series).length,
            memos: migrated.memos.length,
        };
    }
    return { status: "nothing" };
}

// ── 设置也搬 ──
// 插件的设置不在数据桶里，而在已安装插件列表 chat_plugins_v3 里那一项的
// .settings 下。数据桶的 key 里带着插件 id，按 id 找到那一项就行。

const PLUGIN_LIST_KEY = "chat_plugins_v3";
const PLUGIN_SETTING_KEYS = [
    "scope", "nearMinutes", "futureDays", "maxEvents", "weekStartDay",
    "includePastToday", "chinaHolidays", "ontarioHolidays", "chinaHolidayColor", "ontarioHolidayColor",
] as const;

type InstalledPluginLike = { manifest?: { id?: string; settings?: Array<{ key?: string }> }; settings?: Record<string, unknown> };

/** 找日历插件那一项：优先按数据桶记下的 id，找不到再按设置项的形状认 */
function findCalendarPluginEntry(list: InstalledPluginLike[], preferredId: string | null): InstalledPluginLike | null {
    if (preferredId) {
        const byId = list.find((entry) => entry?.manifest?.id === preferredId);
        if (byId) return byId;
    }
    return list.find((entry) => {
        const keys = (entry?.manifest?.settings || []).map((field) => field?.key);
        return keys.includes("weekStartDay") && keys.includes("chinaHolidays") && keys.includes("nearMinutes");
    }) || null;
}

export function migrateCalendarSettingsFromPlugin(): { status: "already" | "nothing" } | { status: "migrated"; from: string } {
    if (typeof window === "undefined") return { status: "nothing" };
    const config = loadCalendarConfig();
    if (config.pluginSettingsMigratedFrom) return { status: "already" };

    let list: InstalledPluginLike[] = [];
    try {
        const parsed = JSON.parse(kvGet(PLUGIN_LIST_KEY) || "[]");
        list = Array.isArray(parsed) ? parsed : [];
    } catch {
        return { status: "nothing" };
    }

    const bucket = loadCalendarExtras().migratedFrom || "";
    const preferredId = bucket.startsWith(PLUGIN_DATA_PREFIX) ? bucket.slice(PLUGIN_DATA_PREFIX.length) : null;
    const entry = findCalendarPluginEntry(list, preferredId);
    const id = entry?.manifest?.id;
    if (!entry || !id) return { status: "nothing" };

    const picked: Record<string, unknown> = {};
    for (const key of PLUGIN_SETTING_KEYS) {
        if (entry.settings && key in entry.settings) picked[key] = entry.settings[key];
    }
    // 走一遍规范化：插件里存的值也可能越界或类型不对
    saveCalendarConfig(normalizeCalendarConfig({ ...config, ...picked, pluginSettingsMigratedFrom: id }));
    return { status: "migrated", from: id };
}
