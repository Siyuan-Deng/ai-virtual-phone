"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, Palette, Settings } from "lucide-react";
import { loadBooks, addBook, deleteBook, saveChapters, loadProgress, saveRawFile, countAnnotationsByBook } from "@/lib/reading-storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadReadingCover, saveReadingCover } from "@/lib/reading-appearance";
import { decodeTxtArrayBuffer, parseTxtContent, parseEpubFile, parseMobiFile, PDF_PAGES_PER_CHAPTER } from "@/lib/reading-parser";
import { loadReadingInteractionConfig } from "@/lib/reading-storage";
import type { Book, BookChapter } from "@/lib/reading-types";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import { ContentDialog } from "@/components/ui/modal";
import { ReadingAppearanceDialog, type ReadingAppearanceSaveOptions, type ReadingLoadedFonts } from "./reading-appearance-dialog";
import { ReadingInteractionDialog } from "./reading-interaction-dialog";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";

type Props = {
    onOpenBook: (book: Book) => void;
    onClose: () => void;
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    loadedFonts: ReadingLoadedFonts;
    onSaveAppearance: (appearance: ReadingAppearance, options: ReadingAppearanceSaveOptions) => Promise<void>;
};

/** 封面图最长边。列表里只有几十像素宽，存手机原图纯属浪费 IndexedDB。 */
const COVER_MAX_SIZE = 900;

/** 压缩用户选的封面图。和贴纸压缩同一套路：任何一步不支持就原图存下去。 */
async function compressCoverImage(blob: Blob): Promise<Blob> {
    if (typeof window === "undefined" || typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return blob;
    try {
        const bmp = await createImageBitmap(blob);
        let w = bmp.width;
        let h = bmp.height;
        if (w > COVER_MAX_SIZE || h > COVER_MAX_SIZE) {
            const scale = COVER_MAX_SIZE / Math.max(w, h);
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
        }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) { bmp.close(); return blob; }
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const compressed = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
        return compressed.size > 0 && compressed.size < blob.size ? compressed : blob;
    } catch {
        return blob;
    }
}

const IMPORT_DIAG_KEY = "reading-import-diagnostic-v1";

type ImportDiagnostic = {
    status: "running" | "failed";
    stage: string;
    fileName: string;
    fileSize: number;
    format?: Book["format"];
    detail?: string;
    updatedAt: string;
};

function buildImportError(stage: string, err: unknown, format?: Book["format"]): { summary: string; detail?: string } {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const lower = detail.toLowerCase();

    if (lower.includes("notfounderror") || lower.includes("object store")) {
        return {
            summary: `导入失败，阶段：${stage}。本地阅读数据库结构异常，刷新页面后重试即可自动修复。`,
            detail,
        };
    }

    if (lower.includes("quotaexceeded")) {
        return {
            summary: `导入失败，阶段：${stage}。当前浏览器可用存储空间不足，原始文件没能保存成功。`,
            detail,
        };
    }

    if (lower.includes("database") || lower.includes("indexeddb") || lower.includes("idbdatabase")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器本地数据库写入失败。`,
            detail,
        };
    }

    if (lower.includes("out of memory") || lower.includes("memory") || lower.includes("allocation") || lower.includes("unable to allocate")) {
        return {
            summary: `导入失败，阶段：${stage}。当前手机内存不足，这份${format === "pdf" ? " PDF " : ""}文件对浏览器来说太大了。`,
            detail,
        };
    }

    if (lower.includes("abort") || lower.includes("interrupted")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器中断了这次文件处理，手机上常见于切后台、内存紧张或系统回收。`,
            detail,
        };
    }

    if (lower.includes("failed to load pdf.js") || lower.includes("pdf")) {
        return {
            summary: `导入失败，阶段：${stage}。PDF 引擎没能完成这份文件的读取。`,
            detail,
        };
    }

    return {
        summary: `导入失败，阶段：${stage}。`,
        detail,
    };
}

export function ReadingShelf({ onOpenBook, onClose, appearance, backgroundUrl, loadedFonts, onSaveAppearance }: Props) {
    const [books, setBooks] = useState<Book[]>([]);
    /** bookId → 封面 objectURL；没有封面的书不在这里，走原来那种自己画的封面 */
    const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
    /** bookId → 批注条数（用户 + 角色） */
    const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});
    /** bookId → 伴读角色名。名字一律从角色数据里取，不写死 */
    const [companionNames, setCompanionNames] = useState<Record<string, string>>({});
    const [progressMap, setProgressMap] = useState<Record<string, {
        chapterIndex: number;
        total: number;
        hasProgress: boolean;
        fraction?: number;
        current?: number;
        pageTotal?: number;
        scope?: "book" | "chapter";
    }>>({});
    const [importing, setImporting] = useState(false);
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const [importError, setImportError] = useState<{ summary: string; detail?: string } | null>(null);
    const [search, setSearch] = useState("");
    const [showAppearanceDialog, setShowAppearanceDialog] = useState(false);
    const [showInteractionDialog, setShowInteractionDialog] = useState(false);
    /** 已经有封面的书，点封面先弹这个小菜单（换 / 移除），没封面的直接开相册 */
    const [coverMenuBook, setCoverMenuBook] = useState<Book | null>(null);
    const [coverBusy, setCoverBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    /** 正在设封面的书。存 ref 而不是 state：点完立刻要打开文件选择器，
     *  state 这一拍还没落地，onChange 里就取不到目标书了。 */
    const coverTargetRef = useRef<string | null>(null);

    const persistImportDiagnostic = (payload: ImportDiagnostic | null) => {
        if (typeof window === "undefined") return;
        if (!payload) {
            kvRemove(IMPORT_DIAG_KEY);
            return;
        }
        kvSet(IMPORT_DIAG_KEY, JSON.stringify(payload));
    };

    useEffect(() => {
        const allBooks = loadBooks();
        setBooks(allBooks);
        (async () => {
            const map: typeof progressMap = {};
            const companions: Record<string, string> = {};
            const characters = loadCharacters();
            for (const b of allBooks) {
                const p = await loadProgress(b.id);
                map[b.id] = {
                    chapterIndex: p?.chapterIndex ?? 0,
                    total: b.totalChapters,
                    hasProgress: !!p,
                    fraction: p?.progressFraction,
                    current: p?.progressCurrent,
                    pageTotal: p?.progressTotal,
                    scope: p?.progressScope,
                };
                const companionId = p?.companionCharacterId;
                const companionName = companionId
                    ? characters.find((character) => character.id === companionId)?.name
                    : undefined;
                if (companionName) companions[b.id] = companionName;
            }
            setProgressMap(map);
            setCompanionNames(companions);
            setAnnotationCounts(await countAnnotationsByBook().catch(() => ({})));
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 封面按书逐本取。串行读：这几个资源共用一个 IndexedDB，并发打开会互相 block。
    useEffect(() => {
        let cancelled = false;
        const created: string[] = [];
        (async () => {
            const map: Record<string, string> = {};
            for (const b of books) {
                const blob = await loadReadingCover(b.id).catch(() => null);
                if (cancelled) break;
                if (!blob || blob.size === 0) continue;
                const url = URL.createObjectURL(blob);
                created.push(url);
                map[b.id] = url;
            }
            if (cancelled) { created.forEach(url => URL.revokeObjectURL(url)); return; }
            setCoverUrls(prev => {
                Object.values(prev).forEach(url => URL.revokeObjectURL(url));
                return map;
            });
        })();
        return () => { cancelled = true; };
    }, [books]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = kvGet(IMPORT_DIAG_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw) as ImportDiagnostic;
            if (!saved?.stage || !saved?.updatedAt) return;

            const timeLabel = new Date(saved.updatedAt).toLocaleString();
            const sizeLabel = saved.fileSize > 0 ? `，文件大小约 ${(saved.fileSize / 1024 / 1024).toFixed(1)} MB` : "";
            const summary = saved.status === "running"
                ? `上次导入在「${saved.stage}」阶段中断了。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`
                : `上次导入在「${saved.stage}」阶段失败。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`;
            setImportError({ summary, detail: saved.detail });
        } catch {
            // Ignore broken diagnostics.
        }
    }, []);

    // Dismiss must also clear the persisted diagnostic — it's reloaded on every
    // mount, which is what made the old inline banner impossible to get rid of.
    const dismissImportError = () => {
        setImportError(null);
        persistImportDiagnostic(null);
    };

    /** 换掉一本书的封面图：null 表示恢复成自动生成的那种封面 */
    const applyCover = async (bookId: string, blob: Blob | null) => {
        setCoverBusy(true);
        try {
            await saveReadingCover(bookId, blob);
            const nextUrl = blob ? URL.createObjectURL(blob) : null;
            setCoverUrls(prev => {
                const previous = prev[bookId];
                if (previous) URL.revokeObjectURL(previous);
                const next = { ...prev };
                if (nextUrl) next[bookId] = nextUrl;
                else delete next[bookId];
                return next;
            });
        } catch (err) {
            setImportError({
                summary: "封面保存失败。",
                detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
        } finally {
            setCoverBusy(false);
        }
    };

    const pickCoverFor = (bookId: string) => {
        coverTargetRef.current = bookId;
        coverInputRef.current?.click();
    };

    const handleCoverClick = (book: Book) => {
        // 已有封面的书先问一句，否则误触就把 EPUB 自带封面换掉了，还退不回去
        if (coverUrls[book.id]) setCoverMenuBook(book);
        else pickCoverFor(book.id);
    };

    const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        const bookId = coverTargetRef.current;
        coverTargetRef.current = null;
        if (!file || !bookId) return;
        await applyCover(bookId, await compressCoverImage(file));
    };

    const filteredBooks = search.trim()
        ? books.filter(b => b.title.toLowerCase().includes(search.toLowerCase()) || b.author?.toLowerCase().includes(search.toLowerCase()))
        : books;

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = "";
        setImporting(true);
        setImportError(null);
        setImportStatus("正在准备导入…");
        let importStage = "准备导入";
        const ext = file.name.split(".").pop()?.toLowerCase();
        const isMobiExt = ext === "mobi" || ext === "azw3" || ext === "azw" || ext === "prc";
        const detectedFormat = ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : isMobiExt ? "mobi" : "txt";
        persistImportDiagnostic({
            status: "running",
            stage: importStage,
            fileName: file.name,
            fileSize: file.size,
            format: detectedFormat,
            updatedAt: new Date().toISOString(),
        });

        try {
            let parsed;
            let format: Book["format"];
            let rawFile: Blob | null = null;

            if (ext === "txt") {
                importStage = "读取 TXT 文件";
                setImportStatus("正在读取 TXT 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "txt",
                    updatedAt: new Date().toISOString(),
                });
                const readingConfig = loadReadingInteractionConfig();
                const { text } = decodeTxtArrayBuffer(await file.arrayBuffer(), readingConfig.txtEncoding);
                parsed = parseTxtContent(text, file.name, readingConfig.paragraphMode);
                format = "txt";
            } else if (ext === "epub") {
                importStage = "读取 EPUB 文件";
                setImportStatus("正在读取 EPUB 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                const buffer = await file.arrayBuffer();
                importStage = "解析 EPUB 内容";
                setImportStatus("正在解析 EPUB 内容…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                parsed = await parseEpubFile(buffer, file.name);
                format = "epub";
            } else if (isMobiExt) {
                importStage = "读取 MOBI 文件";
                setImportStatus("正在读取 MOBI 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "mobi",
                    updatedAt: new Date().toISOString(),
                });
                const buffer = await file.arrayBuffer();
                importStage = "解析 MOBI 内容";
                setImportStatus("正在解析 MOBI 内容…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "mobi",
                    updatedAt: new Date().toISOString(),
                });
                parsed = await parseMobiFile(buffer, file.name);
                format = "mobi";
            } else if (ext === "pdf") {
                rawFile = file;
                importStage = "创建 PDF 导入记录";
                setImportStatus("正在创建 PDF 导入记录…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "pdf",
                    updatedAt: new Date().toISOString(),
                });
                parsed = {
                    title: file.name.replace(/\.[^.]+$/, "") || "未命名",
                    chapters: [{ title: `第1-${PDF_PAGES_PER_CHAPTER}页`, paragraphs: [] }],
                    totalPages: 0,
                };
                format = "pdf";
            } else {
                alert("不支持的格式，请上传 TXT、EPUB 或 PDF 文件");
                persistImportDiagnostic(null);
                return;
            }

            const bookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const book: Book = {
                id: bookId,
                title: parsed.title,
                author: parsed.author,
                format,
                totalChapters: parsed.chapters.length,
                createdAt: new Date().toISOString(),
            };

            const chapters: BookChapter[] = parsed.chapters.map((ch, i) => {
                if (format === "pdf") {
                    const pageStart = i * PDF_PAGES_PER_CHAPTER + 1;
                    const totalPages = "totalPages" in parsed ? (parsed as { totalPages: number }).totalPages : pageStart + PDF_PAGES_PER_CHAPTER - 1;
                    const pageEnd = Math.min(pageStart + PDF_PAGES_PER_CHAPTER - 1, totalPages);
                    return {
                        id: `${bookId}_ch${i}`,
                        bookId,
                        index: i,
                        title: ch.title,
                        paragraphs: [],
                        pageStart,
                        pageEnd,
                    };
                }
                return { id: `${bookId}_ch${i}`, bookId, index: i, title: ch.title, paragraphs: ch.paragraphs };
            });

            importStage = "写入书架数据";
            setImportStatus("正在写入书架数据…");
            persistImportDiagnostic({
                status: "running",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                updatedAt: new Date().toISOString(),
            });
            await addBook(book);
            await saveChapters(bookId, chapters);
            if ("cover" in parsed && parsed.cover) {
                await saveReadingCover(bookId, new Blob([parsed.cover.data], { type: parsed.cover.mime }))
                    .catch(() => { /* 封面存不下不该挡住导入 */ });
            }
            if (rawFile) {
                try {
                    importStage = format === "pdf" ? "保存原始 PDF 文件" : "保存原始文件";
                    setImportStatus(format === "pdf" ? "正在保存原始 PDF 文件…" : "正在保存原始文件…");
                    persistImportDiagnostic({
                        status: "running",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        updatedAt: new Date().toISOString(),
                    });
                    await saveRawFile(bookId, rawFile);
                } catch (saveErr) {
                    await deleteBook(bookId).catch(() => {});
                    await saveReadingCover(bookId, null).catch(() => {});
                    const built = buildImportError(importStage, saveErr, format);
                    setImportError(built);
                    persistImportDiagnostic({
                        status: "failed",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        detail: built.detail || built.summary,
                        updatedAt: new Date().toISOString(),
                    });
                    return;
                }
            }
            setBooks(loadBooks());
            setProgressMap(prev => ({ ...prev, [bookId]: { chapterIndex: 0, total: chapters.length, hasProgress: false } }));
            setImportStatus(null);
            persistImportDiagnostic(null);
        } catch (err) {
            console.error("[Reading] Import failed:", err);
            const format = detectedFormat;
            const built = buildImportError(importStage, err, format);
            setImportError(built);
            persistImportDiagnostic({
                status: "failed",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                detail: built.detail || built.summary,
                updatedAt: new Date().toISOString(),
            });
        } finally {
            setImporting(false);
            setImportStatus(null);
        }
    };

    const handleDelete = async (bookId: string) => {
        if (!confirm("确定删除这本书吗？")) return;
        await deleteBook(bookId);
        await saveReadingCover(bookId, null).catch(() => {});
        setBooks(loadBooks());
    };

    const formatBadge = (f: string) => f.toUpperCase();

    const coverGradients = ["linen", "mist", "graphite", "sage", "cream", "parchment"] as const;
    const coverLayouts = ["layout-1", "layout-2", "layout-3", "layout-4"] as const;

    return (
        <div className="reading-app-surface absolute inset-0 z-[100] flex flex-col">
            <header className="reading-shelf-header">
                <div className="reading-shelf-appbar">
                    <button className="reading-shelf-back" type="button" onClick={onClose} aria-label="返回">
                        <ChevronLeft size={22} strokeWidth={2.5} />
                    </button>
                    <div className="reading-shelf-actions">
                        <button className="reading-shelf-action-btn" type="button" onClick={() => setShowInteractionDialog(true)} aria-label="阅读设置">
                            <Settings size={16} strokeWidth={1.7} />
                        </button>
                        <button className="reading-shelf-action-btn" type="button" onClick={() => setShowAppearanceDialog(true)} aria-label="阅读外观">
                            <Palette size={16} strokeWidth={1.7} />
                        </button>
                        <label className="reading-shelf-action-btn reading-shelf-action-primary" style={{ cursor: "pointer" }}>
                            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 5v14M5 12h14" />
                            </svg>
                            <input ref={fileRef} type="file" accept=".txt,.epub,.mobi,.azw3,.prc,.pdf" onChange={handleFileUpload} className="hidden" disabled={importing} />
                        </label>
                    </div>
                </div>
                <div className="reading-shelf-title-stack">
                    <h1 className="reading-shelf-title">书架</h1>
                    <span className="reading-shelf-subtitle">{books.length} BOOKS IN YOUR LIBRARY</span>
                </div>
            </header>

            <div className="reading-shelf-body">
                <div className="px-4 pb-3">
                    <div className="reading-search-bar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={`搜索 ${books.length} 本书`}
                            className="reading-search-input"
                        />
                    </div>
                </div>

                {importing && (
                    <div className="text-center ts-13 py-2" style={{ color: "var(--reading-warm-brown, #8a5a2b)" }}>
                        {importStatus ? `导入中：${importStatus}` : "导入中..."}
                    </div>
                )}
                {importError && (
                    <div className="modal-overlay" data-ui="modal" onClick={dismissImportError}>
                        <div className="reading-import-error-card reading-import-error-dialog" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="reading-import-error-close" onClick={dismissImportError} aria-label="关闭">✕</button>
                            <div className="reading-import-error-kicker">IMPORT ERROR</div>
                            <div className="ts-13 font-medium" style={{ color: "#2f261f" }}>导入失败</div>
                            <div className="ts-12 mt-1" style={{ color: "#7f7266" }}>{importError.summary}</div>
                            {importError.detail && (
                                <div className="ts-11 mt-2 break-all reading-import-error-detail" style={{ color: "#a39487" }}>{importError.detail}</div>
                            )}
                            <button type="button" className="reading-import-error-ok" onClick={dismissImportError}>知道了</button>
                        </div>
                    </div>
                )}

                {filteredBooks.length === 0 ? (
                    <div className="py-10 text-center ts-14" style={{ color: "var(--reading-warm-ink-tertiary, #999)" }}>
                        {books.length === 0 ? "还没有书籍，点右上角 + 导入" : "没有匹配的书籍"}
                    </div>
                ) : (
                    <div className="reading-book-list">
                        {filteredBooks.map(book => {
                            const prog = progressMap[book.id];
                            const fallbackFraction = prog?.hasProgress && prog.total > 0
                                ? Math.min(1, Math.max(0, (prog.chapterIndex + 1) / prog.total))
                                : 0;
                            const progressFraction = prog?.hasProgress
                                ? Math.min(1, Math.max(0, prog.fraction ?? fallbackFraction))
                                : 0;
                            const progressPct = Math.round(progressFraction * 100);
                            const progressMeta = !prog?.hasProgress
                                ? null
                                : prog.scope === "book" && prog.current && prog.pageTotal
                                    ? `${prog.current}/${prog.pageTotal}`
                                    : prog.current && prog.pageTotal
                                        ? `第${Math.max(1, prog.chapterIndex + 1)}章 · ${prog.current}/${prog.pageTotal}`
                                        : `第${Math.max(1, prog.chapterIndex + 1)}/${Math.max(1, prog.total)}章`;
                            const gradient = coverGradients[book.title.length % coverGradients.length];
                            const layout = coverLayouts[(book.title.length + (book.author?.length || 0)) % coverLayouts.length];
                            return (
                                <div key={book.id} className="reading-list-item" onClick={() => onOpenBook(book)}>
                                    {/* 点封面是换封面，不是打开书 */}
                                    <button
                                        type="button"
                                        className="reading-list-cover-btn"
                                        onClick={(e) => { e.stopPropagation(); handleCoverClick(book); }}
                                        disabled={coverBusy}
                                        aria-label={`设置《${book.title}》的封面`}
                                    >
                                        {coverUrls[book.id] ? (
                                            <div className="reading-list-cover reading-list-cover--image">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={coverUrls[book.id]} alt="" />
                                            </div>
                                        ) : (
                                            <div className={`reading-list-cover reading-list-cover--${gradient} reading-list-cover--${layout}`}>
                                                <span className="reading-list-cover-author">{book.author || ""}</span>
                                                <span className="reading-list-cover-title">{book.title}</span>
                                            </div>
                                        )}
                                    </button>
                                    <div className="reading-list-info">
                                        <span className="reading-list-title">{book.title}</span>
                                        {book.author && <span className="reading-list-author">{book.author}</span>}
                                        <div className="reading-list-meta">
                                            <span className="reading-list-badge">{formatBadge(book.format)}</span>
                                            <span>{book.totalChapters}章</span>
                                            {annotationCounts[book.id] ? (
                                                <span className="reading-list-badge">批注 {annotationCounts[book.id]}条</span>
                                            ) : null}
                                            {companionNames[book.id] ? (
                                                <span className="reading-list-badge">伴读 {companionNames[book.id]}</span>
                                            ) : null}
                                        </div>
                                        <div className="reading-list-progress-row">
                                            <span className="reading-list-progress-label">
                                                {prog?.hasProgress ? `阅读进度 ${progressPct}%` : "未开始阅读"}
                                            </span>
                                            {progressMeta && (
                                                <span className="reading-list-progress-meta">
                                                    {progressMeta}
                                                </span>
                                            )}
                                        </div>
                                        <div className="reading-list-progress-track" aria-hidden="true">
                                            <div className="reading-list-progress-fill" style={{ width: `${prog?.hasProgress ? progressPct : 0}%` }} />
                                        </div>
                                    </div>
                                    <button
                                        className="reading-list-delete"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(book.id); }}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                        </svg>
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="reading-shelf-footer">
                    共 {books.length} 本书籍
                </div>
            </div>

            <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { void handleCoverFileChange(e); }}
            />

            {coverMenuBook && (
                <ContentDialog
                    title="封面"
                    confirmLabel=""
                    cancelLabel="取消"
                    onConfirm={() => setCoverMenuBook(null)}
                    onCancel={() => setCoverMenuBook(null)}
                >
                    <div className="reading-settings-grid">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            disabled={coverBusy}
                            onClick={() => {
                                const target = coverMenuBook.id;
                                setCoverMenuBook(null);
                                pickCoverFor(target);
                            }}
                        >
                            从相册选择图片
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            disabled={coverBusy}
                            onClick={() => {
                                const target = coverMenuBook.id;
                                setCoverMenuBook(null);
                                void applyCover(target, null);
                            }}
                        >
                            移除封面，恢复默认样式
                        </button>
                    </div>
                </ContentDialog>
            )}

            {showAppearanceDialog && (
                <ReadingAppearanceDialog
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    loadedFonts={loadedFonts}
                    onClose={() => setShowAppearanceDialog(false)}
                    onSave={onSaveAppearance}
                />
            )}

            {showInteractionDialog && (
                <ReadingInteractionDialog onClose={() => setShowInteractionDialog(false)} />
            )}
        </div>
    );
}
