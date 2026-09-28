"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Highlighter, ImagePlus, Palette, Trash2 } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { ColorInput, Slider } from "@/components/ui/form";
import type { ReadingAnnotationFontFamilyId, ReadingAppearance } from "@/lib/reading-appearance";
import {
    READING_ANNOTATION_FONT_SIZE_MAX,
    READING_ANNOTATION_FONT_SIZE_MIN,
    READING_ANNOTATION_STYLE_DEFAULTS,
    READING_BG_BRIGHTNESS_MAX,
    READING_BG_BRIGHTNESS_MIN,
    readingBackgroundOverlay,
    readingMarkColor,
    resolveReadingAnnotationFontFamily,
    resolveReadingFontFamily,
} from "@/lib/reading-appearance";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { READING_CSS_SCHEME_TARGET, loadReadingCustomCss } from "@/lib/reading-custom-css";
import { ReadingFontTier } from "./reading-font-tier";
import { ReadingFontDiagnostics } from "./reading-font-diagnostics";

export type ReadingAppearanceSaveOptions = {
    backgroundFile: File | null;
    clearBackground: boolean;
    customFontFile: File | null;
    clearCustomFont: boolean;
    annotationFontFile: File | null;
    clearAnnotationFont: boolean;
    userAnnotationFontFile: File | null;
    clearUserAnnotationFont: boolean;
    /** 阅读 app 的自定义 CSS（和外观存在一起保存，空串表示清空） */
    customCss: string;
};

/** 已经加载好的三档自定义字体 family（形如 "XxxFont_123"），用来让预览行显示真实字体 */
export type ReadingLoadedFonts = {
    body?: string;
    annotation?: string;
    userAnnotation?: string;
};

type Props = {
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    loadedFonts: ReadingLoadedFonts;
    onClose: () => void;
    onSave: (appearance: ReadingAppearance, options: ReadingAppearanceSaveOptions) => Promise<void>;
};

export function ReadingAppearanceDialog({ appearance, backgroundUrl, loadedFonts, onClose, onSave }: Props) {
    const [draft, setDraft] = useState<ReadingAppearance>(appearance);
    const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
    const [customFontFile, setCustomFontFile] = useState<File | null>(null);
    const [annotationFontFile, setAnnotationFontFile] = useState<File | null>(null);
    const [userAnnotationFontFile, setUserAnnotationFontFile] = useState<File | null>(null);
    const [clearBackground, setClearBackground] = useState(false);
    const [clearCustomFont, setClearCustomFont] = useState(false);
    const [clearAnnotationFont, setClearAnnotationFont] = useState(false);
    const [clearUserAnnotationFont, setClearUserAnnotationFont] = useState(false);
    const [saving, setSaving] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(backgroundUrl);
    const [customCssDraft, setCustomCssDraft] = useState(() => loadReadingCustomCss());
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDraft(appearance);
        setBackgroundFile(null);
        setCustomFontFile(null);
        setAnnotationFontFile(null);
        setUserAnnotationFontFile(null);
        setClearBackground(false);
        setClearCustomFont(false);
        setClearAnnotationFont(false);
        setClearUserAnnotationFont(false);
        setPreviewUrl(backgroundUrl);
    }, [appearance, backgroundUrl]);

    useEffect(() => {
        if (!backgroundFile) return;
        const url = URL.createObjectURL(backgroundFile);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [backgroundFile]);

    const hasPreview = useMemo(() => Boolean(previewUrl) && !clearBackground, [previewUrl, clearBackground]);
    // 预览块用和正文一样的叠色方式，滑动条拖到哪里，这里就是那个效果
    const backgroundPreviewLayers = useMemo(() => {
        if (!previewUrl) return undefined;
        const overlay = readingBackgroundOverlay(draft.backgroundBrightness);
        return overlay ? `${overlay}, url("${previewUrl}")` : `url("${previewUrl}")`;
    }, [draft.backgroundBrightness, previewUrl]);

    // 预览的回退链和 CSS 里那条完全一致：我的批注 → TA的批注 → 正文 → App 字体。
    const bodyCss = useMemo(
        () => resolveReadingFontFamily(draft.fontFamily, clearCustomFont ? undefined : loadedFonts.body),
        [draft.fontFamily, clearCustomFont, loadedFonts.body],
    );
    const annotationCss = useMemo(
        () => resolveReadingAnnotationFontFamily(
            draft.annotationFontFamily,
            clearAnnotationFont ? undefined : loadedFonts.annotation,
        ) || bodyCss,
        [draft.annotationFontFamily, clearAnnotationFont, loadedFonts.annotation, bodyCss],
    );

    const handleSave = async () => {
        try {
            setSaving(true);
            await onSave(draft, {
                backgroundFile,
                clearBackground,
                customFontFile,
                clearCustomFont,
                annotationFontFile,
                clearAnnotationFont,
                userAnnotationFontFile,
                clearUserAnnotationFont,
                customCss: customCssDraft,
            });
            onClose();
        } catch (err) {
            alert(err instanceof Error ? err.message : "阅读外观保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <ContentDialog
            title="阅读外观"
            confirmLabel={saving ? "保存中..." : "保存"}
            cancelLabel="取消"
            onConfirm={() => { if (!saving) void handleSave(); }}
            onCancel={() => { if (!saving) onClose(); }}
        >
            <div className="reading-settings-grid">
                <ReadingFontTier
                    heading="正文样式"
                    value={draft.fontFamily}
                    inheritedCss="var(--app-font-family)"
                    loadedCustomFamily={clearCustomFont ? undefined : loadedFonts.body}
                    customFontName={draft.customFontName}
                    pendingFile={customFontFile}
                    disabled={saving}
                    onChangeFamily={(next) => setDraft((prev) => ({
                        ...prev,
                        fontFamily: next as ReadingAppearance["fontFamily"],
                    }))}
                    onPickFile={(file) => {
                        setCustomFontFile(file);
                        setClearCustomFont(false);
                        setDraft((prev) => ({ ...prev, fontFamily: "custom", customFontName: file.name }));
                    }}
                    onClearFont={() => {
                        setCustomFontFile(null);
                        setClearCustomFont(true);
                        setDraft((prev) => ({ ...prev, customFontName: undefined }));
                    }}
                >
                    <Slider
                        label="字号"
                        min={14}
                        max={28}
                        step={1}
                        value={draft.fontSize}
                        onChange={(e) => setDraft((prev) => ({ ...prev, fontSize: Number(e.target.value) }))}
                        displayValue={`${draft.fontSize}px`}
                    />
                    <Slider
                        label="行间距"
                        min={1.4}
                        max={2.4}
                        step={0.1}
                        value={draft.lineHeight}
                        onChange={(e) => setDraft((prev) => ({ ...prev, lineHeight: Number(e.target.value) }))}
                        displayValue={draft.lineHeight.toFixed(1)}
                    />
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">文字颜色</span>
                        <ColorInput value={draft.textColor} onChange={(textColor) => setDraft((prev) => ({ ...prev, textColor }))} />
                    </div>
                </ReadingFontTier>

                <ReadingFontTier
                    heading="TA的批注样式"
                    value={draft.annotationFontFamily ?? "inherit"}
                    inheritLabel="跟随正文"
                    inheritedCss={bodyCss}
                    loadedCustomFamily={clearAnnotationFont ? undefined : loadedFonts.annotation}
                    customFontName={draft.annotationCustomFontName}
                    pendingFile={annotationFontFile}
                    disabled={saving}
                    onChangeFamily={(next) => setDraft((prev) => ({
                        ...prev,
                        annotationFontFamily: next as ReadingAnnotationFontFamilyId,
                    }))}
                    onPickFile={(file) => {
                        setAnnotationFontFile(file);
                        setClearAnnotationFont(false);
                        setDraft((prev) => ({
                            ...prev,
                            annotationFontFamily: "custom",
                            annotationCustomFontName: file.name,
                        }));
                    }}
                    onClearFont={() => {
                        setAnnotationFontFile(null);
                        setClearAnnotationFont(true);
                        setDraft((prev) => ({ ...prev, annotationCustomFontName: undefined }));
                    }}
                >
                    <Slider
                        label="字号"
                        min={READING_ANNOTATION_FONT_SIZE_MIN}
                        max={READING_ANNOTATION_FONT_SIZE_MAX}
                        step={1}
                        value={draft.annotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize}
                        onChange={(e) => setDraft((prev) => ({ ...prev, annotationFontSize: Number(e.target.value) }))}
                        displayValue={`${draft.annotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize}px`}
                    />
                    <Slider
                        label="行间距"
                        min={1.2}
                        max={2.4}
                        step={0.02}
                        value={draft.annotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight}
                        onChange={(e) => setDraft((prev) => ({ ...prev, annotationLineHeight: Number(e.target.value) }))}
                        displayValue={(draft.annotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight).toFixed(2)}
                    />
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">文字颜色</span>
                        <ColorInput
                            value={draft.annotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.textColor}
                            onChange={(annotationTextColor) => setDraft((prev) => ({ ...prev, annotationTextColor }))}
                        />
                    </div>
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">卡片颜色</span>
                        <ColorInput
                            value={draft.annotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.cardColor}
                            onChange={(annotationCardColor) => setDraft((prev) => ({ ...prev, annotationCardColor }))}
                        />
                    </div>
                </ReadingFontTier>

                <ReadingFontTier
                    heading="我的批注样式"
                    value={draft.userAnnotationFontFamily ?? "inherit"}
                    inheritLabel="跟随 TA 的批注"
                    inheritedCss={annotationCss}
                    loadedCustomFamily={clearUserAnnotationFont ? undefined : loadedFonts.userAnnotation}
                    customFontName={draft.userAnnotationCustomFontName}
                    pendingFile={userAnnotationFontFile}
                    disabled={saving}
                    onChangeFamily={(next) => setDraft((prev) => ({
                        ...prev,
                        userAnnotationFontFamily: next as ReadingAnnotationFontFamilyId,
                    }))}
                    onPickFile={(file) => {
                        setUserAnnotationFontFile(file);
                        setClearUserAnnotationFont(false);
                        setDraft((prev) => ({
                            ...prev,
                            userAnnotationFontFamily: "custom",
                            userAnnotationCustomFontName: file.name,
                        }));
                    }}
                    onClearFont={() => {
                        setUserAnnotationFontFile(null);
                        setClearUserAnnotationFont(true);
                        setDraft((prev) => ({ ...prev, userAnnotationCustomFontName: undefined }));
                    }}
                >
                    <Slider
                        label="字号"
                        min={READING_ANNOTATION_FONT_SIZE_MIN}
                        max={READING_ANNOTATION_FONT_SIZE_MAX}
                        step={1}
                        value={draft.userAnnotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize}
                        onChange={(e) => setDraft((prev) => ({ ...prev, userAnnotationFontSize: Number(e.target.value) }))}
                        displayValue={`${draft.userAnnotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize}px`}
                    />
                    <Slider
                        label="行间距"
                        min={1.2}
                        max={2.4}
                        step={0.02}
                        value={draft.userAnnotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight}
                        onChange={(e) => setDraft((prev) => ({ ...prev, userAnnotationLineHeight: Number(e.target.value) }))}
                        displayValue={(draft.userAnnotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight).toFixed(2)}
                    />
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">文字颜色</span>
                        <ColorInput
                            value={draft.userAnnotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.userTextColor}
                            onChange={(userAnnotationTextColor) => setDraft((prev) => ({ ...prev, userAnnotationTextColor }))}
                        />
                    </div>
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">卡片颜色</span>
                        <ColorInput
                            value={draft.userAnnotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.userCardColor}
                            onChange={(userAnnotationCardColor) => setDraft((prev) => ({ ...prev, userAnnotationCardColor }))}
                        />
                    </div>
                </ReadingFontTier>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Highlighter size={15} />
                        <span>高亮与划线</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>自己划的和 TA 划的分开配色，一眼看得出这道线是谁划的。</span>
                    </p>
                    {([
                        {
                            title: "我划的",
                            highlight: draft.highlightColor || READING_ANNOTATION_STYLE_DEFAULTS.highlightColor,
                            underline: draft.underlineColor || READING_ANNOTATION_STYLE_DEFAULTS.underlineColor,
                            onHighlight: (highlightColor: string) => setDraft((prev) => ({ ...prev, highlightColor })),
                            onUnderline: (underlineColor: string) => setDraft((prev) => ({ ...prev, underlineColor })),
                        },
                        {
                            title: "TA 划的",
                            highlight: draft.charHighlightColor || READING_ANNOTATION_STYLE_DEFAULTS.charHighlightColor,
                            underline: draft.charUnderlineColor || READING_ANNOTATION_STYLE_DEFAULTS.charUnderlineColor,
                            onHighlight: (charHighlightColor: string) => setDraft((prev) => ({ ...prev, charHighlightColor })),
                            onUnderline: (charUnderlineColor: string) => setDraft((prev) => ({ ...prev, charUnderlineColor })),
                        },
                    ]).map((tier) => (
                        <div key={tier.title} className="reading-mark-tier">
                            <span className="reading-settings-label-inline">{tier.title}</span>
                            <div className="reading-settings-color-row">
                                <span className="reading-settings-label-inline">高亮颜色</span>
                                <ColorInput value={tier.highlight} onChange={tier.onHighlight} />
                            </div>
                            <div className="reading-settings-color-row">
                                <span className="reading-settings-label-inline">划线颜色</span>
                                <ColorInput value={tier.underline} onChange={tier.onUnderline} />
                            </div>
                            <div className="reading-mark-preview">
                                <span
                                    className="reading-mark"
                                    data-style="highlight"
                                    style={{ background: readingMarkColor(tier.highlight, 0.72) }}
                                >高亮效果</span>
                                <span
                                    className="reading-mark"
                                    data-style="underline"
                                    style={{ borderBottomColor: readingMarkColor(tier.underline, 0.85) }}
                                >划线效果</span>
                            </div>
                        </div>
                    ))}
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Palette size={15} />
                        <span>全屏背景</span>
                    </div>
                    <div
                        className="reading-bg-preview"
                        style={hasPreview ? { backgroundImage: backgroundPreviewLayers } : undefined}
                    >
                        {!hasPreview && <span>书架页和阅读页共用背景</span>}
                    </div>
                    {hasPreview && (
                        <Slider
                            label="背景亮度"
                            min={READING_BG_BRIGHTNESS_MIN}
                            max={READING_BG_BRIGHTNESS_MAX}
                            step={0.05}
                            value={draft.backgroundBrightness ?? 1}
                            onChange={(e) => setDraft((prev) => ({ ...prev, backgroundBrightness: Number(e.target.value) }))}
                            displayValue={`${Math.round((draft.backgroundBrightness ?? 1) * 100)}%`}
                        />
                    )}
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => fileRef.current?.click()}
                            disabled={saving}
                        >
                            <ImagePlus size={14} />
                            <span>{hasPreview ? "更换背景" : "选择背景"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => {
                                setBackgroundFile(null);
                                setClearBackground(true);
                                setPreviewUrl(null);
                            }}
                            disabled={saving || (!hasPreview && !backgroundFile)}
                        >
                            <Trash2 size={14} />
                            <span>清除</span>
                        </button>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (!file) return;
                            setBackgroundFile(file);
                            setClearBackground(false);
                        }}
                    />
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Code2 size={15} />
                        <span>自定义 CSS</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>只作用在阅读 app 内部。常用类名：.reading-line（正文）、.reading-annotation（批注卡片）、.reading-list-item（书架条目）。</span>
                    </p>
                    <textarea
                        className="reading-custom-css-input"
                        value={customCssDraft}
                        onChange={(e) => setCustomCssDraft(e.target.value)}
                        placeholder={".reading-annotation { border-radius: 10px; }"}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        disabled={saving}
                    />
                    <div className="reading-settings-actions">
                        <CSSSchemeBar
                            target={READING_CSS_SCHEME_TARGET}
                            currentCSS={customCssDraft}
                            onLoad={setCustomCssDraft}
                            btnStyle={{
                                width: 34,
                                height: 34,
                                borderRadius: 8,
                                border: "1px solid var(--reading-warm-card-border, #f0e8da)",
                                background: "rgba(255, 255, 255, 0.6)",
                                color: "var(--reading-warm-ink, #111)",
                            }}
                        />
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => setCustomCssDraft("")}
                            disabled={saving || !customCssDraft}
                        >
                            <Trash2 size={14} />
                            <span>清空</span>
                        </button>
                    </div>
                </section>

                <ReadingFontDiagnostics appearance={appearance} loadedFonts={loadedFonts} />
            </div>
        </ContentDialog>
    );
}
