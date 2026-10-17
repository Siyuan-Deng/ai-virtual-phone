// lib/reading-rechunk.ts — 自定义分章：把整本书摊平成段落序列，再按「节点」重新分组。
//
// 为什么这样做而不是重跑一遍解析器：
//  · 重跑解析（换个分章正则重新切 TXT / 重新读 EPUB）会换掉段落本身，
//    批注和划线锚的是「章号 + 段号 + 字符区间」，段落一变这些锚点就全废了。
//  · 摊平后重新分组，段落对象是原样搬过去的，段号只是换了归属，
//    所以每一个锚点都能精确算出新位置（字符偏移完全不受影响）。
//
// 代价是「只能挪边界，不能改正文」。这正好覆盖需求：嫌默认分章不对，就调边界。
//
// 纯函数、不碰存储。落库与迁移见 lib/reading-rechunk-apply.ts。

import type { BookChapter, ReadingBlockStyle, ReadingInlineSpan } from "./reading-types";

/** 摊平后的一段正文：带上它在原书里的位置和原书排版信息 */
export type FlatReadingParagraph = {
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
    /** 原书排版：块级样式（没有就是 null） */
    style: ReadingBlockStyle | null;
    /** 原书排版：行内样式区间 */
    spans: ReadingInlineSpan[] | null;
    /** 嵌在句子里的行内小图（脚注角标这类） */
    inlineImages: number[] | null;
    /** PDF 用：所在页与页内纵向位置（重新分章目前不开放给 PDF，留着是为了数据结构对称） */
    pageNum?: number;
    yRatio?: number;
};

/** 一章的草稿：从全书第 start 段开始，到下一个节点之前。 */
export type RechunkDraft = {
    /** 全书连续段号（0 基） */
    start: number;
    title: string;
};

export type RechunkAnchor = { chapterIndex: number; paragraphIndex: number };

export type RechunkPlan = {
    /** 重新分组后的章节（id 按 `${bookId}_ch${i}` 重新生成） */
    chapters: BookChapter[];
    /** 旧锚点 → 新锚点。key 见 anchorKey() */
    remap: Map<string, RechunkAnchor>;
    /** 全书段落总数 */
    totalParagraphs: number;
};

export function anchorKey(chapterIndex: number, paragraphIndex: number): string {
    return `${chapterIndex}:${paragraphIndex}`;
}

/** 逐段对齐的数组只有在长度对得上时才可信——对不上说明是旧数据或被裁错过，
 *  当它不存在（和阅读器里渲染时的判断保持一致，否则这里搬得动、那边不认）。 */
function alignedArray<T>(list: T[] | undefined, length: number): T[] | null {
    return Array.isArray(list) && list.length === length ? list : null;
}

/** 把整本书摊成一条段落序列。插图的占位段（￼img:…）也是普通段落，照样保留。 */
export function flattenReadingParagraphs(chapters: BookChapter[]): FlatReadingParagraph[] {
    const out: FlatReadingParagraph[] = [];
    chapters.forEach((chapter, chapterIndex) => {
        const length = chapter.paragraphs.length;
        const styles = alignedArray(chapter.paragraphStyles, length);
        const spans = alignedArray(chapter.paragraphSpans, length);
        const inline = alignedArray(chapter.paragraphInlineImages, length);
        const pages = alignedArray(chapter.paragraphPages, length);
        const positions = alignedArray(chapter.paragraphYPositions, length);
        chapter.paragraphs.forEach((text, paragraphIndex) => {
            out.push({
                chapterIndex,
                paragraphIndex,
                text,
                style: styles?.[paragraphIndex] ?? null,
                spans: spans?.[paragraphIndex] ?? null,
                inlineImages: inline?.[paragraphIndex] ?? null,
                ...(pages ? { pageNum: pages[paragraphIndex] } : {}),
                ...(positions ? { yRatio: positions[paragraphIndex] } : {}),
            });
        });
    });
    return out;
}

/** 当前目录对应的切分草稿。空章节不占段位，因此也不会出现在草稿里
 *  （应用之后它会被删掉——编辑器会就此给出提示）。 */
export function buildRechunkDrafts(chapters: BookChapter[]): RechunkDraft[] {
    const drafts: RechunkDraft[] = [];
    let flat = 0;
    chapters.forEach((chapter, index) => {
        if (chapter.paragraphs.length === 0) return;
        drafts.push({ start: flat, title: (chapter.title || "").trim() || `第${index + 1}章` });
        flat += chapter.paragraphs.length;
    });
    return drafts;
}

/** 用户标出来的一个分章节点（划线 → 设置节点）。锚点和批注一样是「章号 + 段号」。 */
export type CustomSplitAnchor = { chapterIndex: number; paragraphIndex: number; title?: string };

/** 每章的第一段在全书里的连续段号。 */
export function chapterFlatOffsets(chapters: BookChapter[]): number[] {
    const offsets: number[] = new Array(chapters.length);
    let acc = 0;
    chapters.forEach((chapter, index) => {
        offsets[index] = acc;
        acc += chapter.paragraphs.length;
    });
    return offsets;
}

/** 节点锚点 → 全书连续段号。锚点落在空章节/越界位置时返回 null（这种节点没法落地）。 */
export function anchorToFlatIndex(chapters: BookChapter[], anchor: CustomSplitAnchor): number | null {
    const chapter = chapters[anchor.chapterIndex];
    if (!chapter || chapter.paragraphs.length === 0) return null;
    const within = Math.max(0, Math.min(chapter.paragraphs.length - 1, Math.trunc(anchor.paragraphIndex)));
    return chapterFlatOffsets(chapters)[anchor.chapterIndex] + within;
}

/**
 * 把「自动目录 + 用户节点」合成一份切分草稿。
 *
 * 两种模式：
 *  · merge（默认）：保留自动分章的所有边界，用户节点作为**额外的**边界插进去——
 *    这样在一本几百章的书里标几处，不会把其余章节全并成一章；
 *  · only：完全按用户节点切，自动边界全部丢掉（节点太少时会切出很长的章，界面上有提示）。
 *
 * 节点上写的章名只作用于「从这一段开头的那一章」；merge 模式下如果自动边界正好落在同一段，
 * 以用户的章名为准。
 */
export function buildDraftsFromNodes(
    chapters: BookChapter[],
    nodes: CustomSplitAnchor[],
    mode: "merge" | "only",
): { drafts: RechunkDraft[]; warnings: string[] } {
    const warnings: string[] = [];
    const nodeStarts = new Map<number, string>();
    for (const node of nodes) {
        const flat = anchorToFlatIndex(chapters, node);
        if (flat === null) {
            warnings.push(`有一处节点落在空章节里（第${node.chapterIndex + 1}章），已忽略`);
            continue;
        }
        const title = (node.title || "").trim();
        // 同一段上两处节点：保留第一个有名字的
        if (!nodeStarts.has(flat) || (title && !nodeStarts.get(flat))) nodeStarts.set(flat, title);
    }

    if (mode === "only") {
        if (nodeStarts.size === 0) {
            return { drafts: [{ start: 0, title: "" }], warnings: ["还没有设置任何节点，暂时只能切成全文一章"] };
        }
        const drafts = [...nodeStarts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([start, title]) => ({ start, title }));
        return { drafts, warnings };
    }

    const auto = buildRechunkDrafts(chapters);
    const merged = new Map<number, string>();
    for (const draft of auto) merged.set(draft.start, draft.title);
    for (const [start, title] of nodeStarts) {
        if (title) merged.set(start, title);
        else if (!merged.has(start)) merged.set(start, "");
    }
    const drafts = [...merged.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, title]) => ({ start, title }));
    return { drafts, warnings };
}

/** 分章应用后，把节点锚点搬到新目录上（否则列表里那几个节点会指着旧章号）。 */
export function remapCustomSplitNodes<T extends CustomSplitAnchor>(
    plan: RechunkPlan,
    nodes: T[],
): { nodes: T[]; dropped: number } {
    const next: T[] = [];
    let dropped = 0;
    for (const node of nodes) {
        const anchor = plan.remap.get(anchorKey(node.chapterIndex, node.paragraphIndex));
        if (!anchor) {
            dropped += 1;
            continue;
        }
        // 连同 id / quote / createdAt 一起搬：列表里那几行改完目录还得是同一批节点
        next.push({ ...node, chapterIndex: anchor.chapterIndex, paragraphIndex: anchor.paragraphIndex });
    }
    return { nodes: next, dropped };
}

/** 清洗用户改过的草稿：夹到合法范围、去重、排序、补第一段。
 *  返回的 warnings 是给用户看的说明，不是异常——这些情况都能安全继续。 */
export function normalizeRechunkDrafts(
    drafts: RechunkDraft[],
    totalParagraphs: number,
): { drafts: RechunkDraft[]; warnings: string[] } {
    const warnings: string[] = [];
    const seen = new Set<number>();
    const cleaned: RechunkDraft[] = [];

    for (const draft of drafts) {
        const raw = Number(draft.start);
        if (!Number.isFinite(raw)) {
            warnings.push("有一处段号不是数字，已忽略");
            continue;
        }
        const start = Math.trunc(raw);
        if (start < 0) {
            warnings.push(`段号 ${start + 1} 小于 1，已按第 1 段处理`);
        }
        const bounded = Math.max(0, start);
        if (bounded >= totalParagraphs) {
            warnings.push(`段号 ${bounded + 1} 超过了全书 ${totalParagraphs} 段，已忽略`);
            continue;
        }
        if (seen.has(bounded)) {
            warnings.push(`段号 ${bounded + 1} 重复出现，只保留第一处`);
            continue;
        }
        seen.add(bounded);
        cleaned.push({ start: bounded, title: (draft.title || "").trim() });
    }

    cleaned.sort((a, b) => a.start - b.start);

    // 第一段必须是一个新章节的开头，否则最前面那几段会没有归属
    if (cleaned.length === 0) {
        cleaned.push({ start: 0, title: "" });
    } else if (cleaned[0].start !== 0) {
        cleaned.unshift({ start: 0, title: "" });
        warnings.push("第一个节点不在开头，已自动补上「开篇」");
    }

    cleaned.forEach((draft, index) => {
        if (!draft.title) draft.title = cleaned.length === 1 ? "全文" : `第${index + 1}章`;
    });

    return { drafts: cleaned, warnings };
}

/** 按草稿重新分组，并算出「旧锚点 → 新锚点」的完整映射。
 *
 *  映射是这里最要紧的产物：批注、划线、书签、记忆日志全靠它跟着搬家。
 *  因为段落序列原样保留，映射是全覆盖的（数学上不可能有漏项）。 */
export function buildRechunkPlan(
    bookId: string,
    chapters: BookChapter[],
    drafts: RechunkDraft[],
): RechunkPlan {
    const flat = flattenReadingParagraphs(chapters);
    const normalized = normalizeRechunkDrafts(drafts, flat.length).drafts;
    const remap = new Map<string, RechunkAnchor>();
    const next: BookChapter[] = [];

    normalized.forEach((draft, chapterIndex) => {
        const end = chapterIndex + 1 < normalized.length ? normalized[chapterIndex + 1].start : flat.length;
        const slice = flat.slice(draft.start, end);
        if (slice.length === 0) return; // 空章不落地（重复节点已在清洗阶段去掉）

        // 逐段对齐的四条数组：只有真的存在才写，避免给整本书平添一堆空数组
        const styles: (ReadingBlockStyle | null)[] = [];
        const spans: (ReadingInlineSpan[] | null)[] = [];
        const inline: (number[] | null)[] = [];
        const pages: number[] = [];
        const positions: number[] = [];
        let hasStyle = false;
        let hasSpan = false;
        let hasInline = false;
        let hasPage = false;
        let hasPosition = false;

        slice.forEach((paragraph, paragraphIndex) => {
            styles.push(paragraph.style);
            spans.push(paragraph.spans);
            inline.push(paragraph.inlineImages);
            if (paragraph.style) hasStyle = true;
            if (paragraph.spans && paragraph.spans.length > 0) hasSpan = true;
            if (paragraph.inlineImages && paragraph.inlineImages.length > 0) hasInline = true;
            if (typeof paragraph.pageNum === "number") {
                pages.push(paragraph.pageNum);
                hasPage = true;
            }
            if (typeof paragraph.yRatio === "number") {
                positions.push(paragraph.yRatio);
                hasPosition = true;
            }
            remap.set(anchorKey(paragraph.chapterIndex, paragraph.paragraphIndex), {
                chapterIndex: next.length,
                paragraphIndex,
            });
        });

        next.push({
            id: `${bookId}_ch${next.length}`,
            bookId,
            index: next.length,
            title: draft.title,
            paragraphs: slice.map((paragraph) => paragraph.text),
            ...(hasStyle ? { paragraphStyles: styles } : {}),
            ...(hasSpan ? { paragraphSpans: spans } : {}),
            ...(hasInline ? { paragraphInlineImages: inline } : {}),
            ...(hasPage ? { paragraphPages: pages } : {}),
            ...(hasPosition ? { paragraphYPositions: positions } : {}),
        });
    });

    return { chapters: next, remap, totalParagraphs: flat.length };
}

/** 旧章节里的一个位置 → 新章节里的对应位置（用于书签、进度这类「章内比例」）。
 *  找不到（老章节本身是空的）就返回 null，调用方按「无法迁移」处理。 */
export function remapChapterPosition(
    plan: RechunkPlan,
    chapters: BookChapter[],
    oldChapterIndex: number,
    within: number,
): { chapterIndex: number; within: number } | null {
    const oldLength = chapters[oldChapterIndex]?.paragraphs.length ?? 0;
    if (oldLength <= 0) return null;
    const clamped = Math.min(1, Math.max(0, Number.isFinite(within) ? within : 0));
    const oldParagraph = Math.min(oldLength - 1, Math.floor(clamped * oldLength));
    const anchor = plan.remap.get(anchorKey(oldChapterIndex, oldParagraph));
    if (!anchor) return null;
    const newLength = plan.chapters[anchor.chapterIndex]?.paragraphs.length ?? 0;
    return {
        chapterIndex: anchor.chapterIndex,
        within: newLength > 0 ? anchor.paragraphIndex / newLength : 0,
    };
}

/** 只关心「第几章」的调用（记忆日志）用这个：拿旧章第一段定位新章。 */
export function remapChapterIndex(
    plan: RechunkPlan,
    chapters: BookChapter[],
    oldChapterIndex: number,
): number | null {
    const oldLength = chapters[oldChapterIndex]?.paragraphs.length ?? 0;
    if (oldLength <= 0) return null;
    return plan.remap.get(anchorKey(oldChapterIndex, 0))?.chapterIndex ?? null;
}

/** 草稿和当前目录是否完全一致（一致就没必要落库） */
export function isSameLayout(chapters: BookChapter[], drafts: RechunkDraft[]): boolean {
    const current = buildRechunkDrafts(chapters);
    if (current.length !== drafts.length) return false;
    return current.every((draft, index) =>
        draft.start === drafts[index].start && draft.title === drafts[index].title,
    );
}

/** 列表模式 ↔ 文本模式互转。行格式：`起始段号|标题`，段号从 1 数起（给人看的）。 */
export function draftsToText(drafts: RechunkDraft[]): string {
    return drafts.map((draft) => `${draft.start + 1}|${draft.title}`).join("\n");
}

export function textToDrafts(text: string): RechunkDraft[] {
    const drafts: RechunkDraft[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const separator = trimmed.search(/[|｜]/);
        const numberPart = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
        const titlePart = separator >= 0 ? trimmed.slice(separator + 1) : "";
        const parsed = Number(numberPart.replace(/[^\d]/g, ""));
        if (!Number.isFinite(parsed) || parsed <= 0) continue;
        drafts.push({ start: parsed - 1, title: titlePart.trim() });
    }
    return drafts;
}
