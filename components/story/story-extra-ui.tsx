"use client";

// 剧情侧栏（选角色）和番外用到的几块界面，版式照用户选定的方案 C。

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Eraser, Folder, Plus, Save, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/primitives";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadPresets, loadRegexes, loadWorldBooks } from "@/lib/settings-storage";
import { inheritedCharacterAppApiLabel, loadCharacterAppApiId, saveCharacterAppApiId } from "@/lib/app-api-binding";
import { loadWorldBookFolders, loadWorldBookRootOrder } from "@/lib/worldbook-folders";
import { loadApiConfigFolders, loadApiConfigRootOrder } from "@/lib/api-config-folders";
import { buildPickerEntries } from "@/lib/item-folders";
import type {
  StoryExtraBindings,
  StoryExtraConfig,
  StoryExtraOrder,
  StoryExtraPerson,
  StoryExtraTemplate,
  StoryOrphanGroup,
  StorySession,
} from "@/lib/story-storage";
import {
  STORY_EXTRA_PERSONS,
  STORY_EXTRA_PRESETS_UPDATED_EVENT,
  cleanStoryExtraScenes,
  deleteStoryExtraPreset,
  loadStoryExtraPresets,
  normalizeStoryExtraTemplate,
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

// ── 找回剧情：消息还在、却没挂在任何角色上的 ──
// 不按名字猜是谁的（会有同名角色）；只有原记录还在、或记忆总结进度精确对上时才预先选好

function fullDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

type StorySlotCounts = (characterId: string, kind: "main" | "extra") => number;

function StoryRecoverCard({
  group,
  entries,
  characterId,
  existingCount,
  onChooseCharacter,
  onAttach,
}: {
  group: StoryOrphanGroup;
  entries: StoryCharacterEntry[];
  characterId: string;
  existingCount: StorySlotCounts;
  onChooseCharacter: () => void;
  onAttach: (sessionId: string, characterId: string, kind: "main" | "extra") => Promise<void>;
}) {
  const [kind, setKind] = useState<"main" | "extra">(() => (
    group.record ? (group.record.kind === "extra" ? "extra" : "main") : (group.looksLikeExtra ? "extra" : "main")
  ));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setConfirming(false), [characterId]);
  const character = entries.find((entry) => entry.character.id === characterId)?.character;
  const kindLabel = kind === "extra" ? "番外" : "正篇";
  const already = character ? existingCount(character.id, kind) : 0;
  const range = fullDate(group.firstAt) === fullDate(group.lastAt)
    ? fullDate(group.lastAt)
    : `${fullDate(group.firstAt)} – ${fullDate(group.lastAt)}`;
  const known = character && group.knownCharacterId === character.id;

  return (
    <div className="story-recover-card">
      <div className="story-recover-meta">{group.count} 条 · {range}</div>
      {group.firstText ? <div className="story-recover-line"><span>开头</span>{group.firstText}</div> : null}
      {group.lastText && group.count > 1 ? <div className="story-recover-line"><span>最后</span>{group.lastText}</div> : null}
      <button type="button" className="story-recover-pick" onClick={onChooseCharacter}>
        {character ? (
          <>
            <Avatar src={character.avatar || undefined} name={character.name} size="sm" />
            <span className="story-character-row-main">
              <span className="story-character-row-name">{character.name}</span>
              <span className="story-character-row-line">
                正篇 {existingCount(character.id, "main")} 条 · 番外 {existingCount(character.id, "extra")} 条
              </span>
            </span>
          </>
        ) : (
          <span className="story-recover-pick-empty">选择角色</span>
        )}
        <ChevronRight size={14} />
      </button>
      {known ? (
        <div className="story-recover-note">
          {group.knownBy === "record" ? "原来的记录里就是这个角色" : "这个角色的记忆总结进度正好停在这段里"}
        </div>
      ) : null}
      <div className="story-mode-switch" role="tablist">
        {(["main", "extra"] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-active={kind === value ? "true" : undefined}
            onClick={() => {
              setKind(value);
              setConfirming(false);
            }}
          >
            {value === "extra" ? "番外" : "正篇"}
          </button>
        ))}
      </div>
      {already > 0 && character ? (
        <div className="story-recover-note">它的{kindLabel}里现在有 {already} 条，会按时间合在一起</div>
      ) : null}
      <button
        type="button"
        className={`story-tool-btn${confirming ? " is-danger" : ""}`}
        disabled={!character || busy}
        onClick={async () => {
          if (!character) return;
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setBusy(true);
          try {
            await onAttach(group.sessionId, character.id, kind);
          } finally {
            setBusy(false);
            setConfirming(false);
          }
        }}
      >
        {busy ? "正在挂回去…" : confirming ? `再点一次，挂到${character?.name ?? ""}的${kindLabel}` : "挂回去"}
      </button>
    </div>
  );
}

export function StoryRecoverSheet({
  groups,
  entries,
  existingCount,
  onAttach,
  onClose,
}: {
  groups: StoryOrphanGroup[];
  entries: StoryCharacterEntry[];
  existingCount: StorySlotCounts;
  onAttach: (sessionId: string, characterId: string, kind: "main" | "extra") => Promise<void>;
  onClose: () => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const pickedFor = (group: StoryOrphanGroup) => picks[group.sessionId] ?? (
    group.knownCharacterId && entries.some(({ character }) => character.id === group.knownCharacterId) ? group.knownCharacterId : ""
  );

  if (pickingFor) {
    const keyword = query.trim().toLowerCase();
    const shown = keyword ? entries.filter(({ character }) => character.name.toLowerCase().includes(keyword)) : entries;
    const close = () => {
      setPickingFor(null);
      setQuery("");
    };
    return (
      <div className="story-drawer-sheet">
        <SheetHead title="挂到哪个角色" onClose={close} />
        <div className="story-sheet-body">
          <div className="story-search">
            <SearchIcon />
            <input value={query} placeholder="搜索角色" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="story-sheet-scroll">
            {shown.length === 0 ? <div className="story-sheet-empty">没有叫这个名字的角色</div> : null}
            {shown.map(({ character }) => (
              <button
                key={character.id}
                type="button"
                className="story-character-row"
                data-active={picks[pickingFor] === character.id ? "true" : undefined}
                onClick={() => {
                  setPicks((current) => ({ ...current, [pickingFor]: character.id }));
                  close();
                }}
              >
                <Avatar src={character.avatar || undefined} name={character.name} size="sm" />
                <span className="story-character-row-main">
                  <span className="story-character-row-name">{character.name}</span>
                  <span className="story-character-row-line">
                    正篇 {existingCount(character.id, "main")} 条 · 番外 {existingCount(character.id, "extra")} 条
                  </span>
                </span>
                <span className="story-character-row-date">{shortDate(character.createdAt)}建</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="story-drawer-sheet">
      <SheetHead title="找回剧情" onClose={onClose} />
      <div className="story-sheet-body">
        <div className="story-sheet-scroll">
          {groups.length === 0 ? <div className="story-sheet-empty">没有要找回的剧情了</div> : null}
          {groups.map((group) => (
            <StoryRecoverCard
              key={group.sessionId}
              group={group}
              entries={entries}
              characterId={pickedFor(group)}
              existingCount={existingCount}
              onChooseCharacter={() => setPickingFor(group.sessionId)}
              onAttach={onAttach}
            />
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

type Option = { id: string; name: string; folderId?: string; pinned?: boolean };

function bindingOptions(kind: StoryBindingKind): Option[] {
  if (kind === "api") {
    return loadApiConfigs().map((config) => ({
      id: config.id,
      name: config.name || `${config.provider} · ${config.defaultModel}`,
      folderId: config.folderId,
      pinned: config.pinned,
    }));
  }
  if (kind === "preset") return loadPresets().map((preset) => ({ id: preset.id, name: preset.name }));
  if (kind === "worldBooks") return loadWorldBooks().map((book) => ({ id: book.id, name: book.name, folderId: book.folderId, pinned: book.pinned }));
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
    </div>
  );
}

export function StoryBindingPicker({
  kind,
  bindings,
  onChange,
  onClose,
  title,
  followLabel = "跟随剧情",
}: {
  kind: StoryBindingKind;
  bindings: StoryExtraBindings;
  onChange: (next: StoryExtraBindings) => void;
  onClose: () => void;
  /** 默认「番外xx」；剧情正篇自己的绑定用别的标题 */
  title?: string;
  /** 不单独绑、跟着上一级走的那一行 */
  followLabel?: string;
}) {
  const options = useMemo(() => bindingOptions(kind), [kind]);
  const multi = kind === "worldBooks" || kind === "regexes";
  const selected = selectedBindingIds(kind, bindings);
  const label = BINDING_LABELS[kind];
  // 世界书、API 有文件夹时分层：外面是置顶的、文件夹和未分类的，点文件夹进去选；不同文件夹里的世界书可以同时勾
  const folders = useMemo(() => (kind === "worldBooks" ? loadWorldBookFolders() : kind === "api" ? loadApiConfigFolders() : []), [kind]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  // 最外层跟设置页一样：置顶的在最上面（在文件夹里的也会出现），然后文件夹和其余的按拖出来的顺序混排
  const rootEntries = useMemo(() => {
    if (folders.length === 0) return null;
    return buildPickerEntries(options, folders, kind === "api" ? loadApiConfigRootOrder() : loadWorldBookRootOrder());
  }, [options, folders, kind]);
  const inFolder = (folderId: string) => options.filter((option) => option.folderId === folderId);
  const openFolder = rootEntries && openFolderId ? folders.find((folder) => folder.id === openFolderId) : undefined;

  const optionRow = (option: Option) => {
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
  };

  const folderRow = (folder: { id: string; name: string }) => {
    const count = inFolder(folder.id).filter((option) => selected?.includes(option.id)).length;
    return (
      <button key={folder.id} type="button" className="story-option-row story-option-folder" onClick={() => setOpenFolderId(folder.id)}>
        <span className="story-option-folder-name"><Folder size={15} />{folder.name}</span>
        <span className="story-option-folder-meta">{count > 0 ? `已选 ${count}` : null}<ChevronRight size={15} /></span>
      </button>
    );
  };

  const setIds = (next: string[] | undefined) => {
    if (kind === "api") onChange({ ...bindings, apiConfigId: next?.[0] });
    else if (kind === "preset") onChange({ ...bindings, presetId: next?.[0] });
    else if (kind === "worldBooks") onChange({ ...bindings, worldBookIds: next });
    else onChange({ ...bindings, regexIds: next });
  };

  return (
    <div className="story-drawer-sheet">
      <SheetHead title={title ?? `番外${label}`} onClose={onClose} />
      <div className="story-sheet-body">
        <div className="story-sheet-scroll">
          {openFolder ? (
            <button type="button" className="story-option-row story-option-folder" onClick={() => setOpenFolderId(null)}>
              <span className="story-option-folder-name"><ChevronLeft size={15} />{openFolder.name}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="story-option-row"
                data-active={selected === undefined ? "true" : undefined}
                onClick={() => { setIds(undefined); if (!multi) onClose(); }}
              >
                <span>{followLabel}</span>
                {selected === undefined ? <Check size={15} /> : null}
              </button>
              {rootEntries ? rootEntries.map((entry) => (entry.item ? optionRow(entry.item) : entry.folder ? folderRow(entry.folder) : null)) : null}
            </>
          )}
          {options.length === 0 ? <div className="story-sheet-empty">还没有可选的{label}</div> : null}
          {openFolder ? inFolder(openFolder.id).map(optionRow) : rootEntries ? null : options.map(optionRow)}
          {multi ? (
            <div className="story-drawer-note">勾了几个就只用这几个；一个都不勾就是不用{label}。</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── 剧情正篇自己的 API：就是设置 → 绑定 → 这个角色 → 剧情 里的那一项，两边改的是同一份 ──

/** 这个角色剧情单独绑的 API（没单独绑就是 undefined） */
export function loadStoryApiOverride(characterId: string): string | undefined {
  return loadCharacterAppApiId(characterId, "story");
}

export function saveStoryApiOverride(characterId: string, apiConfigId: string | undefined): void {
  saveCharacterAppApiId(characterId, "story", apiConfigId);
}

/** 不单独绑时实际用的那个（全局 → 角色默认 → 剧情应用默认），显示成「继承：xx」 */
export function storyApiFollowLabel(characterId: string): string {
  return inheritedCharacterAppApiLabel(characterId, "story");
}

export function StoryMainBindingsSection({
  characterId,
  revision,
  onOpen,
}: {
  characterId: string;
  /** 绑定改过就变，让这里重新读 */
  revision: number;
  onOpen: () => void;
}) {
  const value = useMemo(() => {
    const own = loadStoryApiOverride(characterId);
    const name = own ? bindingOptions("api").find((option) => option.id === own)?.name : undefined;
    return name ? { text: name, follow: false } : { text: storyApiFollowLabel(characterId), follow: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, revision]);
  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">剧情绑定</div>
      <button type="button" className="story-bind-row" onClick={onOpen}>
        <span>{BINDING_LABELS.api}</span>
        <span data-follow={value.follow ? "true" : undefined}>{value.text}</span>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

// ── 番外方案：模板（含梗概和开关）+ 绑定成套保存、切换 ──

/** 方案里梗概空着：切过去时保留现在写的那段，比较时也不管这一项 */
function matchesPreset(preset: StoryExtraConfig, current: StoryExtraConfig): boolean {
  const comparable = preset.template.content.trim()
    ? current
    : { ...current, template: { ...current.template, content: "" } };
  return JSON.stringify(preset) === JSON.stringify(comparable);
}

export function StoryExtraPresetBar({
  config,
  onLoad,
  variant = "drawer",
}: {
  config: StoryExtraConfig;
  onLoad: (config: StoryExtraConfig) => void;
  /** 侧栏里是单独一段；番外模板面板里只占一行 */
  variant?: "drawer" | "template";
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [presets, setPresets] = useState<StoryExtraPreset[]>(() => loadStoryExtraPresets());
  // 另一个下拉框（侧栏 / 番外模板）存了或删了方案，这里跟着刷新
  useEffect(() => {
    const reload = () => setPresets(loadStoryExtraPresets());
    window.addEventListener(STORY_EXTRA_PRESETS_UPDATED_EVENT, reload);
    return () => window.removeEventListener(STORY_EXTRA_PRESETS_UPDATED_EVENT, reload);
  }, []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 方案和现在都写了梗概：先问一句再替换
  const [pendingReplace, setPendingReplace] = useState<StoryExtraPreset | null>(null);
  // 下拉框只在现在的设置和某套方案一致时显示它；改过就回到占位，方便重新选回去
  const selectedId = presets.find((preset) => matchesPreset(preset.config, config))?.id ?? "";

  const apply = (preset: StoryExtraPreset) => {
    const content = preset.config.template.content.trim() ? preset.config.template.content : config.template.content;
    onLoad({ ...preset.config, template: { ...preset.config.template, content } });
  };

  // 弹窗挂到剧情页最外层，盖住整页（侧栏会滚动，挂在侧栏里会跟着跑）
  const dialogHost = pendingReplace ? rootRef.current?.closest(".story-app-shell") : null;
  const dialog = pendingReplace ? (
    <div className="story-confirm-overlay" onClick={() => setPendingReplace(null)}>
      <div className="story-confirm" role="alertdialog" aria-label="替换梗概" onClick={(event) => event.stopPropagation()}>
        <div className="story-confirm-title">替换梗概？</div>
        <div className="story-confirm-text">「{pendingReplace.name}」里存了梗概，切换后会替换你现在写的这段。</div>
        <div className="story-confirm-actions">
          <button type="button" onClick={() => setPendingReplace(null)}>取消</button>
          <button
            type="button"
            data-primary="true"
            onClick={() => {
              apply(pendingReplace);
              setPendingReplace(null);
            }}
          >
            继续
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const controls = (
    <>
      <select
        className="story-preset-select"
        value={selectedId}
        onChange={(event) => {
          setConfirmingDelete(false);
          const preset = presets.find((item) => item.id === event.target.value);
          if (!preset) return;
          const incoming = preset.config.template.content.trim();
          const current = config.template.content.trim();
          if (incoming && current && incoming !== current) {
            setPendingReplace(preset);
            return;
          }
          apply(preset);
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
    </>
  );

  const namingRow = naming ? (
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
          saveStoryExtraPreset(name || "未命名", config);
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
  ) : null;

  const dialogNode = dialog && dialogHost ? createPortal(dialog, dialogHost) : dialog;

  if (variant === "template") {
    return (
      <div className="story-template-preset" ref={rootRef}>
        <div className="story-preset-row">
          <span className="story-template-label">番外方案</span>
          {controls}
        </div>
        {namingRow}
        {dialogNode}
      </div>
    );
  }

  return (
    <div className="story-drawer-section" ref={rootRef}>
      <div className="story-drawer-eyebrow">番外方案</div>
      <div className="story-preset-row">{controls}</div>
      {namingRow}
      <div className="story-drawer-note">包括绑定信息与番外指令。</div>
      {dialogNode}
    </div>
  );
}

// ── 番外指令卡：模板发出去的那条，默认折叠 ──

export function StoryExtraOrderCard({
  order,
  rawContent,
  userName,
  charName,
}: {
  order: StoryExtraOrder;
  rawContent: string;
  /** 现在的名字；发送时记下的名字优先 */
  userName: string;
  charName: string;
}) {
  const [open, setOpen] = useState(false);
  const template = normalizeStoryExtraTemplate(order);
  // 指令被手动编辑过就不再拿模板字段概括它（早先的消息没记原文，当作没改过）
  const edited = order.instruction !== undefined && rawContent !== order.instruction;
  const words = template.words.trim().replace(/字(以上)?$/, "").trim();
  const scenes = cleanStoryExtraScenes(template.scenes);
  // 折叠时显示梗概；只写了 if线 就显示 if线
  const summary = template.content.trim() || template.ifLine.trim();
  return (
    <div className="story-extra-order">
      <button type="button" className="story-extra-order-head" onClick={() => setOpen((value) => !value)}>
        <span>番外指令</span>
        <span>{open ? "收起" : "展开"}</span>
      </button>
      <div className={`story-extra-order-text${open ? " is-open" : ""}`}>
        {open || edited || !summary ? rawContent : summary}
      </div>
      {edited ? null : (
        <div className="story-extra-chips">
          {template.ifLine.trim() ? <span>if线</span> : null}
          {words ? <span>{words} 字以上</span> : null}
          {scenes ? <span>{scenes} 个场景</span> : null}
          {template.style.trim() ? <span>{template.style.trim()}</span> : null}
          <span>{order.userName || userName} · {template.userPerson}</span>
          {/* 早先的指令只定了 user 的人称 */}
          {order.charPerson ? <span>{order.charName || charName} · {template.charPerson}</span> : null}
          {template.includePrevious ? <span>带上之前的番外</span> : null}
        </div>
      )}
    </div>
  );
}

// ── 系统指令 ──

/** 发出去的系统指令：和番外指令卡一个样子，默认折叠 */
export function StoryInstructionCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="story-extra-order">
      <button type="button" className="story-extra-order-head" onClick={() => setOpen((value) => !value)}>
        <span>系统指令</span>
        <span>{open ? "收起" : "展开"}</span>
      </button>
      <div className={`story-extra-order-text${open ? " is-open" : ""}`}>{content}</div>
    </div>
  );
}

/** 侧栏里管系统指令：输入栏显不显示「指令」按钮，快捷指令的增删 */
export function StoryCommandSettingsSection({
  buttonVisible,
  onButtonVisibleChange,
  commands,
  onCommandsChange,
  sending,
  onSend,
}: {
  buttonVisible: boolean;
  onButtonVisibleChange: (visible: boolean) => void;
  commands: string[];
  onCommandsChange: (commands: string[]) => void;
  /** 正在生成时不能发 */
  sending: boolean;
  /** 在这里直接把写的这条当系统指令发出去 */
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onCommandsChange([...commands, text]);
    setDraft("");
  };
  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text);
    setDraft("");
  };
  return (
    <div className="story-drawer-section">
      <div className="story-drawer-eyebrow">系统指令</div>
      <button
        type="button"
        className="story-template-toggle"
        role="switch"
        aria-checked={buttonVisible}
        data-on={buttonVisible ? "true" : undefined}
        onClick={() => onButtonVisibleChange(!buttonVisible)}
      >
        <span>输入栏显示「指令」按钮</span>
        <i aria-hidden="true" />
      </button>
      <div className="story-command-manage">
        <span className="story-command-manage-label">快捷指令</span>
        {commands.length > 0 ? (
          <div className="story-command-list">
            {commands.map((command) => (
              <div key={command} className="story-command-item">
                <span>{command}</span>
                <button type="button" aria-label="删除这条快捷指令" onClick={() => onCommandsChange(commands.filter((item) => item !== command))}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="story-command-add">
          <input
            value={draft}
            placeholder="输入快捷指令"
            enterKeyHint="send"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button type="button" className="story-command-save" disabled={!draft.trim()} onClick={add}>保存</button>
          <button type="button" className="story-command-send" disabled={!draft.trim() || sending} onClick={send}>发送</button>
        </div>
      </div>
    </div>
  );
}

// ── 番外模板 ──

export function StoryExtraTemplateSheet({
  initial,
  bindings,
  userName,
  charName,
  top,
  sending,
  quickCommands,
  onSave,
  onBindingsChange,
  onSend,
  onClose,
}: {
  initial: StoryExtraTemplate;
  /** 侧栏里存的快捷指令，可以挑一条接进「其它要求」 */
  quickCommands: string[];
  bindings: StoryExtraBindings;
  userName: string;
  charName: string;
  /** 面板从标题栏下沿开始 */
  top: number;
  sending: boolean;
  /** 面板关掉（包括整页关掉）时，把填的内容存回番外窗口 */
  onSave: (template: StoryExtraTemplate) => void;
  /** 在面板里切方案时，方案里的绑定直接存回番外窗口 */
  onBindingsChange: (bindings: StoryExtraBindings) => void;
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
  // 梗概和 if线设定共用一个框，上面切换；清空只清当前这一页
  const [textTab, setTextTab] = useState<"content" | "ifLine">("content");
  // 「其它要求」右边的「＋快捷指令」：点开挑一条，接在其它要求后面
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const quickMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!quickMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!quickMenuRef.current?.contains(event.target as Node)) setQuickMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [quickMenuOpen]);
  const appendQuickCommand = (command: string) => {
    setDraft((prev) => ({ ...prev, extra: prev.extra.trim() ? `${prev.extra.trim()}\n${command}` : command }));
    setQuickMenuOpen(false);
  };
  const personRows = [
    { name: userName, value: draft.userPerson, pick: (value: StoryExtraPerson) => set({ userPerson: value }) },
    { name: charName, value: draft.charPerson, pick: (value: StoryExtraPerson) => set({ charPerson: value }) },
  ];

  return (
    <div className="story-template-sheet" style={{ top }} role="dialog" aria-label="番外模板">
      <div className="story-template-head">
        <span className="story-template-title">番外模板</span>
        <button type="button" className="story-top-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="story-template-body">
        <StoryExtraPresetBar
          variant="template"
          config={{ template: draft, bindings }}
          onLoad={(next) => {
            setDraft(next.template);
            onBindingsChange(next.bindings);
          }}
        />
        <div className="story-template-field">
          <div className="story-template-tabs" role="tablist" aria-label="梗概和 if线设定">
            <button type="button" role="tab" aria-selected={textTab === "content"} data-active={textTab === "content" ? "true" : undefined} onClick={() => setTextTab("content")}>梗概</button>
            <button type="button" role="tab" aria-selected={textTab === "ifLine"} data-active={textTab === "ifLine" ? "true" : undefined} onClick={() => setTextTab("ifLine")}>if线设定</button>
            <button
              type="button"
              className="story-template-clear"
              disabled={!draft[textTab]}
              onClick={() => set({ [textTab]: "" })}
              aria-label={textTab === "content" ? "清空梗概" : "清空 if线设定"}
            >
              <Eraser size={13} />清空
            </button>
          </div>
          {textTab === "content" ? (
            <textarea rows={5} value={draft.content} placeholder="这篇番外大概写什么" aria-label="梗概" onChange={(event) => set({ content: event.target.value })} />
          ) : (
            <textarea rows={5} value={draft.ifLine} placeholder="可选：如果……会怎样（比如：如果那年他没有出国）" aria-label="if线设定" onChange={(event) => set({ ifLine: event.target.value })} />
          )}
        </div>
        <div className="story-template-pair story-template-triple">
          <label className="story-template-field">
            <span className="story-template-label">文风</span>
            <input value={draft.style} placeholder="比如轻松风趣冷幽默" onChange={(event) => set({ style: event.target.value })} />
          </label>
          <label className="story-template-field">
            <span className="story-template-label">字数（以上）</span>
            <input value={draft.words} inputMode="numeric" placeholder="比如 4000" onChange={(event) => set({ words: event.target.value })} />
          </label>
          <label className="story-template-field">
            <span className="story-template-label">场景数</span>
            <input value={draft.scenes} inputMode="numeric" placeholder="比如 3" onChange={(event) => set({ scenes: event.target.value })} />
          </label>
        </div>
        <div className="story-template-persons">
          {personRows.map((row, index) => (
            <Fragment key={index}>
              <span className="story-template-label">{row.name}人称</span>
              <div className="story-template-options">
                {STORY_EXTRA_PERSONS.map((value) => (
                  <button key={value} type="button" data-active={row.value === value ? "true" : undefined} onClick={() => row.pick(value)}>
                    {value}
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
        <div className="story-template-field story-template-extra" ref={quickMenuRef}>
          <div className="story-template-label-row">
            <span className="story-template-label">其它要求</span>
            <span className="story-template-label-actions">
              <button
                type="button"
                className="story-template-quick-btn"
                aria-expanded={quickMenuOpen}
                onClick={() => setQuickMenuOpen((value) => !value)}
              >
                <Plus size={12} />快捷指令
              </button>
              <button
                type="button"
                className="story-template-clear"
                disabled={!draft.extra}
                onClick={() => set({ extra: "" })}
                aria-label="清空其它要求"
              >
                <Eraser size={13} />清空
              </button>
            </span>
          </div>
          <textarea rows={2} value={draft.extra} placeholder="可选：结局、要出现的细节、禁止事项……" aria-label="其它要求" onChange={(event) => set({ extra: event.target.value })} />
          {quickMenuOpen ? (
            <div className="story-template-quick-menu" role="menu">
              {quickCommands.length > 0 ? quickCommands.map((command) => (
                <button key={command} type="button" role="menuitem" onClick={() => appendQuickCommand(command)}>{command}</button>
              )) : (
                <span className="story-template-quick-empty">快捷指令在右上角菜单里添加</span>
              )}
            </div>
          ) : null}
        </div>
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
        disabled={sending || (!draft.content.trim() && !draft.ifLine.trim())}
        onClick={() => onSend(draft)}
      >
        发送番外指令
      </button>
    </div>
  );
}
