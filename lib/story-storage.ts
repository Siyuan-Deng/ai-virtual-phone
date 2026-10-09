import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
};

export type StoryExtraPerson = "第一人称" | "第二人称" | "第三人称";

/** 番外模板里的几项。用模板发出去的那条用户消息会带着它，标记「从这里开始新的一篇」 */
export type StoryExtraTemplate = {
  /** 梗概 */
  content: string;
  /** if线设定：和正篇不一样的前提（如果……） */
  ifLine: string;
  style: string;
  /** 字数，原样保存用户填的（「4000」「四千」都行） */
  words: string;
  /** 要几个不同的场景，原样保存用户填的；空着就不提 */
  scenes: string;
  /** 用什么人称写 user / char，分开选 */
  userPerson: StoryExtraPerson;
  charPerson: StoryExtraPerson;
  extra: string;
  /** 这一篇要不要带上之前的番外一起发给模型 */
  includePrevious: boolean;
};

/** 番外单独的绑定；没填的那项跟随剧情 */
export type StoryExtraBindings = {
  apiConfigId?: string;
  presetId?: string;
  /** undefined 跟随剧情；[] 不用世界书 */
  worldBookIds?: string[];
  /** undefined 跟随剧情；[] 不用正则 */
  regexIds?: string[];
};

export type StoryExtraConfig = {
  template: StoryExtraTemplate;
  bindings: StoryExtraBindings;
};

/** 消息上记的番外指令：发送时的模板 + 当时代入的名字 + 拼好的原文 */
export type StoryExtraOrder = StoryExtraTemplate & {
  userName?: string;
  charName?: string;
  /** 发出去的指令原文；和消息正文对不上说明被手动编辑过 */
  instruction?: string;
};

export type StorySession = {
  id: string;
  characterId: string;
  /** 正篇（缺省）还是番外。每个角色各一个 */
  kind?: "main" | "extra";
  /** 番外窗口的模板和单独绑定 */
  extraConfig?: StoryExtraConfig;
  title?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  /** 顶部阅读卡里那句引言；没改过就用默认的，番外没改过跟正篇 */
  metaQuote?: string;
  /** 剧情背景：聊天图片库里的 id。番外没设过就用正篇的；番外设成空字符串就是番外不要背景 */
  backgroundImage?: string;
  lastMessageId?: string;
  lastMessagePreview?: string;
};

export type StoryMessageRole = "user" | "assistant" | "system";

export type StoryMessage = {
  id: string;
  sessionId: string;
  role: StoryMessageRole;
  rawContent: string;
  renderedContent?: string;
  storySummary?: string;
  regexSignature?: string;
  parserVersion?: number;
  createdAt: string;
  /** 番外：用模板发出的指令，带着当时填的模板 */
  extraOrder?: StoryExtraOrder;
  /** 系统指令：作为 system 发给模型，不算用户说的话 */
  instruction?: boolean;
};

export type StoryProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

class StoryDatabase extends Dexie {
  sessions!: Dexie.Table<StorySession, string>;
  messages!: Dexie.Table<StoryMessage, string>;

  constructor() {
    super("AiPhoneStoryDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
  }
}

const storyDb = new StoryDatabase();

let _hydrated = false;
let _sessionsCache: StorySession[] = [];
let _messagesCache: StoryMessage[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStorySessionActivityTime(session: StorySession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  const candidateTime = getStorySessionActivityTime(candidate);
  const currentTime = getStorySessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

function storySessionSlot(session: Pick<StorySession, "characterId" | "kind">): string {
  return `${session.characterId}:${session.kind === "extra" ? "extra" : "main"}`;
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  // 每个角色一个正篇 + 一个番外；同一格里有重复的只留最新那个
  const indexByCharacter = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const item = id === session.id && characterId === session.characterId
      ? session
      : { ...session, id, characterId };
    const slot = storySessionSlot(item);
    const existingIndex = indexByCharacter.get(slot);
    if (existingIndex === undefined) {
      indexByCharacter.set(slot, normalized.length);
      normalized.push(item);
      if (item !== session) changed = true;
      continue;
    }

    changed = true;
    if (isPreferredStorySession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.transaction("rw", storyDb.sessions, async () => {
    await storyDb.sessions.clear();
    await storyDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  const [sessions, messages] = await Promise.all([
    storyDb.sessions.toArray().catch(() => []),
    storyDb.messages.toArray().catch(() => []),
  ]);
  _messagesCache = messages;
  const normalized = normalizeStorySessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
  _hydrated = true;
}

export function loadStorySessions(): StorySession[] {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  // 空值安全：旧版本/异常导入的数据可能缺 updatedAt，排序不能让页面崩溃
  return [..._sessionsCache].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

/** 最近一次有消息的会话（正篇或番外都算）；进剧情 App 时回到这里 */
export function findLastActiveStorySession(): StorySession | undefined {
  let latest: StoryMessage | undefined;
  for (const message of _messagesCache) {
    if (!latest || (message.createdAt || "") > (latest.createdAt || "")) latest = message;
  }
  return latest ? _sessionsCache.find((session) => session.id === latest.sessionId) : undefined;
}

/** 这个角色的正篇会话（不会拿到番外那个） */
export function findMainStorySession(characterId: string): StorySession | undefined {
  return _sessionsCache.find((session) => session.characterId === characterId && session.kind !== "extra");
}

export function createOrGetStorySession(characterId: string, kind: "main" | "extra" = "main"): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const existing = _sessionsCache.find((session) => (
    session.characterId === characterId && (session.kind === "extra" ? "extra" : "main") === kind
  ));
  if (existing) return existing;

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId,
    ...(kind === "extra" ? { kind: "extra" as const } : {}),
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

export function updateStorySession(sessionId: string, updates: Partial<StorySession>): StorySession | null {
  const idx = _sessionsCache.findIndex((session) => session.id === sessionId);
  if (idx === -1) return null;
  const next: StorySession = {
    ..._sessionsCache[idx],
    ...updates,
    uiPrefs: { ..._sessionsCache[idx].uiPrefs, ...updates.uiPrefs },
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  storyDb.sessions.put(next).catch(() => undefined);
  return next;
}

export function pushStoryMessage(
  input: Omit<StoryMessage, "id" | "createdAt">
): StoryMessage {
  const message: StoryMessage = {
    ...input,
    id: generateId("story_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  storyDb.messages.put(message).catch(() => undefined);

  const previewSource = message.renderedContent || message.rawContent;
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 64);
  updateStorySession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    updatedAt: message.createdAt,
  });

  return message;
}

/** Delete a single story message */
export function deleteStoryMessage(messageId: string): void {
    _messagesCache = _messagesCache.filter(m => m.id !== messageId);
    storyDb.messages.delete(messageId).catch(() => undefined);
}

/** Delete a message and all messages after it (by createdAt in same session) */
export function deleteStoryMessagesFrom(sessionId: string, messageId: string): void {
    const msg = _messagesCache.find(m => m.id === messageId);
    if (!msg) return;
    const idsToDelete = _messagesCache
        .filter(m => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
        .map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !idsToDelete.includes(m.id));
    storyDb.messages.bulkDelete(idsToDelete).catch(() => undefined);
}

/** Edit a story message's rawContent (renderedContent will be rebuilt by cache invalidation) */
export function editStoryMessage(messageId: string, newRawContent: string): void {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    _messagesCache[idx] = {
        ..._messagesCache[idx],
        rawContent: newRawContent,
        renderedContent: undefined,
        regexSignature: undefined,
        parserVersion: undefined,
    };
    storyDb.messages.put(_messagesCache[idx]).catch(() => undefined);
}

/** 清空一个会话的全部消息（番外「清空番外」用） */
export function clearStoryMessages(sessionId: string): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  storyDb.messages.where("sessionId").equals(sessionId).delete().catch(() => undefined);
  updateStorySession(sessionId, { lastMessageId: undefined, lastMessagePreview: undefined });
}

export function replaceStoryMessages(sessionId: string, messages: StoryMessage[]): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _messagesCache.push(...messages);
  storyDb.messages.where("sessionId").equals(sessionId).delete()
    .then(() => storyDb.messages.bulkPut(messages))
    .catch(() => undefined);
}

function compactProjectionText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadStoryProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string; userName?: string; charName?: string }
): StoryProjectionEntry[] {
  // 只投正篇：番外里的内容不进记忆区
  const session = findMainStorySession(characterId);
  if (!session) return [];
  const messages = loadStoryMessages(session.id);
  const projections: StoryProjectionEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant") continue;
    if (options?.afterTimestamp && current.createdAt <= options.afterTimestamp) continue;

    if (!current.storySummary) continue;
    const summaryText = compactProjectionText(current.storySummary, 500);
    if (!summaryText) continue;

    const ts = formatChatTimestamp(current.createdAt);
    projections.push({
      id: `story_projection_${current.id}`,
      timestamp: current.createdAt,
      content: `[事件 ${ts}] ${summaryText}`,
    });
  }

  return projections;
}
