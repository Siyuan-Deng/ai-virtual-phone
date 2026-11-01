"use client";

// 世界卷宗 tab 条 + 卷宗编辑 sheet + 新建卷宗 sheet
// 视觉隐喻：每个世界 = 一份牛皮纸案卷，激活的 tab 是「翻开的那份」，
// 与画布纸面连成一体；编辑模式下拍立得可以拖到 tab 上「归档」进别的世界。
// 长按一个 tab 可以左右拖动换顺序（和设置页卡片的长按拖动是同一套）。

import { useState } from "react";
import type { CharacterWorldGroup } from "@/lib/character-world-storage";
import { DEFAULT_CHARACTER_WORLD_ID } from "@/lib/character-world-storage";
import { useLongPressReorder } from "@/components/settings/use-long-press-reorder";

const REORDER_GROUP = "world-tabs";

export function WorldTabStrip({
  groups,
  currentWorldId,
  memberCounts,
  dropTargetWorldId,
  onSelect,
  onOpenEditor,
  onOpenCreate,
  onReorder,
}: {
  groups: CharacterWorldGroup[];
  currentWorldId: string;
  memberCounts: Map<string, number>;
  /** 拖拽拍立得悬停中的 tab（高亮为可归档状态） */
  dropTargetWorldId: string | null;
  onSelect: (worldId: string) => void;
  /** 再次点按当前激活的 tab → 打开卷宗编辑 */
  onOpenEditor: () => void;
  onOpenCreate: () => void;
  /** 长按拖完松手：新的顺序 */
  onReorder: (orderedIds: string[]) => void;
}) {
  const reorder = useLongPressReorder((_group, orderedIds) => onReorder(orderedIds));
  const ids = groups.map(group => group.id);
  return (
    <div className="wt-strip" role="tablist" aria-label="世界卷宗">
      {reorder.order(REORDER_GROUP, groups).map(group => {
        const active = group.id === currentWorldId;
        const dropping = group.id === dropTargetWorldId;
        return (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-world-tab-id={group.id}
            {...reorder.itemProps(REORDER_GROUP, group.id, ids)}
            className={`wt-tab ${active ? "wt-tab-active" : ""} ${dropping ? "wt-tab-drop" : ""}`}
            onClick={() => (active ? onOpenEditor() : onSelect(group.id))}
            title={active ? "点按编辑这份卷宗" : `打开「${group.name}」`}
          >
            <span className="wt-tab-name">{group.name}</span>
            <span className="wt-tab-count">{memberCounts.get(group.id) ?? 0}</span>
            {active && <span className="wt-tab-edit" aria-hidden>✎</span>}
          </button>
        );
      })}
      <button type="button" className="wt-tab wt-tab-new" onClick={onOpenCreate} aria-label="新建世界">
        ＋
      </button>
    </div>
  );
}

/** 卷宗编辑：改名 / 世界观描述 / 删除（角色并回默认世界；默认世界能改名、不能删） */
export function WorldCaseSheet({
  group,
  defaultWorldName,
  onRename,
  onUpdateDescription,
  onDelete,
  onClose,
}: {
  group: CharacterWorldGroup;
  /** 默认世界现在叫什么（改过名就显示新名字） */
  defaultWorldName: string;
  onRename: (name: string) => void;
  onUpdateDescription: (description: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDefault = group.id === DEFAULT_CHARACTER_WORLD_ID;

  const save = () => {
    if (name.trim() && name.trim() !== group.name) onRename(name.trim());
    if (description.trim() !== group.description) onUpdateDescription(description.trim());
    onClose();
  };

  return (
    <div className="wt-modal" onClick={save}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">CASE FILE</div>
        <label className="wt-paper-label">卷宗名称</label>
        <input
          className="wt-paper-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="世界名称"
        />
        {isDefault && <p className="wt-paper-hint">这是默认世界，可以改名但不能删除，删除其他世界时角色会回到这里。</p>}
        <label className="wt-paper-label">世界观描述（会注入该世界所有角色的上下文）</label>
        <textarea
          className="wt-paper-textarea"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="写下这个世界的背景、时代、阵营边界、共同常识或角色互动前提…"
        />
        <div className="wt-paper-actions">
          {!isDefault && (
            confirmDelete ? (
              <>
                <span className="wt-paper-confirm">确认删除？角色将并回「{defaultWorldName}」</span>
                <button type="button" className="wt-btn wt-btn-danger" onClick={onDelete}>删除</button>
                <button type="button" className="wt-btn" onClick={() => setConfirmDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className="wt-btn wt-btn-danger" onClick={() => setConfirmDelete(true)}>删除卷宗</button>
            )
          )}
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" onClick={save}>完成</button>
        </div>
      </div>
    </div>
  );
}

/** 新建卷宗 */
export function NewWorldSheet({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim());
  };
  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">NEW CASE</div>
        <label className="wt-paper-label">新卷宗名称</label>
        <input
          className="wt-paper-input"
          value={name}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="例如：现代都市 / 仙侠界"
        />
        <div className="wt-paper-actions">
          <button type="button" className="wt-btn" onClick={onClose}>取消</button>
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" disabled={!name.trim()} onClick={submit}>建立</button>
        </div>
      </div>
    </div>
  );
}
