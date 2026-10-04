"use client";

// 角色在私聊里改用户日历：照搬「用户日历增强版」插件 4.3 的「非删除型修改权限」。
// 角色回复里带一个隐藏块 <user_calendar_actions>[{"action":…,"args":{…}}]</user_calendar_actions>，
// 由 calendar-chat-service 摘出来交给这里逐个执行；返回的摘要拼成聊天里那条「X修改了你的日历：…」。
// 只有新增和修改，没有任何删除。角色改的待办不触发「完成待办后的回应」（那是给用户自己勾的）。

import type { CalendarColorKey, CalendarScheduleItem, CalendarWeekPlan } from "./calendar-types";
import { loadOwnerCalendarPlansRaw, replaceOwnerCalendarPlans } from "./calendar-storage";
import { getWeekStartIso, getWeekdayLabel, pickScheduleColorKey, sanitizeScheduleEmoji } from "./calendar-utils";
import {
    loadCalendarExtras,
    normalizeCalendarTodos,
    saveCalendarExtras,
    type CalendarEventDetails,
    type CalendarMemoPage,
    type CalendarRecurrenceFrequency,
    type CalendarTodo,
} from "./calendar-extras";
import { addDaysIso, createRecurringSeries, recurrenceDates, recurrenceRuleLabel, updateEntireSeries } from "./calendar-recurrence";

const USER = { ownerType: "user", ownerId: "self" } as const;
const COLOR_KEYS: CalendarColorKey[] = ["blue", "green", "amber", "rose", "violet", "teal", "slate", "lilac"];
const FREQUENCIES: CalendarRecurrenceFrequency[] = ["daily", "weekly", "monthly", "yearly"];

type Args = Record<string, unknown>;

// ── 文本和日期小工具（和插件同一套规则） ──

function fullText(value: unknown, fallback = ""): string {
    const text = String(value ?? "").replace(/\r/g, "").trim();
    return text || fallback;
}

function oneLine(value: unknown, fallback = "", maxLength = 180): string {
    const text = String(value ?? "").replace(/\r/g, "").trim().slice(0, maxLength).replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ");
    return text || fallback;
}

function makeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function objectArg(value: unknown): Args {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Args : {};
}

function parseIsoDate(text: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function toLocalIsoDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function requireActionDate(value: unknown, label = "日期"): string {
    const text = String(value || "");
    const parsed = parseIsoDate(text);
    // 2026-02-30 这种会被 Date 顺延成 3 月，转回来对不上就是无效日期
    if (!parsed || toLocalIsoDate(parsed) !== text) throw new Error(`${label}格式无效`);
    return text;
}

function requireActionTime(value: unknown, label = "时间"): string {
    const text = String(value || "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`${label}格式无效`);
    return text;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

function actionColor(value: unknown, fallback: CalendarColorKey): CalendarColorKey {
    const key = String(value || fallback || "");
    return COLOR_KEYS.includes(key as CalendarColorKey) ? key as CalendarColorKey : fallback;
}

/** 备忘录横幅颜色多一个 auto */
function memoColor(value: unknown, fallback: string): string {
    const key = String(value || fallback || "");
    if (key === "auto") return "auto";
    return COLOR_KEYS.includes(key as CalendarColorKey) ? key : fallback;
}

function actionTodos(value: unknown, allowDeadline: boolean): CalendarTodo[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).map((raw) => {
        const todo = objectArg(raw);
        const text = oneLine(todo.text, "", 240);
        if (!text) return null;
        const dueDate = allowDeadline && todo.dueDate ? requireActionDate(todo.dueDate, "待办截止日期") : "";
        const dueTime = dueDate && todo.dueTime ? requireActionTime(todo.dueTime, "待办截止时间") : "";
        return { id: makeId("todo"), text, done: false, dueDate, dueTime, createdAt: new Date().toISOString() };
    }).filter((todo): todo is CalendarTodo => todo !== null);
}

function notifyCalendarChanged(): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("calendar-updated"));
}

// ── 日程 ──

function findEvent(plans: CalendarWeekPlan[], eventId: string): { plan: CalendarWeekPlan; index: number; item: CalendarScheduleItem } | null {
    for (const plan of plans) {
        const index = plan.items.findIndex((item) => String(item.id) === String(eventId));
        if (index >= 0) return { plan, index, item: plan.items[index] };
    }
    return null;
}

function weekPlanFor(plans: CalendarWeekPlan[], date: string, now: string): CalendarWeekPlan {
    const weekStart = getWeekStartIso(new Date(`${date}T00:00:00`));
    let plan = plans.find((entry) => entry.weekStart === weekStart);
    if (!plan) {
        plan = { id: makeId("calendar_week"), ...USER, weekStart, items: [], updatedAt: now };
        plans.push(plan);
    }
    return plan;
}

function commitPlans(plans: CalendarWeekPlan[]): void {
    replaceOwnerCalendarPlans(USER.ownerType, USER.ownerId, plans.filter((plan) => plan.items.length > 0));
}

function createEvent(args: Args): string {
    const title = oneLine(args.title, "", 300);
    if (!title) throw new Error("新增日程缺少标题");
    const date = requireActionDate(args.date, "开始日期");
    const allDay = args.allDay === true;
    const startTime = requireActionTime(args.startTime || "09:00", "开始时间");
    const endTime = requireActionTime(args.endTime || "10:00", "结束时间");
    if (endTime <= startTime) throw new Error("日程结束时间必须晚于开始时间");
    const recurrence = objectArg(args.recurrence);
    const frequency = FREQUENCIES.includes(recurrence.frequency as CalendarRecurrenceFrequency)
        ? recurrence.frequency as CalendarRecurrenceFrequency
        : null;
    const forever = frequency !== null && recurrence.forever === true;
    const untilDate = frequency === null ? date : (forever ? "" : requireActionDate(recurrence.untilDate || date, "重复结束日期"));
    if (!forever && untilDate < date) throw new Error("重复结束日期不能早于开始日期");
    const start = parseIsoDate(date) as Date;
    const weekdays = frequency === "weekly"
        ? (Array.isArray(recurrence.weekdays) ? recurrence.weekdays : [start.getDay()])
            .map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : undefined;
    if (frequency === "weekly" && (!weekdays || weekdays.length === 0)) throw new Error("每周重复至少需要选择一天");
    const monthDay = frequency === "monthly" ? clampNumber(recurrence.monthDay, start.getDate(), 1, 31) : undefined;
    const monthLastDay = frequency === "monthly" && recurrence.monthLastDay === true;
    if (frequency && recurrenceDates(date, forever ? addDaysIso(date, 730) : untilDate, frequency, { weekdays, monthDay, monthLastDay }).length === 0) {
        throw new Error("所选日期范围内没有符合重复规则的日期");
    }
    const details = { note: fullText(args.note, ""), allDay, todos: actionTodos(args.todos, false) };
    const fields = {
        startTime,
        endTime,
        location: oneLine(args.location, "", 300),
        title,
        emoji: oneLine(args.emoji, "", 20),
        colorKey: actionColor(args.colorKey, pickScheduleColorKey(startTime)),
    };

    if (frequency) {
        const result = createRecurringSeries({
            fields,
            details,
            frequency,
            rule: { weekdays, monthDay, monthLastDay },
            startDate: date,
            untilDate,
            forever,
        });
        if (!result.ok) throw new Error(result.error);
        const rule = recurrenceRuleLabel({ frequency, weekdays, monthDay, monthLastDay });
        return `新增日程“${title}”（${rule}${forever ? "，永远" : `，至 ${untilDate}`}）`;
    }

    const now = new Date().toISOString();
    const id = makeId("calendar_item");
    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId);
    const plan = weekPlanFor(plans, date, now);
    plan.items.push({
        id,
        date,
        weekday: getWeekdayLabel(date),
        startTime,
        endTime,
        location: fields.location,
        title,
        emoji: sanitizeScheduleEmoji(fields.emoji),
        colorKey: fields.colorKey,
        source: "manual",
        createdAt: now,
        updatedAt: now,
    });
    plan.updatedAt = now;
    commitPlans(plans);
    const extras = loadCalendarExtras();
    saveCalendarExtras({
        ...extras,
        eventDetails: { ...extras.eventDetails, [id]: { ...details, seriesId: null, updatedAt: now } },
    });
    notifyCalendarChanged();
    return `新增日程“${title}”`;
}

function updateEvent(args: Args): string {
    const eventId = String(args.eventId || "");
    if (!eventId) throw new Error("修改日程缺少 eventId");
    const patch = objectArg(args.patch);
    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId);
    const record = findEvent(plans, eventId);
    const extras = loadCalendarExtras();
    const details: CalendarEventDetails = extras.eventDetails[eventId] ?? { note: "", allDay: false, todos: [], seriesId: null, updatedAt: "" };

    if (args.scope === "series") {
        if (!record || !details.seriesId) throw new Error("找不到可修改的重复日程系列");
        const startTime = patch.startTime !== undefined ? requireActionTime(patch.startTime, "开始时间") : record.item.startTime;
        const endTime = patch.endTime !== undefined ? requireActionTime(patch.endTime, "结束时间") : record.item.endTime;
        const title = patch.title !== undefined ? oneLine(patch.title, "", 300) : record.item.title;
        if (!title) throw new Error("日程标题不能为空");
        const result = updateEntireSeries({
            seriesId: details.seriesId,
            currentItemId: eventId,
            fields: {
                startTime,
                endTime,
                title,
                location: patch.location !== undefined ? oneLine(patch.location, "", 300) : record.item.location,
                emoji: patch.emoji !== undefined ? oneLine(patch.emoji, "", 20) : (record.item.emoji ?? ""),
                colorKey: patch.colorKey !== undefined
                    ? actionColor(patch.colorKey, record.item.colorKey || pickScheduleColorKey(startTime))
                    : (record.item.colorKey || pickScheduleColorKey(startTime)),
            },
            details: {
                note: patch.note !== undefined ? fullText(patch.note, "") : details.note,
                allDay: patch.allDay !== undefined ? patch.allDay === true : details.allDay === true,
                todos: normalizeCalendarTodos(details.todos),
            },
            untilDate: patch.untilDate ? requireActionDate(patch.untilDate, "重复结束日期") : "",
        });
        if (!result.ok) throw new Error(result.error);
        return `修改重复日程“${title}”的全部 ${result.count} 次日程`;
    }

    if (!record) throw new Error("找不到要修改的日程");
    const date = patch.date !== undefined ? requireActionDate(patch.date, "日程日期") : record.item.date;
    const startTime = patch.startTime !== undefined ? requireActionTime(patch.startTime, "开始时间") : record.item.startTime;
    const endTime = patch.endTime !== undefined ? requireActionTime(patch.endTime, "结束时间") : record.item.endTime;
    if (endTime <= startTime) throw new Error("日程结束时间必须晚于开始时间");
    const title = patch.title !== undefined ? oneLine(patch.title, "", 300) : record.item.title;
    if (!title) throw new Error("日程标题不能为空");
    const now = new Date().toISOString();
    const nextItem: CalendarScheduleItem = {
        ...record.item,
        date,
        weekday: getWeekdayLabel(date),
        startTime,
        endTime,
        title,
        location: patch.location !== undefined ? oneLine(patch.location, "", 300) : record.item.location,
        emoji: patch.emoji !== undefined ? sanitizeScheduleEmoji(oneLine(patch.emoji, "", 20)) : record.item.emoji,
        colorKey: patch.colorKey !== undefined
            ? actionColor(patch.colorKey, record.item.colorKey || pickScheduleColorKey(startTime))
            : (record.item.colorKey || pickScheduleColorKey(startTime)),
        updatedAt: now,
    };
    record.plan.items.splice(record.index, 1);
    record.plan.updatedAt = now;
    const target = weekPlanFor(plans, date, now);
    target.items.push(nextItem);
    target.items.sort((a, b) => `${a.date} ${a.startTime} ${a.endTime}`.localeCompare(`${b.date} ${b.startTime} ${b.endTime}`));
    target.updatedAt = now;
    commitPlans(plans);
    const allDay = patch.allDay !== undefined ? patch.allDay === true : details.allDay === true;
    saveCalendarExtras({
        ...extras,
        eventDetails: {
            ...extras.eventDetails,
            [eventId]: {
                ...details,
                note: patch.note !== undefined ? fullText(patch.note, "") : details.note,
                allDay,
                todos: normalizeCalendarTodos(details.todos),
                updatedAt: now,
            },
        },
    });
    notifyCalendarChanged();
    return `修改日程“${title}”（${date}${allDay ? " 全天" : ` ${startTime}–${endTime}`}）`;
}

// ── 待办（日程里的 / 备忘录里的） ──

type TodoTarget =
    | { source: "memo"; memos: CalendarMemoPage[]; memo: CalendarMemoPage; todos: CalendarTodo[] }
    | { source: "event"; eventId: string; details: CalendarEventDetails; todos: CalendarTodo[] };

function todoTarget(sourceValue: unknown, ownerIdValue: unknown): TodoTarget {
    const source = String(sourceValue || "");
    const ownerId = String(ownerIdValue || "");
    const extras = loadCalendarExtras();
    if (source === "memo") {
        const memo = extras.memos.find((item) => String(item.id) === ownerId);
        if (!memo) throw new Error("找不到目标备忘录");
        return { source, memos: extras.memos, memo, todos: normalizeCalendarTodos(memo.checklist) };
    }
    if (source !== "event") throw new Error("待办来源必须是 event 或 memo");
    let details = extras.eventDetails[ownerId];
    if (!details) {
        // 从没加过备注 / 待办的日程还没有附加信息，日程本身在就补一份空的
        const exists = findEvent(loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId), ownerId);
        if (!exists) throw new Error("找不到目标日程待办清单");
        details = { note: "", allDay: false, todos: [], seriesId: null, updatedAt: "" };
    }
    return { source, eventId: ownerId, details, todos: normalizeCalendarTodos(details.todos) };
}

/** 存回去；故意不走 setEventTodoDone / reportEventTodosChanged，免得角色自己勾的待办又触发「完成后回应」 */
function saveTodoTarget(target: TodoTarget): void {
    const now = new Date().toISOString();
    const extras = loadCalendarExtras();
    if (target.source === "memo") {
        const memo = { ...target.memo, checklist: target.todos, updatedAt: now };
        saveCalendarExtras({ ...extras, memos: extras.memos.map((item) => (item.id === memo.id ? memo : item)) });
        return;
    }
    saveCalendarExtras({
        ...extras,
        eventDetails: { ...extras.eventDetails, [target.eventId]: { ...target.details, todos: target.todos, updatedAt: now } },
    });
}

function setTodoState(args: Args): string {
    const target = todoTarget(args.source, args.ownerId);
    const todo = target.todos.find((item) => item.id === String(args.todoId || ""));
    if (!todo) throw new Error("找不到目标待办");
    todo.done = args.done === true;
    saveTodoTarget(target);
    return `${todo.done ? "勾选完成" : "取消完成"}待办“${todo.text}”`;
}

/** 重复日程：同一系列的每一次都加 / 都改（按位置对应） */
function seriesInstances(ownerId: string): { title: string; ids: string[]; details: Record<string, CalendarEventDetails> } {
    const plans = loadOwnerCalendarPlansRaw(USER.ownerType, USER.ownerId);
    const event = findEvent(plans, ownerId);
    const extras = loadCalendarExtras();
    const seriesId = extras.eventDetails[ownerId]?.seriesId;
    if (!event || !seriesId) throw new Error("目标日程不属于重复系列，无法修改整个重复日程");
    const ids = plans.flatMap((plan) => plan.items).map((item) => item.id).filter((id) => extras.eventDetails[id]?.seriesId === seriesId);
    if (ids.length === 0) throw new Error("没有找到重复日程实例");
    return { title: oneLine(event.item.title, "未命名事项"), ids, details: extras.eventDetails };
}

function addTodoToSeries(ownerId: string, text: string): string {
    const { title, ids, details } = seriesInstances(ownerId);
    const createdAt = new Date().toISOString();
    const eventDetails = { ...details };
    for (const id of ids) {
        const current = eventDetails[id];
        eventDetails[id] = {
            ...current,
            todos: [...normalizeCalendarTodos(current.todos), { id: makeId("todo"), text, done: false, dueDate: "", dueTime: "", createdAt }],
            updatedAt: createdAt,
        };
    }
    saveCalendarExtras({ ...loadCalendarExtras(), eventDetails });
    return `为重复日程“${title}”的全部实例新增待办“${text}”（现有及以后每次重复均生效）`;
}

function updateTodoAcrossSeries(ownerId: string, todoId: string, patch: Args): string {
    const { title, ids, details } = seriesInstances(ownerId);
    const sourceTodos = normalizeCalendarTodos(details[ownerId]?.todos);
    const sourceIndex = sourceTodos.findIndex((todo) => todo.id === todoId);
    if (sourceIndex < 0) throw new Error("找不到目标待办");
    const nextText = patch.text !== undefined ? oneLine(patch.text, "", 240) : sourceTodos[sourceIndex].text;
    if (!nextText) throw new Error("待办内容不能为空，也不能用空文字删除");
    const now = new Date().toISOString();
    const eventDetails = { ...details };
    let updated = 0;
    for (const id of ids) {
        const todos = normalizeCalendarTodos(eventDetails[id].todos);
        if (!todos[sourceIndex]) continue;
        todos[sourceIndex] = { ...todos[sourceIndex], text: nextText };
        eventDetails[id] = { ...eventDetails[id], todos, updatedAt: now };
        updated += 1;
    }
    if (updated === 0) throw new Error("没有找到可同步修改的重复待办");
    saveCalendarExtras({ ...loadCalendarExtras(), eventDetails });
    return `修改重复日程“${title}”全部实例中的待办“${nextText}”（以后每次重复均生效）`;
}

function addTodo(args: Args): string {
    const text = oneLine(args.text, "", 240);
    if (!text) throw new Error("新增待办缺少内容");
    if (args.source === "event" && args.scope === "series") return addTodoToSeries(String(args.ownerId || ""), text);
    const target = todoTarget(args.source, args.ownerId);
    const dueDate = target.source === "memo" && args.dueDate ? requireActionDate(args.dueDate, "待办截止日期") : "";
    const dueTime = dueDate && args.dueTime ? requireActionTime(args.dueTime, "待办截止时间") : "";
    target.todos.push({ id: makeId("todo"), text, done: false, dueDate, dueTime, createdAt: new Date().toISOString() });
    saveTodoTarget(target);
    return `在${target.source === "memo" ? "备忘录" : "日程"}中新增待办“${text}”`;
}

function updateTodo(args: Args): string {
    const patch = objectArg(args.patch);
    const todoId = String(args.todoId || "");
    if (args.source === "event" && args.scope === "series") return updateTodoAcrossSeries(String(args.ownerId || ""), todoId, patch);
    const target = todoTarget(args.source, args.ownerId);
    const todo = target.todos.find((item) => item.id === todoId);
    if (!todo) throw new Error("找不到目标待办");
    if (patch.text !== undefined) {
        const text = oneLine(patch.text, "", 240);
        if (!text) throw new Error("待办内容不能为空，也不能用空文字删除");
        todo.text = text;
    }
    if (target.source === "memo" && patch.dueDate !== undefined) {
        todo.dueDate = patch.dueDate ? requireActionDate(patch.dueDate, "待办截止日期") : "";
        todo.dueTime = todo.dueDate && patch.dueTime ? requireActionTime(patch.dueTime, "待办截止时间") : "";
    } else if (target.source === "memo" && patch.dueTime !== undefined) {
        if (!todo.dueDate) throw new Error("设置截止时间前需要先有截止日期");
        todo.dueTime = patch.dueTime ? requireActionTime(patch.dueTime, "待办截止时间") : "";
    }
    saveTodoTarget(target);
    return `修改待办“${todo.text}”`;
}

// ── 备忘录 ──

function createMemo(args: Args): string {
    const now = new Date().toISOString();
    const title = oneLine(args.title, "无标题备忘录", 200);
    const memo: CalendarMemoPage = {
        id: makeId("memo"),
        title,
        body: fullText(args.body, ""),
        bannerColor: memoColor(args.bannerColor, "auto"),
        checklist: actionTodos(args.checklist, true),
        createdAt: now,
        updatedAt: now,
    };
    const extras = loadCalendarExtras();
    saveCalendarExtras({ ...extras, memos: [...extras.memos, memo] });
    return `新增备忘录“${title}”`;
}

function updateMemo(args: Args): string {
    const memoId = String(args.memoId || "");
    const patch = objectArg(args.patch);
    const extras = loadCalendarExtras();
    const current = extras.memos.find((item) => String(item.id) === memoId);
    if (!current) throw new Error("找不到要修改的备忘录");
    const memo: CalendarMemoPage = {
        ...current,
        title: patch.title !== undefined ? oneLine(patch.title, "无标题备忘录", 200) : current.title,
        body: patch.body !== undefined ? fullText(patch.body, "") : current.body,
        bannerColor: patch.bannerColor !== undefined ? memoColor(patch.bannerColor, current.bannerColor || "auto") : current.bannerColor,
        updatedAt: new Date().toISOString(),
    };
    saveCalendarExtras({ ...extras, memos: extras.memos.map((item) => (item.id === memoId ? memo : item)) });
    return `修改备忘录“${memo.title || "无标题备忘录"}”`;
}

/** 执行一个动作，返回给通知用的一句摘要；不认识的动作（包括任何删除）直接报错不执行 */
export function executeCharacterCalendarAction(action: unknown): string {
    const record = objectArg(action);
    const name = String(record.action || "");
    const args = objectArg(record.args);
    if (name === "event.create") return createEvent(args);
    if (name === "event.update") return updateEvent(args);
    if (name === "todo.set_state") return setTodoState(args);
    if (name === "todo.add") return addTodo(args);
    if (name === "todo.update") return updateTodo(args);
    if (name === "memo.create") return createMemo(args);
    if (name === "memo.update") return updateMemo(args);
    throw new Error(`不支持动作“${name || "空动作"}”；未执行任何删除`);
}
