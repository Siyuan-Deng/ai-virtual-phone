"use client";

import { Check, ChevronLeft, Trash2 } from "lucide-react";
import { Input } from "../ui/form";
import type { CalendarColorKey } from "@/lib/calendar-types";
import type { CalendarTodo } from "@/lib/calendar-extras";
import { CALENDAR_COLOR_KEYS } from "@/lib/calendar-utils";

export type CalendarEventDraft = {
  id?: string;
  date: string;
  /** 结束日期（含当天）；留空视为单天。跨多天时保存会按天生成日程 */
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

export function CalendarEventEditModal({
  draft,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
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
          <div className="calendar-dt-row">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">开始日期</label>
              <Input
                type="date"
                value={draft.date}
                onChange={e => {
                  const nextDate = e.target.value;
                  const currentEnd = draft.endDate || draft.date;
                  // 结束日期跟随开始日期，除非用户已把结束日期改到更晚
                  onChange({ ...draft, date: nextDate, endDate: currentEnd > nextDate ? currentEnd : nextDate });
                }}
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
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">结束日期</label>
              <Input
                type="date"
                value={draft.endDate || draft.date}
                min={draft.date}
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
            <span className="calendar-dt-toggle-slot" aria-hidden="true" />
          </div>

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

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">备注</label>
            <textarea
              className="ui-input calendar-note-input"
              rows={3}
              value={draft.note || ""}
              onChange={e => onChange({ ...draft, note: e.target.value })}
              placeholder="可选：补充背景、准备事项或其他说明"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">待办清单</label>
            <div className="calendar-checklist">
              {(draft.todos || []).map((todo, index) => (
                <div key={todo.id} className="calendar-check-row">
                  <input
                    type="checkbox"
                    checked={todo.done}
                    aria-label={todo.text || "待办"}
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
