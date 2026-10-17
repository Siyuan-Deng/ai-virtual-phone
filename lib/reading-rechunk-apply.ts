// lib/reading-rechunk-apply.ts — 把「重新分组」这个纯计算结果真正落库，并搬家依赖数据。
//
// 分工：
//  · lib/reading-rechunk.ts        纯计算：新章节 + 旧锚点 → 新锚点
//  · 这里                          读写存储：章节、批注、划线、书签、进度、记忆日志
//
// 迁移原则（按需求定的）：能精确对应的全部自动迁移；对应不上的删除，
// 并把删了多少条如实报给用户，不静默吞掉。

"use client";

import type { Book, BookChapter, ReadingAnnotation, ReadingBookmark, ReadingProgress } from "./reading-types";
import { applyChapterRebuild, loadAllAnnotations, loadBookmarks, loadProgress } from "./reading-storage";
import { loadReadingMarks, replaceReadingMarks } from "./reading-marks";
import { remapReadingAnnotationMemos } from "./reading-memory";
import { buildBookPositionIndex, chapterToBookFraction } from "./reading-progress";
import {
    anchorKey,
    remapChapterIndex,
    remapChapterPosition,
    type RechunkPlan,
} from "./reading-rechunk";

export type RechunkMigrationReport = {
    annotations: { moved: number; dropped: number };
    marks: { moved: number; dropped: number };
    bookmarks: { moved: number; dropped: number };
    memos: { moved: number; dropped: number };
    /** 当前阅读位置搬到新目录后的落点；null = 原位置没有正文可锚，只能回到开头 */
    position: { chapterIndex: number; within: number } | null;
    /** 非致命问题（比如划线写回失败）。空数组 = 一切正常 */
    warnings: string[];
};

/** 迁移前的预检：读出各类数据的条数，好让用户在确认框里看到「会影响多少东西」。 */
export async function previewRechunkImpact(book: Book): Promise<{
    annotations: number;
    marks: number;
    bookmarks: number;
}> {
    const [annotations, marks, bookmarks] = await Promise.all([
        loadAllAnnotations(book.id).catch(() => [] as ReadingAnnotation[]),
        Promise.resolve(loadReadingMarks(book.id)),
        loadBookmarks(book.id).catch(() => [] as ReadingBookmark[]),
    ]);
    return { annotations: annotations.length, marks: marks.length, bookmarks: bookmarks.length };
}

/**
 * 应用重新分组。
 *
 * @param chapters 重建前的章节（用来算旧位置），必须是内存里当前那份，不能是重建后的
 * @param plan     buildRechunkPlan 的结果
 * @param current  当前阅读位置（章号 + 章内比例），重建后要搬到对应位置
 */
export async function applyRechunk(
    book: Book,
    chapters: BookChapter[],
    plan: RechunkPlan,
    current: { chapterIndex: number; within: number },
): Promise<RechunkMigrationReport> {
    const report: RechunkMigrationReport = {
        annotations: { moved: 0, dropped: 0 },
        marks: { moved: 0, dropped: 0 },
        bookmarks: { moved: 0, dropped: 0 },
        memos: { moved: 0, dropped: 0 },
        position: null,
        warnings: [],
    };

    // ── 批注：锚点是「章号 + 段号」，段落原样保留，所以逐条都能对上 ──
    const oldAnnotations = await loadAllAnnotations(book.id).catch(() => [] as ReadingAnnotation[]);
    const nextAnnotations: ReadingAnnotation[] = [];
    for (const annotation of oldAnnotations) {
        const anchor = plan.remap.get(anchorKey(annotation.chapterIndex, annotation.paragraphIndex));
        if (!anchor) {
            report.annotations.dropped += 1;
            continue;
        }
        report.annotations.moved += 1;
        nextAnnotations.push({
            ...annotation,
            chapterIndex: anchor.chapterIndex,
            paragraphIndex: anchor.paragraphIndex,
        });
    }

    // ── 划线：同上，groupId 不动，跨段那一组仍然是同一组 ──
    const oldMarks = loadReadingMarks(book.id);
    const nextMarks = oldMarks.flatMap((mark) => {
        const anchor = plan.remap.get(anchorKey(mark.chapterIndex, mark.paragraphIndex));
        if (!anchor) {
            report.marks.dropped += 1;
            return [];
        }
        report.marks.moved += 1;
        return [{
            ...mark,
            chapterIndex: anchor.chapterIndex,
            paragraphIndex: anchor.paragraphIndex,
        }];
    });

    // ── 书签：存的是章内比例，按比例换算成旧段号再搬到新章 ──
    const oldBookmarks = await loadBookmarks(book.id).catch(() => [] as ReadingBookmark[]);
    const nextBookmarks: ReadingBookmark[] = [];
    for (const bookmark of oldBookmarks) {
        const target = remapChapterPosition(plan, chapters, bookmark.chapterIndex, bookmark.fraction);
        if (!target) {
            report.bookmarks.dropped += 1;
            continue;
        }
        report.bookmarks.moved += 1;
        nextBookmarks.push({
            ...bookmark,
            chapterIndex: target.chapterIndex,
            chapterTitle: plan.chapters[target.chapterIndex]?.title || bookmark.chapterTitle,
            fraction: target.within,
            // 页码是 PDF 的概念，重新分章不开放给 PDF，这里保持原值不动
        });
    }

    // ── 当前阅读位置 + 存盘进度 ──
    const oldProgress = await loadProgress(book.id).catch(() => null);
    const position = remapChapterPosition(plan, chapters, current.chapterIndex, current.within)
        ?? (plan.chapters.length > 0 ? { chapterIndex: 0, within: 0 } : null);
    report.position = position;

    let progress: ReadingProgress | null = null;
    if (position) {
        const index = buildBookPositionIndex(plan.chapters);
        const fraction = chapterToBookFraction(position.chapterIndex, position.within, index);
        progress = {
            bookId: book.id,
            chapterIndex: position.chapterIndex,
            // 翻页模式的 scrollPosition 是「页序号」，而页数要重新分页才知道，
            // 所以落到新章开头（0），由阅读器重新分页后接管；滚动模式存的就是比例，直接沿用。
            scrollPosition: oldProgress?.readingMode === "scroll" ? position.within : 0,
            companionCharacterId: oldProgress?.companionCharacterId,
            progressFraction: fraction,
            // 全书口径的两个数：和阅读器存盘时同一套（跳过的部分也算在里面）
            progressCurrent: Math.max(1, Math.round(fraction * 100)),
            progressTotal: 100,
            progressScope: "book",
            readingMode: oldProgress?.readingMode,
            lastReadAt: new Date().toISOString(),
        };
    }

    // ── 先落 Dexie（一个事务，失败整体回滚），再写 kv ──
    await applyChapterRebuild({
        bookId: book.id,
        chapters: plan.chapters,
        annotations: nextAnnotations,
        bookmarks: nextBookmarks,
        progress,
    });

    try {
        replaceReadingMarks(book.id, nextMarks);
    } catch (err) {
        report.warnings.push(`划线没能写回（${err instanceof Error ? err.message : String(err)}），请重新划一次`);
    }

    // 记忆日志：只存了章号 + 章名，按「旧章第一段落在新哪一章」定位
    try {
        const result = remapReadingAnnotationMemos(book.id, book.title, (oldChapterIndex) => {
            const nextIndex = remapChapterIndex(plan, chapters, oldChapterIndex);
            if (nextIndex === null) return null;
            return {
                chapterIndex: nextIndex,
                chapterTitle: plan.chapters[nextIndex]?.title || "",
            };
        });
        report.memos.moved = result.updated;
        report.memos.dropped = result.dropped;
    } catch (err) {
        report.warnings.push(`记忆日志没能跟着更新（${err instanceof Error ? err.message : String(err)}）`);
    }

    return report;
}

/** 报告里有没有「丢了东西」的情况，决定结果弹窗要不要用警示色 */
export function reportHasLoss(report: RechunkMigrationReport): boolean {
    return report.annotations.dropped > 0
        || report.marks.dropped > 0
        || report.bookmarks.dropped > 0
        || report.memos.dropped > 0
        || report.warnings.length > 0;
}
