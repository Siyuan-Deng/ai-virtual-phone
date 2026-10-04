"use client";

// 日历的「附加信息」：原生日历条目只有日期/起止时间/地点/标题/emoji/颜色，
// 全天、永久、重复系列、备注、待办、备忘录、逐角色权限这些都挂在这里，
// 按条目 id 关联。字段结构刻意和「用户日历增强版」插件完全一致——那边的
// 数据要原样搬进来，形状对不上就得写转换，转换就有丢字段的风险。

import { kvGet, kvKeysWithPrefix, kvSet, registerKvMigration } from "./kv-db";
import {
    loadCalendarConfig,
    loadOwnerCalendarPlansRaw,
    normalizeCalendarConfig,
    replaceOwnerCalendarPlans,
    saveCalendarConfig,
} from "./calendar-storage";

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

/** sending：正在发；sent：发出去了；failed：生成报错了（隔一会儿再试，最多试 3 次） */
export type CalendarReminderSentRecord = { at: number; status: "sending" | "sent" | "failed"; attempts?: number };

/** 角色改过的日历动作：`${角色id}:${请求指纹}:${第几个动作}` → 执行记录。重试同一轮不会重复执行 */
export type CalendarWriteReceipt = { at: number; action: string; summary: string };

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
    /** 角色 id → 能不能在私聊里改用户日历（不含删除）；还要同时在知情角色里勾上才算 */
    writeAccess: Record<string, boolean>;
    writeReceipts: Record<string, CalendarWriteReceipt>;
    todoCompletionQueue: unknown[];
    /** `${角色id}:${提醒key}` → 发送状态，用来保证每条只提醒一次 */
    reminderSent: Record<string, CalendarReminderSentRecord>;
    /** 「清空全部」的时间水位：早于它的条目不再复活 */
    clearBarrier: { clearedAt: string } | null;
    /** 从哪个插件桶迁移来的；有值就不再迁移第二次 */
    migratedFrom?: string;
    migratedAt?: string;
    /** 迁移之后插件那边又写过的东西补搬过了（插件现在不再运行，补一次就够） */
    pluginResyncedAt?: string;
    /** 插件 4.3 加的「修改权限」补搬过了（早先的迁移按旧版插件做，没带上这一项） */
    writeAccessMigratedAt?: string;
};

export const EMPTY_CALENDAR_EXTRAS: CalendarExtras = {
    eventDetails: {},
    series: {},
    memos: [],
    characterAccess: null,
    todoReactions: {},
    writeAccess: {},
    writeReceipts: {},
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

    // 插件里存的是 true 或 "allow"
    const writeSource = (raw.writeAccess ?? raw.calendarWriteAccessV1) as Record<string, unknown> | undefined;
    const writeAccess: Record<string, boolean> = {};
    if (writeSource && typeof writeSource === "object" && !Array.isArray(writeSource)) {
        for (const [id, value] of Object.entries(writeSource)) writeAccess[String(id)] = value === true || value === "allow";
    }

    const receiptSource = (raw.writeReceipts ?? raw.calendarWriteReceiptsV1) as Record<string, unknown> | undefined;
    const writeReceipts: Record<string, CalendarWriteReceipt> = {};
    if (receiptSource && typeof receiptSource === "object" && !Array.isArray(receiptSource)) {
        const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
        for (const [key, record] of Object.entries(receiptSource)) {
            const entry = (record && typeof record === "object" ? record : {}) as Record<string, unknown>;
            const at = Number(entry.at || 0);
            if (!Number.isFinite(at) || at < cutoff) continue;
            writeReceipts[key] = { at, action: String(entry.action || ""), summary: String(entry.summary || "") };
        }
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
            const rawStatus = typeof record === "object" && record ? (record as Record<string, unknown>).status : undefined;
            const status = rawStatus === "sending" || rawStatus === "failed" ? rawStatus : "sent";
            const attempts = typeof record === "object" && record ? Number((record as Record<string, unknown>).attempts) : NaN;
            reminderSent[key] = Number.isFinite(attempts) && attempts > 0 ? { at, status, attempts } : { at, status };
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
        writeAccess,
        writeReceipts,
        todoCompletionQueue,
        reminderSent,
        clearBarrier: clearedAt ? { clearedAt } : null,
        migratedFrom: typeof raw.migratedFrom === "string" ? raw.migratedFrom : undefined,
        pluginResyncedAt: typeof raw.pluginResyncedAt === "string" ? raw.pluginResyncedAt : undefined,
        writeAccessMigratedAt: typeof raw.writeAccessMigratedAt === "string" ? raw.writeAccessMigratedAt : undefined,
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

// ── 一键清除 ──

function queueTaskKey(record: unknown): string {
    const key = (record as { taskKey?: unknown } | null)?.taskKey;
    return typeof key === "string" ? key : "";
}

/** 删掉和这些日程 / 备忘录有关的提醒记录和待回应队列（插件 cleanupReminderKeys） */
function withoutReminderTraces(
    extras: CalendarExtras,
    eventIds: Set<string>,
    memoIds: Set<string>,
): Pick<CalendarExtras, "reminderSent" | "todoCompletionQueue"> {
    const events = Array.from(eventIds);
    const memos = Array.from(memoIds);
    const reminderSent: CalendarExtras["reminderSent"] = {};
    for (const [key, record] of Object.entries(extras.reminderSent)) {
        const removed = events.some((id) => key.includes(`:event:${id}:`))
            || memos.some((id) => key.includes(`:memo:${id}:`));
        if (!removed) reminderSent[key] = record;
    }
    const todoCompletionQueue = extras.todoCompletionQueue.filter((record) => {
        const taskKey = queueTaskKey(record);
        return !events.some((id) => taskKey.startsWith(`event:${id}:`))
            && !memos.some((id) => taskKey.startsWith(`memo:${id}:`));
    });
    return { reminderSent, todoCompletionQueue };
}

/** 清除自己日历上的日程。不给日期就是全部；给了按条目日期筛，首尾两天都算。
 *  日程本身一次性整份落盘，成功之后再清附加信息，不会停在删了一半的状态。
 *  返回删掉了几条。 */
export function clearUserCalendarEvents(startDate = "", endDate = ""): number {
    const clearAll = !startDate && !endDate;
    const plans = loadOwnerCalendarPlansRaw("user", "self");
    const removedIds = new Set<string>();
    for (const plan of plans) {
        for (const item of plan.items) {
            if (clearAll || (item.date >= startDate && item.date <= endDate)) removedIds.add(item.id);
        }
    }
    const remaining = clearAll ? [] : plans
        .map((plan) => ({ ...plan, items: plan.items.filter((item) => item.date < startDate || item.date > endDate) }))
        .filter((plan) => plan.items.length > 0);
    replaceOwnerCalendarPlans("user", "self", remaining);

    const extras = loadCalendarExtras();
    if (clearAll) {
        // 全部清空时连孤立的旧详情和系列一起删，不只看当前还在的条目
        const reminderSent: CalendarExtras["reminderSent"] = {};
        for (const [key, record] of Object.entries(extras.reminderSent)) {
            if (!key.includes(":event:")) reminderSent[key] = record;
        }
        saveCalendarExtras({
            ...extras,
            eventDetails: {},
            series: {},
            reminderSent,
            todoCompletionQueue: extras.todoCompletionQueue.filter((record) => !queueTaskKey(record).startsWith("event:")),
            clearBarrier: { clearedAt: new Date().toISOString() },
        });
    } else {
        const eventDetails = { ...extras.eventDetails };
        for (const id of removedIds) delete eventDetails[id];
        // 没有任何日程再引用的重复系列也一起删
        const usedSeries = new Set(Object.values(eventDetails).map((entry) => entry.seriesId).filter(Boolean));
        const series = Object.fromEntries(Object.entries(extras.series).filter(([id]) => usedSeries.has(id)));
        saveCalendarExtras({
            ...extras,
            eventDetails,
            series,
            ...withoutReminderTraces(extras, removedIds, new Set()),
        });
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("calendar-updated"));
    return removedIds.size;
}

/** 备忘录的创建日期（本地日期）。createdAt 是 UTC 时间串，直接截前十位
 *  会把晚上建的备忘录算到第二天，所以先转回本地。 */
function memoCreatedDate(memo: CalendarMemoPage): string {
    const value = memo.createdAt || memo.updatedAt || "";
    const parsed = new Date(value);
    if (value && !Number.isNaN(parsed.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    }
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}

/** 清除备忘录。不给日期就是全部；给了按创建日期筛，首尾两天都算。返回删掉了几页。 */
export function clearCalendarMemos(startDate = "", endDate = ""): number {
    const extras = loadCalendarExtras();
    const clearAll = !startDate && !endDate;
    const removedIds = new Set<string>();
    const memos = extras.memos.filter((memo) => {
        const date = memoCreatedDate(memo);
        const remove = clearAll || (!!date && date >= startDate && date <= endDate);
        if (remove) removedIds.add(memo.id);
        return !remove;
    });
    saveCalendarExtras({ ...extras, memos, ...withoutReminderTraces(extras, new Set(), removedIds) });
    return removedIds.size;
}

// ── 勾待办 ──
// 横幅、备忘录查看页都从这里勾。勾选状态一变就报给角色的「完成待办后回应」
// （calendar-chat-service 启动时挂上来；这里不直接 import 它，免得循环依赖）。

type TodoTransitionListener = {
    event?: (eventId: string, before: CalendarTodo[] | undefined, after: CalendarTodo[] | undefined) => void;
    memo?: (memo: CalendarMemoPage, before: CalendarTodo[] | undefined) => void;
};

let todoListener: TodoTransitionListener = {};

export function setCalendarTodoListener(listener: TodoTransitionListener): void {
    todoListener = listener;
}

/** 日程的待办勾选状态可能变了（编辑框保存后也调用） */
export function reportEventTodosChanged(eventId: string, before: CalendarTodo[] | undefined, after: CalendarTodo[] | undefined): void {
    try {
        todoListener.event?.(eventId, before, after);
    } catch (error) {
        console.warn("[Calendar] 待办回应处理失败", error);
    }
}

/** 备忘录的待办勾选状态可能变了（编辑后保存也调用） */
export function reportMemoTodosChanged(memo: CalendarMemoPage, before: CalendarTodo[] | undefined): void {
    try {
        todoListener.memo?.(memo, before);
    } catch (error) {
        console.warn("[Calendar] 待办回应处理失败", error);
    }
}

export function setEventTodoDone(itemId: string, todoId: string, done: boolean): void {
    const extras = loadCalendarExtras();
    const details = extras.eventDetails[itemId];
    if (!details) return;
    const todos = details.todos.map((todo) => todo.id === todoId ? { ...todo, done } : todo);
    saveCalendarExtras({
        ...extras,
        eventDetails: {
            ...extras.eventDetails,
            [itemId]: { ...details, todos, updatedAt: new Date().toISOString() },
        },
    });
    reportEventTodosChanged(itemId, details.todos, todos);
}

export function setMemoTodoDone(memoId: string, todoId: string, done: boolean): void {
    const extras = loadCalendarExtras();
    const memo = extras.memos.find((item) => item.id === memoId);
    if (!memo) return;
    const next: CalendarMemoPage = {
        ...memo,
        checklist: memo.checklist.map((todo) => todo.id === todoId ? { ...todo, done } : todo),
        updatedAt: new Date().toISOString(),
    };
    saveCalendarExtras({ ...extras, memos: extras.memos.map((item) => (item.id === memoId ? next : item)) });
    reportMemoTodosChanged(next, memo.checklist);
}

/** 删一页备忘录，连同它的提醒记录 */
export function deleteCalendarMemo(memoId: string): void {
    const extras = loadCalendarExtras();
    saveCalendarExtras({
        ...extras,
        memos: extras.memos.filter((memo) => memo.id !== memoId),
        ...withoutReminderTraces(extras, new Set(), new Set([memoId])),
    });
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

/** 迁移之后插件如果又被打开用过，那段时间在插件里新建 / 改过的备忘录、日程附加信息、重复系列
 *  只在插件的数据桶里。补搬一次：只拿比迁移时间新的条目，原生这边更新过的不覆盖，
 *  原生这边删掉的也不会被翻出来（删掉的那些在插件里不会比迁移时间新）。 */
export function resyncCalendarExtrasFromPlugin(): { status: "done" | "skipped"; memos?: number; events?: number; series?: number } {
    if (typeof window === "undefined") return { status: "skipped" };
    const current = loadCalendarExtras();
    if (!current.migratedFrom || !current.migratedAt || current.pluginResyncedAt) return { status: "skipped" };
    let bucket: CalendarExtras;
    try {
        const raw = kvGet(current.migratedFrom);
        if (!raw) {
            saveCalendarExtras({ ...current, pluginResyncedAt: new Date().toISOString() });
            return { status: "done", memos: 0, events: 0, series: 0 };
        }
        bucket = normalizeCalendarExtras(JSON.parse(raw));
    } catch {
        return { status: "skipped" };
    }
    const since = current.migratedAt;
    const newer = (value: string | undefined, than: string | undefined) => Boolean(value && value > since && (!than || value > than));

    const memos = [...current.memos];
    let memoCount = 0;
    for (const memo of bucket.memos) {
        const index = memos.findIndex((item) => item.id === memo.id);
        if (!newer(memo.updatedAt, index >= 0 ? memos[index].updatedAt : undefined)) continue;
        if (index >= 0) memos[index] = memo;
        else memos.push(memo);
        memoCount += 1;
    }
    const eventDetails = { ...current.eventDetails };
    let eventCount = 0;
    for (const [id, details] of Object.entries(bucket.eventDetails)) {
        if (!newer(details.updatedAt, eventDetails[id]?.updatedAt)) continue;
        eventDetails[id] = details;
        eventCount += 1;
    }
    const series = { ...current.series };
    let seriesCount = 0;
    for (const [id, entry] of Object.entries(bucket.series)) {
        if (series[id] || !newer(entry.updatedAt || entry.createdAt, undefined)) continue;
        series[id] = entry;
        seriesCount += 1;
    }
    saveCalendarExtras({ ...current, memos, eventDetails, series, pluginResyncedAt: new Date().toISOString() });
    return { status: "done", memos: memoCount, events: eventCount, series: seriesCount };
}

/** 早先的迁移是照旧版插件（4.2）做的，没带上 4.3 加的「修改权限」。插件数据桶还在的话补搬一次；
 *  原生这边已经设过的角色不覆盖。桶已经随插件卸载没了，就只能在「日历知情角色」里重新选。 */
export function migrateCalendarWriteAccessFromPlugin(): { status: "done" | "skipped"; count?: number } {
    if (typeof window === "undefined") return { status: "skipped" };
    const current = loadCalendarExtras();
    if (!current.migratedFrom || current.writeAccessMigratedAt) return { status: "skipped" };
    let count = 0;
    const writeAccess = { ...current.writeAccess };
    try {
        const raw = kvGet(current.migratedFrom);
        const bucket = raw ? normalizeCalendarExtras(JSON.parse(raw)) : null;
        for (const [id, allowed] of Object.entries(bucket?.writeAccess ?? {})) {
            if (id in writeAccess) continue;
            writeAccess[id] = allowed;
            count += 1;
        }
    } catch {
        return { status: "skipped" };
    }
    saveCalendarExtras({ ...current, writeAccess, writeAccessMigratedAt: new Date().toISOString() });
    return { status: "done", count };
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

/** 是不是那个已经并进源码的日历增强插件：按设置项的形状认，不认插件 id */
export function isAbsorbedCalendarPlugin(manifest: { settings?: Array<{ key?: string }> } | undefined): boolean {
    const keys = (manifest?.settings || []).map((field) => field?.key);
    return keys.includes("weekStartDay") && keys.includes("chinaHolidays") && keys.includes("nearMinutes");
}

/** 找日历插件那一项：优先按数据桶记下的 id，找不到再按设置项的形状认 */
function findCalendarPluginEntry(list: InstalledPluginLike[], preferredId: string | null): InstalledPluginLike | null {
    if (preferredId) {
        const byId = list.find((entry) => entry?.manifest?.id === preferredId);
        if (byId) return byId;
    }
    return list.find((entry) => isAbsorbedCalendarPlugin(entry?.manifest)) || null;
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
