"use client";

// 日历设置里的「经期设置」折叠栏：原来详情页右上角「周期设置」弹窗的内容。
// 和设置页其它项一样改了就存；数字框失焦才存，存进去会夹到合法范围。

import { useMemo, useState } from "react";
import { Check, HeartPulse, Pencil, Trash2, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import {
  deleteMenstrualRecord,
  saveMenstrualConfig,
  updateMenstrualRecord,
  type MenstrualConfig,
  type MenstrualPeriodCareLeadDays,
  type MenstrualRecord,
} from "@/lib/menstrual-storage";

type CharacterOption = { characterId: string; name: string };
type CharacterListKey = "periodKnowCharacterIds" | "periodCareCharacterIds";

/** 只列已有私聊会话的角色，最近聊过的排前面；名字用会话备注 */
function buildCharacterOptions(): CharacterOption[] {
  const characterById = new Map(loadCharacters().map(char => [char.id, char]));
  const latestSessionByCharacter = new Map<string, ReturnType<typeof loadChatSessions>[number]>();
  for (const session of loadChatSessions()) {
    if (session.isGroup || !characterById.has(session.contactId)) continue;
    const existing = latestSessionByCharacter.get(session.contactId);
    if (!existing || session.updatedAt > existing.updatedAt) latestSessionByCharacter.set(session.contactId, session);
  }
  return Array.from(latestSessionByCharacter.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(session => ({
      characterId: session.contactId,
      name: session.alias || characterById.get(session.contactId)!.name,
    }));
}

export function MenstrualSettingsSection({
  config,
  records,
  onConfigChange,
  onRecordsChange,
  onNotice,
}: {
  config: MenstrualConfig;
  records: MenstrualRecord[];
  onConfigChange: (next: MenstrualConfig) => void;
  onRecordsChange: (next: MenstrualRecord[]) => void;
  onNotice?: (text: string) => void;
}) {
  const options = useMemo(() => buildCharacterOptions(), []);
  const [editingRecord, setEditingRecord] = useState<{ id: string; startDate: string; endDate: string } | null>(null);

  const save = (patch: Partial<MenstrualConfig>) => {
    onConfigChange(saveMenstrualConfig({ ...config, ...patch }));
    window.dispatchEvent(new CustomEvent("menstrual-period-care-updated"));
  };

  // 空着或不是数字就当没改；范围外的由 saveMenstrualConfig 夹回去，key 跟着值变好让框里显示夹过的数
  const numberInput = (key: "cycleLength" | "periodLength" | "periodCareLeadDays", min: number, max: number, className = "ui-input") => (
    <input
      key={`${key}:${config[key]}`}
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      defaultValue={config[key]}
      onBlur={e => {
        const value = Math.round(Number(e.target.value));
        if (!e.target.value.trim() || !Number.isFinite(value)) {
          e.target.value = String(config[key]);
          return;
        }
        const clamped = Math.min(max, Math.max(min, value));
        if (clamped !== config[key]) save({ [key]: key === "periodCareLeadDays" ? clamped as MenstrualPeriodCareLeadDays : clamped });
        else e.target.value = String(clamped);
      }}
    />
  );

  const toggleCharacter = (key: CharacterListKey, characterId: string) => {
    const current = config[key];
    save({ [key]: current.includes(characterId) ? current.filter(id => id !== characterId) : [...current, characterId] });
  };

  // 点列名：这一列全选；已经全选了就全部取消
  const toggleColumn = (key: CharacterListKey) => {
    const ids = options.map(option => option.characterId);
    const current = config[key];
    const allOn = ids.length > 0 && ids.every(id => current.includes(id));
    save({ [key]: allOn ? current.filter(id => !ids.includes(id)) : Array.from(new Set([...current, ...ids])) });
  };

  const saveRecordEdit = () => {
    if (!editingRecord) return;
    const result = updateMenstrualRecord(editingRecord.id, editingRecord.startDate, editingRecord.endDate);
    if (result.error) {
      onNotice?.(result.error);
      return;
    }
    onRecordsChange(result.records);
    setEditingRecord(null);
    onNotice?.("经期记录已更新");
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="menu-desc ml-1">周期长度</label>
          {numberInput("cycleLength", 21, 60)}
        </div>
        <div className="flex flex-col gap-1">
          <label className="menu-desc ml-1">经期天数</label>
          {numberInput("periodLength", 2, 10)}
        </div>
      </div>

      <div className="calendar-menstrual-care-panel">
        <button
          type="button"
          className="calendar-menstrual-care-toggle"
          data-active={config.periodCareEnabled ? "true" : undefined}
          onClick={() => save({ periodCareEnabled: !config.periodCareEnabled })}
        >
          <span className="calendar-menstrual-care-toggle-icon">
            <HeartPulse size={16} />
          </span>
          <span className="calendar-menstrual-care-toggle-copy">
            <strong>让TA关心我的经期</strong>
            <span>只显示已有聊天会话的角色</span>
          </span>
          <span className="calendar-menstrual-pill-switch" aria-hidden="true">
            <span className="calendar-menstrual-pill-switch-thumb" />
          </span>
        </button>

        {config.periodCareEnabled ? (
          <div className="calendar-menstrual-care-body">
            <label className="calendar-period-care-lead-inline">
              <span>提前多久关心</span>
              {numberInput("periodCareLeadDays", 1, 3, "ui-input calendar-period-care-lead-input")}
              <span>天</span>
            </label>

            <div className="calendar-menstrual-care-section">
              <div className="calendar-period-care-picker-head">
                <span className="menu-desc ml-1">选择角色</span>
                {options.length > 0 ? (
                  <>
                    <button type="button" className="calendar-period-care-column" onClick={() => toggleColumn("periodKnowCharacterIds")}>知道</button>
                    <button type="button" className="calendar-period-care-column" onClick={() => toggleColumn("periodCareCharacterIds")}>关心</button>
                  </>
                ) : null}
              </div>
              {options.length > 0 ? (
                <div className="calendar-period-care-list">
                  {options.map(option => {
                    const knows = config.periodKnowCharacterIds.includes(option.characterId);
                    const cares = config.periodCareCharacterIds.includes(option.characterId);
                    return (
                      <div key={option.characterId} className="calendar-period-care-row">
                        <span className="calendar-period-care-row-name">{option.name}</span>
                        <button
                          type="button"
                          className="calendar-period-care-check"
                          data-active={knows ? "true" : undefined}
                          aria-pressed={knows}
                          aria-label={`${option.name}知道我的经期状况`}
                          onClick={() => toggleCharacter("periodKnowCharacterIds", option.characterId)}
                        >
                          <span>{knows ? <Check size={12} strokeWidth={3} /> : null}</span>
                        </button>
                        <button
                          type="button"
                          className="calendar-period-care-check"
                          data-active={cares ? "true" : undefined}
                          aria-pressed={cares}
                          aria-label={`${option.name}主动关心我的经期`}
                          onClick={() => toggleCharacter("periodCareCharacterIds", option.characterId)}
                        >
                          <span>{cares ? <Check size={12} strokeWidth={3} /> : null}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="calendar-menstrual-empty">已有聊天会话的角色会显示在这里。</div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {records.length > 0 ? (
        <div className="calendar-menstrual-modal-history">
          <label className="menu-desc ml-1">经期记录</label>
          <div className="calendar-menstrual-modal-list">
            {records.slice(0, 4).map(record => (editingRecord?.id === record.id ? (
              <div key={record.id} className="calendar-menstrual-modal-item">
                <div className="calendar-menstrual-record-edit">
                  <label>
                    <span>开始</span>
                    <input
                      type="date"
                      value={editingRecord.startDate}
                      onChange={e => setEditingRecord(prev => (prev ? { ...prev, startDate: e.target.value } : prev))}
                    />
                  </label>
                  <label>
                    <span>结束</span>
                    <input
                      type="date"
                      value={editingRecord.endDate}
                      onChange={e => setEditingRecord(prev => (prev ? { ...prev, endDate: e.target.value } : prev))}
                    />
                  </label>
                </div>
                <button type="button" className="calendar-menstrual-modal-icon" onClick={() => setEditingRecord(null)} aria-label="取消编辑">
                  <X size={14} />
                </button>
                <button type="button" className="calendar-menstrual-modal-icon" data-variant="primary" onClick={saveRecordEdit} aria-label="保存记录">
                  <Check size={14} />
                </button>
              </div>
            ) : (
              <div key={record.id} className="calendar-menstrual-modal-item">
                <div>
                  <span>{record.startDate} 至 {record.endDate}</span>
                </div>
                <button
                  type="button"
                  className="calendar-menstrual-modal-icon"
                  onClick={() => setEditingRecord({ id: record.id, startDate: record.startDate, endDate: record.endDate })}
                  aria-label="编辑记录"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="calendar-menstrual-modal-delete"
                  onClick={() => {
                    onRecordsChange(deleteMenstrualRecord(record.id));
                    onNotice?.("经期记录已删除");
                  }}
                  aria-label="删除记录"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )))}
          </div>
        </div>
      ) : (
        <div className="calendar-menstrual-empty">还没有完成的经期记录。先在日程页点“经期来了”，结束时再点“经期走了”。</div>
      )}
    </>
  );
}
