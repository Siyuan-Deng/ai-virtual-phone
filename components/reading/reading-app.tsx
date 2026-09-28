"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { hydrateKvDb } from "@/lib/kv-db";
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

export default function ReadingApp({ onClose }: Props) {
    const [ready, setReady] = useState(false);
    const [activeBook, setActiveBook] = useState<Book | null>(null);
    const [appearance, setAppearance] = useState<ReadingAppearance>(DEFAULT_READING_APPEARANCE);
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

    const resolvedAnnotationFont = resolveReadingAnnotationFontFamily(appearance.annotationFontFamily, annotationFontFamily);
    const resolvedUserAnnotationFont = resolveReadingAnnotationFontFamily(appearance.userAnnotationFontFamily, userAnnotationFontFamily);
    const appearanceStyle = {
        // 只有真的选了批注字体才下发这个变量；跟随正文时整条不出现，CSS 自然回退到正文字体
        ...(resolvedAnnotationFont
            ? { ["--reading-annotation-font-family" as "--reading-annotation-font-family"]: resolvedAnnotationFont }
            : {}),
        ...(resolvedUserAnnotationFont
            ? { ["--reading-user-annotation-font-family" as "--reading-user-annotation-font-family"]: resolvedUserAnnotationFont }
            : {}),
        ["--reading-font-family" as "--reading-font-family"]: resolveReadingFontFamily(appearance.fontFamily, customFontFamily),
        ["--reading-font-size" as "--reading-font-size"]: `${appearance.fontSize}px`,
        ["--reading-text-color" as "--reading-text-color"]: appearance.textColor,
        ["--reading-line-height" as "--reading-line-height"]: String(appearance.lineHeight),
        ["--reading-bg-image" as "--reading-bg-image"]: backgroundUrl ? `url("${backgroundUrl}")` : "none",
    } as CSSProperties;
    // 传给阅读器，让它在字体/字号/行距变化后重新分页
    const appearanceKey = [
        appearance.fontFamily,
        appearance.fontSize,
        appearance.lineHeight,
        customFontFamily || "",
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
