import Dexie from "dexie";
import { hydrateKvDb, kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "./kv-db";
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
  /** 「纸张显示」关掉：正文那张纸变透明。番外没设过就跟正篇 */
  paperHidden?: boolean;
  /** 上传的正文字体（主题资源库里的 id）；番外设成空字符串就是番外用默认字体 */
  fontAsset?: string;
  /** 正文文字颜色（#rrggbb）；番外设成空字符串就是番外用主题默认色 */
  textColor?: string;
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

function storySessionMessageCount(sessionId: string): number {
  let count = 0;
  for (const message of _messagesCache) if (message.sessionId === sessionId) count += 1;
  return count;
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  // 有内容的永远比空的优先：同一格里多出来的多半是读库没读到时新建的空会话，
  // 不能因为它「更新」就把有剧情的那个挤掉
  const candidateHasMessages = storySessionMessageCount(candidate.id) > 0;
  const currentHasMessages = storySessionMessageCount(current.id) > 0;
  if (candidateHasMessages !== currentHasMessages) return candidateHasMessages;
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

// 只写回整理后的会话，不删库里的记录：同一格里被挤掉的那个留在库里，
// 它的消息在「找回剧情」里还能挂回来（以前这里先清空整张表，挤掉的会话连同引言等设置就没了）
function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.sessions.bulkPut(sessions).catch(() => undefined);
}

// ── 会话备份 ──
// 每个会话（正篇 / 番外）的设置在 KV 库里另存一份，一个会话一条，只在设置真的变了时才写。
// 剧情库里的会话记录要是没了（不管什么原因），只要它的消息还在，下次打开就从这里原样补回来：
// 正文、记忆区的剧情事件、引言、CSS、背景都在，不用手动找回。
const SESSION_BACKUP_PREFIX = "ai_phone_story_session_backup_v1:";
// KV 库读好之后才写：没读出来时写进去的半份会把原来那份盖掉
let _backupReady = false;
const _backupSignatures = new Map<string, string>();

/** 要备份的部分：最后一条消息能从消息算出来，不存 */
function sessionBackupRecord(session: StorySession): Partial<StorySession> {
  const record: Partial<StorySession> = { ...session };
  delete record.lastMessageId;
  delete record.lastMessagePreview;
  return record;
}

function sessionBackupSignature(session: StorySession): string {
  // 更新时间每发一条都会变，不算「设置变了」
  const record = sessionBackupRecord(session);
  delete record.updatedAt;
  return JSON.stringify(record);
}

function backupStorySession(session: StorySession): void {
  if (!_backupReady) return;
  const signature = sessionBackupSignature(session);
  if (_backupSignatures.get(session.id) === signature) return;
  _backupSignatures.set(session.id, signature);
  kvSet(SESSION_BACKUP_PREFIX + session.id, JSON.stringify(sessionBackupRecord(session)));
}

function removeStorySessionBackup(sessionId: string): void {
  _backupSignatures.delete(sessionId);
  if (kvGet(SESSION_BACKUP_PREFIX + sessionId) !== null) kvRemove(SESSION_BACKUP_PREFIX + sessionId);
}

function readStorySessionBackups(): Map<string, StorySession> {
  const backups = new Map<string, StorySession>();
  for (const key of kvKeysWithPrefix(SESSION_BACKUP_PREFIX)) {
    try {
      const record = JSON.parse(kvGet(key) || "null") as StorySession | null;
      const id = key.slice(SESSION_BACKUP_PREFIX.length);
      if (!record || typeof record.characterId !== "string" || !record.characterId.trim()) continue;
      backups.set(id, { ...record, id });
    } catch {
      // 坏掉的一条跳过，别的照常
    }
  }
  return backups;
}

/** 从消息补上最后一条和更新时间（备份里不存这几项） */
function withLastMessageFrom(session: StorySession, messages: StoryMessage[]): StorySession {
  let last: StoryMessage | undefined;
  for (const message of messages) {
    if (message.sessionId !== session.id) continue;
    if (!last || (message.createdAt || "") > (last.createdAt || "")) last = message;
  }
  if (!last) return session;
  const preview = (last.renderedContent || last.rawContent || "").replace(/\s+/g, " ").trim().slice(0, 64);
  return {
    ...session,
    lastMessageId: last.id,
    lastMessagePreview: preview,
    updatedAt: (last.createdAt || "") > (session.updatedAt || "") ? last.createdAt : session.updatedAt,
  };
}

async function readStoryTables(): Promise<{ ok: boolean; sessions: StorySession[]; messages: StoryMessage[] }> {
  // iOS 上 IndexedDB 偶尔会读失败（刚从后台回来时尤其多），多试几次
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [sessions, messages] = await Promise.all([storyDb.sessions.toArray(), storyDb.messages.toArray()]);
      return { ok: true, sessions, messages };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  console.warn("[Story] 读取剧情库失败:", lastError);
  return { ok: false, sessions: [], messages: [] };
}

let _hydrating: Promise<void> | null = null;

/** 剧情库读好了没有。没读出来时别新建会话（那样会拿空库当真，新建一堆空会话） */
export function isStoryStorageHydrated(): boolean {
  return _hydrated;
}

export function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return Promise.resolve();
  // 桌面和剧情 App 会同时调；只读一次库，免得后到的那次拿旧快照把中间新写的盖掉
  if (!_hydrating) {
    _hydrating = (async () => {
      const [read, kvReady] = await Promise.all([
        readStoryTables(),
        hydrateKvDb().then(() => true, () => false),
      ]);
      // 读失败不当成空库：_hydrated 保持 false，下次打开再读（和 kv-db 一样，成功才算读好）
      if (!read.ok) return;
      const { messages } = read;
      let sessions = read.sessions;

      if (kvReady) {
        // 会话记录没了、消息还在的，从备份补回来
        const backups = readStorySessionBackups();
        const known = new Set(sessions.map((session) => session.id));
        const referenced = new Set(messages.map((message) => message.sessionId));
        const restored: StorySession[] = [];
        for (const [id, backup] of backups) {
          _backupSignatures.set(id, sessionBackupSignature(backup));
          if (known.has(id)) continue;
          if (referenced.has(id)) restored.push(withLastMessageFrom(backup, messages));
          // 库里没有、也没有消息：会话真的不在了（比如清空了故事数据），备份也不留
          else removeStorySessionBackup(id);
        }
        if (restored.length > 0) {
          console.warn(`[Story] 从备份补回 ${restored.length} 个会话记录`);
          storyDb.sessions.bulkPut(restored).catch(() => undefined);
          sessions = [...sessions, ...restored];
        }
        _backupReady = true;
        // 第一次用这一版时把现有的会话都备份一份；之后只写设置有变的
        for (const session of sessions) backupStorySession(session);
      }

      _messagesCache = messages;
      const normalized = normalizeStorySessions(sessions);
      _sessionsCache = normalized.items;
      if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
      _hydrated = true;
    })().finally(() => {
      _hydrating = null;
    });
  }
  return _hydrating;
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

/** 这个角色最近有消息的那个窗口（正篇或番外）；都没聊过就是正篇 */
export function findLastActiveStorySessionFor(characterId: string): StorySession | undefined {
  const own = _sessionsCache.filter((session) => session.characterId === characterId);
  let latest: StoryMessage | undefined;
  for (const message of _messagesCache) {
    if (!own.some((session) => session.id === message.sessionId)) continue;
    if (!latest || (message.createdAt || "") > (latest.createdAt || "")) latest = message;
  }
  return (latest && own.find((session) => session.id === latest.sessionId)) || findMainStorySession(characterId);
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
  backupStorySession(session);
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
  backupStorySession(next);
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

// ── 找回剧情：消息还在、会话记录却没了（或被同一格里另一个挤掉）的那些 ──

export type StoryOrphanGroup = {
  sessionId: string;
  count: number;
  firstAt: string;
  lastAt: string;
  firstText: string;
  lastText: string;
  /** 有用番外模板发出的指令，多半是番外 */
  looksLikeExtra: boolean;
  /** 库里还留着它原来的会话记录（被挤掉的那种），能直接知道是谁的 */
  record?: StorySession;
  /** 确定是谁的才有（不按名字猜）：原记录里的角色，或某个角色的记忆总结进度正好停在这组的某条消息上 */
  knownCharacterId?: string;
  knownBy?: "record" | "memory";
};

function storyPlainText(message: StoryMessage, maxLen = 80): string {
  const source = message.renderedContent || message.rawContent || "";
  return source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * 消息挂在一个不存在（或没被采用）的会话上的，按会话分组列出来。
 * markers：时间戳 → 角色 id（各角色记忆总结进度停在的那一刻，精确到毫秒），对上了就能确定是谁的
 */
export async function listOrphanStoryGroups(markers?: Map<string, string>): Promise<StoryOrphanGroup[]> {
  const known = new Set(_sessionsCache.map((session) => session.id));
  const groups = new Map<string, StoryMessage[]>();
  for (const message of _messagesCache) {
    if (known.has(message.sessionId)) continue;
    const list = groups.get(message.sessionId);
    if (list) list.push(message);
    else groups.set(message.sessionId, [message]);
  }
  if (groups.size === 0) return [];
  const records = await storyDb.sessions.bulkGet([...groups.keys()]).catch(() => [] as (StorySession | undefined)[]);
  const recordById = new Map(records.filter((item): item is StorySession => !!item).map((item) => [item.id, item]));
  return [...groups.entries()].map(([sessionId, list]) => {
    const sorted = [...list].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    const firstUser = sorted.find((message) => message.role === "user") ?? sorted[0];
    const lastStory = [...sorted].reverse().find((message) => message.role === "assistant") ?? sorted[sorted.length - 1];
    const record = recordById.get(sessionId);
    const markerCharacterId = markers
      ? sorted.map((message) => markers.get(message.createdAt)).find((id): id is string => !!id)
      : undefined;
    return {
      sessionId,
      count: sorted.length,
      firstAt: sorted[0].createdAt,
      lastAt: sorted[sorted.length - 1].createdAt,
      firstText: storyPlainText(firstUser),
      lastText: storyPlainText(lastStory),
      looksLikeExtra: sorted.some((message) => !!message.extraOrder),
      record,
      knownCharacterId: record?.characterId || markerCharacterId,
      knownBy: record?.characterId ? "record" as const : markerCharacterId ? "memory" as const : undefined,
    };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const STORY_DISPLAY_FIELDS = [
  "customCSS", "foldTags", "contextExcludedTags", "metaQuote",
  "backgroundImage", "paperHidden", "fontAsset", "textColor",
] as const;

/** 把一组找回的消息挂到某个角色的正篇 / 番外里；那边已经有消息的话按时间合在一起 */
export async function attachOrphanStoryGroup(
  orphanSessionId: string,
  characterId: string,
  kind: "main" | "extra",
): Promise<StorySession> {
  const target = createOrGetStorySession(characterId, kind);
  if (target.id === orphanSessionId) return target;
  const moved = _messagesCache
    .filter((message) => message.sessionId === orphanSessionId)
    .map((message) => ({ ...message, sessionId: target.id }));
  if (moved.length === 0) return target;
  const movedIds = new Set(moved.map((message) => message.id));
  _messagesCache = _messagesCache.filter((message) => !movedIds.has(message.id));
  _messagesCache.push(...moved);
  await storyDb.messages.bulkPut(moved);

  // 原来的会话记录还在的话，这边没设过的显示设置（引言、CSS 等）从那边拿回来
  const record = await storyDb.sessions.get(orphanSessionId).catch(() => undefined);
  const restored: Partial<StorySession> = {};
  if (record) {
    for (const field of STORY_DISPLAY_FIELDS) {
      if (target[field] === undefined && record[field] !== undefined) {
        (restored as Record<string, unknown>)[field] = record[field];
      }
    }
    if (!target.uiPrefs?.theme && record.uiPrefs?.theme) restored.uiPrefs = record.uiPrefs;
    if (kind === "extra" && !target.extraConfig && record.extraConfig) restored.extraConfig = record.extraConfig;
  }

  const all = loadStoryMessages(target.id);
  const last = all[all.length - 1];
  const previewSource = last ? (last.renderedContent || last.rawContent) : "";
  const lastTime = last?.createdAt || target.updatedAt;
  const next = updateStorySession(target.id, {
    ...restored,
    lastMessageId: last?.id,
    lastMessagePreview: previewSource.replace(/\s+/g, " ").trim().slice(0, 64),
    updatedAt: lastTime > target.updatedAt ? lastTime : target.updatedAt,
  }) ?? target;
  // 消息都搬走了，留着的旧记录只会在下次整理时又被挤掉，删掉
  if (!_sessionsCache.some((session) => session.id === orphanSessionId)) {
    if (record) await storyDb.sessions.delete(orphanSessionId).catch(() => undefined);
    removeStorySessionBackup(orphanSessionId);
  }
  return next;
}
