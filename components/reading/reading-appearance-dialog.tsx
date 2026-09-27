"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Palette, Trash2, Type } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { ColorInput, Select, Slider } from "@/components/ui/form";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import { READING_ANNOTATION_FONT_OPTIONS, READING_FONT_OPTIONS } from "@/lib/reading-appearance";

type Props = {
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    onClose: () => void;
    onSave: (
        appearance: ReadingAppearance,
        options: {
            backgroundFile: File | null;
            clearBackground: boolean;
            customFontFile: File | null;
            clearCustomFont: boolean;
            annotationFontFile: File | null;
            clearAnnotationFont: boolean;
        }
    ) => Promise<void>;
};

export function ReadingAppearanceDialog({ appearance, backgroundUrl, onClose, onSave }: Props) {
    const [draft, setDraft] = useState<ReadingAppearance>(appearance);
    const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
    const [customFontFile, setCustomFontFile] = useState<File | null>(null);
    const [annotationFontFile, setAnnotationFontFile] = useState<File | null>(null);
    const [clearBackground, setClearBackground] = useState(false);
    const [clearCustomFont, setClearCustomFont] = useState(false);
    const [clearAnnotationFont, setClearAnnotationFont] = useState(false);
    const [saving, setSaving] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(backgroundUrl);
    const fileRef = useRef<HTMLInputElement>(null);
    const fontFileRef = useRef<HTMLInputElement>(null);
    const annotationFontFileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDraft(appearance);
        setBackgroundFile(null);
        setCustomFontFile(null);
        setAnnotationFontFile(null);
        setClearBackground(false);
        setClearCustomFont(false);
        setClearAnnotationFont(false);
        setPreviewUrl(backgroundUrl);
    }, [appearance, backgroundUrl]);

    useEffect(() => {
        if (!backgroundFile) return;
        const url = URL.createObjectURL(backgroundFile);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [backgroundFile]);

    const hasPreview = useMemo(() => Boolean(previewUrl) && !clearBackground, [previewUrl, clearBackground]);

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
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Type size={15} />
                        <span>正文样式</span>
                    </div>
                    <label className="reading-settings-label">
                        <span>字体</span>
                        <Select
                            value={draft.fontFamily}
                            onChange={(e) => setDraft((prev) => ({ ...prev, fontFamily: e.target.value as ReadingAppearance["fontFamily"] }))}
                        >
                            {READING_FONT_OPTIONS.map((option) => (
                                option.id === "custom" && !draft.customFontName ? null :
                                <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                        </Select>
                    </label>
                    <div className="reading-settings-inline-note">
                        <span>自定义字体</span>
                        <span>{draft.customFontName ? `已选择 · ${draft.customFontName}` : "未上传"}</span>
                    </div>
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => fontFileRef.current?.click()}
                            disabled={saving}
                        >
                            <Type size={14} />
                            <span>{draft.customFontName ? "更换字体" : "上传字体"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => {
                                setCustomFontFile(null);
                                setClearCustomFont(true);
                                setDraft((prev) => ({
                                    ...prev,
                                    customFontName: undefined,
                                    fontFamily: prev.fontFamily === "custom" ? "system" : prev.fontFamily,
                                }));
                            }}
                            disabled={saving || !draft.customFontName}
                        >
                            <Trash2 size={14} />
                            <span>清除</span>
                        </button>
                    </div>
                    <input
                        ref={fontFileRef}
                        type="file"
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (!file) return;
                            setCustomFontFile(file);
                            setClearCustomFont(false);
                            setDraft((prev) => ({
                                ...prev,
                                fontFamily: "custom",
                                customFontName: file.name,
                            }));
                        }}
                    />
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
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Type size={15} />
                        <span>批注样式</span>
                    </div>
                    <label className="reading-settings-label">
                        <span>字体</span>
                        <Select
                            value={draft.annotationFontFamily ?? "inherit"}
                            onChange={(e) => setDraft((prev) => ({
                                ...prev,
                                annotationFontFamily: e.target.value as ReadingAppearance["annotationFontFamily"],
                            }))}
                        >
                            {READING_ANNOTATION_FONT_OPTIONS.map((option) => (
                                option.id === "custom" && !draft.annotationCustomFontName ? null :
                                <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                        </Select>
                    </label>
                    <div className="reading-settings-inline-note">
                        <span>自定义字体</span>
                        <span>{draft.annotationCustomFontName ? `已选择 · ${draft.annotationCustomFontName}` : "未上传"}</span>
                    </div>
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => annotationFontFileRef.current?.click()}
                            disabled={saving}
                        >
                            <Type size={14} />
                            <span>{draft.annotationCustomFontName ? "更换字体" : "上传字体"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => {
                                setAnnotationFontFile(null);
                                setClearAnnotationFont(true);
                                setDraft((prev) => ({
                                    ...prev,
                                    annotationCustomFontName: undefined,
                                    annotationFontFamily: prev.annotationFontFamily === "custom" ? "inherit" : prev.annotationFontFamily,
                                }));
                            }}
                            disabled={saving || !draft.annotationCustomFontName}
                        >
                            <Trash2 size={14} />
                            <span>清除</span>
                        </button>
                    </div>
                    <input
                        ref={annotationFontFileRef}
                        type="file"
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (!file) return;
                            setAnnotationFontFile(file);
                            setClearAnnotationFont(false);
                            setDraft((prev) => ({
                                ...prev,
                                annotationFontFamily: "custom",
                                annotationCustomFontName: file.name,
                            }));
                        }}
                    />
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Palette size={15} />
                        <span>全屏背景</span>
                    </div>
                    <div
                        className="reading-bg-preview"
                        style={hasPreview ? { backgroundImage: `url("${previewUrl}")` } : undefined}
                    >
                        {!hasPreview && <span>书架页和阅读页共用背景</span>}
                    </div>
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
            </div>
        </ContentDialog>
    );
}
