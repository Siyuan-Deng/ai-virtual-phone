"use client";

// 计次、分步待办用到的几样小东西。横幅和备忘录查看页里是一个方框（外圈是进度，里面是还剩几次），
// 大小和普通待办的勾选框一样，做满变成勾；编辑框里写 1/3。

import { useEffect, useRef } from "react";
import {
    CALENDAR_TODO_STEPS_MAX,
    CALENDAR_TODO_TARGET_MAX,
    calendarTodoProgress,
    newCalendarTodo,
    newCalendarTodoStep,
    type CalendarTodo,
    type CalendarTodoChange,
    type CalendarTodoKind,
} from "@/lib/calendar-extras";

const LONG_PRESS_MS = 500;

export function isProgressTodo(todo: CalendarTodo): boolean {
    return Boolean(todo.target) || Array.isArray(todo.steps);
}

/** 外圈：顺时针走的进度 */
function ProgressFrame({ width, height, ratio }: { width: number; height: number; ratio: number }) {
    const rect = { x: 1, y: 1, width: width - 2, height: height - 2, rx: 4.5 };
    return (
        <svg className="calendar-todo-frame" viewBox={`0 0 ${width} ${height}`} fill="none" aria-hidden="true">
            <rect {...rect} className="calendar-todo-frame-track" strokeWidth={1.5} />
            <rect {...rect} className="calendar-todo-frame-bar" strokeWidth={2} pathLength={100} strokeDasharray={`${ratio * 100} 100`} />
        </svg>
    );
}

/** 做满是普通待办那个勾，没做满是方框 + 还剩几次 */
export function TodoSquare({ todo }: { todo: CalendarTodo }) {
    const progress = calendarTodoProgress(todo);
    if (!progress) return null;
    if (todo.done) return <input type="checkbox" className="calendar-todo-checked" checked readOnly tabIndex={-1} aria-hidden="true" />;
    return (
        <span className="calendar-todo-square">
            <ProgressFrame width={22} height={22} ratio={progress.total ? progress.done / progress.total : 0} />
            <b>{progress.total - progress.done}</b>
        </span>
    );
}

/** 点一下加一次，长按减一次 */
export function TodoCountButton({ todo, onChange }: { todo: CalendarTodo; onChange: (change: CalendarTodoChange) => void }) {
    const timerRef = useRef(0);
    const heldRef = useRef(false);
    const count = todo.count ?? 0;
    const cancel = () => window.clearTimeout(timerRef.current);
    useEffect(() => cancel, []);
    return (
        <button
            type="button"
            className="calendar-todo-count"
            aria-label={`${todo.text}，还剩 ${(todo.target ?? 0) - count} 次，点一下加一次，长按减一次`}
            onPointerDown={() => {
                heldRef.current = false;
                cancel();
                timerRef.current = window.setTimeout(() => {
                    heldRef.current = true;
                    if (count > 0) onChange({ count: count - 1 });
                }, LONG_PRESS_MS);
            }}
            onPointerUp={cancel}
            onPointerLeave={cancel}
            onPointerCancel={cancel}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
                event.stopPropagation();
                if (heldRef.current) {
                    heldRef.current = false;
                    return;
                }
                if (!todo.done) onChange({ count: count + 1 });
            }}
        >
            <TodoSquare todo={todo} />
        </button>
    );
}

export function TodoStepChecks({ todo, onChange, className }: { todo: CalendarTodo; onChange: (change: CalendarTodoChange) => void; className?: string }) {
    return (
        <div className={`calendar-todo-steps ${className ?? ""}`} onClick={(event) => event.stopPropagation()}>
            {(todo.steps ?? []).map((step) => (
                <label key={step.id} className={step.done ? "is-done" : undefined}>
                    <input type="checkbox" checked={step.done} aria-label={step.text} onChange={(event) => onChange({ stepId: step.id, done: event.target.checked })} />
                    <span>{step.text}</span>
                </label>
            ))}
        </div>
    );
}

/** 编辑框里占勾选框那一格：和横幅同一个方框，写已完成 / 总数；数字长了才加宽 */
export function TodoLead({ todo, color }: { todo: CalendarTodo; color: string }) {
    const progress = todo.target
        ? { done: todo.count ?? 0, total: todo.target }
        : { done: (todo.steps ?? []).filter((step) => step.done).length, total: todo.steps?.length ?? 0 };
    const text = `${progress.done}/${progress.total}`;
    const width = text.length <= 3 ? 22 : text.length === 4 ? 28 : 34;
    return (
        <span className="calendar-todo-lead" data-color={color} style={{ width }}>
            <ProgressFrame width={width} height={22} ratio={progress.total ? progress.done / progress.total : 0} />
            <b>{text}</b>
        </span>
    );
}

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (value: number) => void }) {
    return (
        <span className="calendar-todo-stepper">
            <button type="button" aria-label={`${label}减一`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
            <b>{value}</b>
            <button type="button" aria-label={`${label}加一`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
        </span>
    );
}

/** 编辑框里计次、分步多出来的那部分 */
export function TodoProgressFields({ todo, onChange, inputClassName }: { todo: CalendarTodo; onChange: (next: CalendarTodo) => void; inputClassName?: string }) {
    if (todo.target) {
        const count = todo.count ?? 0;
        return (
            <div className="calendar-todo-fields">
                <span>一共 <Stepper value={todo.target} min={2} max={CALENDAR_TODO_TARGET_MAX} label="总次数" onChange={(target) => onChange({ ...todo, target, count: Math.min(count, target) })} /> 次</span>
                <span>已做 <Stepper value={count} min={0} max={todo.target} label="已做次数" onChange={(next) => onChange({ ...todo, count: next })} /></span>
            </div>
        );
    }
    const steps = todo.steps ?? [];
    return (
        <div className="calendar-todo-step-edit">
            {steps.map((step, index) => (
                <div key={step.id} className="calendar-todo-step-row">
                    <input
                        type="checkbox"
                        checked={step.done}
                        aria-label={step.text || `第 ${index + 1} 步`}
                        onChange={(event) => onChange({ ...todo, steps: steps.map((item) => (item.id === step.id ? { ...item, done: event.target.checked } : item)) })}
                    />
                    <input
                        type="text"
                        className={inputClassName ?? "ui-input"}
                        value={step.text}
                        placeholder="步骤"
                        onChange={(event) => onChange({ ...todo, steps: steps.map((item) => (item.id === step.id ? { ...item, text: event.target.value } : item)) })}
                    />
                    <button type="button" aria-label="删除这一步" onClick={() => onChange({ ...todo, steps: steps.filter((item) => item.id !== step.id) })}>×</button>
                </div>
            ))}
            {steps.length < CALENDAR_TODO_STEPS_MAX ? (
                <button type="button" className="calendar-add-row" onClick={() => onChange({ ...todo, steps: [...steps, newCalendarTodoStep()] })}>＋ 添加步骤</button>
            ) : null}
        </div>
    );
}

const ADD_BUTTONS: Array<{ kind: CalendarTodoKind; label: string }> = [
    { kind: "check", label: "＋ 添加普通待办" },
    { kind: "count", label: "＋ 添加计次待办" },
    { kind: "steps", label: "＋ 添加分步待办" },
    { kind: "bullet", label: "＋ 添加列表要点" },
];

export function TodoAddButtons({ className, onAdd }: { className: string; onAdd: (todo: CalendarTodo) => void }) {
    return (
        <>
            {ADD_BUTTONS.map((button) => (
                <button key={button.kind} type="button" className={className} onClick={() => onAdd(newCalendarTodo(button.kind))}>{button.label}</button>
            ))}
        </>
    );
}
