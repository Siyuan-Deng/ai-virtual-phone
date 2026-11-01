// lib/cjk-typeset.ts
// 中文段落排版小工具：把末尾两个字用 WORD JOINER 粘住，避免段落最后一行只剩一个字（孤字）。
// 纯 ASCII 文本（链接、英文）原样返回。结果按原文缓存；缓存挂在 globalThis 上，热更新时不丢。

const WORD_JOINER = "⁠";
const CJK_RE = /[㐀-鿿豈-﫿]/;

type TypesetMemo = Map<string, string>;

function memo(): TypesetMemo {
    const slot = Symbol.for("ai-phone.typeset.memo");
    const host = globalThis as unknown as Record<symbol, TypesetMemo | undefined>;
    let cache = host[slot];
    if (!cache) {
        cache = new Map();
        host[slot] = cache;
    }
    return cache;
}

export function typeset(text: string): string {
    const cache = memo();
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let out = text;
    if (CJK_RE.test(text) && text.length > 2) {
        const chars = Array.from(text);
        // 末尾是标点时，把标点前的两个字一起粘住
        let end = chars.length - 1;
        while (end > 0 && !CJK_RE.test(chars[end])) end--;
        if (end > 0) {
            chars.splice(end, 0, WORD_JOINER);
            out = chars.join("");
        }
    }
    cache.set(text, out);
    return out;
}
