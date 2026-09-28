"use client";

import type { Book, BookChapter, ReadingAnnotation, ReadingMark } from "./reading-types";
import { isUserAnnotation } from "./reading-types";

export type AnnotationExportInput = {
    book: Book;
    chapters: BookChapter[];
    annotations: ReadingAnnotation[];
    marks: ReadingMark[];
    /** 用户批注署名。角色批注署角色自己的名字，都不写死。 */
    userName: string;
    exportedAt?: Date;
};

const MARK_LABEL: Record<ReadingMark["style"], string> = {
    highlight: "高亮",
    underline: "划线",
};

function formatDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 整本书的批注和标记导出成 Markdown。按章节、章节内按段落顺序排。 */
export function buildAnnotationMarkdown(input: AnnotationExportInput): string {
    const { book, chapters, annotations, marks, userName } = input;
    const lines: string[] = [
        `# 《${book.title}》批注`,
        "",
        `> 导出于 ${formatDate(input.exportedAt ?? new Date())}`,
        `> 批注 ${annotations.length} 条 · 标记 ${marks.length} 处`,
        "",
    ];

    const sorted = [...chapters].sort((a, b) => a.index - b.index);
    let wroteAny = false;

    for (const chapter of sorted) {
        const chapterAnnotations = annotations
            .filter(item => item.chapterIndex === chapter.index)
            .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.createdAt.localeCompare(b.createdAt));
        const chapterMarks = marks
            .filter(item => item.chapterIndex === chapter.index)
            .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.start - b.start);
        if (chapterAnnotations.length === 0 && chapterMarks.length === 0) continue;

        wroteAny = true;
        lines.push(`## ${chapter.title?.trim() || `第${chapter.index + 1}章`}`, "");

        for (const annotation of chapterAnnotations) {
            if (annotation.quote) lines.push(`> ${annotation.quote.replace(/\n+/g, " ")}`, "");
            const who = isUserAnnotation(annotation) ? userName : (annotation.characterName || "TA");
            lines.push(`**${who}**：${annotation.content.replace(/\n+/g, " ")}`, "");
        }

        if (chapterMarks.length > 0) {
            lines.push("### 标记", "");
            for (const mark of chapterMarks) {
                lines.push(`- ${MARK_LABEL[mark.style]}：${mark.text.replace(/\n+/g, " ")}`);
            }
            lines.push("");
        }
    }

    if (!wroteAny) lines.push("（这本书还没有任何批注或标记）", "");
    return lines.join("\n");
}

export function annotationExportFileName(book: Book): string {
    // 文件名里的这些字符在各平台上都不安全，统一换成下划线
    const safe = book.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
    return `${safe}-批注.md`;
}
