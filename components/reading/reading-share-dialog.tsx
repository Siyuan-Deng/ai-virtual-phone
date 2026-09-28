"use client";

import { useEffect, useRef, useState } from "react";
import { ContentDialog } from "@/components/ui/modal";
import { Toggle } from "@/components/ui/form";
import { downloadFile } from "@/lib/download-utils";
import { loadReadingProfile, loadReadingProfileAvatar } from "@/lib/reading-profile";
import {
    READING_SHARE_TEMPLATES,
    READING_SHARE_TEMPLATE_PRESETS,
    readingShareCardToBlob,
    renderReadingShareCard,
    type ReadingShareAnnotation,
    type ReadingShareFonts,
    type ReadingSharePalette,
    type ReadingShareTemplate,
} from "@/lib/reading-share-card";
import { ColorInput } from "@/components/ui/form";
import {
    READING_ANNOTATION_STYLE_DEFAULTS,
    loadReadingAppearance,
} from "@/lib/reading-appearance";

type Props = {
    quoteParagraphs: string[];
    bookTitle: string;
    bookAuthor: string;
    chapterTitle: string;
    progressPercent: number;
    annotations: ReadingShareAnnotation[];
    onClose: () => void;
};

/** 阅读界面实际渲染用的三档字体。直接问 DOM 最准——自定义上传的字体在这里是
 *  运行期才生成的 family 名，配置里查不到；注入的那条样式也只有 DOM 知道。 */
function resolveRenderedFonts(): ReadingShareFonts {
    const fallback = '"Songti SC", serif';
    if (typeof document === "undefined") return { body: fallback, userAnnotation: fallback, charAnnotation: fallback };
    const surface = document.querySelector(".reading-app-surface");
    if (!surface) return { body: fallback, userAnnotation: fallback, charAnnotation: fallback };

    /** 在阅读区里临时插一个隐藏元素，看它实际吃到什么字体 */
    const probe = (build: (host: HTMLElement) => HTMLElement) => {
        const host = document.createElement("div");
        host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
        const target = build(host);
        surface.appendChild(host);
        const family = getComputedStyle(target).fontFamily;
        host.remove();
        return family || fallback;
    };

    const annotationProbe = (author: "user" | "character") => probe((host) => {
        const card = document.createElement("div");
        card.className = "reading-annotation";
        card.setAttribute("data-author", author);
        const text = document.createElement("span");
        text.className = "reading-annotation-text";
        card.appendChild(text);
        host.appendChild(card);
        return text;
    });

    return {
        body: probe((host) => {
            const line = document.createElement("p");
            line.className = "reading-line";
            host.appendChild(line);
            return line;
        }),
        userAnnotation: annotationProbe("user"),
        charAnnotation: annotationProbe("character"),
    };
}

export function ReadingShareDialog({
    quoteParagraphs, bookTitle, bookAuthor, chapterTitle, progressPercent, annotations, onClose,
}: Props) {
    const [template, setTemplate] = useState<ReadingShareTemplate>("poster");
    const [palette, setPalette] = useState<ReadingSharePalette>(READING_SHARE_TEMPLATE_PRESETS.poster);
    const [align, setAlign] = useState<"left" | "center">(READING_SHARE_TEMPLATE_PRESETS.poster.align);

    /** 换模板时配色和对齐回到那个模板的出厂值——深色版面套上浅色底会直接糊掉 */
    const pickTemplate = (next: ReadingShareTemplate) => {
        const preset = READING_SHARE_TEMPLATE_PRESETS[next];
        setTemplate(next);
        setPalette({ background: preset.background, ink: preset.ink, sub: preset.sub, accent: preset.accent });
        setAlign(preset.align);
    };
    const hasMine = annotations.some((annotation) => annotation.authorType === "user");
    const hasTheirs = annotations.some((annotation) => annotation.authorType === "character");
    const [withMine, setWithMine] = useState(hasMine);
    const [withTheirs, setWithTheirs] = useState(hasTheirs);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const avatarRef = useRef<CanvasImageSource | null>(null);
    /** 摘抄内容在弹窗打开期间不会变；钉住，免得父组件重渲染就重画一遍 */
    const contentRef = useRef({ quoteParagraphs, annotations, bookTitle, bookAuthor, chapterTitle, progressPercent });

    useEffect(() => {
        let cancelled = false;
        const draw = async () => {
            try {
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

                const content = contentRef.current;
                const appearance = loadReadingAppearance();
                const canvas = renderReadingShareCard({
                    template,
                    quoteParagraphs: content.quoteParagraphs,
                    bookTitle: content.bookTitle,
                    bookAuthor: content.bookAuthor,
                    chapterTitle: content.chapterTitle,
                    userName: loadReadingProfile().name,
                    avatar: avatarRef.current,
                    progressPercent: content.progressPercent,
                    annotations: content.annotations.filter((annotation) => (
                        annotation.authorType === "user" ? withMine : withTheirs
                    )),
                    annotationColors: {
                        user: appearance.userAnnotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.userCardColor,
                        character: appearance.annotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.cardColor,
                    },
                    fonts: resolveRenderedFonts(),
                    timestamp: new Date(),
                    palette,
                    align,
                });
                if (cancelled) return;
                canvas.className = "reading-share-canvas";
                canvasRef.current = canvas;
                previewRef.current?.replaceChildren(canvas);
                setError(null);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "图片生成失败");
            }
        };
        void draw();
        return () => { cancelled = true; };
    }, [align, palette, template, withMine, withTheirs]);

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
                <div className="reading-share-preview" ref={previewRef} />

                <div className="reading-share-templates">
                    {READING_SHARE_TEMPLATES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`reading-share-template${template === option.id ? " is-active" : ""}`}
                            onClick={() => pickTemplate(option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                <div className="reading-share-knobs">
                    <div className="reading-share-colors">
                        {([
                            ["背景", "background"],
                            ["文字", "ink"],
                            ["次要", "sub"],
                            ["点缀", "accent"],
                        ] as Array<[string, keyof ReadingSharePalette]>).map(([label, key]) => (
                            <label key={key} className="reading-share-color">
                                <span>{label}</span>
                                <ColorInput
                                    value={palette[key]}
                                    onChange={(value) => setPalette((prev) => ({ ...prev, [key]: value }))}
                                />
                            </label>
                        ))}
                    </div>
                    <div className="reading-share-aligns">
                        {([["左对齐", "left"], ["居中", "center"]] as Array<[string, "left" | "center"]>).map(([label, value]) => (
                            <button
                                key={value}
                                type="button"
                                className={`reading-share-template${align === value ? " is-active" : ""}`}
                                onClick={() => setAlign(value)}
                            >{label}</button>
                        ))}
                    </div>
                </div>

                {hasMine && (
                    <div className="reading-settings-inline-note">
                        <span>带上我的批注</span>
                        <Toggle checked={withMine} onChange={setWithMine} />
                    </div>
                )}
                {hasTheirs && (
                    <div className="reading-settings-inline-note">
                        <span>带上 TA 的批注</span>
                        <Toggle checked={withTheirs} onChange={setWithTheirs} />
                    </div>
                )}

                {error && (
                    <div className="reading-settings-inline-note">
                        <span>出错了</span>
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </ContentDialog>
    );
}
