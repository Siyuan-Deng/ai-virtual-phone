"use client";

// 聊天气泡里的 LaTeX 公式。KaTeX 连字体有几百 KB，只有消息里真的有公式才加载。
// 难点是 $：「花了 $5，又花了 $10」不能当成公式，所以不直接交给 remark-math，
// 先把不像公式的 $ 转义掉；模型常写的 \(…\)、\[…\] 也在这里换成 $ 的写法。

import { useEffect, useState } from "react";
import type { Options } from "react-markdown";

type MathPlugins = { remarkMath: NonNullable<Options["remarkPlugins"]>[number]; rehypeKatex: NonNullable<Options["rehypePlugins"]>[number] };

const CJK_RE = /[　-〿㐀-鿿＀-￯]/;
/** 只有公式才会写的符号：中文里混了 $ 时靠它们判断 */
const MATH_SIGN_RE = /[\\^_=]/;

function looksLikeMath(inner: string): boolean {
    if (!inner || /^\s/.test(inner) || /\s$/.test(inner)) return false;
    const plain = inner.replace(/\\(?:text|mathrm|textbf|operatorname)\{[^}]*\}/g, "");
    return !CJK_RE.test(plain) || MATH_SIGN_RE.test(plain);
}

/** 从 start 往后找同一行里没被转义的 $ */
function findClosingDollar(text: string, start: number): number {
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (char === "\n") return -1;
        if (char === "\\") i += 1;
        else if (char === "$") return i;
    }
    return -1;
}

/** 留下像公式的 $，其余的转义成普通字符 */
function escapeStrayDollars(text: string): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (char === "\\") {
            out += text.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (char !== "$") {
            out += char;
            i += 1;
            continue;
        }
        if (text[i + 1] === "$") {
            const end = text.indexOf("$$", i + 2);
            if (end > i + 2) {
                out += text.slice(i, end + 2);
                i = end + 2;
            } else {
                out += "\\$\\$";
                i += 2;
            }
            continue;
        }
        const close = findClosingDollar(text, i + 1);
        // US$100 的 $ 不是开头；$5-$6 这种结尾后面紧跟数字的也不是
        const isMath = close > 0
            && !/[A-Za-z0-9]/.test(text[i - 1] ?? "")
            && !/\d/.test(text[close + 1] ?? "")
            && looksLikeMath(text.slice(i + 1, close));
        if (isMath) {
            out += text.slice(i, close + 1);
            i = close + 1;
        } else {
            out += "\\$";
            i += 1;
        }
    }
    return out;
}

function normalizeSegment(segment: string): string {
    if (!/[$\\]/.test(segment)) return segment;
    const delimited = segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (match, inner: string) => (looksLikeMath(inner.trim()) ? `\n$$\n${inner.trim()}\n$$\n` : match))
        .replace(/\\\(([\s\S]+?)\\\)/g, (match, inner: string) => (looksLikeMath(inner.trim()) ? `$${inner.trim()}$` : match))
        // 单独一行的 $$…$$ 是块级公式，写成三行 remark-math 才认
        .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_match, inner: string) => `$$\n${inner.trim()}\n$$`);
    return escapeStrayDollars(delimited);
}

/** 代码块、行内代码之外的部分做公式整理 */
export function normalizeChatMath(text: string): string {
    return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part) => (part.startsWith("`") ? part : normalizeSegment(part))).join("");
}

/** 整理之后还留着没转义的 $，就是有公式 */
export function hasChatMath(normalized: string): boolean {
    return /(^|[^\\])\$/.test(normalized.replace(/```[\s\S]*?```|`[^`\n]*`/g, ""));
}

let loaded: MathPlugins | null = null;
let loading: Promise<MathPlugins> | null = null;

function loadMathPlugins(): Promise<MathPlugins> {
    loading ??= Promise.all([
        import("remark-math"),
        import("rehype-katex"),
        // @ts-expect-error 样式文件没有类型声明
        import("katex/dist/katex.min.css"),
    ]).then(([remarkMath, rehypeKatex]) => {
        loaded = {
            remarkMath: remarkMath.default,
            rehypeKatex: [rehypeKatex.default, { throwOnError: false, strict: false, output: "html" }],
        };
        return loaded;
    });
    return loading;
}

/** 有公式时加载 KaTeX；没加载好之前先显示原文 */
export function useChatMathPlugins(needed: boolean): MathPlugins | null {
    const [plugins, setPlugins] = useState<MathPlugins | null>(loaded);
    useEffect(() => {
        if (!needed || plugins) return;
        let cancelled = false;
        void loadMathPlugins().then((result) => { if (!cancelled) setPlugins(result); }).catch((error) => console.warn("[ChatMath] 公式组件加载失败", error));
        return () => { cancelled = true; };
    }, [needed, plugins]);
    return needed ? plugins : null;
}
