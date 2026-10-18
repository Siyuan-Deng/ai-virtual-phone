"use client";

import { useEffect, useRef, useState } from "react";
import { ContentDialog } from "@/components/ui/modal";
import { Toggle } from "@/components/ui/form";
import { downloadFile } from "@/lib/download-utils";
import { loadReadingProfile, loadReadingProfileAvatar } from "@/lib/reading-profile";
import {
    READING_SHARE_PALETTES,
    READING_SHARE_TEMPLATES,
    READING_SHARE_TEMPLATE_PRESETS,
    readingShareCardToBlob,
    renderReadingShareCard,
    type ReadingShareAlign,
    type ReadingShareAnnotation,
    type ReadingShareAvatarShape,
    type ReadingShareFonts,
    type ReadingShareJoin,
    type ReadingSharePalette,
    type ReadingShareSegment,
    READING_SHARE_RATIOS,
    type ReadingShareRatio,
    type ReadingShareTemplate,
} from "@/lib/reading-share-card";
import { ReadingPresetBar } from "./reading-preset-bar";
import { ColorInput } from "@/components/ui/form";
import {
    READING_ANNOTATION_STYLE_DEFAULTS,
    loadReadingAppearance,
} from "@/lib/reading-appearance";

type Props = {
    quoteParagraphs: string[];
    /** 片刻纪事合并分享：几段各自带出处和说话人。给了就能选怎么隔开；你我都有时还能分开对齐 */
    quoteSegments?: ReadingShareSegment[];
    bookTitle: string;
    bookAuthor: string;
    chapterTitle: string;
    progressPercent: number;
    annotations: ReadingShareAnnotation[];
    onClose: () => void;
    /** 片刻纪事借用这个弹窗：进度位写日期 */
    progressLabel?: string;
    /** 署名换成说这句话的人；不给就是阅读账号 */
    signature?: { name: string; avatar?: string };
    /** 片刻纪事：署名可以选角色、自己或两人（两人时再选谁在前，默认自己在前）。给了它就不看 signature */
    signatureChoices?: {
        char: { name: string; avatar?: string };
        user: { name: string; avatar?: string };
        /** 打开时默认选谁：说这句话的人（合并时你我都有就是两人） */
        initial: "char" | "user" | "both";
    };
    /** 字体直接给；不给就去阅读界面里量 */
    fonts?: ReadingShareFonts;
    /** 片刻纪事：自己的话用 user 字体；他的话可以选系统字体（fonts.body）还是 char 字体 */
    speakerFonts?: { user: string; char: string };
    title?: string;
    /** 存图的文件名开头 */
    filePrefix?: string;
};

/** 头像地址（data URL 或图片地址）读成能画到 canvas 上的图 */
async function loadAvatarImage(src: string): Promise<CanvasImageSource | null> {
    // 用 onload 不用 decode()：页面在后台（切走、锁屏）时 decode() 会一直等着，图就出不来
    return new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

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

const SEGMENT_JOINS: Array<[string, ReadingShareJoin]> = [["「……」", "ellipsis"], ["出处", "caption"], ["直接接上", "none"]];
const ALIGNS: Array<[string, ReadingShareAlign]> = [["左对齐", "left"], ["居中", "center"], ["右对齐", "right"]];
const TINTS: Array<[string, boolean]> = [["原色", false], ["淡化", true]];
const CHAR_FONTS: Array<[string, "system" | "char"]> = [["系统字体", "system"], ["角色字体", "char"]];

/** 一排单选的小胶囊 */
function ChipRow<T>({ options, value, onChange }: { options: Array<[string, T]>; value: T; onChange: (value: T) => void }) {
    return (
        <div className="reading-share-aligns">
            {options.map(([label, option]) => (
                <button
                    key={label}
                    type="button"
                    className={`reading-share-template${value === option ? " is-active" : ""}`}
                    onClick={() => onChange(option)}
                >{label}</button>
            ))}
        </div>
    );
}

export function ReadingShareDialog({
    quoteParagraphs, quoteSegments, bookTitle, bookAuthor, chapterTitle, progressPercent, annotations, onClose,
    progressLabel, signature, signatureChoices, fonts, speakerFonts, title = "分享摘抄", filePrefix = "摘抄",
}: Props) {
    const [signer, setSigner] = useState<"char" | "user" | "both">(signatureChoices?.initial ?? "char");
    const [signerOrder, setSignerOrder] = useState<"user" | "char">("user");
    const [template, setTemplate] = useState<ReadingShareTemplate>("poster");
    const [palette, setPalette] = useState<ReadingSharePalette>(READING_SHARE_TEMPLATE_PRESETS.poster);
    const [align, setAlign] = useState<ReadingShareAlign>(READING_SHARE_TEMPLATE_PRESETS.poster.align);
    const [avatarShape, setAvatarShape] = useState<ReadingShareAvatarShape>("circle");
    const [ratio, setRatio] = useState<ReadingShareRatio>("auto");
    const [segmentJoin, setSegmentJoin] = useState<ReadingShareJoin>("ellipsis");
    const [tintUser, setTintUser] = useState(false);
    /** 自己的话默认靠右，他的话跟模板走（就是上面那个 align） */
    const [userAlign, setUserAlign] = useState<ReadingShareAlign>("right");
    const merged = (quoteSegments?.length ?? 0) > 1;
    const mixed = merged
        && quoteSegments!.some(segment => segment.speaker === "user")
        && quoteSegments!.some(segment => segment.speaker !== "user");
    /** 他的话用系统字体还是角色字体（只在片刻纪事、而且有他的话时可选） */
    const [charFont, setCharFont] = useState<"system" | "char">("system");
    const canPickCharFont = Boolean(speakerFonts && signatureChoices && quoteSegments?.some(segment => segment.speaker !== "user"));

    /** 换模板时配色和对齐回到那个模板的出厂值——深色版面套上浅色底会直接糊掉 */
    const pickTemplate = (next: ReadingShareTemplate) => {
        const preset = READING_SHARE_TEMPLATE_PRESETS[next];
        setTemplate(next);
        setPalette({ background: preset.background, ink: preset.ink, sub: preset.sub, accent: preset.accent });
        setAlign(preset.align);
    };

    /** 存一档 = 模板 + 配色 + 对齐 */
    type ShareStyle = {
        template: ReadingShareTemplate;
        palette: ReadingSharePalette;
        align: ReadingShareAlign;
        avatarShape?: ReadingShareAvatarShape;
        ratio?: ReadingShareRatio;
        // 片刻纪事才有的几项：存档时这一页有才存，读档时档里有才改（阅读那边和老档都没有，照旧）
        signer?: "char" | "user" | "both";
        signerOrder?: "user" | "char";
        userAlign?: ReadingShareAlign;
        tintUser?: boolean;
        segmentJoin?: ReadingShareJoin;
        charFont?: "system" | "char";
    };
    const currentStyle = (): ShareStyle => ({
        template, palette, align, avatarShape, ratio,
        ...(signatureChoices ? { signer, signerOrder } : {}),
        ...(mixed ? { userAlign, tintUser } : {}),
        ...(merged ? { segmentJoin } : {}),
        ...(canPickCharFont ? { charFont } : {}),
    });
    const applyStyle = (style: ShareStyle) => {
        if (!style?.template || !READING_SHARE_TEMPLATE_PRESETS[style.template]) return;
        setTemplate(style.template);
        if (style.palette) setPalette(style.palette);
        if (style.align) setAlign(style.align);
        setAvatarShape(style.avatarShape === "square" ? "square" : "circle");
        // 老档里没有比例这项，当成自适应
        setRatio(READING_SHARE_RATIOS.some(item => item.id === style.ratio) ? style.ratio as ReadingShareRatio : "auto");
        if (style.signer === "char" || style.signer === "user" || style.signer === "both") setSigner(style.signer);
        if (style.signerOrder === "user" || style.signerOrder === "char") setSignerOrder(style.signerOrder);
        if (ALIGNS.some(([, value]) => value === style.userAlign)) setUserAlign(style.userAlign as ReadingShareAlign);
        if (typeof style.tintUser === "boolean") setTintUser(style.tintUser);
        if (SEGMENT_JOINS.some(([, value]) => value === style.segmentJoin)) setSegmentJoin(style.segmentJoin as ReadingShareJoin);
        if (style.charFont === "system" || style.charFont === "char") setCharFont(style.charFont);
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
    /** 片刻纪事两个人的头像，按地址缓存，切署名时不用重新解码 */
    const choiceAvatarsRef = useRef(new Map<string, CanvasImageSource | null>());
    /** 摘抄内容在弹窗打开期间不会变；钉住，免得父组件重渲染就重画一遍 */
    const contentRef = useRef({ quoteParagraphs, quoteSegments, speakerFonts, annotations, bookTitle, bookAuthor, chapterTitle, progressPercent, progressLabel, signature, signatureChoices, fonts });

    useEffect(() => {
        let cancelled = false;
        const draw = async () => {
            try {
                const given = contentRef.current;
                // 片刻纪事：按选的署名排出「第一个 / 第二个」
                const choices = given.signatureChoices;
                const signers = choices
                    ? (signer === "both"
                        ? (signerOrder === "user" ? [choices.user, choices.char] : [choices.char, choices.user])
                        : [signer === "user" ? choices.user : choices.char])
                    : null;
                const loadChoiceAvatar = async (src?: string) => {
                    if (!src) return null;
                    const cache = choiceAvatarsRef.current;
                    if (!cache.has(src)) cache.set(src, await loadAvatarImage(src));
                    return cache.get(src) ?? null;
                };
                const choiceAvatars = signers ? await Promise.all(signers.map(item => loadChoiceAvatar(item.avatar))) : [];
                if (!signers && avatarRef.current === null) {
                    if (given.signature) {
                        avatarRef.current = given.signature.avatar ? await loadAvatarImage(given.signature.avatar) : null;
                    } else {
                        const blob = await loadReadingProfileAvatar().catch(() => null);
                        if (blob && typeof createImageBitmap === "function") {
                            avatarRef.current = await createImageBitmap(blob).catch(() => null);
                        }
                    }
                }
                // 等字体真正可用，否则画出来的是系统字体
                if (typeof document !== "undefined" && document.fonts?.ready) {
                    if (given.fonts) await document.fonts.load(`40px ${given.fonts.body}`).catch(() => {});
                    for (const family of [given.speakerFonts?.user, given.speakerFonts?.char]) {
                        if (family) await document.fonts.load(`40px ${family}`).catch(() => {});
                    }
                    await document.fonts.ready.catch(() => {});
                }
                if (cancelled) return;

                const content = contentRef.current;
                const appearance = loadReadingAppearance();
                const canvas = renderReadingShareCard({
                    template,
                    quoteParagraphs: content.quoteParagraphs,
                    ...(content.quoteSegments?.length ? { quoteSegments: content.quoteSegments } : {}),
                    ...(merged ? { segmentJoin } : {}),
                    ...(content.speakerFonts ? {
                        speakerFonts: {
                            user: content.speakerFonts.user,
                            ...(charFont === "char" ? { char: content.speakerFonts.char } : {}),
                        },
                    } : {}),
                    ...(mixed ? { userAlign, tintUserSegments: tintUser } : {}),
                    bookTitle: content.bookTitle,
                    bookAuthor: content.bookAuthor,
                    chapterTitle: content.chapterTitle,
                    userName: signers ? signers[0].name : content.signature ? content.signature.name : loadReadingProfile().name,
                    avatar: signers ? choiceAvatars[0] : avatarRef.current,
                    ...(signers && signers[1] ? { coSigner: { name: signers[1].name, avatar: choiceAvatars[1] } } : {}),
                    progressPercent: content.progressPercent,
                    progressLabel: content.progressLabel,
                    annotations: content.annotations.filter((annotation) => (
                        annotation.authorType === "user" ? withMine : withTheirs
                    )),
                    annotationColors: {
                        user: appearance.userAnnotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.userCardColor,
                        character: appearance.annotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.cardColor,
                    },
                    fonts: content.fonts ?? resolveRenderedFonts(),
                    timestamp: new Date(),
                    palette,
                    align,
                    avatarShape,
                    ratio,
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
    }, [align, avatarShape, palette, ratio, template, withMine, withTheirs, signer, signerOrder, merged, mixed, segmentJoin, userAlign, tintUser, charFont]);

    const handleDownload = async () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
            setBusy(true);
            setError(null);
            const blob = await readingShareCardToBlob(canvas);
            const stamp = new Date().toISOString().slice(0, 10);
            await downloadFile(blob, `${filePrefix}-${contentRef.current.bookTitle || "未命名"}-${stamp}.png`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <ContentDialog
            title={title}
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
                    <div className="reading-share-schemes">
                        {READING_SHARE_PALETTES[template].map((scheme) => {
                            const active = scheme.palette.background === palette.background
                                && scheme.palette.ink === palette.ink
                                && scheme.palette.accent === palette.accent;
                            return (
                                <button
                                    key={scheme.name}
                                    type="button"
                                    className={`reading-share-scheme${active ? " is-active" : ""}`}
                                    onClick={() => setPalette(scheme.palette)}
                                    title={scheme.name}
                                    aria-label={scheme.name}
                                >
                                    <span className="reading-share-scheme-swatch" style={{ background: scheme.palette.background }}>
                                        <i style={{ background: scheme.palette.accent }} />
                                        <i style={{ background: scheme.palette.ink }} />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
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
                    {mixed && signatureChoices ? (
                        // 你我都有：名字一列，右边各一排对齐；他那排底下可选字体，自己那排底下是原色/淡化
                        <div className="reading-share-who-grid">
                            <span className="reading-share-who">{signatureChoices.char.name}</span>
                            <ChipRow options={ALIGNS} value={align} onChange={setAlign} />
                            {canPickCharFont && (
                                <>
                                    <span aria-hidden="true" />
                                    <ChipRow options={CHAR_FONTS} value={charFont} onChange={setCharFont} />
                                </>
                            )}
                            <span className="reading-share-who">{signatureChoices.user.name}</span>
                            <ChipRow options={ALIGNS} value={userAlign} onChange={setUserAlign} />
                            <span aria-hidden="true" />
                            <ChipRow options={TINTS} value={tintUser} onChange={setTintUser} />
                        </div>
                    ) : (
                        <>
                            <ChipRow options={ALIGNS} value={align} onChange={setAlign} />
                            {canPickCharFont && signatureChoices && (
                                <div className="reading-share-who-grid">
                                    <span className="reading-share-who">{signatureChoices.char.name}</span>
                                    <ChipRow options={CHAR_FONTS} value={charFont} onChange={setCharFont} />
                                </div>
                            )}
                        </>
                    )}
                    {merged && (
                        <>
                            <span className="reading-settings-label-inline">段与段之间</span>
                            <div className="reading-share-aligns">
                                {SEGMENT_JOINS.map(([label, value]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        className={`reading-share-template${segmentJoin === value ? " is-active" : ""}`}
                                        onClick={() => setSegmentJoin(value)}
                                    >{label}</button>
                                ))}
                            </div>
                        </>
                    )}
                    <div className="reading-share-aligns">
                        {READING_SHARE_RATIOS.map(({ id, label }) => (
                            <button
                                key={id}
                                type="button"
                                className={`reading-share-template${ratio === id ? " is-active" : ""}`}
                                onClick={() => setRatio(id)}
                            >{label}</button>
                        ))}
                    </div>
                    <div className="reading-share-aligns">
                        {([["圆头像", "circle"], ["方头像", "square"]] as Array<[string, ReadingShareAvatarShape]>).map(([label, value]) => (
                            <button
                                key={value}
                                type="button"
                                className={`reading-share-template${avatarShape === value ? " is-active" : ""}`}
                                onClick={() => setAvatarShape(value)}
                            >{label}</button>
                        ))}
                    </div>
                    {signatureChoices && (
                        <>
                            <span className="reading-settings-label-inline">署名</span>
                            <div className="reading-share-aligns">
                                {([
                                    [signatureChoices.char.name, "char"],
                                    [signatureChoices.user.name, "user"],
                                    ["两人", "both"],
                                ] as Array<[string, "char" | "user" | "both"]>).map(([label, value]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        className={`reading-share-template${signer === value ? " is-active" : ""}`}
                                        onClick={() => setSigner(value)}
                                    >{label}</button>
                                ))}
                            </div>
                            {signer === "both" && (
                                <div className="reading-share-aligns">
                                    {([
                                        [`${signatureChoices.user.name}在前`, "user"],
                                        [`${signatureChoices.char.name}在前`, "char"],
                                    ] as Array<[string, "user" | "char"]>).map(([label, value]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            className={`reading-share-template${signerOrder === value ? " is-active" : ""}`}
                                            onClick={() => setSignerOrder(value)}
                                        >{label}</button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                    <ReadingPresetBar<ShareStyle>
                        kind="share"
                        current={currentStyle}
                        onLoad={applyStyle}
                        defaultName={READING_SHARE_TEMPLATES.find(t => t.id === template)?.label || "我的样式"}
                    />
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
