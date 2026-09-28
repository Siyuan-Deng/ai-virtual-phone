"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { resolveReadingFontFamily } from "@/lib/reading-appearance";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import type { ReadingLoadedFonts } from "./reading-appearance-dialog";

/** 诊断用的样张文字：中英文数字都有，换字体一眼能看出来 */
const SAMPLE = "春江花月夜 Reading 123";
/** 参照字体：iOS 和 macOS 都自带，和系统默认的黑体长得完全不一样 */
const REFERENCE = '"Kaiti SC", "STKaiti", serif';

/** 四种把字体交给元素的方式，各测一行。哪一行没变成楷体，
 *  就说明那条路在这台设备上不通——截个图就能定位。 */
const DIAG_CSS = [
    `.reading-font-diag .diag-injected { font-family: ${REFERENCE}; }`,
    ".reading-font-diag .diag-var { font-family: var(--diag-font); }",
].join("\n");

type Props = {
    appearance: ReadingAppearance;
    loadedFonts: ReadingLoadedFonts;
};

export function ReadingFontDiagnostics({ appearance, loadedFonts }: Props) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [report, setReport] = useState<string[]>([]);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const root = rootRef.current;
        if (!root) return;
        const shortFont = (value: string | undefined) =>
            (value || "").replace(/"/g, "").split(",")[0].trim() || "(空)";
        const readRow = (selector: string) => {
            const el = root.querySelector(selector);
            return el ? shortFont(getComputedStyle(el).fontFamily) : "(找不到)";
        };
        /** 翻样式表：.reading-line 这条规则现在长什么样。
         *  显示成 var(...) 说明手机上跑的还是旧版 CSS（PWA 缓存没换掉）。 */
        const inspectStylesheets = () => {
            let lineRule = "(没找到规则)";
            let cssVersion = "旧";
            try {
                for (const sheet of Array.from(document.styleSheets)) {
                    let rules: CSSRuleList;
                    try {
                        rules = sheet.cssRules;
                    } catch {
                        continue; // 跨域样式表读不了，跳过
                    }
                    for (const rule of Array.from(rules)) {
                        if (!(rule instanceof CSSStyleRule)) continue;
                        if (rule.selectorText === ".reading-line") {
                            lineRule = rule.style.fontFamily || "(没有 font-family)";
                        }
                        // 这个类只有最新版 CSS 里才有
                        if (rule.selectorText === ".reading-font-diag-report") cssVersion = "新";
                    }
                }
            } catch {
                lineRule = "(读不到样式表)";
            }
            return { lineRule, cssVersion };
        };

        /** 运行时注册进 document.fonts 的字体（自定义字体就是这样加进去的）。
         *  status 不是 loaded 就说明字体文件没真的生效。 */
        const listRuntimeFaces = () => {
            try {
                const faces: string[] = [];
                document.fonts.forEach((face) => {
                    if (!face.family.startsWith("AIVirtualPhoneReading")) return;
                    faces.push(`${face.family.slice(0, 28)}:${face.status}`);
                });
                return faces.length ? faces.join(" / ") : "(没有)";
            } catch {
                return "(读不到)";
            }
        };

        const surface = document.querySelector(".reading-app-surface");
        const host = surface?.parentElement as HTMLElement | null;
        const shelfTitle = document.querySelector(".reading-shelf-title");
        const resolved = resolveReadingFontFamily(appearance.fontFamily, loadedFonts.body);

        // 下一帧再量：注入的 <style> 要等浏览器应用完才有结果
        const timer = window.setTimeout(() => {
            const sheets = inspectStylesheets();
            setReport([
                `设置=${appearance.fontFamily}${appearance.customFontName ? `（${appearance.customFontName}）` : ""}`,
                `解析值=${shortFont(resolved)}`,
                `自定义字体=${loadedFonts.body ? shortFont(loadedFonts.body) : "未加载"}`,
                `根节点内联=${shortFont(host?.style.fontFamily) }`,
                `书架标题实际=${shelfTitle ? shortFont(getComputedStyle(shelfTitle).fontFamily) : "(当前不在书架)"}`,
                `①内联=${readRow(".diag-inline")}`,
                `②继承=${readRow(".diag-inherit")}`,
                `③注入=${readRow(".diag-injected")}`,
                `④变量=${readRow(".diag-var")}`,
                `已注册字体数=${typeof document !== "undefined" && document.fonts ? document.fonts.size : "?"}`,
                `运行期字体=${listRuntimeFaces()}`,
                `CSS版本=${sheets.cssVersion}`,
                `.reading-line规则=${sheets.lineRule}`,
            ]);
        }, 60);
        return () => window.clearTimeout(timer);
    }, [appearance, loadedFonts, open]);

    return (
        <details
            className="reading-fold"
            open={open}
            onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
            <summary className="reading-fold-summary">
                <span>字体诊断</span>
                <span className="reading-fold-count">字体不生效时点开</span>
            </summary>
            <div className="reading-fold-body reading-font-diag" ref={rootRef} style={{ ["--diag-font" as "--diag-font"]: REFERENCE } as CSSProperties}>
                <style>{DIAG_CSS}</style>
                <div className="reading-settings-inline-note"><span>①内联（楷体）</span></div>
                <div className="reading-font-preview diag-inline" style={{ fontFamily: REFERENCE }}>{SAMPLE}</div>
                <div className="reading-settings-inline-note"><span>②继承（你当前设的正文字体）</span></div>
                <div className="reading-font-preview diag-inherit">{SAMPLE}</div>
                <div className="reading-settings-inline-note"><span>③注入样式（楷体）</span></div>
                <div className="reading-font-preview diag-injected">{SAMPLE}</div>
                <div className="reading-settings-inline-note"><span>④CSS 变量（楷体）</span></div>
                <div className="reading-font-preview diag-var">{SAMPLE}</div>
                {loadedFonts.body && (
                    <>
                        <div className="reading-settings-inline-note"><span>⑤你上传的字体</span></div>
                        <div className="reading-font-preview" style={{ fontFamily: loadedFonts.body }}>{SAMPLE}</div>
                    </>
                )}
                <pre className="reading-font-diag-report">{report.join("\n")}</pre>
            </div>
        </details>
    );
}
