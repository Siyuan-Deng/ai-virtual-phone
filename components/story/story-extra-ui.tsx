"use client";

// 剧情侧栏（选角色）和番外用到的几块界面，版式照用户选定的方案 C。

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Save, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/primitives";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadPresets, loadRegexes, loadWorldBooks } from "@/lib/settings-storage";
import type { StoryExtraBindings, StoryExtraConfig, StoryExtraTemplate, StorySession } from "@/lib/story-storage";
import {
  STORY_EXTRA_PERSONS,
  buildStoryExtraInstruction,
  deleteStoryExtraPreset,
  loadStoryExtraPresets,
  saveStoryExtraPreset,
  type StoryExtraPreset,
} from "@/lib/story-extra";

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function plainPreview(value: string | undefined): string {
  return (value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export type StoryCharacterEntry = {
  character: Character;
  /** 正篇会话；还没读过就是 undefined */
  session?: StorySession;
};

function hasRead(entry: StoryCharacterEntry): boolean {
  return Boolean(entry.session?.lastMessageId);
}

/** 读过的按最后一次活动倒序排在前面，没读过的按原顺序跟在后面 */
export function orderStoryCharacters(characters: Character[], sessions: StorySession[]): StoryCharacterEntry[] {
  const mainByCharacter = new Map(
    sessions.filter((session) => session.kind !== "extra").map((session) => [session.characterId, session]),
  );
  const entries = characters.map((character) => ({ character, session: mainByCharacter.get(character.id) }));
  const read = entries
    .filter(hasRead)
    .sort((a, b) => String(b.session?.updatedAt || "").localeCompare(String(a.session?.updatedAt || "")));
  return [...read, ...entries.filter((entry) => !hasRead(entry))];
}

// ── 正在阅读 ──

export function StoryNowCard({
  character,
  mainSession,
  mode,
  onSwitchMode,
}: {
  character: Character;
  mainSession?: StorySession | null;
  mode: "main" | "extra";
  onSwitchMode: (mode: "main" | "extra") => void;
}) {
  const lastRead = mainSession?.lastMessageId ? `上次读到 ${shortDate(mainSession.updatedAt)}` : "还没开始";
  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">正在阅读</div>
      <div className="story-now-card">
        <Avatar src={character.avatar || undefined} name={character.name} size="lg" />
        <div className="story-now-copy">
          <div className="story-now-title">《{character.name}》</div>
          <div className="story-now-sub">{mode === "extra" ? "番外" : `正篇 · ${lastRead}`}</div>
        </div>
        <div className="story-mode-switch" role="tablist" aria-label="正篇或番外">
          {(["main", "extra"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              data-active={mode === value ? "true" : undefined}
              onClick={() => onSwitchMode(value)}
            >
              {value === "main" ? "正篇" : "番外"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 最近 + 全部角色 ──

export function StoryRecentSection({
  entries,
  activeId,
  onPick,
  onOpenAll,
}: {
  entries: StoryCharacterEntry[];
  activeId: string;
  onPick: (characterId: string) => void;
  onOpenAll: () => void;
}) {
  const recent = entries.filter((entry) => entry.character.id !== activeId).slice(0, 5);
  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">最近</div>
      {recent.length > 0 ? (
        <div className="story-recent-grid">
          {recent.map(({ character }) => (
            <button key={character.id} type="button" className="story-recent-item" onClick={() => onPick(character.id)}>
              <Avatar src={character.avatar || undefined} name={character.name} size="md" />
              <span>{character.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="story-all-btn" onClick={onOpenAll}>
        <span>全部角色</span>
        <span>{entries.length} ›</span>
      </button>
    </div>
  );
}

function SheetHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="story-sheet-head">
      <span className="story-sheet-title">{title}</span>
      <button type="button" className="story-top-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

export function StoryCharacterSheet({
  entries,
  activeId,
  onPick,
  onClose,
}: {
  entries: StoryCharacterEntry[];
  activeId: string;
  onPick: (characterId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const shown = keyword ? entries.filter(({ character }) => character.name.toLowerCase().includes(keyword)) : entries;
  const groups = [
    { label: "最近读过", items: shown.filter(hasRead) },
    { label: "还没开始", items: shown.filter((entry) => !hasRead(entry)) },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="story-drawer-sheet">
      <SheetHead title="全部角色" onClose={onClose} />
      <div className="story-sheet-body">
        <div className="story-search">
          <SearchIcon />
          <input value={query} placeholder="搜索角色" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="story-sheet-scroll">
          {groups.length === 0 ? <div className="story-sheet-empty">没有叫这个名字的角色</div> : null}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="story-sheet-index">{group.label}</div>
              {group.items.map(({ character, session }) => (
                <button
                  key={character.id}
                  type="button"
                  className="story-character-row"
                  data-active={character.id === activeId ? "true" : undefined}
                  onClick={() => onPick(character.id)}
                >
                  <Avatar src={character.avatar || undefined} name={character.name} size="sm" />
                  <span className="story-character-row-main">
                    <span className="story-character-row-name">{character.name}</span>
                    <span className="story-character-row-line">{plainPreview(session?.lastMessagePreview) || "还没有开始"}</span>
                  </span>
                  <span className="story-character-row-date">{hasRead({ character, session }) ? shortDate(session?.updatedAt) : ""}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 番外绑定 ──

export type StoryBindingKind = "api" | "preset" | "worldBooks" | "regexes";

const BINDING_KINDS: StoryBindingKind[] = ["api", "preset", "worldBooks", "regexes"];
const BINDING_LABELS: Record<StoryBindingKind, string> = {
  api: "API",
  preset: "预设",
  worldBooks: "世界书",
  regexes: "正则",
};

type Option = { id: string; name: string };

function bindingOptions(kind: StoryBindingKind): Option[] {
  if (kind === "api") {
    return loadApiConfigs().map((config) => ({ id: config.id, name: config.name || `${config.provider} · ${config.defaultModel}` }));
  }
  if (kind === "preset") return loadPresets().map((preset) => ({ id: preset.id, name: preset.name }));
  if (kind === "worldBooks") return loadWorldBooks().map((book) => ({ id: book.id, name: book.name }));
  return loadRegexes().map((regex) => ({ id: regex.id, name: regex.name }));
}

function selectedBindingIds(kind: StoryBindingKind, bindings: StoryExtraBindings): string[] | undefined {
  if (kind === "api") return bindings.apiConfigId ? [bindings.apiConfigId] : undefined;
  if (kind === "preset") return bindings.presetId ? [bindings.presetId] : undefined;
  return kind === "worldBooks" ? bindings.worldBookIds : bindings.regexIds;
}

function bindingValue(kind: StoryBindingKind, bindings: StoryExtraBindings): { text: string; follow: boolean } {
  const ids = selectedBindingIds(kind, bindings);
  if (!ids) return { text: "跟随剧情", follow: true };
  const options = bindingOptions(kind);
  const names = ids.map((id) => options.find((option) => option.id === id)?.name).filter(Boolean);
  if (kind === "api" || kind === "preset") {
    // 绑的那个被删掉了：生成时会退回剧情的绑定，这里也照实显示
    return names.length > 0 ? { text: names[0] as string, follow: false } : { text: "跟随剧情", follow: true };
  }
  return { text: names.length > 0 ? names.join("、") : "不使用", follow: false };
}

export function StoryExtraBindingsSection({
  bindings,
  onOpen,
}: {
  bindings: StoryExtraBindings;
  onOpen: (kind: StoryBindingKind) => void;
}) {
  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">番外绑定</div>
      {BINDING_KINDS.map((kind) => {
        const value = bindingValue(kind, bindings);
        return (
          <button key={kind} type="button" className="story-bind-row" onClick={() => onOpen(kind)}>
            <span>{BINDING_LABELS[kind]}</span>
            <span data-follow={value.follow ? "true" : undefined}>{value.text}</span>
            <span aria-hidden="true">›</span>
          </button>
        );
      })}
      <div className="story-drawer-note">没单独选的项跟随剧情的绑定。</div>
    </div>
  );
}

export function StoryBindingPicker({
  kind,
  bindings,
  onChange,
  onClose,
}: {
  kind: StoryBindingKind;
  bindings: StoryExtraBindings;
  onChange: (next: StoryExtraBindings) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => bindingOptions(kind), [kind]);
  const multi = kind === "worldBooks" || kind === "regexes";
  const selected = selectedBindingIds(kind, bindings);
  const label = BINDING_LABELS[kind];

  const setIds = (next: string[] | undefined) => {
    if (kind === "api") onChange({ ...bindings, apiConfigId: next?.[0] });
    else if (kind === "preset") onChange({ ...bindings, presetId: next?.[0] });
    else if (kind === "worldBooks") onChange({ ...bindings, worldBookIds: next });
    else onChange({ ...bindings, regexIds: next });
  };

  return (
    <div className="story-drawer-sheet">
      <SheetHead title={`番外${label}`} onClose={onClose} />
      <div className="story-sheet-body">
        <div className="story-sheet-scroll">
          <button
            type="button"
            className="story-option-row"
            data-active={selected === undefined ? "true" : undefined}
            onClick={() => { setIds(undefined); if (!multi) onClose(); }}
          >
            <span>跟随剧情</span>
            {selected === undefined ? <Check size={15} /> : null}
          </button>
          {options.length === 0 ? <div className="story-sheet-empty">还没有可选的{label}</div> : null}
          {options.map((option) => {
            const on = Boolean(selected?.includes(option.id));
            return (
              <button
                key={option.id}
                type="button"
                className="story-option-row"
                data-active={on ? "true" : undefined}
                onClick={() => {
                  if (!multi) {
                    setIds([option.id]);
                    onClose();
                    return;
                  }
                  const current = selected ?? [];
                  setIds(on ? current.filter((id) => id !== option.id) : [...current, option.id]);
                }}
              >
                <span>{option.name}</span>
                {on ? <Check size={15} /> : null}
              </button>
            );
          })}
          {multi ? (
            <div className="story-drawer-note">勾了几个就只用这几个；一个都不勾就是不用{label}。</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── 番外方案：模板 + 绑定成套保存、切换 ──

/** 大概内容每篇都不一样、「带上之前的番外」每次自己选，这两项不进方案；切方案时保留现在的 */
function presetPart(config: StoryExtraConfig): StoryExtraConfig {
  return { ...config, template: { ...config.template, content: "", includePrevious: false } };
}

function presetKey(config: StoryExtraConfig): string {
  return JSON.stringify(presetPart(config));
}

export function StoryExtraPresetBar({
  config,
  onLoad,
}: {
  config: StoryExtraConfig;
  onLoad: (config: StoryExtraConfig) => void;
}) {
  const [presets, setPresets] = useState<StoryExtraPreset[]>(() => loadStoryExtraPresets());
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 下拉框只在现在的设置和某套方案一致时显示它；改过就回到占位，方便重新选回去
  const currentKey = presetKey(config);
  const selectedId = presets.find((preset) => presetKey(preset.config) === currentKey)?.id ?? "";

  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">番外方案</div>
      <div className="story-preset-row">
        <select
          className="story-preset-select"
          value={selectedId}
          onChange={(event) => {
            setConfirmingDelete(false);
            const preset = presets.find((item) => item.id === event.target.value);
            if (!preset) return;
            const { content, includePrevious } = config.template;
            onLoad({ ...preset.config, template: { ...preset.config.template, content, includePrevious } });
          }}
        >
          <option value="">{presets.length > 0 ? "选一套保存过的方案" : "还没有保存过方案"}</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        {selectedId ? (
          <button
            type="button"
            className={`story-preset-btn${confirmingDelete ? " is-danger" : ""}`}
            aria-label={confirmingDelete ? "确认删除这套方案" : "删除这套方案"}
            onClick={() => {
              if (!confirmingDelete) { setConfirmingDelete(true); return; }
              deleteStoryExtraPreset(selectedId);
              setConfirmingDelete(false);
              setPresets(loadStoryExtraPresets());
            }}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="story-preset-btn"
          aria-label="把现在的模板和绑定存成一套"
          onClick={() => {
            setName(presets.find((item) => item.id === selectedId)?.name ?? "");
            setNaming(true);
            setConfirmingDelete(false);
          }}
        >
          <Save size={15} />
        </button>
      </div>
      {naming ? (
        <div className="story-preset-row">
          <input
            className="story-preset-input"
            value={name}
            maxLength={30}
            placeholder="给这套方案起个名字"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="story-preset-btn"
            aria-label="确认保存"
            onClick={() => {
              saveStoryExtraPreset(name || "未命名", presetPart(config));
              setPresets(loadStoryExtraPresets());
              setNaming(false);
            }}
          >
            <Check size={15} />
          </button>
          <button type="button" className="story-preset-btn" aria-label="取消" onClick={() => setNaming(false)}>
            <X size={15} />
          </button>
        </div>
      ) : null}
      <div className="story-drawer-note">文风、字数、人称、其它要求和上面的绑定存成一套，同名会覆盖。</div>
    </div>
  );
}

// ── 番外指令卡：模板发出去的那条，默认折叠 ──

export function StoryExtraOrderCard({ order, rawContent }: { order: StoryExtraTemplate; rawContent: string }) {
  const [open, setOpen] = useState(false);
  // 指令被手动编辑过就不再拿模板字段概括它
  const edited = rawContent !== buildStoryExtraInstruction(order);
  const words = order.words.trim().replace(/字(以上)?$/, "").trim();
  return (
    <div className="story-extra-order">
      <button type="button" className="story-extra-order-head" onClick={() => setOpen((value) => !value)}>
        <span>番外指令</span>
        <span>{open ? "收起" : "展开"}</span>
      </button>
      <div className={`story-extra-order-text${open ? " is-open" : ""}`}>
        {open || edited || !order.content.trim() ? rawContent : order.content}
      </div>
      {edited ? null : (
        <div className="story-extra-chips">
          {words ? <span>{words} 字以上</span> : null}
          {order.style.trim() ? <span>{order.style.trim()}</span> : null}
          <span>{order.person}</span>
          {order.includePrevious ? <span>带上之前的番外</span> : null}
        </div>
      )}
    </div>
  );
}

// ── 番外模板 ──

export function StoryExtraTemplateSheet({
  initial,
  top,
  sending,
  onSave,
  onSend,
  onClose,
}: {
  initial: StoryExtraTemplate;
  /** 面板从标题栏下沿开始 */
  top: number;
  sending: boolean;
  /** 面板关掉（包括整页关掉）时，把填的内容存回番外窗口 */
  onSave: (template: StoryExtraTemplate) => void;
  onSend: (template: StoryExtraTemplate) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<StoryExtraTemplate>(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  useEffect(() => () => onSaveRef.current(draftRef.current), []);

  const set = (patch: Partial<StoryExtraTemplate>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="story-template-sheet" style={{ top }} role="dialog" aria-label="番外模板">
      <div className="story-template-head">
        <span className="story-template-title">番外模板</span>
        <button type="button" className="story-top-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="story-template-body">
        <label className="story-template-field">
          <span className="story-template-label">大概内容</span>
          <textarea rows={5} value={draft.content} placeholder="这篇番外大概写什么" onChange={(event) => set({ content: event.target.value })} />
        </label>
        <div className="story-template-pair">
          <label className="story-template-field">
            <span className="story-template-label">文风</span>
            <input value={draft.style} placeholder="比如轻松风趣冷幽默" onChange={(event) => set({ style: event.target.value })} />
          </label>
          <label className="story-template-field">
            <span className="story-template-label">字数（以上）</span>
            <input value={draft.words} inputMode="numeric" placeholder="比如 4000" onChange={(event) => set({ words: event.target.value })} />
          </label>
        </div>
        <div className="story-template-inline">
          <span className="story-template-label">人称</span>
          <div className="story-template-options">
            {STORY_EXTRA_PERSONS.map((person) => (
              <button key={person} type="button" data-active={draft.person === person ? "true" : undefined} onClick={() => set({ person })}>
                {person}
              </button>
            ))}
          </div>
        </div>
        <label className="story-template-field">
          <span className="story-template-label">其它要求</span>
          <textarea rows={2} value={draft.extra} placeholder="可选：结局、要出现的细节、禁止事项……" onChange={(event) => set({ extra: event.target.value })} />
        </label>
        <button
          type="button"
          className="story-template-toggle"
          role="switch"
          aria-checked={draft.includePrevious}
          data-on={draft.includePrevious ? "true" : undefined}
          onClick={() => set({ includePrevious: !draft.includePrevious })}
        >
          <span>带上之前的番外内容</span>
          <i aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className="story-template-send"
        disabled={sending || !draft.content.trim()}
        onClick={() => onSend(draft)}
      >
        发送番外指令
      </button>
    </div>
  );
}
