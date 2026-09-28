"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { Toggle } from "@/components/ui/form";
import { downloadFile } from "@/lib/download-utils";
import {
    READING_ANNOTATION_STYLE_DEFAULTS,
    loadReadingAppearance,
} from "@/lib/reading-appearance";
import { loadReadingProfile, loadReadingProfileAvatar } from "@/lib/reading-profile";
import {
    READING_SHARE_TEMPLATES,
    readingShareCardToBlob,
    renderReadingShareCard,
    type ReadingShareAnnotation,
    type ReadingShareTemplate,
} from "@/lib/reading-share-card";
import type { ReadingMarkStyle } from "@/lib/reading-types";

type Props = {
    quoteParagraphs: string[];
    bookTitle: string;
    chapterTitle: string;
    progressPercent: number;
    annotations: ReadingShareAnnotation[];
    markStyle: ReadingMarkStyle;
    onClose: () => void;
};

/** 阅读界面实际用的正文字体。直接问 DOM 最准——自定义上传的字体在这里是一个
 *  运行期才生成的 family 名，配置里查不到。 */
function resolveRenderedFontFamily(): string {
    if (typeof document === "undefined") return "serif";
    const line = document.querySelector(".reading-line");
    const family = line ? getComputedStyle(line).fontFamily : "";
    return family || '"Songti SC", serif';
}

export function ReadingShareDialog({
    quoteParagraphs, bookTitle, chapterTitle, progressPercent, annotations, markStyle, onClose,
}: Props) {
    const [template, setTemplate] = useState<ReadingShareTemplate>("paper");
    const [withAnnotations, setWithAnnotations] = useState(annotations.length > 0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const avatarRef = useRef<CanvasImageSource | null>(null);
    /** 摘抄内容在弹窗打开期间不会变；用 ref 钉住，免得父组件每次重渲染
     *  都换一个新数组，把画布重画一遍。 */
    const contentRef = useRef({ quoteParagraphs, annotations, bookTitle, chapterTitle, progressPercent, markStyle });

    useEffect(() => {
        let cancelled = false;
        const draw = async () => {
            try {
                // 头像只取一次，之后换模板不用重读 IndexedDB
                if (avatarRef.current === null) {
                    const blob = await loadReadingProfileAvatar().catch(() => null);
                    if (blob && typeof createImageBitmap === "function") {
                        avatarRef.current = await createImageBitmap(blob).catch(() => null);
                    }
                }
                // 等字体真正可用，否则画出来的是系统字体
                if (typeof document !== "undefined" && document.fonts?.ready) {
                    await document.fonts.ready.catch(() => {});
                }
                if (cancelled) return;

                const appearance = loadReadingAppearance();
                const content = contentRef.current;
                const canvas = renderReadingShareCard({
                    template,
                    quoteParagraphs: content.quoteParagraphs,
                    bookTitle: content.bookTitle,
                    chapterTitle: content.chapterTitle,
                    userName: loadReadingProfile().name,
                    avatar: avatarRef.current,
                    progressPercent: content.progressPercent,
                    annotations: withAnnotations ? content.annotations : [],
                    fontFamily: resolveRenderedFontFamily(),
                    markStyle: content.markStyle,
                    markColor: content.markStyle === "highlight"
                        ? (appearance.highlightColor || READING_ANNOTATION_STYLE_DEFAULTS.highlightColor)
                        : (appearance.underlineColor || READING_ANNOTATION_STYLE_DEFAULTS.underlineColor),
                });
                if (cancelled) return;
                canvas.className = "reading-share-canvas";
                canvasRef.current = canvas;
                const host = previewRef.current;
                if (host) {
                    host.replaceChildren(canvas);
                }
                setError(null);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "图片生成失败");
            }
        };
        void draw();
        return () => { cancelled = true; };
    }, [template, withAnnotations]);

    const handleDownload = async () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
            setBusy(true);
            setError(null);
            const blob = await readingShareCardToBlob(canvas);
            const stamp = new Date().toISOString().slice(0, 10);
            await downloadFile(blob, `摘抄-${contentRef.current.bookTitle || "未命名"}-${stamp}.png`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <ContentDialog
            title="分享摘抄"
            confirmLabel={busy ? "生成中..." : "保存图片"}
            cancelLabel="关闭"
            onConfirm={() => { if (!busy) void handleDownload(); }}
            onCancel={onClose}
        >
            <div className="reading-settings-grid">
                <div className="reading-share-templates">
                    {READING_SHARE_TEMPLATES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`reading-share-template${template === option.id ? " is-active" : ""}`}
                            onClick={() => setTemplate(option.id)}
                        >
                            <span className="reading-share-template-label">{option.label}</span>
                            <span className="reading-share-template-hint">{option.hint}</span>
                        </button>
                    ))}
                </div>

                {annotations.length > 0 && (
                    <div className="reading-settings-inline-note">
                        <span>带上批注（{annotations.length} 条）</span>
                        <Toggle checked={withAnnotations} onChange={setWithAnnotations} />
                    </div>
                )}

                <div className="reading-share-preview" ref={previewRef} />

                {error && (
                    <div className="reading-settings-inline-note">
                        <span>出错了</span>
                        <span>{error}</span>
                    </div>
                )}

                <div className="reading-settings-inline-note">
                    <Download size={13} />
                    <span>点下面的「保存图片」存到相册；iOS 会先弹出系统分享面板。</span>
                </div>
            </div>
        </ContentDialog>
    );
}
