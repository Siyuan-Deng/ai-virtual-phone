// 片刻纪事：从剧情正篇、番外里收下来的片段，按角色一本放在手记里。
// 只存收的那一刻的文字和出处；原消息删了改了，这边不跟着变。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const MOMENTS_KEY = "ai_phone_moments_v1";
registerKvMigration(MOMENTS_KEY);

export const MOMENTS_UPDATED_EVENT = "moments-updated";

export type MomentSource = "story" | "extra";

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
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeMoment(raw: unknown): Moment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs.map(text).map(line => line.trim()).filter(Boolean)
    : [];
  if (!text(value.id) || !text(value.characterId) || paragraphs.length === 0) return null;
  return {
    id: text(value.id),
    characterId: text(value.characterId),
    characterName: text(value.characterName),
    source: value.source === "extra" ? "extra" : "story",
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
