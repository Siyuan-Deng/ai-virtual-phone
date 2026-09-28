"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { ReadingMark } from "./reading-types";

// 标记量小且需要同步读取（渲染时按行切片），放 kv 而不是 Dexie，免去 schema 版本迁移。
const MARKS_KEY = "ai_phone_reading_marks_v1";
registerKvMigration(MARKS_KEY);

type MarkStore = Record<string, ReadingMark[]>;

function loadAll(): MarkStore {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(MARKS_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as MarkStore : {};
    } catch {
        return {};
    }
}

export function loadReadingMarks(bookId: string): ReadingMark[] {
    return loadAll()[bookId] || [];
}

export function saveReadingMark(mark: ReadingMark): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    const list = all[mark.bookId] || [];
    all[mark.bookId] = [...list.filter(item => item.id !== mark.id), mark];
    kvSet(MARKS_KEY, JSON.stringify(all));
}

/** 这条标记属于哪一组。老数据没有 groupId，自己就是一组。 */
export function readingMarkGroupId(mark: ReadingMark): string {
    return mark.groupId || mark.id;
}

/** 同一次划选产生的所有标记，按阅读顺序排好 */
export function readingMarkGroup(marks: ReadingMark[], mark: ReadingMark): ReadingMark[] {
    const groupId = readingMarkGroupId(mark);
    return marks
        .filter(item => readingMarkGroupId(item) === groupId)
        .sort((x, y) => x.chapterIndex - y.chapterIndex || x.paragraphIndex - y.paragraphIndex || x.start - y.start);
}

export function deleteReadingMark(bookId: string, markId: string): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    all[bookId] = (all[bookId] || []).filter(item => item.id !== markId);
    kvSet(MARKS_KEY, JSON.stringify(all));
}
