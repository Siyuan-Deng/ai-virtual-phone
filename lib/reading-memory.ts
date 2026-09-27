"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// 批注写进记忆区要在 loadNativeTimeline 里同步读到，而批注本体存在 Dexie（异步）。
// 所以写批注时顺手往这个 kv 日志里追一条，时间线直接读日志。
// 荧光笔/划线不写进来——那是纯阅读标记，不该占记忆。
const MEMO_KEY = "ai_phone_reading_annotation_memos_v1";
registerKvMigration(MEMO_KEY);

/** 只保留最近这么多条：记忆区本身还会再截断，日志没必要无限长。 */
const MEMO_LIMIT = 300;

export type ReadingAnnotationMemo = {
    /** 批注条目与 ReadingAnnotation.id 一致，删批注时按它删日志 */
    id: string;
    /** 缺省即批注——老数据没有这个字段，读出来仍按批注处理 */
    kind?: "annotation" | "summary";
    /** 区间总结用：人读的范围描述，例如「第3章—第5章」 */
    rangeLabel?: string;
    characterId: string;
    bookTitle: string;
    chapterIndex: number;
    chapterTitle: string;
    authorType: "user" | "character";
    /** 批注锚定的原文片段，没有就是整段批注 */
    quote?: string;
    content: string;
    createdAt: string;
};

export function loadReadingAnnotationMemos(): ReadingAnnotationMemo[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(MEMO_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed as ReadingAnnotationMemo[] : [];
    } catch {
        return [];
    }
}

function persist(list: ReadingAnnotationMemo[]): void {
    kvSet(MEMO_KEY, JSON.stringify(list.slice(-MEMO_LIMIT)));
}

export function appendReadingAnnotationMemos(memos: ReadingAnnotationMemo[]): void {
    if (typeof window === "undefined" || memos.length === 0) return;
    const existing = loadReadingAnnotationMemos();
    const seen = new Set(existing.map(memo => memo.id));
    const added = memos.filter(memo => !seen.has(memo.id));
    if (added.length === 0) return;
    persist([...existing, ...added]);
}

export function deleteReadingAnnotationMemo(annotationId: string): void {
    if (typeof window === "undefined") return;
    const existing = loadReadingAnnotationMemos();
    const next = existing.filter(memo => memo.id !== annotationId);
    if (next.length !== existing.length) persist(next);
}

/** 记忆区里的标签，交给 formatStoredPromptEventContent 补时间戳 */
export function readingMemoLabel(memo: ReadingAnnotationMemo): string {
    return memo.kind === "summary" ? "共读摘要" : "批注";
}

/** 记忆区里那一行，带 [标签] 头交给 formatStoredPromptEventContent 补时间。
 *  角色名和用户名一律由调用方传进来，不在这里写死。 */
export function formatReadingAnnotationMemo(
    memo: ReadingAnnotationMemo,
    params: { userName: string; characterName: string },
): string {
    const chapter = memo.chapterTitle.trim() || `第${memo.chapterIndex + 1}章`;
    if (memo.kind === "summary") {
        const range = memo.rangeLabel?.trim() || chapter;
        return `[共读摘要]《${memo.bookTitle}》${range}：${memo.content}`;
    }
    const who = memo.authorType === "user" ? params.userName : params.characterName;
    const where = memo.quote ? `在「${memo.quote}」旁` : "";
    return `[批注]《${memo.bookTitle}》${chapter} ${who}${where}写道：${memo.content}`;
}
