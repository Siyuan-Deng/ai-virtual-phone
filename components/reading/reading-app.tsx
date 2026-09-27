"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
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
    resolveReadingAnnotationFontFamily,
    resolveReadingFontFamily,
    saveReadingAnnotationFont,
    saveReadingAppearance,
    saveReadingBackground,
    saveReadingCustomFont,
    type ReadingAppearance,
} from "@/lib/reading-appearance";

type Props = { onClose: () => void };

export default function ReadingApp({ onClose }: Props) {
    const [ready, setReady] = useState(false);
    const [activeBook, setActiveBook] = useState<Book | null>(null);
    const [appearance, setAppearance] = useState<ReadingAppearance>(DEFAULT_READING_APPEARANCE);
    const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
    const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
    const [annotationFontFamily, setAnnotationFontFamily] = useState<string | undefined>(undefined);
    // Keep track of the last opened book so viewer stays mounted
    const lastBookRef = useRef<Book | null>(null);
    const backgroundUrlRef = useRef<string | null>(null);
    const customFontUrlRef = useRef<string | null>(null);
    const annotationFontUrlRef = useRef<string | null>(null);
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
        setFamily: (family: string | undefined) => void,
        familyPrefix: string,
    ) => {
        if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = null;
        }
        setFamily(undefined);
        if (!blob) return;

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const familyName = `${familyPrefix}_${Date.now()}`;

        try {
            const face = new FontFace(familyName, `url("${url}")`);
            await face.load();
            document.fonts.add(face);
            setFamily(`"${familyName}"`);
        } catch {
            setFamily(undefined);
        }
    };

    const loadCustomFontFace = (blob: Blob | null) =>
        loadFontFace(blob, customFontUrlRef, setCustomFontFamily, "AIVirtualPhoneReadingFont");

    const loadAnnotationFontFace = (blob: Blob | null) =>
        loadFontFace(blob, annotationFontUrlRef, setAnnotationFontFamily, "AIVirtualPhoneReadingAnnotationFont");

    useEffect(() => {
        hydrateReadingStorage().then(() => setReady(true));
        setAppearance(loadReadingAppearance());
        // 串行读取：三者共用同一个 IndexedDB。并发打开时，若库缺 store 需要升版本补建，
        // 会被其它尚未关闭的连接 block 掉。顺序执行可以保证同一时刻只有一个连接。
        void (async () => {
            const background = await loadReadingBackground();
            updateBackgroundUrl(background ? URL.createObjectURL(background) : null);
            await loadCustomFontFace(await loadReadingCustomFont());
            await loadAnnotationFontFace(await loadReadingAnnotationFont());
        })();
        return () => {
            if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
            if (customFontUrlRef.current) URL.revokeObjectURL(customFontUrlRef.current);
            if (annotationFontUrlRef.current) URL.revokeObjectURL(annotationFontUrlRef.current);
        };
    }, []);

    const handleSaveAppearance = async (
        nextAppearance: ReadingAppearance,
        options: {
            backgroundFile: File | null;
            clearBackground: boolean;
            customFontFile: File | null;
            clearCustomFont: boolean;
            annotationFontFile: File | null;
            clearAnnotationFont: boolean;
        },
    ) => {
        const normalized = saveReadingAppearance(nextAppearance);
        setAppearance(normalized);

        // 放在下面几个 early return 之前：原有分支里清背景/清字体都会直接 return，
        // 挂在后面的话「同时改背景和批注字体」就会被吞掉。
        if (options.clearAnnotationFont) {
            await saveReadingAnnotationFont(null);
            await loadAnnotationFontFace(null);
        } else if (options.annotationFontFile) {
            await saveReadingAnnotationFont(options.annotationFontFile);
            await loadAnnotationFontFace(options.annotationFontFile);
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

    const resolvedAnnotationFont = resolveReadingAnnotationFontFamily(appearance.annotationFontFamily, annotationFontFamily);
    const appearanceStyle = {
        // 只有真的选了批注字体才下发这个变量；跟随正文时整条不出现，CSS 自然回退到正文字体
        ...(resolvedAnnotationFont
            ? { ["--reading-annotation-font-family" as "--reading-annotation-font-family"]: resolvedAnnotationFont }
            : {}),
        ["--reading-font-family" as "--reading-font-family"]: resolveReadingFontFamily(appearance.fontFamily, customFontFamily),
        ["--reading-font-size" as "--reading-font-size"]: `${appearance.fontSize}px`,
        ["--reading-text-color" as "--reading-text-color"]: appearance.textColor,
        ["--reading-line-height" as "--reading-line-height"]: String(appearance.lineHeight),
        ["--reading-bg-image" as "--reading-bg-image"]: backgroundUrl ? `url("${backgroundUrl}")` : "none",
    } as CSSProperties;
    const hiddenViewerStyle = {
        position: "absolute",
        inset: 0,
        visibility: "hidden",
        pointerEvents: "none",
    } as CSSProperties;

    if (!ready) return <div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "#fffced" }}><span className="ts-14" style={{ color: "#a39487" }}>加载中...</span></div>;

    return (
        <div className="absolute inset-0" style={appearanceStyle}>
            {!activeBook && (
                <ReadingShelf
                    onOpenBook={setActiveBook}
                    onClose={onClose}
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    onSaveAppearance={handleSaveAppearance}
                />
            )}
            {lastBookRef.current && (
                <div style={activeBook ? undefined : hiddenViewerStyle} aria-hidden={!activeBook}>
                    <ReadingViewer book={lastBookRef.current} onBack={() => setActiveBook(null)} />
                </div>
            )}
        </div>
    );
}
