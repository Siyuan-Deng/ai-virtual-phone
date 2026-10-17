"use client";

// 目录与分章工作台。两种编辑方式共用同一份「切分草稿」：
//  · 列表模式：一章一行，改标题、与上一章合并、在本章中间拆开——日常纠错用这个
//  · 文本模式：一行 `起始段号|标题`，几百章的书用它改起来才不至于点到手断
// 无论哪种，最终都归一成 drafts，交给 buildRechunkPlan 算新目录与锚点映射。
//
// 界面上刻意不提供「改正文」：那会改掉段落本身，批注和划线的锚点就废了。
// 这里只挪边界，所以每条批注、划线都能精确跟着走（见 lib/reading-rechunk.ts 开头）。

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, Info, Trash2 } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import type { Book, BookChapter } from "@/lib/reading-types";
import {
    buildRechunkDrafts,
    buildRechunkPlan,
    draftsToText,
    flattenReadingParagraphs,
    isSameLayout,
    normalizeRechunkDrafts,
    textToDrafts,
    type RechunkDraft,
    type RechunkPlan,
} from "@/lib/reading-rechunk";
import {
    applyRechunk,
    previewRechunkImpact,
    reportHasLoss,
    type RechunkMigrationReport,
} from "@/lib/reading-rechunk-apply";

type Props = {
    book: Book;
    chapters: BookChapter[];
    /** 当前阅读位置（章号 + 章内比例），重建后要跟着走 */
    current: { chapterIndex: number; within: number };
    onClose: () => void;
    onApplied: (chapters: BookChapter[], position: { chapterIndex: number; within: number } | null) => void;
};

/** 超过这个章数就默认用文本模式：几百个输入框一起挂上去，手机上又卡又难点。 */
const LIST_MODE_CHAPTER_LIMIT = 200;

export function ReadingChapterEditor({ book, chapters, current, onClose, onApplied }: Props) {
    const [drafts, setDrafts] = useState<RechunkDraft[]>(() => buildRechunkDrafts(chapters));
    const [textMode, setTextMode] = useState(chapters.length > LIST_MODE_CHAPTER_LIMIT);
    const [textDraft, setTextDraft] = useState(() => draftsToText(buildRechunkDrafts(chapters)));
    const [splittingIndex, setSplittingIndex] = useState<number | null>(null);
    const [splitInput, setSplitInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** 待确认的计划 + 影响面（条数） */
    const [pending, setPending] = useState<{
        plan: RechunkPlan;
        impact: { annotations: number; marks: number; bookmarks: number };
    } | null>(null);
    const [report, setReport] = useState<RechunkMigrationReport | null>(null);
    const [applied, setApplied] = useState<BookChapter[] | null>(null);

    const totalParagraphs = useMemo(() => flattenReadingParagraphs(chapters).length, [chapters]);
    const normalized = useMemo(
        () => normalizeRechunkDrafts(drafts, totalParagraphs),
        [drafts, totalParagraphs],
    );
    const list = normalized.drafts;
    const unchanged = isSameLayout(chapters, list);

    const updateTitle = (index: number, title: string) => {
        setDrafts((prev) => {
            const base = textMode ? normalized.drafts : prev;
            return base.map((draft, i) => (i === index ? { ...draft, title } : draft));
        });
    };

    const mergeWithPrevious = (index: number) => {
        if (index <= 0) return;
        const base = textMode ? normalized.drafts : drafts;
        const next = base.filter((_, i) => i !== index);
        setDrafts(next);
        if (textMode) setTextDraft(draftsToText(next));
    };

    const splitChapter = (index: number, offset: string) => {
        const base = textMode ? normalized.drafts : drafts;
        const target = base[index];
        if (!target) return;
        const end = index + 1 < base.length ? base[index + 1].start : totalParagraphs;
        const chapterLength = end - target.start;
        const within = Number.parseInt(offset.replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(within) || within < 2 || within > chapterLength) {
            setError(`拆分位置要在本章第 2 段到第 ${Math.max(2, chapterLength)} 段之间`);
            return;
        }
        setError(null);
        const next = [...base];
        next.splice(index + 1, 0, { start: target.start + within - 1, title: "" });
        setDrafts(next);
        if (textMode) setTextDraft(draftsToText(next));
        setSplittingIndex(null);
        setSplitInput("");
    };

    const resetDrafts = () => {
        const restored = buildRechunkDrafts(chapters);
        setDrafts(restored);
        setTextDraft(draftsToText(restored));
        setError(null);
    };

    const mergeAll = () => {
        const merged: RechunkDraft[] = [{ start: 0, title: "全文" }];
        setDrafts(merged);
        setTextDraft(draftsToText(merged));
    };

    const applyTextDraft = () => {
        const parsed = textToDrafts(textDraft);
        if (parsed.length === 0) {
            setError("没能从文本里解析出任何节点。每行写成「起始段号|标题」，段号从 1 数起。");
            return;
        }
        setError(null);
        setDrafts(parsed);
    };

    const openConfirm = useCallback(async () => {
        setError(null);
        const plan = buildRechunkPlan(book.id, chapters, normalized.drafts);
        if (plan.chapters.length === 0) {
            setError("这样切下来一章都不剩，请检查分章节点");
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
    }, [book, chapters, normalized.drafts]);

    const runApply = async () => {
        if (!pending) return;
        setBusy(true);
        setError(null);
        try {
            const result = await applyRechunk(book, chapters, pending.plan, current);
            setApplied(pending.plan.chapters);
            setReport(result);
            setPending(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "重建目录失败");
            setPending(null);
        } finally {
            setBusy(false);
        }
    };

    // ── 结果弹窗：先让用户看清楚搬了什么、丢了什么，再回阅读器 ──
    if (report && applied) {
        const loss = reportHasLoss(report);
        return (
            <ContentDialog
                title="目录已重建"
                confirmLabel="回到阅读"
                cancelLabel=""
                onConfirm={() => onApplied(applied, report.position)}
                onCancel={() => onApplied(applied, report.position)}
            >
                <div className="reading-settings-grid">
                    <div className="reading-settings-inline-note">
                        <span>现在共</span>
                        <span>{applied.length} 章</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>批注</span>
                        <span>跟随 {report.annotations.moved} 条{report.annotations.dropped > 0 ? `，删除 ${report.annotations.dropped} 条` : ""}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>划线</span>
                        <span>跟随 {report.marks.moved} 条{report.marks.dropped > 0 ? `，删除 ${report.marks.dropped} 条` : ""}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>书签</span>
                        <span>跟随 {report.bookmarks.moved} 个{report.bookmarks.dropped > 0 ? `，删除 ${report.bookmarks.dropped} 个` : ""}</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>记忆日志</span>
                        <span>更新 {report.memos.moved} 条{report.memos.dropped > 0 ? `，删除 ${report.memos.dropped} 条` : ""}</span>
                    </div>
                    {loss && (
                        <div role="alert">
                            <span className="ts-12" style={{ color: "var(--c-danger)" }}>
                                <AlertCircle size={14} className="inline align-[-2px]" /> 有内容无法对应到新目录，已按规则删除（上面已列出条数）。
                            </span>
                        </div>
                    )}
                    {report.warnings.map((warning) => (
                        <div key={warning} className="reading-settings-inline-note">
                            <span>{warning}</span>
                        </div>
                    ))}
                </div>
            </ContentDialog>
        );
    }

    // ── 确认弹窗：把「会影响什么」在动手前讲清楚 ──
    if (pending) {
        return (
            <ContentDialog
                title="确认重建目录？"
                confirmLabel={busy ? "重建中…" : "重建"}
                cancelLabel="取消"
                onConfirm={() => { if (!busy) void runApply(); }}
                onCancel={() => { if (!busy) setPending(null); }}
            >
                <div className="reading-settings-grid">
                    <div className="reading-settings-inline-note">
                        <span>重建后</span>
                        <span>{pending.plan.chapters.length} 章 · {pending.plan.totalParagraphs} 段</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>已有批注</span>
                        <span>{pending.impact.annotations} 条</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>已有划线</span>
                        <span>{pending.impact.marks} 条</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>已有书签</span>
                        <span>{pending.impact.bookmarks} 个</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>正文</span>
                        <span>不改动一个字</span>
                    </div>
                    <div className="reading-settings-inline-note">
                        <span>可以还原吗</span>
                        <span>目录可以再改回来，但被删掉的批注/划线无法恢复</span>
                    </div>
                </div>
            </ContentDialog>
        );
    }

    return (
        <ContentDialog
            title="目录与分章"
            confirmLabel={busy ? "处理中…" : "预览并应用"}
            cancelLabel="取消"
            onConfirm={() => { if (!busy) void openConfirm(); }}
            onCancel={() => { if (!busy) onClose(); }}
        >
            <div className="reading-settings-grid">
                <p className="reading-settings-inline-note">
                    <span>
                        只调整分章边界和章名，正文一个字都不动，所以批注和划线会跟着段落自动搬到新目录。
                    </span>
                </p>

                <div className="reading-settings-inline-note">
                    <span>全书 {totalParagraphs} 段 · 将分成 {list.length} 章</span>
                    <span />
                </div>

                <div className="reading-share-aligns">
                    <button
                        type="button"
                        className={`reading-share-template${textMode ? "" : " is-active"}`}
                        onClick={() => setTextMode(false)}
                    >
                        逐章编辑
                    </button>
                    <button
                        type="button"
                        className={`reading-share-template${textMode ? " is-active" : ""}`}
                        onClick={() => {
                            setTextMode(true);
                            setTextDraft(draftsToText(normalized.drafts));
                        }}
                    >
                        文本编辑
                    </button>
                </div>

                {textMode ? (
                    <>
                        <p className="reading-settings-inline-note">
                            <span>
                                每行一个节点：<code>起始段号|标题</code>。段号从 1 数起，标题可以留空。
                                删掉一行就是把那一章并到上一章。
                            </span>
                        </p>
                        <textarea
                            className="ui-input"
                            rows={12}
                            value={textDraft}
                            onChange={(event) => setTextDraft(event.target.value)}
                            spellCheck={false}
                        />
                        <button type="button" className="ui-btn ui-btn-outline" onClick={applyTextDraft}>
                            应用文本
                        </button>
                    </>
                ) : (
                    <>
                        <div style={{ maxHeight: 320, overflowY: "auto" }}>
                            {list.map((draft, index) => {
                                const end = index + 1 < list.length ? list[index + 1].start : totalParagraphs;
                                const length = end - draft.start;
                                return (
                                    <div key={`${draft.start}-${index}`} className="reading-mark-row" style={{ display: "block" }}>
                                        <div className="reading-settings-inline-note">
                                            <span>第 {index + 1} 章 · 第 {draft.start + 1} 段起 · {length} 段</span>
                                            <span />
                                        </div>
                                        <input
                                            type="text"
                                            className="ui-input"
                                            value={draft.title}
                                            placeholder={`第${index + 1}章`}
                                            onChange={(event) => updateTitle(index, event.target.value)}
                                        />
                                        <div className="reading-share-aligns">
                                            {index > 0 && (
                                                <button
                                                    type="button"
                                                    className="reading-share-template"
                                                    onClick={() => mergeWithPrevious(index)}
                                                >
                                                    并到上一章
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className="reading-share-template"
                                                onClick={() => {
                                                    setSplittingIndex(splittingIndex === index ? null : index);
                                                    setSplitInput("");
                                                }}
                                            >
                                                拆分
                                            </button>
                                        </div>
                                        {splittingIndex === index && (
                                            <div className="reading-settings-inline-note">
                                                <span>从本章第几段开始成为新章（2 - {Math.max(2, length)}）</span>
                                                <input
                                                    className="ui-input"
                                                    inputMode="numeric"
                                                    value={splitInput}
                                                    onChange={(event) => setSplitInput(event.target.value.replace(/[^\d]/g, ""))}
                                                />
                                                <button
                                                    type="button"
                                                    className="ui-btn ui-btn-outline"
                                                    onClick={() => splitChapter(index, splitInput)}
                                                >
                                                    确定
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="reading-share-aligns">
                            <button type="button" className="reading-share-template" onClick={mergeAll}>
                                全部合并为一章
                            </button>
                            <button type="button" className="reading-share-template" onClick={resetDrafts}>
                                <Trash2 size={13} className="inline align-[-2px]" /> 恢复原目录
                            </button>
                        </div>
                    </>
                )}

                {normalized.warnings.length > 0 && (
                    <div className="reading-settings-inline-note">
                        <span>提醒</span>
                        <span>{normalized.warnings.join("；")}</span>
                    </div>
                )}

                {unchanged && (
                    <div className="reading-settings-inline-note">
                        <span>
                            <Info size={13} className="inline align-[-2px]" /> 目录和现在一样，应用不会产生改动。
                        </span>
                    </div>
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
