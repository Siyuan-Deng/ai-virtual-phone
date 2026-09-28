"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadReadingCustomCss, saveReadingCustomCss } from "@/lib/reading-custom-css";
import { hydrateReadingStorage } from "@/lib/reading-storage";
import { ReadingShelf } from "./reading-shelf";
import { ReadingViewer } from "./reading-viewer";
import type { Book } from "@/lib/reading-types";
import {
    DEFAULT_READING_APPEARANCE,
    loadReadingAnnotationFont,
    loadReadingAppearance,
    loadReadingBackground,
    loadReadingCustomFont,
    loadReadingUserAnnotationFont,
    readingBackgroundOverlay,
    readingMarkColor,
    READING_ANNOTATION_STYLE_DEFAULTS,
    resolveReadingAnnotationFontFamily,
    resolveReadingFontFamily,
    saveReadingAnnotationFont,
    saveReadingAppearance,
    saveReadingBackground,
    saveReadingCustomFont,
    saveReadingUserAnnotationFont,
    type ReadingAppearance,
} from "@/lib/reading-appearance";
import type { ReadingAppearanceSaveOptions } from "./reading-appearance-dialog";

type Props = { onClose: () => void };

type AnnotationCardStyle = { fontSize: number; lineHeight: number; textColor: string; cardColor: string };

/** 一档批注卡片的样式。suffix 为空是 TA 的批注（也就是所有卡片的基准），
 *  [data-author="user"] 是用户自己的那档，权重更高，自然盖在基准上面。 */
function annotationCardCss(suffix: string, style: AnnotationCardStyle): string {
    const card = `.reading-app-surface .reading-annotation${suffix}`;
    return [
        `${card} {`,
        `  background: ${style.cardColor};`,
        "}",
        // 卡片顶上那截「胶带」跟着卡片颜色走，否则换了底色会留下一条不搭的旧色
        `${card}::before {`,
        `  background: ${readingMarkColor(style.cardColor, 0.6)};`,
        "}",
        `${card} .reading-annotation-text,`,
        `${card} .reading-annotation-translation {`,
        `  font-size: calc(${style.fontSize}px * var(--app-text-scale, 1));`,
        `  line-height: ${style.lineHeight};`,
        `  color: ${style.textColor};`,
        "}",
        `${card} .reading-annotation-name {`,
        `  font-size: calc(${Math.round(style.fontSize * 0.85 * 10) / 10}px * var(--app-text-scale, 1));`,
        `  color: ${style.textColor};`,
        "}",
    ].join("\n");
}

export default function ReadingApp({ onClose }: Props) {
    const [ready, setReady] = useState(false);
    const [activeBook, setActiveBook] = useState<Book | null>(null);
    const [appearance, setAppearance] = useState<ReadingAppearance>(DEFAULT_READING_APPEARANCE);
    const [customCss, setCustomCss] = useState("");
    const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
    const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
    const [annotationFontFamily, setAnnotationFontFamily] = useState<string | undefined>(undefined);
    const [userAnnotationFontFamily, setUserAnnotationFontFamily] = useState<string | undefined>(undefined);
    // Keep track of the last opened book so viewer stays mounted
    const lastBookRef = useRef<Book | null>(null);
    const backgroundUrlRef = useRef<string | null>(null);
    const customFontUrlRef = useRef<string | null>(null);
    const annotationFontUrlRef = useRef<string | null>(null);
    const userAnnotationFontUrlRef = useRef<string | null>(null);
    // 换字体时要把上一张 FontFace 从 document.fonts 摘掉：family 名带时间戳，
    // 不摘的话每次保存都会往文档里多挂一份字体，字体文件又不小。
    const customFontFaceRef = useRef<FontFace | null>(null);
    const annotationFontFaceRef = useRef<FontFace | null>(null);
    const userAnnotationFontFaceRef = useRef<FontFace | null>(null);
    if (activeBook) lastBookRef.current = activeBook;

    const updateBackgroundUrl = (nextUrl: string | null) => {
        if (backgroundUrlRef.current && backgroundUrlRef.current !== nextUrl) {
            URL.revokeObjectURL(backgroundUrlRef.current);
        }
        backgroundUrlRef.current = nextUrl;
        setBackgroundUrl(nextUrl);
    };

    const loadFontFace = async (
        blob: Blob | null,
        urlRef: React.MutableRefObject<string | null>,
        faceRef: React.MutableRefObject<FontFace | null>,
        setFamily: (family: string | undefined) => void,
        familyPrefix: string,
    ) => {
        if (faceRef.current) {
            try { document.fonts.delete(faceRef.current); } catch { /* 老浏览器没有 delete，忽略 */ }
            faceRef.current = null;
        }
        if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = null;
        }
        setFamily(undefined);
        if (!blob || typeof FontFace === "undefined") return;

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const familyName = `${familyPrefix}_${Date.now()}`;

        try {
            const face = new FontFace(familyName, `url("${url}")`);
            await face.load();
            document.fonts.add(face);
            faceRef.current = face;
            setFamily(`"${familyName}"`);
        } catch {
            setFamily(undefined);
        }
    };

    const loadCustomFontFace = (blob: Blob | null) =>
        loadFontFace(blob, customFontUrlRef, customFontFaceRef, setCustomFontFamily, "AIVirtualPhoneReadingFont");

    const loadAnnotationFontFace = (blob: Blob | null) =>
        loadFontFace(blob, annotationFontUrlRef, annotationFontFaceRef, setAnnotationFontFamily, "AIVirtualPhoneReadingAnnotationFont");

    const loadUserAnnotationFontFace = (blob: Blob | null) =>
        loadFontFace(blob, userAnnotationFontUrlRef, userAnnotationFontFaceRef, setUserAnnotationFontFamily, "AIVirtualPhoneReadingUserAnnotationFont");

    useEffect(() => {
        void (async () => {
            // 外观存在 kv 里，而 kv 的同步缓存要等 hydrate 完才有内容。先读会拿到空缓存，
            // 于是整套外观静默退回默认值——用户看到的就是「设置根本没保存上」。
            await Promise.all([hydrateKvDb(), hydrateReadingStorage()]).catch(() => {});
            setAppearance(loadReadingAppearance());
            setCustomCss(loadReadingCustomCss());
            setReady(true);
            // 串行读取：这几项共用同一个 IndexedDB。并发打开时，若库缺 store 需要升版本补建，
            // 会被其它尚未关闭的连接 block 掉。顺序执行可以保证同一时刻只有一个连接。
            const background = await loadReadingBackground();
            updateBackgroundUrl(background ? URL.createObjectURL(background) : null);
            await loadCustomFontFace(await loadReadingCustomFont());
            await loadAnnotationFontFace(await loadReadingAnnotationFont());
            await loadUserAnnotationFontFace(await loadReadingUserAnnotationFont());
        })();
        return () => {
            if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
            if (customFontUrlRef.current) URL.revokeObjectURL(customFontUrlRef.current);
            if (annotationFontUrlRef.current) URL.revokeObjectURL(annotationFontUrlRef.current);
            if (userAnnotationFontUrlRef.current) URL.revokeObjectURL(userAnnotationFontUrlRef.current);
            for (const faceRef of [customFontFaceRef, annotationFontFaceRef, userAnnotationFontFaceRef]) {
                if (!faceRef.current) continue;
                try { document.fonts.delete(faceRef.current); } catch { /* 老浏览器没有 delete，忽略 */ }
                faceRef.current = null;
            }
        };
    }, []);

    const handleSaveAppearance = async (
        nextAppearance: ReadingAppearance,
        options: ReadingAppearanceSaveOptions,
    ) => {
        const normalized = saveReadingAppearance(nextAppearance);
        setAppearance(normalized);
        // 自定义 CSS 和外观一起保存。放在最前面：下面几个分支会 early return
        setCustomCss(saveReadingCustomCss(options.customCss));

        // 放在下面几个 early return 之前：原有分支里清背景/清字体都会直接 return，
        // 挂在后面的话「同时改背景和批注字体」就会被吞掉。
        if (options.clearAnnotationFont) {
            await saveReadingAnnotationFont(null);
            await loadAnnotationFontFace(null);
        } else if (options.annotationFontFile) {
            await saveReadingAnnotationFont(options.annotationFontFile);
            await loadAnnotationFontFace(options.annotationFontFile);
        }

        if (options.clearUserAnnotationFont) {
            await saveReadingUserAnnotationFont(null);
            await loadUserAnnotationFontFace(null);
        } else if (options.userAnnotationFontFile) {
            await saveReadingUserAnnotationFont(options.userAnnotationFontFile);
            await loadUserAnnotationFontFace(options.userAnnotationFontFile);
        }

        if (options.clearBackground) {
            await saveReadingBackground(null);
            updateBackgroundUrl(null);
            return;
        }

        if (options.backgroundFile) {
            await saveReadingBackground(options.backgroundFile);
            updateBackgroundUrl(URL.createObjectURL(options.backgroundFile));
        }

        if (options.clearCustomFont) {
            await saveReadingCustomFont(null);
            await loadCustomFontFace(null);
            return;
        }

        if (options.customFontFile) {
            await saveReadingCustomFont(options.customFontFile);
            await loadCustomFontFace(options.customFontFile);
        }
    };

    // 亮度是盖在背景图上的一层纯色，和图一起塞进同一个变量，
    // 这样所有用到 --reading-bg-image 的地方（书架、阅读页、翻页动画）都自动跟着变。
    const backgroundOverlay = readingBackgroundOverlay(appearance.backgroundBrightness);
    const backgroundLayers = backgroundUrl
        ? (backgroundOverlay ? `${backgroundOverlay}, url("${backgroundUrl}")` : `url("${backgroundUrl}")`)
        : "none";
    const resolvedAnnotationFont = resolveReadingAnnotationFontFamily(appearance.annotationFontFamily, annotationFontFamily);
    const resolvedUserAnnotationFont = resolveReadingAnnotationFontFamily(appearance.userAnnotationFontFamily, userAnnotationFontFamily);
    const resolvedBodyFont = resolveReadingFontFamily(appearance.fontFamily, customFontFamily);

    const annotationStyle = {
        fontSize: appearance.annotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize,
        lineHeight: appearance.annotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight,
        textColor: appearance.annotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.textColor,
        cardColor: appearance.annotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.cardColor,
    };
    const userAnnotationStyle = {
        fontSize: appearance.userAnnotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize,
        lineHeight: appearance.userAnnotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight,
        textColor: appearance.userAnnotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.userTextColor,
        cardColor: appearance.userAnnotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.userCardColor,
    };

    // 字体由这段注入的 <style> 统一下发，而不是靠「根节点内联 + 继承」。
    //
    // 起因：用户的全局自定义 CSS 里有一条普通优先级的字体规则，它打不过带声明的
    // 元素，却稳稳打赢「继承」——于是正文 <p>、书架标题 <h1> 这些靠继承拿字体的
    // 元素全被接管，而批注是 <span>、没被那条规则选中，反倒一直是对的。这类事故
    // 以后还会有（插件、主题、自定义 CSS 都能注入全局样式），所以阅读区的字体给成
    // 真正的声明、并且带上一点选择器权重，别再把它挂在最弱的继承上。
    // 这里刻意不用 !important：用户想用自定义 CSS 精细覆盖阅读样式时还能盖得动。
    //
    // 排除项：设置里的字体样张和诊断报告要保留自己的字体，否则预览就没意义了。
    // :where() 本身不带权重，所以整条规则只有「一个 class」那么重：
    // 足以压过 p{} / body *{} 这类全局规则，又不至于让用户没法再覆盖它。
    const FONT_EXCLUDES = ":not(:where(.reading-font-preview, .reading-font-diag-report,"
        + " .reading-annotation-name, .reading-annotation-text, .reading-annotation-translation))";
    const readingFontCss = [
        [
            ".reading-app-surface,",
            `.reading-app-surface *${FONT_EXCLUDES} {`,
            `  font-family: ${resolvedBodyFont};`,
            "}",
        ].join("\n"),
        [
            ".reading-app-surface .reading-annotation-name,",
            ".reading-app-surface .reading-annotation-text,",
            ".reading-app-surface .reading-annotation-translation {",
            `  font-family: ${resolvedAnnotationFont || resolvedBodyFont};`,
            "}",
        ].join("\n"),
        resolvedUserAnnotationFont && [
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-name,',
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-text,',
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-translation {',
            `  font-family: ${resolvedUserAnnotationFont};`,
            "}",
        ].join("\n"),
        // 提示词输入框保持等宽，别被上面那条通吃规则带走
        [
            ".reading-app-surface .reading-settings-prompt textarea,",
            ".reading-app-surface .chat-bilingual-prompt-textarea {",
            "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;",
            "}",
        ].join("\n"),
        // 批注卡片：字号、行距、文字颜色、卡片底色。名字那行按正文的 0.85 缩放，
        // 否则把批注字号调大以后，署名还是原来那么小，看着像没跟上。
        annotationCardCss("", annotationStyle),
        annotationCardCss('[data-author="user"]', userAnnotationStyle),
        // 高亮 / 划线的颜色
        [
            '.reading-app-surface .reading-mark[data-style="highlight"] {',
            `  background: ${readingMarkColor(appearance.highlightColor || READING_ANNOTATION_STYLE_DEFAULTS.highlightColor, 0.72)};`,
            "}",
            '.reading-app-surface .reading-mark[data-style="underline"] {',
            `  border-bottom-color: ${readingMarkColor(appearance.underlineColor || READING_ANNOTATION_STYLE_DEFAULTS.underlineColor, 0.85)};`,
            "}",
        ].join("\n"),
    ].filter(Boolean).join("\n");

    const appearanceStyle = {
        fontFamily: resolvedBodyFont,
        // 三个字体变量继续下发：新版 CSS 已经不读它们了，但用户手机上可能还缓存着
        // 旧版 CSS（PWA 的 Service Worker 会把整套静态资源存下来）。旧规则读到变量
        // 就还能正常显示，读不到则回落成系统字体——正是「换了字体没反应」的样子。
        ["--reading-font-family" as "--reading-font-family"]: resolvedBodyFont,
        ...(resolvedAnnotationFont
            ? { ["--reading-annotation-font-family" as "--reading-annotation-font-family"]: resolvedAnnotationFont }
            : {}),
        ...(resolvedUserAnnotationFont
            ? { ["--reading-user-annotation-font-family" as "--reading-user-annotation-font-family"]: resolvedUserAnnotationFont }
            : {}),
        ["--reading-font-size" as "--reading-font-size"]: `${appearance.fontSize}px`,
        ["--reading-text-color" as "--reading-text-color"]: appearance.textColor,
        ["--reading-line-height" as "--reading-line-height"]: String(appearance.lineHeight),
        ["--reading-bg-image" as "--reading-bg-image"]: backgroundLayers,
    } as CSSProperties;
    // 传给阅读器，让它在字体/字号/行距变化后重新分页。批注字体也算进来：
    // 翻页模式连批注块的高度一起量，批注换字体同样会改变每页塞得下多少东西。
    const appearanceKey = [
        appearance.fontSize,
        appearance.lineHeight,
        resolvedBodyFont,
        resolvedAnnotationFont || "",
        resolvedUserAnnotationFont || "",
        // 批注的字号和行距也会改变卡片高度，翻页模式得重新分页
        annotationStyle.fontSize,
        annotationStyle.lineHeight,
        userAnnotationStyle.fontSize,
        userAnnotationStyle.lineHeight,
    ].join("|");
    const hiddenViewerStyle = {
        position: "absolute",
        inset: 0,
        visibility: "hidden",
        pointerEvents: "none",
    } as CSSProperties;

    if (!ready) return <div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "#fffced" }}><span className="ts-14" style={{ color: "#a39487" }}>加载中...</span></div>;

    return (
        <div className="absolute inset-0" style={appearanceStyle}>
            <style>{readingFontCss}</style>
            {/* 用户自己写的阅读 CSS 放在最后，才盖得过上面那几条 */}
            {customCss && <style>{customCss}</style>}
            {!activeBook && (
                <ReadingShelf
                    onOpenBook={setActiveBook}
                    onClose={onClose}
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    loadedFonts={{
                        body: customFontFamily,
                        annotation: annotationFontFamily,
                        userAnnotation: userAnnotationFontFamily,
                    }}
                    onSaveAppearance={handleSaveAppearance}
                />
            )}
            {lastBookRef.current && (
                <div style={activeBook ? undefined : hiddenViewerStyle} aria-hidden={!activeBook}>
                    <ReadingViewer book={lastBookRef.current} appearanceKey={appearanceKey} onBack={() => setActiveBook(null)} />
                </div>
            )}
        </div>
    );
}
