// lib/reading-types.ts — Type definitions for the Reading (阅读) feature.

export type Book = {
    id: string;
    title: string;
    author?: string;
    format: "txt" | "epub" | "pdf" | "mobi";
    totalChapters: number;
    createdAt: string;
    /** 置顶时间。有值就排在书架最前面，多本置顶按置顶时间倒序。 */
    pinnedAt?: string;
};

/** EPUB 原书排版：一个块（段落）的块级语义样式。
 *  只有用它解析过的书（EPUB / MOBI）才有；TXT、PDF 与老书没有，渲染时按原来的统一排版走。
 *
 *  这里刻意不存原书的任意 CSS，只保留能跨设备稳定复现的语义档位：
 *  原书 CSS 里的多列、浮动、伪元素会让「段落序号 + 段内字符区间」这套批注锚点失效，
 *  而批注要精确到字。详见 reading-parser.ts 里 EPUB 解析段的说明。 */
export type ReadingBlockStyle = {
    /** 标题级别 1-6（对应原书 h1-h6）。缺省 = 正文 */
    heading?: number;
    /** 块级对齐。缺省 = 跟随全局左对齐 */
    align?: "center" | "right";
    /** 首行缩进档位（字符数）。0 = 不缩进；缺省 = 用全局默认（中文首行缩进两字） */
    indent?: number;
    /** 整块加粗 / 斜体（原书整段用 <b> 包住、或 CSS 指定的情况） */
    bold?: boolean;
    italic?: boolean;
    /** 引用块：左侧竖线 + 缩进 + 略小字号 */
    quote?: boolean;
    /** 题记 / 献词：居中且略小 */
    epigraph?: boolean;
    /** 脚注 / 尾注块：小而淡，和正文区分开 */
    footnote?: boolean;
};

/** 段内字符区间的行内样式。区间是 [start, end)，针对已存下来的段落文字，
 *  所以加粗/斜体不新增也不删掉任何字符，批注/划线的字符锚点不受影响。 */
export type ReadingInlineSpan = {
    start: number;
    end: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    /** 上标（脚注编号）/ 下标 */
    sup?: boolean;
    sub?: boolean;
};

export type BookChapter = {
    id: string;
    bookId: string;
    index: number;
    title: string;
    paragraphs: string[];
    /** EPUB 自带目录里的层级：0 = 顶层，1 = 它的子条目。没有目录的书不给。 */
    tocLevel?: number;
    /** EPUB 原书排版：与 paragraphs 一一对应的块级样式；null / 缺省 = 这段按统一排版渲染 */
    paragraphStyles?: (ReadingBlockStyle | null)[];
    /** EPUB 原书排版：与 paragraphs 一一对应的行内样式区间 */
    paragraphSpans?: (ReadingInlineSpan[] | null)[];
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

/** 一个书签 = 书 + 章 + 章节内位置。位置统一用 0-1 的比例存，
 *  翻页模式和滚动模式都能还原；PDF 另外记页码。 */
export type ReadingBookmark = {
    id: string;
    bookId: string;
    chapterIndex: number;
    /** 存一份加书签时的章节名，章节重建后列表也还认得出 */
    chapterTitle: string;
    fraction: number;
    pdfPage?: number;
    /** 当前位置开头的一小段正文，列表里靠它认出是哪儿 */
    excerpt: string;
    createdAt: string;
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
    /** 谁划的。角色也能在正文上划重点；老数据没有这个字段，都是用户自己划的。 */
    authorType?: "user" | "character";
    /** 角色划的线记下是哪个角色，列表里好显示 */
    characterId?: string;
    characterName?: string;
    /** 跨段划选时，同一次划出来的若干段共用一个 groupId：存储和渲染仍按段落切开
     *  （渲染就不用改），但删除、批注、分享都按整组处理。老数据没有这个字段，
     *  自己就是一组。 */
    groupId?: string;
};

export function isUserAnnotation(annotation: Pick<ReadingAnnotation, "authorType">): boolean {
    return annotation.authorType === "user";
}
