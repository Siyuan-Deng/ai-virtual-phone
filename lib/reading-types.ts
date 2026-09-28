// lib/reading-types.ts — Type definitions for the Reading (阅读) feature.

export type Book = {
    id: string;
    title: string;
    author?: string;
    format: "txt" | "epub" | "pdf" | "mobi";
    totalChapters: number;
    createdAt: string;
};

export type BookChapter = {
    id: string;
    bookId: string;
    index: number;
    title: string;
    paragraphs: string[];
    /** EPUB 自带目录里的层级：0 = 顶层，1 = 它的子条目。没有目录的书不给。 */
    tocLevel?: number;
    /** PDF only: synthetic page chunk start (1-based) */
    pageStart?: number;
    /** PDF only: synthetic page chunk end (1-based) */
    pageEnd?: number;
    /** PDF only: page number (1-based) for each paragraph */
    paragraphPages?: number[];
    /** PDF only: vertical position (0-1 ratio) within page for each paragraph */
    paragraphYPositions?: number[];
};

export type ReadingProgress = {
    bookId: string;
    chapterIndex: number;
    scrollPosition: number;
    companionCharacterId?: string;
    progressFraction?: number;
    progressCurrent?: number;
    progressTotal?: number;
    progressScope?: "book" | "chapter";
    /** 保存进度时的阅读模式；滚动模式下 scrollPosition 存的是章节内滚动比例(0-1) */
    readingMode?: "page" | "scroll";
    lastReadAt: string;
};

export type ReadingAnnotation = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    characterId: string;
    characterName: string;
    content: string;
    createdAt: string;
    /** 批注作者。缺省即角色批注——存量数据没有这个字段，读出来仍按角色处理。
     *  用户批注沿用 characterId/characterName 记录「这条是写给哪个角色看的」。 */
    authorType?: "user" | "character";
    /** 批注锚定的原文片段。用户批注是自己选中的那段；角色批注是模型在
     *  [批注:段落序号|原文片段] 里给出的片段。缺省即整段批注（老数据都是这样）。 */
    quote?: string;
    /** quote 在所属段落中的字符区间（含头不含尾）。定位不到时不写。 */
    quoteStart?: number;
    quoteEnd?: number;
};

/** 荧光笔 / 划线。按「段落内字符区间」锚定；纯阅读标记，不进记忆。 */
export type ReadingMarkStyle = "highlight" | "underline";

export type ReadingMark = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    /** 段落内的字符区间（含头不含尾） */
    start: number;
    end: number;
    text: string;
    style: ReadingMarkStyle;
    createdAt: string;
    /** 跨段划选时，同一次划出来的若干段共用一个 groupId：存储和渲染仍按段落切开
     *  （渲染就不用改），但删除、批注、分享都按整组处理。老数据没有这个字段，
     *  自己就是一组。 */
    groupId?: string;
};

export function isUserAnnotation(annotation: Pick<ReadingAnnotation, "authorType">): boolean {
    return annotation.authorType === "user";
}
