// 片刻纪事：从剧情正篇、番外、聊天里收下来的片段，按角色一本放在手记里。
// 只存收的那一刻的文字和出处；原消息删了改了，这边不跟着变。
// 聊天收的是几条一起：文字照字存，别的（表情、转账、拍一拍……）存聊天里原样截的小图，
// 另外存一张整段的聊天截图，分享就用它。图都放在阅读的图片库里，key 以 moment-chat-<id> 开头。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const MOMENTS_KEY = "ai_phone_moments_v1";
registerKvMigration(MOMENTS_KEY);

export const MOMENTS_UPDATED_EVENT = "moments-updated";

export type MomentSource = "story" | "extra" | "chat";

/** 聊天收进来的一条 */
export type MomentChatLine =
  /** 文字：在片刻纪事里用 user / char 各自的字体写 */
  | { kind: "text"; speaker: "user" | "char"; text: string; at: string }
  /** 别的：聊天里原样截下来的透明底小图 */
  | { kind: "snap"; speaker: "user" | "char" | "system"; asset: string; width: number; height: number; at: string };

export type Moment = {
  id: string;
  /** 收进哪一本：剧情里就是那个角色，自己说的话也算这一本 */
  characterId: string;
  characterName: string;
  source: MomentSource;
  /** 这句话是谁说的 */
  speaker: "char" | "user";
  speakerName: string;
  paragraphs: string[];
  sessionId: string;
  messageId: string;
  /** 原消息的时间 */
  messageAt: string;
  /** 收的时间 */
  createdAt: string;
  /** 聊天：一条条消息（paragraphs 里只有其中的文字） */
  lines?: MomentChatLine[];
  /** 聊天：整段的截图，分享用 */
  shotAsset?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeChatLine(raw: unknown): MomentChatLine | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const at = text(value.at);
  if (value.kind === "text") {
    const body = text(value.text).trim();
    return body ? { kind: "text", speaker: value.speaker === "user" ? "user" : "char", text: body, at } : null;
  }
  if (value.kind === "snap" && text(value.asset)) {
    const speaker = value.speaker === "user" || value.speaker === "system" ? value.speaker : "char";
    return { kind: "snap", speaker, asset: text(value.asset), width: Number(value.width) || 0, height: Number(value.height) || 0, at };
  }
  return null;
}

function normalizeMoment(raw: unknown): Moment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs.map(text).map(line => line.trim()).filter(Boolean)
    : [];
  const lines = Array.isArray(value.lines)
    ? value.lines.map(normalizeChatLine).filter((line): line is MomentChatLine => line !== null)
    : [];
  const source: MomentSource = value.source === "extra" || value.source === "chat" ? value.source : "story";
  if (!text(value.id) || !text(value.characterId)) return null;
  if (source === "chat" ? lines.length === 0 : paragraphs.length === 0) return null;
  return {
    ...(source === "chat" ? { lines, ...(text(value.shotAsset) ? { shotAsset: text(value.shotAsset) } : {}) } : {}),
    id: text(value.id),
    characterId: text(value.characterId),
    characterName: text(value.characterName),
    source,
    speaker: value.speaker === "user" ? "user" : "char",
    speakerName: text(value.speakerName),
    paragraphs,
    sessionId: text(value.sessionId),
    messageId: text(value.messageId),
    messageAt: text(value.messageAt),
    createdAt: text(value.createdAt) || new Date().toISOString(),
  };
}

/** 新收的在前 */
export function loadMoments(): Moment[] {
  try {
    const raw = kvGet(MOMENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMoment).filter((item): item is Moment => item !== null);
  } catch {
    return [];
  }
}

function saveMoments(moments: Moment[]): void {
  kvSet(MOMENTS_KEY, JSON.stringify(moments));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MOMENTS_UPDATED_EVENT));
}

/** 同一条消息里同样的字只收一次（整条和自己选的几段可以都收）；收过了返回 null */
export function addMoment(input: Omit<Moment, "id" | "createdAt">): Moment | null {
  const moments = loadMoments();
  const text = input.paragraphs.join("\n");
  if (input.messageId && moments.some(moment => moment.messageId === input.messageId && moment.paragraphs.join("\n") === text)) return null;
  const moment: Moment = {
    ...input,
    id: `moment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  saveMoments([moment, ...moments]);
  return moment;
}

export function deleteMoment(id: string): void {
  saveMoments(loadMoments().filter(moment => moment.id !== id));
  void import("./reading-appearance").then(({ deleteReadingAssetsByPrefix }) => deleteReadingAssetsByPrefix(`moment-chat-${id}-`)).catch(() => {});
}

/** 收聊天时还没存进图库的一条：图先是 Blob */
export type MomentChatLineDraft =
  | Extract<MomentChatLine, { kind: "text" }>
  | { kind: "snap"; speaker: "user" | "char" | "system"; blob: Blob; width: number; height: number; at: string };

/** 收几条聊天：图先存进图库，再记这一张纸。同样几条收过了返回 null */
export async function addChatMoment(
  input: Omit<Moment, "id" | "createdAt" | "source" | "paragraphs" | "lines" | "shotAsset">,
  drafts: MomentChatLineDraft[],
  shot: Blob | null,
): Promise<Moment | null> {
  if (input.messageId && loadMoments().some(moment => moment.source === "chat" && moment.messageId === input.messageId)) return null;
  const { saveReadingAsset } = await import("./reading-appearance");
  const id = `moment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const lines: MomentChatLine[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (draft.kind === "text") {
      lines.push(draft);
      continue;
    }
    const asset = `moment-chat-${id}-${index}`;
    await saveReadingAsset(asset, draft.blob);
    lines.push({ kind: "snap", speaker: draft.speaker, asset, width: draft.width, height: draft.height, at: draft.at });
  }
  if (lines.length === 0) return null;
  let shotAsset: string | undefined;
  if (shot) {
    shotAsset = `moment-chat-${id}-shot`;
    await saveReadingAsset(shotAsset, shot);
  }
  const moment: Moment = {
    ...input,
    id,
    source: "chat",
    paragraphs: lines.flatMap(line => (line.kind === "text" ? [line.text] : [])),
    lines,
    ...(shotAsset ? { shotAsset } : {}),
    createdAt: new Date().toISOString(),
  };
  saveMoments([moment, ...loadMoments()]);
  return moment;
}

/** 聊天那张纸上的图（小图、整段截图） */
export async function loadMomentAsset(key: string): Promise<Blob | null> {
  const { loadReadingAsset } = await import("./reading-appearance");
  return loadReadingAsset(key).catch(() => null);
}

// ── 署名：分享摘抄时用的 ID 和头像，片刻纪事自己的一套（和阅读账号一样，不动角色档案） ──

const PROFILES_KEY = "ai_phone_moment_profiles_v1";
registerKvMigration(PROFILES_KEY);

export const MOMENT_PROFILES_UPDATED_EVENT = "moment-profiles-updated";

export type MomentProfiles = {
  /** 空字符串表示没设置，用身份里的名字 */
  user: { name: string };
  /** 角色 id → 署名；没有的用角色本来的名字 */
  characters: Record<string, { name: string }>;
  /** 角色 id → 自己在这一本里的署名；没有的用上面 user 的 */
  userByCharacter: Record<string, { name: string }>;
};

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

function cleanNames(value: unknown): Record<string, { name: string }> {
  const names: Record<string, { name: string }> = {};
  if (!value || typeof value !== "object") return names;
  for (const [id, profile] of Object.entries(value as Record<string, { name?: unknown }>)) {
    const name = cleanName(profile?.name);
    if (name) names[id] = { name };
  }
  return names;
}

export function loadMomentProfiles(): MomentProfiles {
  try {
    const raw = kvGet(PROFILES_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<MomentProfiles> : {};
    return {
      user: { name: cleanName(parsed.user?.name) },
      characters: cleanNames(parsed.characters),
      userByCharacter: cleanNames(parsed.userByCharacter),
    };
  } catch {
    return { user: { name: "" }, characters: {}, userByCharacter: {} };
  }
}

/** 事件 detail："names" 只改了 ID，"avatar" 换了头像（要重读图片） */
export function saveMomentProfiles(profiles: MomentProfiles): void {
  kvSet(PROFILES_KEY, JSON.stringify(profiles));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MOMENT_PROFILES_UPDATED_EVENT, { detail: "names" }));
}

/** "user" 是外面那个自己，"user:角色id" 是自己在那一本里的，别的是角色 id */
export type MomentProfileOwner = "user" | string;

export function momentUserOwner(characterId: string): MomentProfileOwner {
  return `user:${characterId}`;
}

function avatarKey(owner: MomentProfileOwner): string {
  if (owner === "user") return "moment-avatar-user";
  if (owner.startsWith("user:")) return `moment-avatar-user-${owner.slice(5)}`;
  return `moment-avatar-char-${owner}`;
}

/** 头像存在阅读的图片库里（和阅读账号头像同一处），按 key 区分 */
export async function loadMomentAvatar(owner: MomentProfileOwner): Promise<Blob | null> {
  const { loadReadingAsset } = await import("./reading-appearance");
  return loadReadingAsset(avatarKey(owner)).catch(() => null);
}

export async function saveMomentAvatar(owner: MomentProfileOwner, blob: Blob | null): Promise<void> {
  const { saveReadingAsset } = await import("./reading-appearance");
  await saveReadingAsset(avatarKey(owner), blob);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MOMENT_PROFILES_UPDATED_EVENT, { detail: "avatar" }));
}
