"use client";

// 每本书的「更多设置」：正文排版 + 自定义章节目录 + 章节重命名。
//
// 三个部分刻意放同一个页面里，但都不在这里「随点随改正文」：
//  · 排版：改的是这本书自己的覆盖值（见 lib/reading-book-settings），保存即生效；
//  · 自定义章节目录：节点是在正文里划线、点「设置节点」标出来的（阅读页那个菜单），
//    这里只负责按书内顺序列出来、改名、删除，最后统一应用；
//  · 章节重命名：只改章名，不碰分段，所以不需要重建目录。
// 重建目录走的是 lib/reading-rechunk 那套纯计算 + applyRechunk 的锚点搬家，
// 正文一个字都不动，批注/划线/书签跟着段落走。

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, Info, ListTree, Scissors, Type } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/form";
import type { Book, BookChapter } from "@/lib/reading-types";
import {
    loadReadingAppearance,
    READING_FIRST_LINE_INDENT_MAX,
    READING_PAGE_PADDING_MAX,
} from "@/lib/reading-appearance";
import {
    loadReadingBookSettings,
    removeReadingSplitNode,
    saveReadingBookTypography,
    saveReadingSplitNodes,
    updateReadingSplitNode,
    READING_BOOK_FONT_SIZE_MIN,
    READING_BOOK_FONT_SIZE_MAX,
    READING_BOOK_LINE_HEIGHT_MIN,
    READING_BOOK_LINE_HEIGHT_MAX,
    type ReadingBookTypography,
    type ReadingSplitMode,
    type ReadingSplitNode,
} from "@/lib/reading-book-settings";
import { buildDraftsFromNodes, buildRechunkPlan, remapCustomSplitNodes, type RechunkPlan } from "@/lib/reading-rechunk";
import { applyRechunk, previewRechunkImpact, reportHasLoss, type RechunkMigrationReport } from "@/lib/reading-rechunk-apply";
import { saveChapters } from "@/lib/reading-storage";

type Props = {
    book: Book;
    chapters: BookChapter[];
    /** 当前阅读位置（章号 + 章内比例），重建目录后要跟着走 */
    current: { chapterIndex: number; within: number };
    onClose: () => void;
    /** 目录重建完成（章节数组已换） */
    onApplied: (chapters: BookChapter[], position: { chapterIndex: number; within: number } | null) => void;
    /** 只改了章名：章节数组换了，但阅读位置不动 */
    onChaptersRenamed: (chapters: BookChapter[]) => void;
    /** 从节点列表跳到那一段 */
    onJumpToNode: (chapterIndex: number) => void;
};

function label(chapter: BookChapter | undefined, index: number): string {
    return chapter?.title?.trim() || `第${index + 1}章`;
}

export function ReadingBookSettings({
    book, chapters, current, onClose, onApplied, onChaptersRenamed, onJumpToNode,
}: Props) {
    const [settings, setSettings] = useState(() => loadReadingBookSettings(book.id));
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [renameIndex, setRenameIndex] = useState(() => Math.min(Math.max(0, current.chapterIndex), Math.max(0, chapters.length - 1)));
    const [renameDraft, setRenameDraft] = useState("");
    const [pending, setPending] = useState<{
        plan: RechunkPlan;
        impact: { annotations: number; marks: number; bookmarks: number };
    } | null>(null);
    const [report, setReport] = useState<{ report: RechunkMigrationReport; chapters: BookChapter[] } | null>(null);

    const globalAppearance = useMemo(() => loadReadingAppearance(), []);
    const typography: ReadingBookTypography = settings.typography || {};
    const nodes: ReadingSplitNode[] = settings.splitNodes || [];
    const mode: ReadingSplitMode = settings.splitMode || "merge";

    const effective = {
        fontSize: typography.fontSize ?? globalAppearance.fontSize,
        lineHeight: typography.lineHeight ?? globalAppearance.lineHeight,
        firstLineIndent: typography.firstLineIndent ?? globalAppearance.firstLineIndent ?? 2,
        pagePaddingX: typography.pagePaddingX ?? globalAppearance.pagePaddingX ?? 0,
        textAlign: typography.textAlign ?? globalAppearance.textAlign ?? "left",
    } as const;

    const patchTypography = (patch: ReadingBookTypography) => {
        const next = saveReadingBookTypography(book.id, { ...typography, ...patch });
        setSettings(next);
    };

    const resetTypography = () => {
        const next = saveReadingBookTypography(book.id, {});
        setSettings(next);
        setNote("这本书的排版已恢复为跟随全局外观。");
    };

    const changeMode = (nextMode: ReadingSplitMode) => {
        const next = saveReadingSplitNodes(book.id, nodes, nextMode);
        setSettings(next);
    };

    const applyNodeTitle = (nodeId: string, title: string) => {
        // 输入过程中不落库：每敲一个字都写一次 kv、再派发一次事件，阅读器会跟着重排
        setSettings((prev) => ({
            ...prev,
            splitNodes: (prev.splitNodes || []).map((node) => (node.id === nodeId ? { ...node, title } : node)),
        }));
    };

    const commitNodeTitle = (nodeId: string, title: string) => {
        const next = updateReadingSplitNode(book.id, nodeId, { title: title.trim() });
        setSettings(next);
    };

    const deleteNode = (nodeId: string) => {
        const next = removeReadingSplitNode(book.id, nodeId);
        setSettings(next);
        setNote("节点已删除（还没有应用到目录，随时可以再标一处）。");
    };

    const saveRename = async () => {
        const target = chapters[renameIndex];
        if (!target) return;
        const title = renameDraft.trim();
        if (!title || title === target.title) { setNote("章名没有变化。"); return; }
        const next = chapters.map((chapter, index) => (index === renameIndex ? { ...chapter, title } : chapter));
        try {
            setBusy(true);
            await saveChapters(book.id, next);
            onChaptersRenamed(next);
            setNote(`第${renameIndex + 1}章已改名为「${title}」。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "改名失败");
        } finally {
            setBusy(false);
        }
    };

    const openConfirm = useCallback(async () => {
        setError(null);
        const built = buildDraftsFromNodes(chapters, nodes, mode);
        if (built.drafts.length === 0) {
            setError("这样切下来一章都不剩，请检查分章节点。");
            return;
        }
        const plan = buildRechunkPlan(book.id, chapters, built.drafts);
        if (plan.chapters.length === 0) {
            setError("这样切下来一章都不剩，请检查分章节点。");
            return;
        }
        setBusy(true);
        try {
            const impact = await previewRechunkImpact(book);
            setPending({ plan, impact });
        } catch (err) {
            setError(err instanceof Error ? err.message : "读取现有批注失败");
        } finally {
            setBusy(false);
        }
    }, [book, chapters, mode, nodes]);

    const runApply = async () => {
        if (!pending) return;
        setBusy(true);
        setError(null);
        try {
            const result = await applyRechunk(book, chapters, pending.plan, current);
            // 节点锚点也跟着搬到新目录，否则列表里那几个节点会指着旧章号
            const remapped = remapCustomSplitNodes(pending.plan, nodes);
            const nextSettings = saveReadingSplitNodes(book.id, remapped.nodes, mode);
            setSettings(nextSettings);
            setReport({ report: result, chapters: pending.plan.chapters });
            setPending(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "重建目录失败");
            setPending(null);
        } finally {
            setBusy(false);
        }
    };

    // ── 结果弹窗：搬了什么、丢了什么，看清楚再回阅读页 ──
    if (report) {
        const loss = reportHasLoss(report.report);
        return (
            <ContentDialog
                title="目录已重建"
                confirmLabel="回到阅读"
                cancelLabel=""
                onConfirm={() => onApplied(report.chapters, report.report.position)}
                onCancel={() => onApplied(report.chapters, report.report.position)}
            >
                <div className="reading-settings-grid">
                    <div className="reading-settings-inline-note">
                        <span>现在共</span>
                        <span>{report.chapters.length} 章</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>批注</span>
                        <span>跟随 {report.report.annotations.moved} 条{report.report.annotations.dropped > 0 ? `，删除 ${report.report.annotations.dropped} 条` : ""}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>划线</span>
                        <span>跟随 {report.report.marks.moved} 条{report.report.marks.dropped > 0 ? `，删除 ${report.report.marks.dropped} 条` : ""}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>书签</span>
                        <span>跟随 {report.report.bookmarks.moved} 个{report.report.bookmarks.dropped > 0 ? `，删除 ${report.report.bookmarks.dropped} 个` : ""}</span>
                    </div>
                    {loss && (
                        <div role="alert" className="reading-settings-inline-note">
                            <span className="ts-12" style={{ color: "var(--c-danger)" }}>
                                <AlertCircle size={14} className="inline align-[-2px]" /> 有内容无法对应到新目录，已按规则删除（条数见上）。
                            </span>
                        </div>
                    )}
                    {report.report.warnings.map((warning) => (
                        <div key={warning} className="reading-settings-inline-note"><span>{warning}</span></div>
                    ))}
                </div>
            </ContentDialog>
        );
    }

    // ── 应用前确认 ──
    if (pending) {
        return (
            <ContentDialog
                title="应用自定义目录？"
                confirmLabel={busy ? "处理中…" : "应用"}
                cancelLabel="取消"
                onConfirm={() => { if (!busy) void runApply(); }}
                onCancel={() => { if (!busy) setPending(null); }}
            >
                <div className="reading-settings-grid">
                    <div className="reading-settings-inline-note">
                        <span>应用后</span>
                        <span>{pending.plan.chapters.length} 章 · {pending.plan.totalParagraphs} 段</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>切分方式</span>
                        <span>{mode === "only" ? "只按我的节点" : "自动目录 + 我的节点"}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>正文</span>
                        <span>不改动一个字</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>已有批注 / 划线 / 书签</span>
                        <span>{pending.impact.annotations} / {pending.impact.marks} / {pending.impact.bookmarks}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>可以还原吗</span>
                        <span>目录可以再改回来，但被删掉的批注/划线无法恢复</span>
                    </div>
                </div>
            </ContentDialog>
        );
    }

    const preview = buildDraftsFromNodes(chapters, nodes, mode);

    return (
        <ContentDialog
            title="本书更多设置"
            confirmLabel="完成"
            cancelLabel="关闭"
            onConfirm={onClose}
            onCancel={onClose}
        >
            <div className="reading-settings-grid">
                {/* ── 排版 ── */}
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Type size={15} />
                        <span>正文排版（只影响这本书）</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>没动过的项跟随「阅读外观」里的全局设置。改完立刻生效，翻页模式会按新字号重新分页。</span>
                    </p>

                    <div className="reading-settings-inline-note">
                        <span>字号</span>
                        <span>{effective.fontSize}px{typography.fontSize === undefined ? "（全局）" : ""}</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={READING_BOOK_FONT_SIZE_MIN}
                        max={READING_BOOK_FONT_SIZE_MAX}
                        step={1}
                        value={effective.fontSize}
                        onChange={(event) => patchTypography({ fontSize: Number(event.target.value) })}
                    />

                    <div className="reading-settings-inline-note">
                        <span>行距</span>
                        <span>{effective.lineHeight}{typography.lineHeight === undefined ? "（全局）" : ""}</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={READING_BOOK_LINE_HEIGHT_MIN}
                        max={READING_BOOK_LINE_HEIGHT_MAX}
                        step={0.1}
                        value={effective.lineHeight}
                        onChange={(event) => patchTypography({ lineHeight: Number(event.target.value) })}
                    />

                    <div className="reading-settings-inline-note">
                        <span>首行缩进</span>
                        <span>{effective.firstLineIndent} 字{typography.firstLineIndent === undefined ? "（全局）" : ""}</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={0}
                        max={READING_FIRST_LINE_INDENT_MAX}
                        step={1}
                        value={effective.firstLineIndent}
                        onChange={(event) => patchTypography({ firstLineIndent: Number(event.target.value) })}
                    />

                    <div className="reading-settings-inline-note">
                        <span>左右页边距</span>
                        <span>{effective.pagePaddingX}px{typography.pagePaddingX === undefined ? "（全局）" : ""}</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={0}
                        max={READING_PAGE_PADDING_MAX}
                        step={2}
                        value={effective.pagePaddingX}
                        onChange={(event) => patchTypography({ pagePaddingX: Number(event.target.value) })}
                    />

                    <div className="reading-share-aligns">
                        <button
                            type="button"
                            className={`reading-share-template${effective.textAlign === "left" ? " is-active" : ""}`}
                            onClick={() => patchTypography({ textAlign: "left" })}
                        >
                            左对齐
                        </button>
                        <button
                            type="button"
                            className={`reading-share-template${effective.textAlign === "justify" ? " is-active" : ""}`}
                            onClick={() => patchTypography({ textAlign: "justify" })}
                        >
                            两端对齐
                        </button>
                    </div>

                    <button type="button" className="ui-btn ui-btn-outline" onClick={resetTypography}>
                        恢复为跟随全局
                    </button>
                </section>

                {/* ── 自定义章节目录 ── */}
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Scissors size={15} />
                        <span>自定义章节目录</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>
                            在正文里选中一句话（或点住已有的划线）→ 菜单里点「设置节点」，
                            就会在那一段开头切一章。节点按书内顺序列在下面，可以改章名、删掉。
                        </span>
                    </p>

                    <div className="reading-share-aligns">
                        <button
                            type="button"
                            className={`reading-share-template${mode === "merge" ? " is-active" : ""}`}
                            onClick={() => changeMode("merge")}
                        >
                            自动目录 + 我的节点
                        </button>
                        <button
                            type="button"
                            className={`reading-share-template${mode === "only" ? " is-active" : ""}`}
                            onClick={() => changeMode("only")}
                        >
                            只按我的节点
                        </button>
                    </div>

                    <div className="reading-settings-inline-note">
                        <span>当前规则下会切成</span>
                        <span>{preview.drafts.length} 章</span>
                    </div>

                    {nodes.length === 0 ? (
                        <div className="reading-settings-inline-note">
                            <span>
                                <Info size={13} className="inline align-[-2px]" /> 还没设置节点。
                                去正文里划一句，点「设置节点」就会出现在这里。
                            </span>
                        </div>
                    ) : (
                        <div style={{ maxHeight: 320, overflowY: "auto" }}>
                            {nodes.map((node, index) => {
                                const chapter = chapters[node.chapterIndex];
                                return (
                                    <div key={node.id} className="reading-mark-row" style={{ display: "block" }}>
                                        <div className="reading-settings-inline-note">
                                            <span>
                                                {index + 1}. 第 {node.chapterIndex + 1} 章 · 第 {node.paragraphIndex + 1} 段
                                                {chapter ? ` · ${label(chapter, node.chapterIndex)}` : ""}
                                            </span>
                                            <span />
                                        </div>
                                        {node.quote && (
                                            <div className="reading-my-annotation-row-quote">{node.quote}</div>
                                        )}
                                        <input
                                            type="text"
                                            className="ui-input"
                                            value={node.title || ""}
                                            placeholder="这一章的章名（留空自动编号）"
                                            onChange={(event) => applyNodeTitle(node.id, event.target.value)}
                                            onBlur={(event) => commitNodeTitle(node.id, event.target.value)}
                                        />
                                        <div className="reading-share-aligns">
                                            <button
                                                type="button"
                                                className="reading-share-template"
                                                onClick={() => { onJumpToNode(node.chapterIndex); }}
                                            >
                                                跳到这一段
                                            </button>
                                            <button
                                                type="button"
                                                className="reading-share-template"
                                                onClick={() => deleteNode(node.id)}
                                            >
                                                删除节点
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {preview.warnings.length > 0 && (
                        <div className="reading-settings-inline-note">
                            <span>提醒</span>
                            <span>{preview.warnings.join("；")}</span>
                        </div>
                    )}

                    <button
                        type="button"
                        className="ui-btn ui-btn-primary"
                        disabled={busy || nodes.length === 0}
                        onClick={() => { void openConfirm(); }}
                    >
                        {busy ? "处理中…" : "应用目录"}
                    </button>
                    <p className="reading-settings-inline-note">
                        <span>只调整分章边界和章名，正文不动，批注和划线会跟着段落搬到新目录。</span>
                    </p>
                </section>

                {/* ── 章节重命名 ── */}
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <ListTree size={15} />
                        <span>章节重命名</span>
                    </div>
                    <label className="reading-settings-label">
                        <span>选一章</span>
                        <Select
                            value={String(renameIndex)}
                            onChange={(event) => {
                                const next = Number(event.target.value);
                                setRenameIndex(Number.isFinite(next) ? next : 0);
                                setRenameDraft("");
                                setNote(null);
                            }}
                        >
                            {chapters.map((chapter, index) => (
                                <option key={chapter.id || index} value={index}>
                                    {index + 1}. {label(chapter, index)}
                                </option>
                            ))}
                        </Select>
                    </label>
                    <input
                        type="text"
                        className="ui-input"
                        value={renameDraft}
                        placeholder={label(chapters[renameIndex], renameIndex)}
                        onChange={(event) => setRenameDraft(event.target.value)}
                    />
                    <button
                        type="button"
                        className="ui-btn ui-btn-outline"
                        disabled={busy}
                        onClick={() => { void saveRename(); }}
                    >
                        保存章名
                    </button>
                    <p className="reading-settings-inline-note">
                        <span>只改章名，不重新分段，也不影响阅读位置。</span>
                    </p>
                </section>

                {note && (
                    <div className="reading-settings-inline-note"><span>{note}</span></div>
                )}
                {error && (
                    <div role="alert" className="reading-settings-inline-note">
                        <span style={{ color: "var(--c-danger)" }}>{error}</span>
                    </div>
                )}
            </div>
        </ContentDialog>
    );
}
