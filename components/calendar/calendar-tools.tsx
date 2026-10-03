"use client";

// 日历的几个附加界面：备忘录（列表 / 查看 / 编辑）、一键清除、日历知情角色。
// 版式、文案、交互逐项照搬「用户日历与备忘录增强」插件；类名把插件的
// ucal- 前缀一对一换成 caltool-，方便和插件 CSS 逐条对照。

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    clearCalendarMemos,
    clearUserCalendarEvents,
    deleteCalendarMemo,
    loadCalendarExtras,
    normalizeCalendarTodos,
    reportMemoTodosChanged,
    setMemoTodoDone,
    updateCalendarExtras,
    type CalendarMemoPage,
    type CalendarTodo,
} from "@/lib/calendar-extras";
import { formatIsoDate } from "@/lib/calendar-utils";

/** 备忘录待办横幅颜色：插件里的 MEMO_BANNER_COLORS，顺序和文字都一样 */
export const MEMO_BANNER_COLORS: Array<{ key: string; label: string }> = [
    { key: "auto", label: "自动" },
    { key: "blue", label: "蓝" },
    { key: "green", label: "绿" },
    { key: "amber", label: "橙" },
    { key: "rose", label: "粉" },
    { key: "violet", label: "紫" },
    { key: "teal", label: "青" },
    { key: "slate", label: "灰" },
    { key: "lilac", label: "丁香" },
];

export function normalizeMemoBannerColor(value: unknown): string {
    const key = String(value || "auto");
    return MEMO_BANNER_COLORS.some((item) => item.key === key) ? key : "auto";
}

export type TodoReactionMode = "none" | "immediate" | "merge";

export type CalendarToolView =
    | { kind: "memoList" }
    | { kind: "memoView"; memoId: string }
    | { kind: "memoEdit"; memoId: string | null }
    | { kind: "clearMenu" }
    | { kind: "clearRange"; target: "events" | "memos" }
    | { kind: "access" };

/** 确认框单独一层，叠在当前界面上面：取消后回到原来那页，编辑到一半的内容还在 */
export type CalendarConfirmRequest = {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
};

export type CalendarToolCharacter = { id: string; name: string; avatar?: string };

export type CalendarToolNav = {
    go: (view: CalendarToolView | null) => void;
    confirm: (request: CalendarConfirmRequest) => void;
    notify: (message: string) => void;
};

// ── 和插件同一套文本规整 ──

function cleanText(value: unknown, fallback = "", maxLength = 2000): string {
    const text = String(value || "").replace(/\r/g, "").trim().slice(0, maxLength);
    return text || fallback;
}

function fullText(value: unknown, fallback = ""): string {
    const text = String(value || "").replace(/\r/g, "").trim();
    return text || fallback;
}

function oneLine(value: unknown, fallback = "", maxLength = 180): string {
    return cleanText(value, fallback, maxLength).replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

function makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTodoDeadline(todo: CalendarTodo): string {
    if (!todo.dueDate) return "";
    return `${todo.dueDate}${todo.dueTime ? ` ${todo.dueTime}` : " 当天"}`;
}

/** 插件 openCalendarModal 那层壳：遮罩 + 居中白卡 + 「‹ 标题 ✓」。
 *  返回键回上一层，点遮罩直接关掉，和插件一样。 */
function ToolSheet({
    title,
    actionText = "✓",
    actionLabel = "保存",
    hideAction = false,
    actionNode,
    onBack,
    onAction,
    onDismiss,
    children,
}: {
    title: string;
    actionText?: string;
    actionLabel?: string;
    hideAction?: boolean;
    actionNode?: ReactNode;
    onBack: () => void;
    onAction?: () => void;
    onDismiss: () => void;
    children: ReactNode;
}) {
    return (
        <div
            className="modal-overlay calendar-edit-modal-overlay caltool-overlay"
            onClick={(event) => { if (event.target === event.currentTarget) onDismiss(); }}
        >
            <div className="calendar-edit-modal caltool-modal">
                <div className="modal-header">
                    <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="返回" onClick={onBack}>‹</button>
                    <span className="modal-header-title">{title}</span>
                    <button
                        type="button"
                        className={`modal-header-btn modal-header-btn-action${actionNode ? " caltool-edit-action" : ""}`}
                        aria-label={actionLabel}
                        style={hideAction ? { visibility: "hidden" } : undefined}
                        onClick={onAction}
                    >
                        {actionNode ?? actionText}
                    </button>
                </div>
                <div className="modal-body hide-scrollbar caltool-modal-body">{children}</div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="caltool-field">
            <label className="menu-desc">{label}</label>
            {children}
        </div>
    );
}

/** 待办清单编辑器：插件的 renderTodoEditor（allowDeadline 时每行多一排「截止」） */
export function TodoListEditor({
    todos,
    onChange,
    allowDeadline,
}: {
    todos: CalendarTodo[];
    onChange: (todos: CalendarTodo[]) => void;
    allowDeadline: boolean;
}) {
    const listRef = useRef<HTMLDivElement>(null);
    const focusNewRef = useRef(false);
    useEffect(() => {
        if (!focusNewRef.current) return;
        focusNewRef.current = false;
        listRef.current?.lastElementChild?.querySelector<HTMLInputElement>("input[type=text]")?.focus();
    }, [todos.length]);

    const patch = (index: number, next: Partial<CalendarTodo>) => {
        const list = [...todos];
        list[index] = { ...list[index], ...next };
        onChange(list);
    };
    return (
        <>
            <div className="caltool-checklist" ref={listRef}>
                {todos.map((todo, index) => (
                    <div key={todo.id} className="caltool-check-row">
                        <input
                            type="checkbox"
                            checked={todo.done}
                            onChange={(event) => patch(index, { done: event.target.checked })}
                        />
                        <input
                            type="text"
                            className="ui-input"
                            value={todo.text}
                            placeholder="待办事项"
                            onChange={(event) => patch(index, { text: event.target.value })}
                        />
                        <button
                            type="button"
                            className="caltool-icon-button"
                            aria-label="删除待办"
                            onClick={() => onChange(todos.filter((_, i) => i !== index))}
                        >
                            ×
                        </button>
                        {allowDeadline ? (
                            <div className="caltool-deadline-editor">
                                <span className="caltool-deadline-label">截止</span>
                                <input
                                    type="date"
                                    className="ui-input"
                                    aria-label="待办截止日期"
                                    value={todo.dueDate}
                                    onChange={(event) => patch(index, { dueDate: event.target.value })}
                                />
                                <input
                                    type="time"
                                    className="ui-input"
                                    aria-label="待办截止时间"
                                    value={todo.dueTime}
                                    onChange={(event) => patch(index, { dueTime: event.target.value })}
                                />
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
            <button
                type="button"
                className="caltool-add-row"
                onClick={() => {
                    focusNewRef.current = true;
                    onChange([...todos, {
                        id: makeId("todo"), text: "", done: false, dueDate: "", dueTime: "",
                        createdAt: new Date().toISOString(),
                    }]);
                }}
            >
                ＋ 添加待办
            </button>
        </>
    );
}

/** 插件 MEMO_BANNER_COLORS 那排色板，沿用原生日程编辑器的 calendar-color-swatch */
function BannerColorPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    return (
        <div className="calendar-color-picker caltool-banner-color-picker">
            {MEMO_BANNER_COLORS.map((color) => (
                <button
                    key={color.key}
                    type="button"
                    className={`calendar-color-swatch${color.key === "auto" ? " calendar-color-swatch-auto" : ""}`}
                    data-color={color.key === "auto" ? undefined : color.key}
                    data-active={value === color.key ? "true" : "false"}
                    title={color.label}
                    aria-label={`待办横幅颜色：${color.label}`}
                    onClick={() => onChange(color.key)}
                >
                    {color.key === "auto" ? "自动" : null}
                </button>
            ))}
        </div>
    );
}

// ── 备忘录 ──

function MemoList({ nav, close }: { nav: CalendarToolNav; close: () => void }) {
    const memos = [...loadCalendarExtras().memos].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return (
        <ToolSheet
            title="备忘录"
            actionText="＋"
            actionLabel="新建备忘录"
            onBack={close}
            onDismiss={close}
            onAction={() => nav.go({ kind: "memoEdit", memoId: null })}
        >
            {memos.length === 0 ? (
                <div className="caltool-empty">
                    <b>还没有备忘录</b>
                    <span>点右上角＋新建一页，可以写文字或清单。</span>
                </div>
            ) : (
                <div className="caltool-memo-list">
                    {memos.map((memo) => {
                        const preview = oneLine(memo.body, memo.checklist.map((item) => item.text).filter(Boolean).join(" · ") || "空白备忘录", 120);
                        const date = memo.updatedAt
                            ? new Date(memo.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
                            : "";
                        return (
                            <button key={memo.id} type="button" className="caltool-memo-card" onClick={() => nav.go({ kind: "memoView", memoId: memo.id })}>
                                <b>{memo.title || "无标题备忘录"}</b>
                                <span>{preview}</span>
                                <small>{date}</small>
                            </button>
                        );
                    })}
                </div>
            )}
        </ToolSheet>
    );
}

function MemoViewer({ memoId, nav, close }: { memoId: string; nav: CalendarToolNav; close: () => void }) {
    const memo = loadCalendarExtras().memos.find((item) => item.id === memoId) ?? null;
    const missing = memo === null;
    useEffect(() => {
        if (!missing) return;
        nav.notify("这页备忘录已经不存在");
        nav.go({ kind: "memoList" });
    }, [missing, nav]);
    if (!memo) return null;
    const checklist = normalizeCalendarTodos(memo.checklist);
    return (
        <ToolSheet
            title="备忘录"
            actionLabel="编辑备忘录"
            actionNode={<span className="caltool-pencil-icon" />}
            onBack={() => nav.go({ kind: "memoList" })}
            onDismiss={close}
            onAction={() => nav.go({ kind: "memoEdit", memoId })}
        >
            <h2 className="caltool-memo-view-title">{memo.title || "无标题备忘录"}</h2>
            {memo.body ? <div className="caltool-memo-view-body">{fullText(memo.body)}</div> : null}
            {checklist.length ? (
                <section className="caltool-memo-view-checklist">
                    <label className="menu-desc">清单</label>
                    {checklist.map((todo) => {
                        const deadline = formatTodoDeadline(todo);
                        return (
                            <label key={todo.id} className={`caltool-view-todo${todo.done ? " is-done" : ""}`}>
                                <input
                                    type="checkbox"
                                    checked={todo.done}
                                    onChange={(event) => setMemoTodoDone(memo.id, todo.id, event.target.checked)}
                                />
                                <span className="caltool-view-todo-content">
                                    <b>{todo.text}</b>
                                    {deadline ? <small>截止：{deadline}</small> : null}
                                </span>
                            </label>
                        );
                    })}
                </section>
            ) : !memo.body ? (
                <div className="caltool-empty">空白备忘录</div>
            ) : null}
        </ToolSheet>
    );
}

function MemoEditor({ memoId, nav, close }: { memoId: string | null; nav: CalendarToolNav; close: () => void }) {
    const [source] = useState<CalendarMemoPage | null>(
        () => (memoId ? loadCalendarExtras().memos.find((item) => item.id === memoId) ?? null : null),
    );
    const [title, setTitle] = useState(source?.title ?? "");
    const [body, setBody] = useState(source?.body ?? "");
    const [bannerColor, setBannerColor] = useState(() => normalizeMemoBannerColor(source?.bannerColor));
    const [checklist, setChecklist] = useState<CalendarTodo[]>(
        () => normalizeCalendarTodos(source?.checklist).map((todo) => ({ ...todo })),
    );
    const back = () => nav.go(source ? { kind: "memoView", memoId: source.id } : { kind: "memoList" });

    const save = () => {
        const now = new Date().toISOString();
        const memo: CalendarMemoPage = {
            id: source?.id ?? makeId("memo"),
            title: oneLine(title, "无标题备忘录", 200),
            body: fullText(body, ""),
            bannerColor,
            checklist: normalizeCalendarTodos(checklist),
            createdAt: source?.createdAt || now,
            updatedAt: now,
        };
        const memos = loadCalendarExtras().memos.filter((item) => item.id !== memo.id);
        memos.push(memo);
        updateCalendarExtras({ memos });
        // 编辑时顺手勾掉的待办，也算完成（和插件一样，只看原来就有的那几条）
        if (source) reportMemoTodosChanged(memo, source.checklist);
        nav.notify("备忘录已保存");
        back();
    };

    return (
        <ToolSheet title={source ? "编辑备忘录" : "新增备忘录"} onBack={back} onDismiss={close} onAction={save}>
            <Field label="标题">
                <input type="text" className="ui-input" value={title} placeholder="标题" onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="正文（可选）">
                <textarea className="ui-textarea" rows={10} value={body} placeholder="写点什么……" onChange={(event) => setBody(event.target.value)} />
            </Field>
            <Field label="待办横幅颜色">
                <BannerColorPicker value={bannerColor} onChange={setBannerColor} />
            </Field>
            <section className="caltool-section">
                <label className="menu-desc">清单</label>
                <div>
                    <TodoListEditor todos={checklist} onChange={setChecklist} allowDeadline />
                </div>
            </section>
            {source ? (
                <button
                    type="button"
                    className="caltool-danger-button"
                    onClick={() => nav.confirm({
                        title: "删除备忘录？",
                        message: "这页文字和清单会被删除，无法恢复。",
                        confirmText: "删除",
                        onConfirm: () => {
                            deleteCalendarMemo(source.id);
                            nav.go({ kind: "memoList" });
                        },
                    })}
                >
                    <span className="caltool-trash-icon" aria-hidden="true"><i /></span>
                    <span>删除备忘录</span>
                </button>
            ) : null}
        </ToolSheet>
    );
}

// ── 一键清除 ──

function ClearOption({ title, description, icon, danger, className, onClick }: {
    title: string; description: string; icon: string; danger?: boolean; className?: string; onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={`caltool-clear-option${danger ? " is-danger" : ""}${className ? ` ${className}` : ""}`}
            onClick={onClick}
        >
            <span className="caltool-clear-symbol">{icon}</span>
            <span className="caltool-clear-copy">
                <b>{title}</b>
                <small>{description}</small>
            </span>
            <span className="caltool-clear-arrow">›</span>
        </button>
    );
}

function clearEvents(nav: CalendarToolNav, start?: string, end?: string): void {
    const count = clearUserCalendarEvents(start, end);
    nav.notify(count ? `已清除 ${count} 条日程` : "所选范围内没有日程");
}

function clearMemos(nav: CalendarToolNav, start?: string, end?: string): void {
    const count = clearCalendarMemos(start, end);
    nav.notify(count ? `已清除 ${count} 页备忘录` : "所选范围内没有备忘录");
}

function ClearMenu({ nav, close }: { nav: CalendarToolNav; close: () => void }) {
    // 插件：点选项先关掉这层，再弹确认框；确认框取消就回到日历
    const ask = (request: CalendarConfirmRequest) => {
        nav.go(null);
        nav.confirm(request);
    };
    return (
        <ToolSheet title="一键清除" hideAction onBack={close} onDismiss={close}>
            <div className="caltool-clear-list">
                <ClearOption title="按日期清除日程" description="手动选择开始与结束日期" icon="日" onClick={() => nav.go({ kind: "clearRange", target: "events" })} />
                <ClearOption title="按日期清除备忘录" description="按备忘录创建日期筛选" icon="记" onClick={() => nav.go({ kind: "clearRange", target: "memos" })} />
                <ClearOption title="清除全部日程" description="保留所有备忘录" icon="日" danger onClick={() => ask({
                    title: "清除全部日程？",
                    message: "全部用户日程、对应备注和待办都会被删除；备忘录会保留。",
                    confirmText: "全部清除",
                    onConfirm: () => clearEvents(nav),
                })} />
                <ClearOption title="清除全部备忘录" description="保留所有日程" icon="记" danger onClick={() => ask({
                    title: "清除全部备忘录？",
                    message: "全部备忘录正文、清单和截止日期都会被删除；日程会保留。",
                    confirmText: "全部清除",
                    onConfirm: () => clearMemos(nav),
                })} />
                <ClearOption title="清除全部日程和备忘录" description="删除用户日历中的全部内容" icon="全" danger onClick={() => ask({
                    title: "清除全部内容？",
                    message: "全部用户日程、日程详情和备忘录都会被删除，无法恢复。",
                    confirmText: "全部清除",
                    onConfirm: () => {
                        const events = clearUserCalendarEvents();
                        const memos = clearCalendarMemos();
                        nav.notify(events || memos ? `已清除 ${events} 条日程、${memos} 页备忘录` : "日历里本来就是空的");
                    },
                })} />
            </div>
        </ToolSheet>
    );
}

function ClearRange({ target, nav, close }: { target: "events" | "memos"; nav: CalendarToolNav; close: () => void }) {
    const [today] = useState(() => formatIsoDate(new Date()));
    const [start, setStart] = useState(today);
    const [end, setEnd] = useState(today);
    const isEvents = target === "events";
    return (
        <ToolSheet
            title={isEvents ? "按日期清除日程" : "按日期清除备忘录"}
            actionLabel="继续清除"
            onBack={() => nav.go({ kind: "clearMenu" })}
            onDismiss={close}
            onAction={() => {
                if (!start || !end || end < start) {
                    nav.notify("请选择正确的开始和结束日期");
                    return;
                }
                nav.go(null);
                nav.confirm({
                    title: "确认清除？",
                    message: isEvents
                        ? `${start} 至 ${end} 的用户日程、日程备注和待办会被删除。`
                        : `${start} 至 ${end} 创建的备忘录会被删除；按创建日期计算。`,
                    confirmText: "清除",
                    onConfirm: () => (isEvents ? clearEvents(nav, start, end) : clearMemos(nav, start, end)),
                });
            }}
        >
            <div className="caltool-clear-date-grid">
                <Field label="开始日期">
                    <input
                        type="date"
                        className="ui-input"
                        value={start}
                        onChange={(event) => {
                            const next = event.target.value;
                            setStart(next);
                            if (end < next) setEnd(next);
                        }}
                    />
                </Field>
                <Field label="结束日期">
                    <input type="date" className="ui-input" value={end} min={start} onChange={(event) => setEnd(event.target.value)} />
                </Field>
            </div>
            <p className="caltool-clear-hint">
                {isEvents ? "日期范围包含开始和结束当天。" : "备忘录按创建日期筛选；待办的截止日期不会改变备忘录的创建日期。"}
            </p>
        </ToolSheet>
    );
}

export function CalendarConfirmSheet({ request, close }: { request: CalendarConfirmRequest; close: () => void }) {
    return (
        <ToolSheet title={request.title} hideAction onBack={close} onDismiss={close}>
            <p className="caltool-confirm-text">{request.message}</p>
            <div className="caltool-confirm-actions">
                <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={close}>取消</button>
                <button
                    type="button"
                    className="calendar-block-btn caltool-confirm-danger"
                    data-variant="primary"
                    onClick={() => { close(); request.onConfirm(); }}
                >
                    {request.confirmText}
                </button>
            </div>
        </ToolSheet>
    );
}

/** 编辑重复系列里的一次、点保存时问范围（插件 openSeriesSaveChoice），叠在编辑框上面 */
export function CalendarSeriesSaveChoice({ onCurrent, onAll, close }: {
    onCurrent: () => void;
    onAll: () => void;
    close: () => void;
}) {
    return (
        <ToolSheet title="保存重复日程" hideAction onBack={close} onDismiss={close}>
            <p className="caltool-series-save-intro">这条日程属于一个重复系列。请选择本次修改的范围。</p>
            <div className="caltool-series-save-list">
                <ClearOption
                    className="caltool-series-save-option"
                    title="仅修改这一次"
                    description="只保存当前这一天，其他日期保持原样"
                    icon="1"
                    onClick={() => { close(); onCurrent(); }}
                />
                <ClearOption
                    className="caltool-series-save-option"
                    title="修改整个重复日程"
                    description="同步修改这个系列已有及之后生成的日程"
                    icon="全"
                    onClick={() => { close(); onAll(); }}
                />
            </div>
        </ToolSheet>
    );
}

// ── 日历知情角色 ──

function normalizeReaction(value: unknown): TodoReactionMode {
    return value === "immediate" || value === "merge" ? value : "none";
}

function AccessPanel({ characters, nav, close }: { characters: CalendarToolCharacter[]; nav: CalendarToolNav; close: () => void }) {
    const [initial] = useState(() => loadCalendarExtras());
    const sorted = [...characters].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    // 插件的规则：从没配置过时视为全部允许
    const [selected, setSelected] = useState<Set<string>>(() => new Set(
        initial.characterAccess === null ? sorted.map((character) => String(character.id)) : initial.characterAccess,
    ));
    const [reactions, setReactions] = useState<Record<string, TodoReactionMode>>(() => Object.fromEntries(
        Object.entries(initial.todoReactions).map(([id, mode]) => [id, normalizeReaction(mode)]),
    ));

    const save = () => {
        const current = loadCalendarExtras();
        // 回应方式整张表都留着（取消勾选的角色以后再勾上还是原来的选项），
        // 待回应队列只留仍被允许、且选了「合并」的角色
        const todoCompletionQueue = current.todoCompletionQueue.filter((record) => {
            const characterId = String((record as { characterId?: unknown } | null)?.characterId ?? "");
            return selected.has(characterId) && reactions[characterId] === "merge";
        });
        updateCalendarExtras({ characterAccess: Array.from(selected), todoReactions: reactions, todoCompletionQueue });
        nav.notify("角色日历权限与待办回应方式已保存");
        close();
    };

    return (
        <ToolSheet title="日历知情角色" actionLabel="保存角色权限" onBack={close} onDismiss={close} onAction={save}>
            <p className="caltool-access-intro">
                右侧勾选后，角色可以在聊天与剧情中读取日历并接收临近提醒；下方可选择你勾完待办后，角色在私聊中不回应、立即回应，或合并进下一次互动。
            </p>
            {sorted.length === 0 ? (
                <div className="caltool-empty">还没有可选择的角色</div>
            ) : (
                <>
                    <div className="caltool-access-actions">
                        <button type="button" className="caltool-text-button" onClick={() => setSelected(new Set(sorted.map((character) => String(character.id))))}>全选</button>
                        <button type="button" className="caltool-text-button" onClick={() => setSelected(new Set())}>全不选</button>
                    </div>
                    <div className="caltool-access-list">
                        {sorted.map((character) => {
                            const id = String(character.id);
                            const on = selected.has(id);
                            return (
                                <label key={id} className="caltool-access-row">
                                    <span className="caltool-access-avatar">
                                        {character.avatar
                                            // eslint-disable-next-line @next/next/no-img-element
                                            ? <img src={character.avatar} alt="" />
                                            : String(character.name || "角").slice(0, 1)}
                                    </span>
                                    <span className="caltool-access-copy">
                                        <span className="caltool-access-name">{character.name || "未命名角色"}</span>
                                        <select
                                            className="ui-select caltool-reaction-select"
                                            disabled={!on}
                                            value={reactions[id] ?? "none"}
                                            onChange={(event) => {
                                                const mode = normalizeReaction(event.target.value);
                                                setReactions((prev) => ({ ...prev, [id]: mode }));
                                            }}
                                        >
                                            <option value="none">完成待办后：不回应</option>
                                            <option value="immediate">完成待办后：立即回应</option>
                                            <option value="merge">完成待办后：与下次消息合并</option>
                                        </select>
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={(event) => {
                                            const checked = event.target.checked;
                                            setSelected((prev) => {
                                                const next = new Set(prev);
                                                if (checked) next.add(id);
                                                else next.delete(id);
                                                return next;
                                            });
                                        }}
                                    />
                                </label>
                            );
                        })}
                    </div>
                </>
            )}
        </ToolSheet>
    );
}

/** 入口：按 view 渲染对应的界面 */
export function CalendarToolModal({
    view,
    nav,
    characters,
}: {
    view: CalendarToolView;
    nav: CalendarToolNav;
    characters: CalendarToolCharacter[];
}) {
    const close = () => nav.go(null);
    switch (view.kind) {
        case "memoList": return <MemoList nav={nav} close={close} />;
        case "memoView": return <MemoViewer key={view.memoId} memoId={view.memoId} nav={nav} close={close} />;
        case "memoEdit": return <MemoEditor key={view.memoId ?? "new"} memoId={view.memoId} nav={nav} close={close} />;
        case "clearMenu": return <ClearMenu nav={nav} close={close} />;
        case "clearRange": return <ClearRange key={view.target} target={view.target} nav={nav} close={close} />;
        case "access": return <AccessPanel characters={characters} nav={nav} close={close} />;
    }
}
