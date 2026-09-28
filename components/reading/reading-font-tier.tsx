"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trash2, Type } from "lucide-react";
import { Select } from "@/components/ui/form";
import {
    READING_FONT_OPTIONS,
    READING_FONT_PREVIEW_TEXT,
    listReadingAnnotationFontOptions,
    type ReadingAnnotationFontFamilyId,
} from "@/lib/reading-appearance";
import { isFontStackIneffective } from "@/lib/reading-font-probe";

/** 正文 / TA的批注 / 我的批注 三档字体设置长得一模一样，只有标题、
 *  「跟随」那一项的措辞和落到哪个自定义字体不同，所以收成一个组件。 */
type Props = {
    heading: string;
    value: ReadingAnnotationFontFamilyId;
    /** 「跟随」项的文案；正文档位不传，下拉里就没有这一项 */
    inheritLabel?: string;
    /** 选「跟随」或自定义字体缺失时，预览该按哪个字体显示（与 CSS 的回退链一致） */
    inheritedCss: string;
    /** 已保存并加载好的自定义字体 family（形如 "XxxFont_123"），没有就是 undefined */
    loadedCustomFamily?: string;
    /** 已保存的自定义字体文件名 */
    customFontName?: string;
    /** 这次在弹窗里新选、还没保存的字体文件 */
    pendingFile: File | null;
    disabled: boolean;
    onChangeFamily: (next: ReadingAnnotationFontFamilyId) => void;
    onPickFile: (file: File) => void;
    onClearFont: () => void;
    /** 跟在字体控件后面的其它设置（正文档位用来放字号 / 行距 / 颜色） */
    children?: ReactNode;
};

/** 把「这次刚选、还没保存」的字体文件临时注册进 document.fonts，
 *  好让预览行立刻显示成它。组件卸载或换文件时注销，避免越攒越多。 */
function usePreviewFontFace(file: File | null): string | undefined {
    const [family, setFamily] = useState<string | undefined>(undefined);
    const faceRef = useRef<FontFace | null>(null);
    const urlRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const cleanup = () => {
            if (faceRef.current) {
                try { document.fonts.delete(faceRef.current); } catch { /* 浏览器不支持 delete 时忽略 */ }
                faceRef.current = null;
            }
            if (urlRef.current) {
                URL.revokeObjectURL(urlRef.current);
                urlRef.current = null;
            }
        };

        cleanup();
        setFamily(undefined);
        if (!file || typeof FontFace === "undefined") return cleanup;

        const url = URL.createObjectURL(file);
        urlRef.current = url;
        const familyName = `ReadingFontPreview_${Date.now()}`;
        const face = new FontFace(familyName, `url("${url}")`);
        void face.load().then(() => {
            if (cancelled) return;
            document.fonts.add(face);
            faceRef.current = face;
            setFamily(`"${familyName}"`);
        }).catch(() => {
            if (!cancelled) setFamily(undefined);
        });

        return () => { cancelled = true; cleanup(); };
    }, [file]);

    return family;
}

export function ReadingFontTier({
    heading,
    value,
    inheritLabel,
    inheritedCss,
    loadedCustomFamily,
    customFontName,
    pendingFile,
    disabled,
    onChangeFamily,
    onPickFile,
    onClearFont,
    children,
}: Props) {
    const fileRef = useRef<HTMLInputElement>(null);
    const previewFamily = usePreviewFontFace(pendingFile);

    /** 这台设备上哪些字体其实没效果。iOS 只开放很少几个字体给网页，
     *  选了没反应的选项必须如实标出来，否则就是个假开关。 */
    const ineffective = useMemo(() => {
        if (typeof window === "undefined") return new Set<string>();
        const baseline = getComputedStyle(document.documentElement)
            .getPropertyValue("--app-font-family").trim() || "sans-serif";
        const result = new Set<string>();
        for (const option of READING_FONT_OPTIONS) {
            if (option.id === "system" || option.id === "custom") continue;
            if (isFontStackIneffective(option.cssValue, baseline)) result.add(option.id);
        }
        return result;
    }, []);

    const options = useMemo(() => {
        const all = listReadingAnnotationFontOptions(value);
        const withHint = all.map((option) => (
            ineffective.has(option.id) ? { ...option, label: `${option.label}（本机无效果）` } : option
        ));
        return inheritLabel
            ? withHint.map((option) => (option.id === "inherit" ? { ...option, label: inheritLabel } : option))
            : withHint.filter((option) => option.id !== "inherit");
    }, [ineffective, inheritLabel, value]);

    const isCustom = value === "custom";
    const customFamily = previewFamily || loadedCustomFamily;
    /** 预览用的字体：自定义但还没上传就退回继承链，和真实渲染的结果一致 */
    const previewCss = value === "inherit"
        ? inheritedCss
        : isCustom
            ? (customFamily || inheritedCss)
            : (READING_FONT_OPTIONS.find((option) => option.id === value)?.cssValue || inheritedCss);
    const pickedName = pendingFile?.name || customFontName;

    return (
        <section className="reading-settings-group">
            <div className="reading-settings-heading">
                <Type size={15} />
                <span>{heading}</span>
            </div>
            <label className="reading-settings-label reading-settings-label--bare">
                <Select
                    value={value}
                    onChange={(e) => onChangeFamily(e.target.value as ReadingAnnotationFontFamilyId)}
                >
                    {options.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                </Select>
            </label>
            <div className="reading-font-preview" style={{ fontFamily: previewCss }}>
                {READING_FONT_PREVIEW_TEXT}
            </div>
            {ineffective.has(value) && (
                <div className="reading-settings-inline-note">
                    <span>提示</span>
                    <span>这台设备没有这个字体，实际显示的是系统默认；想换字体可以选「自定义字体」上传一个字体文件。</span>
                </div>
            )}

            {isCustom && (
                <>
                    <div className="reading-settings-inline-note">
                        <span>字体文件</span>
                        <span>{pickedName ? `已选择 · ${pickedName}` : "未上传，暂按默认字体显示"}</span>
                    </div>
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => fileRef.current?.click()}
                            disabled={disabled}
                        >
                            <Type size={14} />
                            <span>{pickedName ? "更换字体" : "上传字体"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={onClearFont}
                            disabled={disabled || !pickedName}
                        >
                            <Trash2 size={14} />
                            <span>清除</span>
                        </button>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (file) onPickFile(file);
                        }}
                    />
                </>
            )}

            {children}
        </section>
    );
}
