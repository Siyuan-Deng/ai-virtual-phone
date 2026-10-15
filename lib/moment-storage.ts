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
  /** 番外的名字（番外模板里填的内容，取第一行）；正篇、没填的不写 */
  sourceTitle?: string;
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
    ...(text(value.sourceTitle).trim() ? { sourceTitle: text(value.sourceTitle).trim() } : {}),
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

export function isMomentCollected(messageId: string): boolean {
  return loadMoments().some(moment => moment.messageId === messageId);
}

/** 同一条消息只收一次；收过了返回 null */
export function addMoment(input: Omit<Moment, "id" | "createdAt">): Moment | null {
  const moments = loadMoments();
  if (input.messageId && moments.some(moment => moment.messageId === input.messageId)) return null;
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
