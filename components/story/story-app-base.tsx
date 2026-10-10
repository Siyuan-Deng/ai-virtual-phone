"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpenIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";

/* 三条粗横条的实心菜单图标，与实心图标集的笔画粗细一致 */
function SolidMenuIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.6" width="18" height="2.8" />
      <rect x="3" y="10.6" width="18" height="2.8" />
      <rect x="3" y="16.6" width="18" height="2.8" />
    </svg>
  );
}

/* 粗笔画「‹」返回图标，笔画粗细与菜单横条一致 */
function SolidBackIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5 L8 12 L15 19"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { getLastSummarizedTimestamp, incrementEventCounter } from "@/lib/memory-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  attachOrphanStoryGroup,
  clearStoryMessages,
  createOrGetStorySession,
  findLastActiveStorySession,
  findMainStorySession,
  hydrateStoryStorage,
  isStoryStorageHydrated,
  listOrphanStoryGroups,
  loadStoryMessages,
  loadStorySessions,
  pushStoryMessage,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryExtraConfig,
  type StoryExtraOrder,
  type StoryMessage,
  type StoryOrphanGroup,
  type StorySession,
  updateStorySession,
} from "@/lib/story-storage";
import { buildStoryExtraInstruction, normalizeStoryExtraConfig, storyExtraHistory } from "@/lib/story-extra";
import {
  StoryBindingPicker,
  StoryCharacterSheet,
  StoryExtraBindingsSection,
  StoryExtraOrderCard,
  StoryExtraPresetBar,
  StoryCommandSettingsSection,
  StoryExtraTemplateSheet,
  StoryInstructionCard,
  StoryMainBindingsSection,
  StoryNowCard,
  StoryRecentSection,
  StoryRecoverSheet,
  loadStoryApiOverride,
  orderStoryCharacters,
  saveStoryApiOverride,
  storyApiFollowLabel,
  type StoryBindingKind,
} from "@/components/story/story-extra-ui";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import {
  loadStoryCommandButtonVisible,
  loadStoryQuickCommands,
  saveStoryCommandButtonVisible,
  saveStoryQuickCommands,
} from "@/lib/story-commands";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

const DEFAULT_STORY_META_QUOTE = "“有些故事，在开始之前就已经写好了结局。”";

/** 番外窗口的主题 / CSS / 折叠标签 / 引言没单独改过就跟正篇一样 */
function storyDisplaySettings(session: StorySession) {
  const main = session.kind === "extra" ? findMainStorySession(session.characterId) : undefined;
  return {
    uiPrefs: session.uiPrefs?.theme ? session.uiPrefs : (main?.uiPrefs ?? session.uiPrefs ?? {}),
    customCSS: session.customCSS ?? main?.customCSS ?? "",
    foldTags: session.foldTags ?? main?.foldTags,
    contextExcludedTags: session.contextExcludedTags ?? main?.contextExcludedTags,
    metaQuote: session.metaQuote ?? main?.metaQuote ?? DEFAULT_STORY_META_QUOTE,
    backgroundImage: session.backgroundImage ?? main?.backgroundImage ?? "",
    paperHidden: session.paperHidden ?? main?.paperHidden ?? false,
    fontAsset: session.fontAsset ?? main?.fontAsset ?? "",
    textColor: session.textColor ?? main?.textColor ?? "",
  };
}

/** 默认正文字体栈：上传的字体缺字时接着用这些 */
const STORY_FONT_FALLBACK = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", Georgia, serif';

/** 上传的字体按资源 id 注册一次（FontFace），之后同一个字体不用再读 */
const loadedStoryFonts = new Map<string, Promise<string | null>>();
function storyFontFamilyName(assetId: string): string {
  return `StoryUserFont-${assetId.replace(/[^\w-]/g, "")}`;
}
function loadStoryFont(assetId: string): Promise<string | null> {
  const cached = loadedStoryFonts.get(assetId);
  if (cached) return cached;
  const task = (async () => {
    const dataUrl = await getThemeAssetDataUrl(assetId);
    if (!dataUrl || typeof FontFace === "undefined") return null;
    const family = storyFontFamilyName(assetId);
    const buffer = await (await fetch(dataUrl)).arrayBuffer();
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    return family;
  })().catch(() => null);
  loadedStoryFonts.set(assetId, task);
  return task;
}

/** 剧情背景存之前缩到长边 1600：手机原图好几兆，整张塞进页面背景会卡 */
async function shrinkStoryBackground(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("这张图片打不开，换一张试试"));
      img.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 各角色记忆总结进度停在的时间（精确到毫秒）→ 角色 id；找回剧情时用它确定一段剧情是谁的 */
function storyMemoryMarkers(): Map<string, string> {
  const markers = new Map<string, string>();
  for (const character of loadCharacters()) {
    const timestamp = getLastSummarizedTimestamp(character.id);
    if (timestamp) markers.set(timestamp, character.id);
  }
  return markers;
}

type StoryDrawerSheet = { type: "characters" } | { type: "binding"; kind: StoryBindingKind } | { type: "mainApi" } | { type: "recover" };

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  // 空着时不跟着占位提示换行长高（左边多了按钮，提示文字一长就会折成两行）
  if (!el.value) return;
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
}: {
  characterName: string;
  avatar?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant">
      <div className="story-msg-head">
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
        <div className="story-msg-meta">
          <span className="story-msg-name">{characterName}</span>
          <span className="story-msg-time story-generating-head">{status}</span>
        </div>
      </div>
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  characterName,
  isGenerating,
  appendRequest,
  onSend,
  onStop,
  onOpenTemplate,
  showCommandButton,
  quickCommands,
  onSendInstruction,
}: {
  characterName: string;
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  onSend: (text: string) => void;
  onStop: () => void;
  /** 番外窗口：左边多一个「模板」 */
  onOpenTemplate?: () => void;
  /** 左边的「指令」按钮；侧栏里关掉就完全不显示，也不留位置 */
  showCommandButton: boolean;
  quickCommands: string[];
  /** 指令模式下发出去的是一条系统指令（system） */
  onSendInstruction: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [commandMode, setCommandMode] = useState(false);
  const inCommand = commandMode && showCommandButton;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    if (inCommand) {
      // 发完回到普通输入，下一句照常是你说的话
      setCommandMode(false);
      onSendInstruction(text);
      return;
    }
    onSend(text);
  };

  const pickQuickCommand = (command: string) => {
    setDraft(command);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  };

  return (
    <div className="story-composer" data-command={inCommand ? "true" : undefined}>
      {inCommand ? (
        <div className="story-command-strip">
          <span className="story-command-strip-title">系统指令</span>
          {quickCommands.length > 0 ? (
            <div className="story-command-chips">
              {quickCommands.map((command) => (
                <button key={command} type="button" onClick={() => pickQuickCommand(command)}>{command}</button>
              ))}
            </div>
          ) : (
            <span className="story-command-empty">快捷指令在右上角菜单里添加</span>
          )}
        </div>
      ) : null}
      {onOpenTemplate ? (
        <button type="button" className="story-template-btn" onClick={onOpenTemplate}>模板</button>
      ) : null}
      {showCommandButton ? (
        <button
          type="button"
          className="story-command-toggle"
          data-on={inCommand ? "true" : undefined}
          aria-pressed={inCommand}
          onClick={() => setCommandMode((value) => !value)}
        >
          指令
        </button>
      ) : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => resizeStoryComposerTextarea(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={inCommand ? "输入系统指令" : onOpenTemplate ? "继续写番外，或说想怎么改……" : `以你和“${characterName}”为主角继续这一段剧情……`}
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <StopIcon width={17} height={17} /> : <PaperAirplaneIcon width={17} height={17} className="story-send-icon" />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  // 剧情库这次没读出来（iOS 偶尔会）：不新建会话，提示重试
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [, setStorageVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 侧栏里再盖的一层：全部角色 / 番外绑定的选项
  const [drawerSheet, setDrawerSheet] = useState<StoryDrawerSheet | null>(null);
  // 剧情正篇的 API 存在设置的绑定里：那边（或这里）一改就加一，侧栏重新读
  const [bindingRevision, setBindingRevision] = useState(0);
  useEffect(() => {
    const bump = () => setBindingRevision((value) => value + 1);
    window.addEventListener("settings-bindings-updated", bump);
    return () => window.removeEventListener("settings-bindings-updated", bump);
  }, []);
  const [confirmingClearExtra, setConfirmingClearExtra] = useState(false);
  // 消息还在、却没挂在任何角色上的剧情；有的话侧栏工具里出现「找回剧情」
  const [orphanGroups, setOrphanGroups] = useState<StoryOrphanGroup[]>([]);
  useEffect(() => {
    if (!ready || !drawerOpen) return;
    let cancelled = false;
    listOrphanStoryGroups(storyMemoryMarkers()).then((groups) => {
      if (!cancelled) setOrphanGroups(groups);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, drawerOpen]);
  // 正篇还是番外；换角色时回到正篇
  const [mode, setMode] = useState<"main" | "extra">("main");
  const [templateTop, setTemplateTop] = useState<number | null>(null);
  // 系统指令：快捷指令和「指令」按钮显不显示，所有角色共用
  const [quickCommands, setQuickCommands] = useState<string[]>([]);
  const [commandButtonVisible, setCommandButtonVisible] = useState(true);
  // 顶部阅读卡的引言：点一下就地编辑
  const [editingQuote, setEditingQuote] = useState(false);
  const quoteCancelRef = useRef(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // 生成状态按会话记录：避免在 A 会话生成时切到 B 会话也显示"正在生成"
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // 抽屉滑动手势用 ref 而不是 state：手指按住时 touchmove 每帧都在触发，
  // 逐帧 setState 会让整个剧情页以事件频率重渲染（iOS 上拉到顶/底按住不动时
  // 表现为持续的重排/闪烁）
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const display = currentSession ? storyDisplaySettings(currentSession) : null;
  const uiPrefs = display?.uiPrefs || {};
  // 剧情背景：存的是图片库 id，读成地址后放进 --story-wallpaper（自定义 CSS 也用这个变量）
  const backgroundImageId = display?.backgroundImage || "";
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  // 上传的字体、文字颜色：写成一条只有一个 class 权重的规则，放在自定义 CSS 前面——
  // 主题默认值压得住，自定义 CSS 里写了同样的变量就以 CSS 为准
  const fontAssetId = display?.fontAsset || "";
  const customTextColor = display?.textColor || "";
  const paperHidden = display?.paperHidden === true;
  const [loadedFontFamily, setLoadedFontFamily] = useState<string | null>(null);
  const fontInputRef = useRef<HTMLInputElement | null>(null);
  // 折叠标签 / 不进上下文标签：平时只露一行，点开才是输入框
  const [openTagRow, setOpenTagRow] = useState<"fold" | "context" | null>(null);
  useEffect(() => {
    if (!fontAssetId) {
      setLoadedFontFamily(null);
      return;
    }
    let cancelled = false;
    void loadStoryFont(fontAssetId).then((family) => {
      if (!cancelled) setLoadedFontFamily(family);
    });
    return () => { cancelled = true; };
  }, [fontAssetId]);
  useEffect(() => {
    if (!backgroundImageId) {
      setWallpaperUrl(null);
      return;
    }
    let cancelled = false;
    void getChatImageFromIndexedDB(backgroundImageId).then((url) => {
      if (!cancelled) setWallpaperUrl(url);
    });
    return () => { cancelled = true; };
  }, [backgroundImageId]);
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);
  // 番外：单独的绑定，历史只取当前这一篇，不写记忆区
  const isExtra = currentSession?.kind === "extra";
  const extraConfig = isExtra ? normalizeStoryExtraConfig(currentSession?.extraConfig) : null;
  const extraBindings = extraConfig?.bindings;
  const extraBindingsKey = extraBindings ? JSON.stringify(extraBindings) : "";
  // 番外模板、指令里代入的名字（剧情历史不走宏替换）
  const storyUserName = userIdentity?.name?.trim() || "用户";

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      if (!isStoryStorageHydrated()) {
        setLoadFailed(true);
        setReady(true);
        return;
      }
      setLoadFailed(false);
      const allCharacters = loadCharacters();
      // 回到最近一次聊过的那个窗口（正篇或番外）；角色删了或者还没聊过就第一个角色的正篇
      const last = findLastActiveStorySession();
      const resume = last && allCharacters.some((character) => character.id === last.characterId) ? last : undefined;
      const initialChar = resume?.characterId || allCharacters[0]?.id || "";
      const initialMode = resume?.kind === "extra" ? "extra" : "main";
      if (initialChar) {
        const session = createOrGetStorySession(initialChar, initialMode);
        const sessionDisplay = storyDisplaySettings(session);
        setMode(initialMode);
        setActiveCharacterId(initialChar);
        setActiveSessionId(session.id);
        activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
        setVisibleMessageCount(STORY_INITIAL_LOAD);
        setMessages(loadStoryMessages(session.id));
        setCustomCssDraft(sessionDisplay.customCSS);
        setFoldTagsDraft(sessionDisplay.foldTags ?? "think,thinking");
        setContextExcludedTagsDraft(sessionDisplay.contextExcludedTags ?? "think,thinking");
        setStorageVersion((value) => value + 1);
      }
      setQuickCommands(loadStoryQuickCommands());
      setCommandButtonVisible(loadStoryCommandButtonVisible());
      setReady(true);
    });
  }, [loadAttempt]);

  useEffect(() => {
    if (!activeCharacterId) return;
    const session = createOrGetStorySession(activeCharacterId, mode);
    const sessionDisplay = storyDisplaySettings(session);
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(sessionDisplay.customCSS);
    setFoldTagsDraft(sessionDisplay.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(sessionDisplay.contextExcludedTags ?? "think,thinking");
    setTemplateTop(null);
    setEditingQuote(false);
    setStorageVersion((value) => value + 1);
  }, [activeCharacterId, mode]);

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    // 已经贴底（或 iOS 橡皮筋回弹超出底部）时不再强写 scrollTop：
    // 否则 ResizeObserver → 贴底 → scroll 事件 → 再贴底会形成每帧循环，
    // 并和 iOS 的回弹动画互相打架
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // 配置解析可能抛错（如绑定的 API 配置已被删除）；这里在渲染 effect 里，
    // 抛出去会让整个剧情页白屏，所以失败时跳过缓存刷新，错误留到发送时提示
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId, extraBindings);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: display?.foldTags, bindings: extraBindings });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // 依赖用 id/foldTags 原始值而不是 session 对象：会话缓存归一化会更换对象
    // 引用，按对象依赖会让本 effect 在无关渲染中反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentSession?.id, display?.foldTags, extraBindingsKey, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    const nextDisplay = storyDisplaySettings(next);
    setCustomCssDraft(nextDisplay.customCSS);
    setFoldTagsDraft(nextDisplay.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(nextDisplay.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }

  async function handleFontFile(file: File | undefined) {
    if (!file || !currentSession) return;
    try {
      const id = await saveThemeAssetFromBlob(file, "font");
      // 先试着加载，打不开的文件（不是字体、格式不支持）就不留着
      if (!(await loadStoryFont(id))) {
        alert("这个字体文件用不了，换一个 ttf / otf / woff 试试");
        return;
      }
      applySessionUpdates({ fontAsset: id, updatedAt: currentSession.updatedAt });
    } catch (error) {
      alert(error instanceof Error ? error.message : "字体保存失败，请重试");
    }
  }

  async function handleBackgroundFile(file: File | undefined) {
    if (!file || !currentSession) return;
    try {
      const id = await saveChatImageToIndexedDB(await shrinkStoryBackground(file));
      // 换背景不算一次阅读，不改「最近」的顺序
      applySessionUpdates({ backgroundImage: id, updatedAt: currentSession.updatedAt });
    } catch (error) {
      alert(error instanceof Error ? error.message : "背景保存失败，请重试");
    }
  }

  // 番外里清除 = 番外用默认（空字符串）；正篇清除就是去掉，跟着正篇的番外也一起回到默认
  function clearFont() {
    if (!currentSession) return;
    applySessionUpdates({ fontAsset: isExtra ? "" : undefined, updatedAt: currentSession.updatedAt });
  }

  function clearTextColor() {
    if (!currentSession) return;
    applySessionUpdates({ textColor: isExtra ? "" : undefined, updatedAt: currentSession.updatedAt });
  }

  function clearBackground() {
    if (!currentSession) return;
    // 正篇清掉就没有了（跟着正篇的番外也一起没了）；番外清掉是「番外不要背景」，正篇不受影响
    applySessionUpdates({ backgroundImage: isExtra ? "" : undefined, updatedAt: currentSession.updatedAt });
  }

  function storySlotMessageCount(characterId: string, kind: "main" | "extra"): number {
    const session = loadStorySessions().find((item) => (
      item.characterId === characterId && (item.kind === "extra" ? "extra" : "main") === kind
    ));
    return session ? loadStoryMessages(session.id).length : 0;
  }

  async function attachOrphan(sessionId: string, characterId: string, kind: "main" | "extra") {
    const count = orphanGroups.find((group) => group.sessionId === sessionId)?.count ?? 0;
    try {
      const target = await attachOrphanStoryGroup(sessionId, characterId, kind);
      if (target.id === activeSessionIdRef.current) {
        setMessages(loadStoryMessages(target.id));
        setVisibleMessageCount(STORY_INITIAL_LOAD);
      }
      setOrphanGroups(await listOrphanStoryGroups(storyMemoryMarkers()));
      setStorageVersion((value) => value + 1);
      const name = loadCharacters().find((character) => character.id === characterId)?.name ?? "";
      alert(`已挂回${name}的${kind === "extra" ? "番外" : "正篇"}，${count} 条`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "没挂上，请重试");
    }
  }

  function updateExtraConfig(sessionId: string, patch: Partial<StoryExtraConfig>) {
    const session = loadStorySessions().find((item) => item.id === sessionId);
    if (!session || session.kind !== "extra") return;
    const base = normalizeStoryExtraConfig(session.extraConfig);
    const next = { ...base, ...patch };
    if (JSON.stringify(next) === JSON.stringify(base)) return;
    updateStorySession(sessionId, { extraConfig: next });
    if (mountedRef.current) setStorageVersion((value) => value + 1);
  }

  function openDrawer() {
    setDrawerSheet(null);
    setConfirmingClearExtra(false);
    // 模板面板先收起（会把填的内容存回去），免得侧栏里切了方案又被面板里的旧草稿盖掉
    setTemplateTop(null);
    setDrawerOpen(true);
  }

  /** 换角色时保持当前是正篇还是番外 */
  function pickCharacter(characterId: string) {
    setActiveCharacterId(characterId);
    setDrawerSheet(null);
    setDrawerOpen(false);
  }

  function saveMetaQuote(value: string) {
    setEditingQuote(false);
    const text = value.trim();
    if (!currentSession || text === display?.metaQuote) return;
    // 清空就回到默认那句（番外回到跟正篇一样）
    applySessionUpdates({ metaQuote: text || undefined });
  }

  function openTemplate() {
    const shell = shellInnerRef.current;
    const header = shell?.querySelector<HTMLElement>(".story-header");
    setTemplateTop(shell && header ? header.getBoundingClientRect().bottom - shell.getBoundingClientRect().top : 96);
  }

  /** asInstruction：系统指令，存成 system 消息、不马上生成；等下一次正常输入时一起发给模型（它是 system，你的输入是 user） */
  async function handleSend(userTextInput: string, extraOrder?: StoryExtraOrder, asInstruction = false) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const extra = isExtra;
    const bindings = extraBindings;

    const userMessage = pushStoryMessage({
      sessionId,
      role: asInstruction ? "system" : "user",
      rawContent: userText,
      renderedContent: userText,
      ...(extraOrder ? { extraOrder } : {}),
      ...(asInstruction ? { instruction: true } : {}),
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    if (asInstruction) return;
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const sessionHistory = loadStoryMessages(sessionId);
      const historyForGeneration = extra ? storyExtraHistory(sessionHistory) : sessionHistory;
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: display?.foldTags,
        sessionContextExcludedTags: display?.contextExcludedTags,
        signal: generationRun.controller.signal,
        bindings,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId)); // 按会话从存储重读，杜绝跨会话串消息
      }
      setStorageVersion((value) => value + 1);

      const storyCharacter = characters.find((character) => character.id === characterId);
      // 番外读记忆区但不写进去，也不触发总结
      if (storyCharacter && !extra) {
        void (async () => {
          try {
            incrementEventCounter(characterId);
            incrementEventCounter(characterId);
            await maybeRunSummarization(characterId, storyCharacter.name);
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId));
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // 从右边缘向左滑打开
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (!drawerOpen && dragStartX > screenW - 32 && dragDeltaX < -54) {
      openDrawer();
    }
    // 向右滑关闭
    if (drawerOpen && dragDeltaX > 54) {
      setDrawerOpen(false);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId, extraBindings);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // 重试会截掉一条长消息，内容变矮时浏览器把滚动位置钳回新底部，
    // 看起来像"页面跳到上面"；这里主动贴底，让视线落在生成指示器上
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, isExtra ? storyExtraHistory(contextMessages) : contextMessages, {
        sessionFoldTags: display?.foldTags,
        sessionContextExcludedTags: display?.contextExcludedTags,
        signal: generationRun.controller.signal,
        bindings: extraBindings,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  if (!ready) return null;

  if (loadFailed || characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpenIcon width={30} height={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">{loadFailed ? "剧情这次没读出来" : "还没有角色卡"}</div>
                  <div className="story-empty-desc">
                    {loadFailed ? "数据还在，只是手机这次没读出来。点重试，不行就关掉 App 再打开。" : "请先创建或导入角色卡，再进入剧情 APP 开始故事。"}
                  </div>
                </div>
                {loadFailed ? (
                  <button className="story-empty-action" onClick={() => setLoadAttempt((value) => value + 1)}>
                    重试
                  </button>
                ) : (
                  <button className="story-empty-action" onClick={onClose}>
                    返回
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;
  const mainSession = sessions.find((session) => session.characterId === activeCharacterId && session.kind !== "extra") || null;
  const characterEntries = orderStoryCharacters(characters, sessions);

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      data-wallpaper={wallpaperUrl ? "" : undefined}
      data-paper={paperHidden ? "off" : undefined}
      style={wallpaperUrl ? ({ "--story-wallpaper": `url("${wallpaperUrl}")` } as React.CSSProperties) : undefined}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {loadedFontFamily || customTextColor ? (
        <style>{`${sessionScope}{${[
          loadedFontFamily ? `--story-user-font:"${loadedFontFamily}", ${STORY_FONT_FALLBACK};--story-font:var(--story-user-font);` : "",
          customTextColor ? `--story-user-text-color:${customTextColor};--c-story-text:var(--story-user-text-color);` : "",
        ].join("")}}`}</style>
      ) : null}
      {display?.customCSS ? (
        <SessionCustomCSS css={display.customCSS} scope={sessionScope} />
      ) : null}

      {drawerOpen ? <div className="story-drawer-overlay" onClick={() => setDrawerOpen(false)} /> : null}
      <aside className="story-drawer" style={{ transform: drawerOpen ? "translateX(0)" : "translateX(106%)", transition: "transform 220ms ease" }}>
        <StoryNowCard
          character={currentCharacter}
          mainSession={mainSession}
          mode={isExtra ? "extra" : "main"}
          onSwitchMode={(next) => {
            setConfirmingClearExtra(false);
            setMode(next);
          }}
        />

        <StoryRecentSection
          entries={characterEntries}
          activeId={activeCharacterId}
          onPick={pickCharacter}
          onOpenAll={() => setDrawerSheet({ type: "characters" })}
        />

        {isExtra && extraConfig ? (
          <>
            <StoryExtraBindingsSection
              bindings={extraConfig.bindings}
              onOpen={(kind) => setDrawerSheet({ type: "binding", kind })}
            />
            <StoryExtraPresetBar
              config={extraConfig}
              onLoad={(config) => updateExtraConfig(currentSession.id, config)}
            />
          </>
        ) : (
          <StoryMainBindingsSection
            characterId={activeCharacterId}
            revision={bindingRevision}
            onOpen={() => setDrawerSheet({ type: "mainApi" })}
          />
        )}

        <StoryCommandSettingsSection
          buttonVisible={commandButtonVisible}
          onButtonVisibleChange={(visible) => {
            saveStoryCommandButtonVisible(visible);
            setCommandButtonVisible(visible);
          }}
          commands={quickCommands}
          onCommandsChange={(commands) => setQuickCommands(saveStoryQuickCommands(commands))}
          sending={isGenerating}
          onSend={(text) => {
            setDrawerOpen(false);
            void handleSend(text, undefined, true);
          }}
        />

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">显示选项</div>
          <div className="story-bg-row">
            <span className="story-bg-row-label">纸张显示</span>
            <button
              type="button"
              className="story-template-toggle story-bg-row-switch"
              role="switch"
              aria-checked={!paperHidden}
              aria-label="纸张显示"
              data-on={paperHidden ? undefined : "true"}
              onClick={() => {
                if (!currentSession) return;
                applySessionUpdates({ paperHidden: !paperHidden, updatedAt: currentSession.updatedAt });
              }}
            >
              <i aria-hidden="true" />
            </button>
          </div>
          <div className="story-bg-row">
            <span className="story-bg-row-label">剧情背景</span>
            <span className="story-bg-row-actions">
              <button type="button" onClick={() => backgroundInputRef.current?.click()}>更换</button>
              {backgroundImageId ? <button type="button" onClick={clearBackground}>清除</button> : null}
            </span>
            <input
              ref={backgroundInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void handleBackgroundFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
          <div className="story-bg-row">
            <span className="story-bg-row-label">正文字体</span>
            <span className="story-bg-row-actions">
              <button type="button" onClick={() => fontInputRef.current?.click()}>更换</button>
              {fontAssetId ? <button type="button" onClick={clearFont}>清除</button> : null}
            </span>
            <input
              ref={fontInputRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
              hidden
              onChange={(event) => {
                void handleFontFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
          <div className="story-bg-row">
            <span className="story-bg-row-label">文字颜色</span>
            <span className="story-bg-row-actions">
              {customTextColor ? <i className="story-bg-row-swatch" style={{ background: customTextColor }} aria-hidden="true" /> : null}
              {/* 取色器透明地盖在「更换」上：iPhone 上只能手指直接点到它才会弹出来，用代码 click() 打不开 */}
              <span className="story-bg-row-color-btn">
                更换
                <input
                  type="color"
                  aria-label="更换文字颜色"
                  value={customTextColor || "#3a3b3c"}
                  onChange={(event) => {
                    if (!currentSession) return;
                    applySessionUpdates({ textColor: event.target.value, updatedAt: currentSession.updatedAt });
                  }}
                />
              </span>
              {customTextColor ? <button type="button" onClick={clearTextColor}>清除</button> : null}
            </span>
          </div>
          <button
            type="button"
            className="story-bg-row story-bg-row-fold"
            aria-expanded={openTagRow === "fold"}
            onClick={() => setOpenTagRow((value) => (value === "fold" ? null : "fold"))}
          >
            <span className="story-bg-row-label">折叠标签</span>
            <span className="story-bg-row-value">
              <span>{foldTagsDraft.trim() || "think,thinking"}</span>
              <i aria-hidden="true">›</i>
            </span>
          </button>
          {openTagRow === "fold" ? (
            <div className="story-bg-row-panel">
              <input
                type="text"
                value={foldTagsDraft}
                onChange={(e) => setFoldTagsDraft(e.target.value)}
                onBlur={() => applySessionUpdates({ foldTags: foldTagsDraft.trim() || undefined })}
                placeholder="think,thinking"
              />
              <div className="story-bg-row-help">逗号分隔标签名，如 think,thinking,reasoning</div>
            </div>
          ) : null}
          <button
            type="button"
            className="story-bg-row story-bg-row-fold"
            aria-expanded={openTagRow === "context"}
            onClick={() => setOpenTagRow((value) => (value === "context" ? null : "context"))}
          >
            <span className="story-bg-row-label">不进上下文标签</span>
            <span className="story-bg-row-value">
              <span>{contextExcludedTagsDraft.trim() || "think,thinking"}</span>
              <i aria-hidden="true">›</i>
            </span>
          </button>
          {openTagRow === "context" ? (
            <div className="story-bg-row-panel">
              <input
                type="text"
                value={contextExcludedTagsDraft}
                onChange={(e) => setContextExcludedTagsDraft(e.target.value)}
                onBlur={() => applySessionUpdates({ contextExcludedTags: contextExcludedTagsDraft.trim() || undefined })}
                placeholder="think,thinking"
              />
              <div className="story-bg-row-help">默认 think,thinking；影响后续生成上下文，不影响显示与保存</div>
            </div>
          ) : null}
        </div>

        {/* 工具放最下面：正篇只有重建缓存，番外多一个清空番外 */}
        {isExtra ? (
          <div className="story-drawer-section">
            <div className="story-drawer-eyebrow">工具</div>
            {orphanGroups.length > 0 ? (
              <button type="button" className="story-tool-btn" onClick={() => setDrawerSheet({ type: "recover" })}>
                找回剧情（{orphanGroups.length} 段）
              </button>
            ) : null}
            <button
              type="button"
              className={`story-tool-btn${confirmingClearExtra ? " is-danger" : ""}`}
              onClick={() => {
                if (!confirmingClearExtra) {
                  setConfirmingClearExtra(true);
                  return;
                }
                cancelStoryGenerationRun(currentSession.id);
                markGenerating(currentSession.id, false);
                clearStoryMessages(currentSession.id);
                setMessages([]);
                setVisibleMessageCount(STORY_INITIAL_LOAD);
                setConfirmingClearExtra(false);
                setStorageVersion((value) => value + 1);
              }}
            >
              {confirmingClearExtra ? "再点一次，清空这个番外窗口" : "清空番外"}
            </button>
            <button
              className="story-tool-btn"
              onClick={() => {
                try {
                  const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: display?.foldTags, bindings: extraBindings });
                  setMessages(rebuilt);
                  setStorageVersion((value) => value + 1);
                  alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
                } catch (error) {
                  alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
                }
              }}
            >
              重建渲染缓存
            </button>
          </div>
        ) : (
          <div className="story-drawer-section">
            <div className="story-drawer-eyebrow">工具</div>
            {orphanGroups.length > 0 ? (
              <button type="button" className="story-tool-btn" onClick={() => setDrawerSheet({ type: "recover" })}>
                找回剧情（{orphanGroups.length} 段）
              </button>
            ) : null}
            <button
              className="story-tool-btn"
              onClick={() => {
                try {
                  const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
                  setMessages(rebuilt);
                  setStorageVersion((value) => value + 1);
                  alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
                } catch (error) {
                  alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
                }
              }}
            >
              重建渲染缓存
            </button>
          </div>
        )}
      </aside>

      {drawerOpen && drawerSheet?.type === "characters" ? (
        <StoryCharacterSheet
          entries={characterEntries}
          activeId={activeCharacterId}
          onPick={pickCharacter}
          onClose={() => setDrawerSheet(null)}
        />
      ) : null}
      {drawerOpen && drawerSheet?.type === "binding" && extraConfig ? (
        <StoryBindingPicker
          kind={drawerSheet.kind}
          bindings={extraConfig.bindings}
          onChange={(bindings) => updateExtraConfig(currentSession.id, { bindings })}
          onClose={() => setDrawerSheet(null)}
        />
      ) : null}
      {drawerOpen && drawerSheet?.type === "recover" ? (
        <StoryRecoverSheet
          groups={orphanGroups}
          entries={characterEntries}
          existingCount={storySlotMessageCount}
          onAttach={attachOrphan}
          onClose={() => setDrawerSheet(null)}
        />
      ) : null}
      {drawerOpen && drawerSheet?.type === "mainApi" ? (
        <StoryBindingPicker
          kind="api"
          title="剧情API"
          followLabel={storyApiFollowLabel(activeCharacterId)}
          bindings={{ apiConfigId: loadStoryApiOverride(activeCharacterId) }}
          onChange={(bindings) => saveStoryApiOverride(activeCharacterId, bindings.apiConfigId)}
          onClose={() => setDrawerSheet(null)}
        />
      ) : null}

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <SolidBackIcon size={16} />
              </button>
            </div>
            <div className="story-header-center">{isExtra ? "番外" : "Story"}</div>
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <PaintBrushIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={openDrawer} aria-label="打开剧情侧栏">
                <SolidMenuIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {currentCharacter.avatar ? (
                    <img src={currentCharacter.avatar} alt="cover" />
                  ) : (
                    <div className="story-meta-cover-fallback" aria-hidden="true">
                      <span className="story-meta-cover-char">{currentCharacter.name.trim().charAt(0) || "书"}</span>
                      <span className="story-meta-cover-line" />
                      <span className="story-meta-cover-sub">STORY</span>
                    </div>
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">{isExtra ? "番外" : "本次阅读"}：《 {currentCharacter.name} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "我"} x {currentCharacter.name}
                  </div>
                  {editingQuote ? (
                    <textarea
                      className="story-meta-desc story-meta-desc-input"
                      rows={3}
                      autoFocus
                      defaultValue={display?.metaQuote}
                      aria-label="编辑引言"
                      onFocus={(event) => {
                        const el = event.currentTarget;
                        el.setSelectionRange(el.value.length, el.value.length);
                      }}
                      onBlur={(event) => {
                        if (quoteCancelRef.current) {
                          quoteCancelRef.current = false;
                          setEditingQuote(false);
                          return;
                        }
                        saveMetaQuote(event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          quoteCancelRef.current = true;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <div
                      className="story-meta-desc"
                      role="button"
                      tabIndex={0}
                      aria-label="点一下编辑引言"
                      onClick={() => {
                        autoBottomLockRef.current = false;
                        setEditingQuote(true);
                      }}
                    >
                      {display?.metaQuote}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpenIcon width={28} height={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">{isExtra ? "番外从这里开始" : "故事从这里开始"}</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">{isExtra ? "点左下角「模板」填好想看的番外，或者直接在下面写。" : "从底部输入一段引导，剧情会继续展开。"}</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  // 番外模板发出的指令折叠成一张卡；编辑时照常显示原文
                  const extraOrder = message.extraOrder && editingMessageId !== message.id ? message.extraOrder : null;
                  // 系统指令也折叠成一张卡；编辑时照常显示原文
                  const instructionCard = message.instruction === true && editingMessageId !== message.id;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" && !extraOrder ? (
                        <div className="story-msg-head">
                          <div className="story-avatar-wrap">
                            <Avatar src={avatarUrl} name={speakerName} size="md" />
                          </div>
                          <div className="story-msg-meta">
                            <span className="story-msg-name">{speakerName}</span>
                            <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        {extraOrder ? (
                          <StoryExtraOrderCard
                            order={extraOrder}
                            rawContent={message.rawContent}
                            userName={storyUserName}
                            charName={currentCharacter.name}
                          />
                        ) : instructionCard ? (
                          <StoryInstructionCard content={message.rawContent} />
                        ) : (
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        )}
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
              />
            ) : null}
          </div>
        </div>
      </div>

      <StoryComposer
        characterName={currentCharacter.name}
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        onSend={(text) => { void handleSend(text); }}
        onStop={handleStopGeneration}
        onOpenTemplate={isExtra ? openTemplate : undefined}
        showCommandButton={commandButtonVisible}
        quickCommands={quickCommands}
        onSendInstruction={(text) => { void handleSend(text, undefined, true); }}
      />

      {isExtra && extraConfig && templateTop != null ? (
        <StoryExtraTemplateSheet
          key={currentSession.id}
          initial={extraConfig.template}
          bindings={extraConfig.bindings}
          userName={storyUserName}
          charName={currentCharacter.name}
          top={templateTop}
          sending={isGenerating}
          quickCommands={quickCommands}
          onSave={(template) => updateExtraConfig(currentSession.id, { template })}
          onBindingsChange={(bindings) => updateExtraConfig(currentSession.id, { bindings })}
          onSend={(template) => {
            updateExtraConfig(currentSession.id, { template });
            setTemplateTop(null);
            const names = { user: storyUserName, char: currentCharacter.name };
            const instruction = buildStoryExtraInstruction(template, names);
            void handleSend(instruction, { ...template, userName: names.user, charName: names.char, instruction });
          }}
          onClose={() => setTemplateTop(null)}
        />
      ) : null}

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <XMarkIcon width={17} height={17} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 0,
                        border: "none",
                        boxShadow: "none",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: "none",
                        boxShadow: active
                          ? "inset 0 0 0 2px var(--c-story-bg-top, #fdfdfd), 0 0 0 2px var(--c-story-text, #3a3b3c)"
                          : "none",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                borderRadius: 0,
                boxShadow: "none",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0, border: "none", boxShadow: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
