"use client";

import { Check, ChevronLeft, Trash2 } from "lucide-react";
import { Input } from "../ui/form";
import type { CalendarColorKey } from "@/lib/calendar-types";
import type { CalendarRecurrenceFrequency, CalendarTodo } from "@/lib/calendar-extras";
import { CALENDAR_COLOR_KEYS } from "@/lib/calendar-utils";
import { addDaysIso } from "@/lib/calendar-recurrence";

export type CalendarRepeatFrequency = "none" | CalendarRecurrenceFrequency;

export type CalendarEventDraft = {
  id?: string;
  date: string;
  /** 结束日期（含当天）；留空视为单天。跨多天时保存会按天生成日程。
   *  选了重复时这一格是「重复结束日期」 */
  endDate?: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
  emoji: string;
  colorKey?: CalendarColorKey;
  /** 全天：不占具体时段。起止时间仍然保留着（排序、提醒都要用），只是不展示 */
  allDay?: boolean;
  note?: string;
  todos?: CalendarTodo[];
  frequency?: CalendarRepeatFrequency;
  /** 每周重复：0=周日 … 6=周六 */
  weekdays?: number[];
  /** 每月重复的几号（输入框里的字） */
  monthDay?: string;
  monthLastDay?: boolean;
  /** 重复到永远 */
  forever?: boolean;
  /** 属于哪个重复系列。有值时重复规则锁住不能改，和插件一样 */
  seriesId?: string | null;
  /** 切到重复之前的结束日期，切回「不重复」时还原 */
  normalEndDate?: string;
  /** 打开「最后一天」之前填的几号，关掉时还原 */
  rememberedMonthDay?: string;
};

function newTodo(): CalendarTodo {
    return {
        id: `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        text: "",
        done: false,
        dueDate: "",
        dueTime: "",
        createdAt: new Date().toISOString(),
    };
}

function weekdayOf(iso: string): number {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? new Date().getDay() : date.getDay();
}

function dayOfMonth(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return String(Number.isNaN(date.getTime()) ? 1 : date.getDate());
}

const EMOJI_PRESETS = [
  "📌", "💼", "📚", "💻", "🏃", "🏋️", "🍽️", "☕", "🎬",
  "🎮", "🎵", "🛒", "🛍️", "✈️", "🏥", "📞", "💤", "❤️",
  "🎂", "🎨", "🧹", "🐾",
];

const COLOR_LABELS: Record<CalendarColorKey, string> = {
  blue: "蓝",
  green: "绿",
  amber: "橙",
  rose: "粉",
  violet: "紫",
  teal: "青",
  slate: "灰",
  lilac: "丁香",
};

const REPEAT_OPTIONS: Array<[CalendarRepeatFrequency, string]> = [
  ["none", "不重复"],
  ["daily", "每天"],
  ["weekly", "每周"],
  ["monthly", "每月"],
  ["yearly", "每年"],
];

/** 每周重复日的按钮顺序：周一在前、周日在后 */
const WEEKDAY_CHIPS: Array<[number, string]> = [[1, "一"], [2, "二"], [3, "三"], [4, "四"], [5, "五"], [6, "六"], [0, "日"]];

export function CalendarEventEditModal({
  draft,
  withUserExtras,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft;
  /** 自己的日历才有：全天 / 永远 / 重复 / 备注 / 待办（插件当年也只增强了「我」的日历），
   *  角色日历保持宿主原来的样子 */
  withUserExtras: boolean;
  onChange: (next: CalendarEventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const frequency = draft.frequency ?? "none";
  const repeating = frequency !== "none";
  /** 已经是重复系列里的一次：重复方式、每周几、每月几号、永远都不能再改 */
  const locked = Boolean(draft.seriesId);
  const endDate = draft.endDate || draft.date;
  const weekdays = draft.weekdays ?? [weekdayOf(draft.date)];
  const endDateUnavailable = repeating && draft.forever === true;

  /** 切换重复方式：照插件 syncRecurrenceUi(true) 的规则调整结束日期 */
  const changeFrequency = (next: CalendarRepeatFrequency) => {
    const active = next !== "none";
    let nextEnd = endDate;
    let normalEndDate = draft.normalEndDate;
    if (frequency === "none" && active && !locked) {
      // 第一次切到重复：记下原来的结束日期；结束日期不晚于开始日期就默认往后 30 天
      normalEndDate = endDate || draft.date;
      if (nextEnd <= draft.date) nextEnd = addDaysIso(draft.date, 30);
    } else if (frequency !== "none" && !active && !locked) {
      nextEnd = normalEndDate || draft.date;
    } else if (active && nextEnd < draft.date) {
      nextEnd = addDaysIso(draft.date, 30);
    }
    const nextWeekdays = next === "weekly" && weekdays.length === 0 ? [weekdayOf(draft.date)] : weekdays;
    onChange({ ...draft, frequency: next, endDate: nextEnd, normalEndDate, weekdays: nextWeekdays });
  };

  const changeStartDate = (nextDate: string) => {
    let nextEnd = endDate;
    if (repeating) {
      if (nextEnd < nextDate) nextEnd = addDaysIso(nextDate, 30);
    } else {
      // 结束日期跟随开始日期，除非用户已把结束日期改到更晚
      nextEnd = endDate > nextDate ? endDate : nextDate;
    }
    const nextWeekdays = frequency === "weekly" && weekdays.length === 0 ? [weekdayOf(nextDate)] : weekdays;
    onChange({ ...draft, date: nextDate, endDate: nextEnd, weekdays: nextWeekdays });
  };

  const toggleWeekday = (day: number) => {
    const set = new Set(weekdays);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange({ ...draft, weekdays: Array.from(set) });
  };

  const toggleMonthLastDay = () => {
    if (locked) return;
    if (draft.monthLastDay) {
      onChange({ ...draft, monthLastDay: false, monthDay: draft.rememberedMonthDay || dayOfMonth(draft.date) });
    } else {
      onChange({ ...draft, monthLastDay: true, rememberedMonthDay: draft.monthDay || draft.rememberedMonthDay, monthDay: "" });
    }
  };

  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={onClose}>
      <div className="calendar-edit-modal" data-ui="calendar-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" data-ui="modal-header">
          <button onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="返回">
            <ChevronLeft size={18} />
          </button>
          <span className="modal-header-title">{draft.id ? "编辑日程" : "新增日程"}</span>
          <button onClick={onSave} className="modal-header-btn modal-header-btn-action" aria-label="保存">
            <Check size={18} />
          </button>
        </div>

        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
          {withUserExtras ? (
            <>
              <div className="calendar-dt-row">
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">开始日期</label>
                  <Input
                    type="date"
                    value={draft.date}
                    onChange={e => changeStartDate(e.target.value)}
                  />
                </div>
                <div className={`flex flex-col gap-1${draft.allDay ? " calendar-field-unavailable" : ""}`}>
                  <label className="menu-desc ml-1">开始时间</label>
                  <Input
                    type="time"
                    value={draft.startTime}
                    disabled={draft.allDay === true}
                    onChange={e => onChange({ ...draft, startTime: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="calendar-dt-toggle"
                  data-active={draft.allDay ? "true" : undefined}
                  onClick={() => onChange({ ...draft, allDay: !draft.allDay })}
                >
                  全天
                </button>
              </div>

              <div className="calendar-dt-row">
                <div className={`flex flex-col gap-1${endDateUnavailable ? " calendar-field-unavailable" : ""}`}>
                  <label className="menu-desc ml-1">{repeating ? "重复结束日期" : "结束日期"}</label>
                  <Input
                    type="date"
                    value={endDate}
                    min={draft.date}
                    disabled={endDateUnavailable}
                    onChange={e => onChange({ ...draft, endDate: e.target.value })}
                  />
                </div>
                <div className={`flex flex-col gap-1${draft.allDay ? " calendar-field-unavailable" : ""}`}>
                  <label className="menu-desc ml-1">结束时间</label>
                  <Input
                    type="time"
                    value={draft.endTime}
                    disabled={draft.allDay === true}
                    onChange={e => onChange({ ...draft, endTime: e.target.value })}
                  />
                </div>
                {/* 插件的「永远」：重复时是重复到永远；不重复时它和「全天」是同一个开关 */}
                <button
                  type="button"
                  className="calendar-dt-toggle"
                  data-active={(repeating ? draft.forever : draft.allDay) ? "true" : undefined}
                  disabled={locked}
                  onClick={() => {
                    if (repeating) onChange({ ...draft, forever: !draft.forever });
                    else onChange({ ...draft, allDay: !draft.allDay });
                  }}
                >
                  永远
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">开始日期</label>
                  <Input
                    type="date"
                    value={draft.date}
                    onChange={e => changeStartDate(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">结束日期</label>
                  <Input
                    type="date"
                    value={endDate}
                    min={draft.date}
                    onChange={e => onChange({ ...draft, endDate: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">开始时间</label>
                  <Input
                    type="time"
                    value={draft.startTime}
                    onChange={e => onChange({ ...draft, startTime: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">结束时间</label>
                  <Input
                    type="time"
                    value={draft.endTime}
                    onChange={e => onChange({ ...draft, endTime: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">事项</label>
            <Input
              value={draft.title}
              onChange={e => onChange({ ...draft, title: e.target.value })}
              placeholder="例如：部门周会"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">地点</label>
            <Input
              value={draft.location}
              onChange={e => onChange({ ...draft, location: e.target.value })}
              placeholder="例如：公司会议室 / 家里 / 商场"
            />
          </div>

          {withUserExtras ? (
            <>
              <div className="calendar-plugin-field">
                <label className="menu-desc">重复日程</label>
                <select
                  className="ui-select"
                  value={frequency}
                  disabled={locked}
                  onChange={e => changeFrequency(e.target.value as CalendarRepeatFrequency)}
                >
                  {REPEAT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              {frequency === "weekly" ? (
                <div className="calendar-plugin-field">
                  <label className="menu-desc">每周重复日</label>
                  <div className="calendar-weekday-picker">
                    {WEEKDAY_CHIPS.map(([day, label]) => (
                      <button
                        key={day}
                        type="button"
                        className="calendar-weekday-chip"
                        data-active={weekdays.includes(day) ? "true" : "false"}
                        disabled={locked}
                        onClick={() => toggleWeekday(day)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {frequency === "monthly" ? (
                <div className="calendar-plugin-field">
                  <label className="menu-desc">每月重复日期（1–31号）</label>
                  <div className="calendar-month-rule-row">
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      inputMode="numeric"
                      value={draft.monthLastDay ? "" : (draft.monthDay ?? dayOfMonth(draft.date))}
                      placeholder={draft.monthLastDay ? "无需填写" : ""}
                      disabled={draft.monthLastDay === true || locked}
                      onChange={e => onChange({ ...draft, monthDay: e.target.value })}
                    />
                    <button
                      type="button"
                      className="calendar-month-last-button"
                      data-active={draft.monthLastDay ? "true" : "false"}
                      disabled={locked}
                      onClick={toggleMonthLastDay}
                    >
                      最后一天
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="calendar-plugin-field">
                <label className="menu-desc">备注</label>
                <textarea
                  className="ui-textarea"
                  rows={4}
                  value={draft.note || ""}
                  onChange={e => onChange({ ...draft, note: e.target.value })}
                  placeholder="可选：补充背景、准备事项或其他说明"
                />
              </div>

              <div className="calendar-plugin-field">
                <label className="menu-desc">待办清单</label>
                <div>
                  <div className="calendar-checklist">
                    {(draft.todos || []).map((todo, index) => (
                      <div key={todo.id} className="calendar-check-row">
                        <input
                          type="checkbox"
                          checked={todo.done}
                          onChange={() => {
                            const todos = [...(draft.todos || [])];
                            todos[index] = { ...todo, done: !todo.done };
                            onChange({ ...draft, todos });
                          }}
                        />
                        <Input
                          value={todo.text}
                          placeholder="待办事项"
                          onChange={e => {
                            const todos = [...(draft.todos || [])];
                            todos[index] = { ...todo, text: e.target.value };
                            onChange({ ...draft, todos });
                          }}
                        />
                        <button
                          type="button"
                          className="calendar-icon-button"
                          aria-label="删除待办"
                          onClick={() => onChange({ ...draft, todos: (draft.todos || []).filter((_, i) => i !== index) })}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="calendar-add-row"
                    onClick={() => onChange({ ...draft, todos: [...(draft.todos || []), newTodo()] })}
                  >
                    ＋ 添加待办
                  </button>
                </div>
              </div>
            </>
          ) : null}

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">图标（点选，再点一次取消）</label>
            <div className="calendar-emoji-row">
              {draft.emoji && !EMOJI_PRESETS.includes(draft.emoji) ? (
                <button
                  type="button"
                  className="calendar-emoji-preset"
                  data-active="true"
                  onClick={() => onChange({ ...draft, emoji: "" })}
                  aria-label={`取消 ${draft.emoji}`}
                >
                  {draft.emoji}
                </button>
              ) : null}
              {EMOJI_PRESETS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="calendar-emoji-preset"
                  data-active={draft.emoji === emoji ? "true" : undefined}
                  onClick={() => onChange({ ...draft, emoji: draft.emoji === emoji ? "" : emoji })}
                  aria-label={`使用 ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">颜色</label>
            <div className="calendar-color-picker">
              <button
                type="button"
                className="calendar-color-swatch calendar-color-swatch-auto"
                data-active={!draft.colorKey ? "true" : undefined}
                onClick={() => onChange({ ...draft, colorKey: undefined })}
              >
                自动
              </button>
              {CALENDAR_COLOR_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  className="calendar-color-swatch"
                  data-color={key}
                  data-active={draft.colorKey === key ? "true" : undefined}
                  onClick={() => onChange({ ...draft, colorKey: key })}
                  aria-label={`颜色：${COLOR_LABELS[key]}`}
                  title={COLOR_LABELS[key]}
                />
              ))}
            </div>
          </div>

          {draft.id ? (
            <button type="button" className="ui-btn ui-btn-outline calendar-delete-btn" onClick={onDelete}>
              <Trash2 size={16} />
              删除该事项
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
