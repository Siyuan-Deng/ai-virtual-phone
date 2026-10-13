// lib/reading-parser.ts — File parsing for TXT, EPUB, PDF.

import { buildReadingImageMarker, parseReadingImageMarker } from "./reading-inline-image";
import { READING_INLINE_IMAGE_MAX_SIZE, measureAndCompressReadingImage } from "./reading-image";
import type { ReadingBlockStyle, ReadingInlineSpan } from "./reading-types";

// ── PDF.js CDN loader ──
const PDFJS_VERSION = "3.11.174"; // stable version available on cdnjs
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.mjs`;
        script.type = "module";
        // pdf.min.mjs is ESM, use a different approach — load the UMD build
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else {
                reject(new Error("pdfjsLib not found after script load"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js from CDN"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

type PdfSource = ArrayBuffer | Blob;

export type ParsedChapter = {
    title: string;
    paragraphs: string[];
    /** 目录层级：0 = 顶层。来自 EPUB 自带的目录（nav / NCX），没有目录时不给。 */
    tocLevel?: number;
    /** 原书排版：与 paragraphs 一一对应的块级样式（只有 EPUB/MOBI 且书里确实带了样式时才有） */
    paragraphStyles?: (ReadingBlockStyle | null)[];
    /** 原书排版：与 paragraphs 一一对应的行内样式区间 */
    paragraphSpans?: (ReadingInlineSpan[] | null)[];
    /** 与 paragraphs 一一对应的行内小图（脚注角标、装饰符这类嵌在句子里的图） */
    paragraphInlineImages?: (number[] | null)[];
};

export type ParsedBook = {
    title: string;
    author?: string;
    chapters: ParsedChapter[];
    /** EPUB 里自带的封面图；没有就不给，书架退回自己画的那种封面 */
    cover?: { data: ArrayBuffer; mime: string };
    /** 正文插图。段落里用 \uFFFCimg:<index> 占位，这里给出每个 index 对应的图 */
    images?: ReadingParsedImage[];
};

export type ReadingParsedImage = {
    index: number;
    blob: Blob;
    /** 原图像素尺寸；解码不出来时是 0（SVG 等），排版按未知处理 */
    width: number;
    height: number;
};

export type TxtDecodeResult = {
    text: string;
    encoding: string;
};

const TXT_DECODER_CANDIDATES = ["utf-8", "gb18030", "gbk", "big5", "utf-16le", "utf-16be"];

function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string | null {
    try {
        return new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
        return null;
    }
}

function scoreDecodedTxt(text: string): number {
    const sample = text.slice(0, 24000);
    if (!sample.trim()) return -100000;

    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const nulCount = (sample.match(/\u0000/g) || []).length;
    const controlCount = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const punctuationCount = (sample.match(/[，。！？；：“”‘’、（）《》…]/g) || []).length;
    const readableCount = (sample.match(/[A-Za-z0-9\s]/g) || []).length;

    return cjkCount * 3
        + punctuationCount * 2
        + readableCount * 0.15
        - replacementCount * 80
        - nulCount * 100
        - controlCount * 20;
}

/**
 * 解码 TXT 字节流为文本。
 * @param preferredEncoding 用户手动指定的编码（auto 或 undefined = 自动探测）。
 *   指定时优先用该编码解码（BOM 仍优先，因为 BOM 是权威的）；用于用户遇到自动探测
 *   误判导致的乱码时，手动指定 TXT 的真实编码重新导入。
 */
export function decodeTxtArrayBuffer(buffer: ArrayBuffer, preferredEncoding?: string): TxtDecodeResult {
    const bytes = new Uint8Array(buffer);
    const bomCandidates: Array<[string, boolean]> = [];

    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        bomCandidates.push(["utf-8", true]);
    } else if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        bomCandidates.push(["utf-16le", true]);
    } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        bomCandidates.push(["utf-16be", true]);
    }

    // BOM 优先：有 BOM 就以 BOM 声明的编码为准（BOM 比手选更权威）
    for (const [encoding] of bomCandidates) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text !== null) return { text, encoding };
    }

    // 用户手动指定了编码：直接用指定编码解码，不再自动探测
    if (preferredEncoding && preferredEncoding !== "auto") {
        const text = decodeWithEncoding(buffer, preferredEncoding);
        if (text !== null) return { text, encoding: preferredEncoding };
        return { text: "", encoding: preferredEncoding };
    }

    let best: TxtDecodeResult | null = null;
    let bestScore = -Infinity;

    for (const encoding of TXT_DECODER_CANDIDATES) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text === null) continue;
        const score = scoreDecodedTxt(text);
        if (score > bestScore) {
            bestScore = score;
            best = { text, encoding };
        }
    }

    return best ?? { text: decodeWithEncoding(buffer, "utf-8") ?? "", encoding: "utf-8" };
}

// ── Chapter heading patterns ──
const CHAPTER_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集篇]/,       // 第X章, 第X节, 第X回...
    /^Chapter\s+\d+/i,                                        // Chapter 1
    /^CHAPTER\s+[IVXLCDM\d]+/,                                // CHAPTER IV
    /^卷[零一二三四五六七八九十百千\d]+/,                       // 卷一
    /^={3,}/,                                                  // ===
    /^-{3,}/,                                                  // ---
    /^#{1,3}\s+/,                                              // Markdown # heading
];

function isChapterHeading(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 60) return false;
    return CHAPTER_PATTERNS.some(p => p.test(trimmed));
}

/** 剥离开头/结尾的空行：下载 TXT 常在章节标题前后插入分隔空行，
 *  它们不是作者段落空行，混入会污染 splitParagraphs 的空行占比检测。 */
function trimBlankEdges(arr: string[]): string[] {
    let s = 0;
    let e = arr.length;
    while (s < e && arr[s].trim() === "") s += 1;
    while (e > s && arr[e - 1].trim() === "") e -= 1;
    return arr.slice(s, e);
}

/**
 * Parse TXT content into chapters and paragraphs.
 * Splits by chapter headings, then by blank lines for paragraphs.
 * @param mode 段落划分方式：auto 自动探测 / blank 空行 / indent 段首缩进 / line 每行一段
 */
export function parseTxtContent(text: string, fileName?: string, mode: TxtParagraphMode = "auto"): ParsedBook {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    // auto 模式：对整本书探测一次段落格式，所有章节共用同一结论，
    // 避免短章节里夹杂的空白行让个别章节误判成别的格式。
    const resolvedMode = mode === "auto" ? detectParagraphMode(lines) : mode;

    // First pass: find chapter boundaries
    const chapterStarts: { lineIdx: number; title: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (isChapterHeading(lines[i])) {
            chapterStarts.push({ lineIdx: i, title: lines[i].trim().replace(/^#{1,3}\s+/, "") });
        }
    }

    // Extract title from first non-empty line (if before first chapter)
    let bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    if (chapterStarts.length > 0 && chapterStarts[0].lineIdx > 0) {
        for (let i = 0; i < chapterStarts[0].lineIdx; i++) {
            if (lines[i].trim()) { bookTitle = lines[i].trim(); break; }
        }
    }

    // No chapters found → entire text is one chapter
    if (chapterStarts.length === 0) {
        return {
            title: bookTitle,
            chapters: [{
                title: "全文",
                paragraphs: splitParagraphs(trimBlankEdges(lines), resolvedMode),
            }],
        };
    }

    // Build chapters
    const chapters: ParsedChapter[] = [];
    for (let i = 0; i < chapterStarts.length; i++) {
        const start = chapterStarts[i].lineIdx + 1; // skip heading line
        const end = i + 1 < chapterStarts.length ? chapterStarts[i + 1].lineIdx : lines.length;
        const chapterLines = trimBlankEdges(lines.slice(start, end));
        const paragraphs = splitParagraphs(chapterLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.push({ title: chapterStarts[i].title, paragraphs });
        }
    }

    // If there's content before the first chapter, add it as a prologue
    if (chapterStarts[0].lineIdx > 1) {
        const prologueLines = trimBlankEdges(lines.slice(0, chapterStarts[0].lineIdx));
        const paragraphs = splitParagraphs(prologueLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.unshift({ title: "序", paragraphs });
        }
    }

    return { title: bookTitle, chapters };
}

/** 判断一行是否以缩进开头（全角空格 / 2+ 半角空格 / Tab）→ 视为新段落起点。
 *  很多中文网文 TXT 段落之间没有空行，仅靠段首缩进区分段落；
 *  若只按空行分割会把整章合并成一段（批注/讨论时整章一起发给模型）。
 */
function isIndentedParagraphStart(line: string): boolean {
    return /^\u3000/.test(line)   // 全角空格缩进（中文网文最常见）
        || /^ {2,}/.test(line)    // 2+ 半角空格缩进
        || /^\t/.test(line);      // Tab 缩进
}

/** 松散标题行检测：比 isChapterHeading 更宽泛，仅用于识别「章节分隔空行」。
 *  下载 TXT 常在章节标题前后插入分隔空行，这些不是作者段落空行，
 *  若混进空行占比会污染 splitParagraphs 的格式探测（章节很多但每章很短的小说
 *  空行占比轻松超过 2%，被误判成空行分段 → 整章变成一段）。 */
const LENIENT_TITLE_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集部篇]/,   // 第X章/节/回/卷/部/篇
    /^[序楔]/,                                            // 序章 / 楔子
    /^(?:终章|后记|前言|番外|尾声|外传|引子)/,            // 常见非数字标题
    /^[Cc]hapter\s+\d+/,
    /^[Pp]art\s+[IVXLCDM\d]+/,
    /^[零一二三四五六七八九十百千\d]+[、.．:：]/,           // 一、 / 1、 / 1.
    /^[（(][零一二三四五六七八九十百千\d]+[)）]/,           // （一）/（1）
    /^《.+》$/,                                            // 《书名》式短行
    /^[=#*\-]{3,}$/,                                      // 分隔线
];

function isTitleLikeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 40) return false;
    return LENIENT_TITLE_PATTERNS.some((p) => p.test(trimmed));
}

/** 统计「作者段落空行」数量：连续空行块紧邻标题行（前或后）的视为章节分隔空行，不计数 */
function countAuthorBlankLines(lines: string[]): number {
    const titleLike = new Set<number>();
    lines.forEach((line, i) => {
        if (isTitleLikeLine(line)) titleLike.add(i);
    });

    const isBlank = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === "";
    let count = 0;
    let i = 0;
    while (i < lines.length) {
        if (!isBlank(i)) { i += 1; continue; }
        const runStart = i;
        while (i < lines.length && isBlank(i)) i += 1;
        const runEnd = i - 1;
        const beforeTitle = runStart > 0 && titleLike.has(runStart - 1);
        const afterTitle = runEnd + 1 < lines.length && titleLike.has(runEnd + 1);
        if (!beforeTitle && !afterTitle) count += runEnd - runStart + 1;
    }
    return count;
}

/** 按空行分段（标准网文导出格式；段内多行保持在同一段） */
function splitByBlankLines(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
        if (line.trim() === "") {
            if (current.length > 0) {
                paragraphs.push(current.join("\n").trim());
                current = [];
            }
        } else {
            current.push(line);
        }
    }
    if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
    }

    return paragraphs.filter(p => p.length > 0);
}

/** 按段首缩进分段（无空行的中文网文 TXT） */
function splitByIndent(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length > 0) {
            paragraphs.push(current.join("\n").trim());
            current = [];
        }
    };

    for (const line of lines) {
        if (line.trim() === "") {
            flush();
        } else if (isIndentedParagraphStart(line)) {
            flush();
            current.push(line);
        } else {
            current.push(line);
        }
    }
    flush();

    return paragraphs.filter(p => p.length > 0);
}

/** 智能分段：先探测本书格式再选策略——
 *  1) 空行占比 ≥ 15%：空行分段（标准导出格式，段内多行保留）
 *  2) 缩进行占比 ≥ 20%：段首缩进分段（晋江/起点手排 TXT，无空行）
 *  3) 空行占比 ≥ 2%：空行分段（段内多行较长、空行稀疏的情况）
 *  4) 否则：纯换行格式，一行一段（很多网文连开头缩进都省了，纯靠回车换行分段落）
 *  空行占比统计时已剔除「章节分隔空行」（紧邻标题行的空行块），
 *  避免下载 TXT 在章节间插入的空行污染探测。
 *  mode 参数可强制指定划分方式（auto=自动探测）。 */
export type TxtParagraphMode = "auto" | "blank" | "indent" | "line";

/** 全局探测一本书的段落格式（对整本书的 lines 调用一次，保证各章节结论一致） */
export function detectParagraphMode(lines: string[]): TxtParagraphMode {
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    if (nonEmpty.length === 0) return "line";

    const blankRatio = countAuthorBlankLines(lines) / Math.max(1, lines.length);
    const indentedRatio = nonEmpty.filter(isIndentedParagraphStart).length / nonEmpty.length;

    if (blankRatio >= 0.15) return "blank";
    if (indentedRatio >= 0.2) return "indent";
    if (blankRatio >= 0.02) return "blank";
    return "line";
}

function splitParagraphs(lines: string[], mode: TxtParagraphMode = "auto"): string[] {
    const nonEmpty = lines.filter(l => l.trim() !== "");
    if (nonEmpty.length === 0) return [];

    if (mode === "blank") return splitByBlankLines(lines);
    if (mode === "indent") return splitByIndent(lines);
    if (mode === "line") return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);

    const detected = detectParagraphMode(lines);
    if (detected === "blank") return splitByBlankLines(lines);
    if (detected === "indent") return splitByIndent(lines);
    return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);
}

// ── EPUB Parsing ──

/**
 * Parse EPUB file into chapters and paragraphs.
 * EPUB is a ZIP containing XHTML files.
 */
/** 有限并发跑一批任务，保持结果顺序。
 *
 *  图片处理（解码 + webp 编码）是导入过程中最重的一段，原来是纯串行：一张图
 *  解码完才轮到下一张。解码和编码本身在浏览器里是异步的（不占主线程），
 *  并发跑能把这段墙钟时间压到接近 1/并发数。但并发数不能大——每张图解码后
 *  都占一份像素内存，一本画册全放开会直接触发内存告警，所以固定小并发。
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

type TocEntry = { label: string; path: string; level: number };

/** href 去掉锚点和 ./，再解码，用来和 manifest 里的路径对齐 */
function normalizeTocHref(href: string, baseDir: string): string {
    const withoutHash = href.split("#")[0].trim();
    if (!withoutHash) return "";
    let path = decodeURIComponent(withoutHash);
    if (path.startsWith("./")) path = path.slice(2);
    // 目录文件自己可能在子目录里，相对路径要按它所在目录拼
    const combined = baseDir ? `${baseDir}${path}` : path;
    // 压掉 a/b/../c 这种
    const parts: string[] = [];
    for (const piece of combined.split("/")) {
        if (piece === "." || piece === "") continue;
        if (piece === "..") { parts.pop(); continue; }
        parts.push(piece);
    }
    return parts.join("/");
}

/** EPUB3 的导航文档：<nav epub:type="toc"><ol><li><a href>…，靠 <ol> 嵌套表示层级 */
function parseNavDocument(xml: string, baseDir: string): TocEntry[] {
    if (typeof DOMParser === "undefined") return [];
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(xml, "application/xhtml+xml");
        if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(xml, "text/html");
    } catch {
        return [];
    }
    const navs = Array.from(doc.querySelectorAll("nav"));
    const toc = navs.find((nav) => {
        const type = nav.getAttribute("epub:type") || nav.getAttribute("type") || "";
        return /\btoc\b/i.test(type);
    }) || navs[0];
    const root = toc?.querySelector("ol");
    if (!root) return [];

    const entries: TocEntry[] = [];
    const walk = (list: Element, level: number) => {
        for (const li of Array.from(list.children)) {
            if (li.tagName.toLowerCase() !== "li") continue;
            const anchorEl = li.querySelector(":scope > a, :scope > span > a");
            const href = anchorEl?.getAttribute("href") || "";
            const label = (anchorEl?.textContent || "").replace(/\s+/g, " ").trim();
            const path = normalizeTocHref(href, baseDir);
            if (label && path) entries.push({ label, path, level });
            const childList = li.querySelector(":scope > ol");
            if (childList) walk(childList, level + 1);
        }
    };
    walk(root, 0);
    return entries;
}

/** EPUB2 的 toc.ncx：<navMap><navPoint><navLabel><text>…，navPoint 嵌套表示层级 */
function parseNcxDocument(xml: string, baseDir: string): TocEntry[] {
    if (typeof DOMParser === "undefined") return [];
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(xml, "application/xml");
    } catch {
        return [];
    }
    const navMap = doc.getElementsByTagName("navMap")[0];
    if (!navMap) return [];

    const entries: TocEntry[] = [];
    const walk = (parent: Element, level: number) => {
        for (const child of Array.from(parent.children)) {
            if (child.tagName.replace(/^.*:/, "") !== "navPoint") continue;
            const label = (child.getElementsByTagName("text")[0]?.textContent || "").replace(/\s+/g, " ").trim();
            const href = child.getElementsByTagName("content")[0]?.getAttribute("src") || "";
            const path = normalizeTocHref(href, baseDir);
            if (label && path) entries.push({ label, path, level });
            walk(child, level + 1);
        }
    };
    walk(navMap, 0);
    return entries;
}

export async function parseEpubFile(arrayBuffer: ArrayBuffer, fileName?: string): Promise<ParsedBook> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. Find container.xml → rootfile path
    const containerXml = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!rootfileMatch) throw new Error("Invalid EPUB: no rootfile");
    const rootfilePath = rootfileMatch[1];
    const rootDir = rootfilePath.includes("/") ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1) : "";

    // 2. Parse OPF (package document)
    const opfXml = await zip.file(rootfilePath)?.async("text");
    if (!opfXml) throw new Error("Invalid EPUB: missing OPF");

    // Extract title and author
    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const authorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    const bookTitle = titleMatch?.[1]?.trim() || fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const author = authorMatch?.[1]?.trim();

    // 3. Extract spine order (reading order)
    const spineItems: string[] = [];
    const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
        const itemRefPattern = /idref="([^"]+)"/g;
        let m;
        while ((m = itemRefPattern.exec(spineMatch[1])) !== null) {
            spineItems.push(m[1]);
        }
    }

    // 4. Build id → href map from manifest
    const idToHref = new Map<string, string>();
    // EPUB3 的导航文档（properties="nav"）本身就是一张目录页，阅读器已经有自己的
    // 导航面板，把它当章节收进来只会在正文里多出一屏目录条目。
    const navItemIds = new Set<string>();
    const idToMime = new Map<string, string>();
    let coverImageId = "";
    const manifestMatch = opfXml.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
    if (manifestMatch) {
        const itemTagPattern = /<item\b[^>]*>/gi;
        let tag;
        while ((tag = itemTagPattern.exec(manifestMatch[1])) !== null) {
            const id = tag[0].match(/\bid="([^"]+)"/)?.[1];
            const itemHref = tag[0].match(/\bhref="([^"]+)"/)?.[1];
            if (!id || !itemHref) continue;
            idToHref.set(id, itemHref);
            const mime = tag[0].match(/\bmedia-type="([^"]+)"/)?.[1];
            if (mime) idToMime.set(id, mime);
            if (/\bproperties="[^"]*\bnav\b[^"]*"/i.test(tag[0])) navItemIds.add(id);
            // EPUB3 的封面标记
            if (/\bproperties="[^"]*\bcover-image\b[^"]*"/i.test(tag[0])) coverImageId = id;
        }
    }

    // EPUB2 用 <meta name="cover" content="ID">；再不行就找 id/href 里带 cover 的图片
    if (!coverImageId) {
        const metaCover = opfXml.match(/<meta\b[^>]*\bname="cover"[^>]*>/i)?.[0];
        const candidate = metaCover?.match(/\bcontent="([^"]+)"/)?.[1];
        if (candidate && idToHref.has(candidate)) coverImageId = candidate;
    }
    if (!coverImageId) {
        for (const [id, itemHref] of idToHref) {
            if (!idToMime.get(id)?.startsWith("image/")) continue;
            if (/cover/i.test(id) || /cover/i.test(itemHref)) { coverImageId = id; break; }
        }
    }

    let cover: ParsedBook["cover"];
    const coverHref = coverImageId ? idToHref.get(coverImageId) : undefined;
    const coverMime = coverImageId ? idToMime.get(coverImageId) : undefined;
    if (coverHref && coverMime?.startsWith("image/")) {
        const data = await zip.file(rootDir + decodeURIComponent(coverHref))?.async("arraybuffer");
        if (data && data.byteLength > 0) cover = { data, mime: coverMime };
    }

    // 5. 读书自带的目录：章节名用目录里的名字，比从正文第一个标题猜准得多
    //    （正文里常常「四 狗屋」在 <h2> 和正文里各出现一次，猜出来就是「四 狗屋 四 狗屋」）
    const tocByPath = new Map<string, { label: string; level: number }>();
    {
        let tocXml = "";
        let tocDir = rootDir;
        // EPUB3：manifest 里 properties="nav" 的那份
        for (const navId of navItemIds) {
            const navHref = idToHref.get(navId);
            if (!navHref) continue;
            const navPath = rootDir + decodeURIComponent(navHref);
            const text = await zip.file(navPath)?.async("text");
            if (!text) continue;
            tocXml = text;
            tocDir = navPath.includes("/") ? navPath.substring(0, navPath.lastIndexOf("/") + 1) : "";
            break;
        }
        let entries = tocXml ? parseNavDocument(tocXml, tocDir) : [];

        // EPUB2：<spine toc="ncx">，或 manifest 里那份 x-dtbncx+xml
        if (entries.length === 0) {
            let ncxId = opfXml.match(/<spine[^>]*\btoc="([^"]+)"/i)?.[1] || "";
            if (!ncxId) {
                for (const [id, mime] of idToMime) {
                    if (mime === "application/x-dtbncx+xml") { ncxId = id; break; }
                }
            }
            const ncxHref = ncxId ? idToHref.get(ncxId) : undefined;
            if (ncxHref) {
                const ncxPath = rootDir + decodeURIComponent(ncxHref);
                const ncxXml = await zip.file(ncxPath)?.async("text");
                if (ncxXml) {
                    const ncxDir = ncxPath.includes("/") ? ncxPath.substring(0, ncxPath.lastIndexOf("/") + 1) : "";
                    entries = parseNcxDocument(ncxXml, ncxDir);
                }
            }
        }

        // 同一个文件可能被目录里的多条指向（靠锚点区分小节），取第一条
        for (const entry of entries) {
            if (!tocByPath.has(entry.path)) tocByPath.set(entry.path, { label: entry.label, level: entry.level });
        }
    }

    // 6. Read each spine item and extract text
    const chapters: ParsedChapter[] = [];
    // 插图：章节里的标记是「本章第几张」，这里换算成「全书第几张」，
    // 同一张图被多处引用时只存一份。
    const imagePathToIndex = new Map<string, number>();
    const imagePaths: string[] = [];
    for (const itemId of spineItems) {
        if (navItemIds.has(itemId)) continue;
        const href = idToHref.get(itemId);
        if (!href) continue;
        const filePath = rootDir + decodeURIComponent(href);
        const html = await zip.file(filePath)?.async("text");
        if (!html) continue;

        // Extract text from HTML
        const extracted = extractTextFromHtml(html);
        if (extracted.paragraphs.length === 0) continue;

        let finalParagraphs = extracted.paragraphs;
        let paragraphStyles = extracted.paragraphStyles;
        let paragraphSpans = extracted.paragraphSpans;
        let paragraphInlineImages = extracted.paragraphInlineImages;
        if (extracted.imageSrcs && extracted.imageSrcs.length > 0) {
            const chapterDir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
            const localToGlobal = new Map<number, number>();
            extracted.imageSrcs.forEach((src, localIndex) => {
                const resolved = normalizeTocHref(src, chapterDir);
                if (!resolved) return;
                let globalIndex = imagePathToIndex.get(resolved);
                if (globalIndex === undefined) {
                    globalIndex = imagePaths.length;
                    imagePathToIndex.set(resolved, globalIndex);
                    imagePaths.push(resolved);
                }
                localToGlobal.set(localIndex, globalIndex);
            });
            const mapped = extracted.paragraphs.map((paragraph) => {
                const marker = parseReadingImageMarker(paragraph);
                if (!marker) return paragraph;
                const globalIndex = localToGlobal.get(marker.index);
                return globalIndex === undefined ? "" : buildReadingImageMarker(globalIndex);
            });
            // 样式/行内数组和 paragraphs 是按下标对齐的，段落被剔掉时必须用同一张掩码一起裁
            const keepMask = mapped.map((paragraph) => paragraph !== "");
            finalParagraphs = mapped.filter((paragraph) => paragraph !== "");
            paragraphStyles = maskParagraphList(paragraphStyles, keepMask);
            paragraphSpans = maskParagraphList(paragraphSpans, keepMask);
            paragraphInlineImages = maskParagraphList(paragraphInlineImages, keepMask);
            if (finalParagraphs.length === 0) continue;

            // 行内小图的序号还停在「本章 imageSrcs 下标」，换算成全书下标；
            // 换算不出来的连占位字符一起删，避免序号整体错位（见 pruneInlineImages）
            if (paragraphInlineImages) {
                const nextText = finalParagraphs.slice();
                const nextInline: (number[] | null)[] = [];
                for (let i = 0; i < nextText.length; i += 1) {
                    const list = paragraphInlineImages[i];
                    if (!list || list.length === 0) { nextInline.push(null); continue; }
                    const pruned = pruneInlineImages(nextText[i], list, (localIndex) => localToGlobal.get(localIndex));
                    nextText[i] = pruned.text;
                    nextInline.push(pruned.inlineImages ?? null);
                }
                finalParagraphs = nextText;
                paragraphInlineImages = nextInline.some((list) => list !== null) ? nextInline : undefined;
            }
        }

        const fromToc = tocByPath.get(normalizeTocHref(href, rootDir));
        chapters.push({
            title: fromToc?.label || extracted.title || `第${chapters.length + 1}章`,
            paragraphs: finalParagraphs,
            ...(fromToc ? { tocLevel: fromToc.level } : {}),
            ...(paragraphStyles ? { paragraphStyles } : {}),
            ...(paragraphSpans ? { paragraphSpans } : {}),
            ...(paragraphInlineImages ? { paragraphInlineImages } : {}),
        });
    }

    // 7. 取出插图的字节，量原图尺寸（翻页分页要用它算这张图占多高）并压一道。
    //    解码 + 编码合并成一次（见 measureAndCompressReadingImage），有限并发跑。
    const images: ReadingParsedImage[] = [];
    const droppedImages = new Set<number>();
    const processed = await mapWithConcurrency(imagePaths, 3, async (imagePath, index) => {
        const data = await zip.file(imagePath)?.async("blob");
        if (!data || data.size === 0) return { index, dropped: true as const };
        const measured = await measureAndCompressReadingImage(data, READING_INLINE_IMAGE_MAX_SIZE);
        // 1x1 透明占位、分隔线之类的小图没有阅读价值，只会在正文里留一行空白
        if (measured.width > 0 && measured.height > 0 && (measured.width < 40 || measured.height < 40)) {
            return { index, dropped: true as const };
        }
        return {
            index,
            dropped: false as const,
            image: {
                index,
                blob: measured.blob,
                width: measured.width,
                height: measured.height,
            } satisfies ReadingParsedImage,
        };
    });
    for (const item of processed) {
        if (item.dropped) droppedImages.add(item.index);
        else images.push(item.image);
    }

    if (images.length > 0 || droppedImages.size > 0) {
        const sizeByIndex = new Map(images.map((image) => [image.index, image]));
        for (const chapter of chapters) {
            const mapped = chapter.paragraphs.map((paragraph) => {
                const marker = parseReadingImageMarker(paragraph);
                if (!marker) return paragraph;
                if (droppedImages.has(marker.index)) return "";
                const image = sizeByIndex.get(marker.index);
                return buildReadingImageMarker(marker.index, image?.width ?? 0, image?.height ?? 0);
            });
            // 被丢掉的插图段落会把后面的下标整体前移，样式数组必须跟着裁
            const keepMask = mapped.map((paragraph) => paragraph !== "");
            chapter.paragraphs = mapped.filter((paragraph) => paragraph !== "");
            if (chapter.paragraphStyles) {
                chapter.paragraphStyles = maskParagraphList(chapter.paragraphStyles, keepMask);
            }
            if (chapter.paragraphSpans) {
                chapter.paragraphSpans = maskParagraphList(chapter.paragraphSpans, keepMask);
            }
            if (chapter.paragraphInlineImages) {
                chapter.paragraphInlineImages = maskParagraphList(chapter.paragraphInlineImages, keepMask);
            }
        }
    }

    // 被丢弃的行内小图要从正文里摘掉，否则会留下一个拿不到图的占位字符
    if (droppedImages.size > 0) {
        for (const chapter of chapters) {
            if (!chapter.paragraphInlineImages) continue;
            const nextText: string[] = [];
            const nextInline: (number[] | null)[] = [];
            chapter.paragraphs.forEach((paragraph, index) => {
                const stripped = stripDroppedInlineImages(paragraph, chapter.paragraphInlineImages?.[index] ?? undefined, droppedImages);
                nextText.push(stripped.text);
                nextInline.push(stripped.inlineImages ?? null);
            });
            chapter.paragraphs = nextText;
            chapter.paragraphInlineImages = nextInline.some((list) => list !== null) ? nextInline : undefined;
        }
    }

    if (chapters.length === 0) {
        return { title: bookTitle, author, cover, chapters: [{ title: "全文", paragraphs: ["（EPUB 解析失败，未找到文本内容）"] }] };
    }

    return { title: bookTitle, author, cover, chapters, ...(images.length > 0 ? { images } : {}) };
}

/** MOBI 里章节之间是 <mbp:pagebreak/>。切开后每一块当一章，走和 EPUB 相同的取文路径。 */
export async function parseMobiFile(arrayBuffer: ArrayBuffer, fileName?: string): Promise<ParsedBook> {
    const { parseMobiDocument } = await import("./reading-mobi");
    const { html, title } = parseMobiDocument(arrayBuffer);
    const bookTitle = title || fileName?.replace(/\.(mobi|azw3?|prc)$/i, "") || "未命名";

    const pieces = html
        .split(/<mbp:pagebreak[^>]*>/i)
        .map(piece => piece.trim())
        .filter(Boolean);

    const chapters: ParsedChapter[] = [];
    for (const piece of pieces) {
        const extracted = extractTextFromHtml(piece);
        if (extracted.paragraphs.length === 0) continue;
        chapters.push({
            title: extracted.title || `第${chapters.length + 1}章`,
            paragraphs: extracted.paragraphs,
            ...(extracted.paragraphStyles ? { paragraphStyles: extracted.paragraphStyles } : {}),
            ...(extracted.paragraphSpans ? { paragraphSpans: extracted.paragraphSpans } : {}),
            ...(extracted.paragraphInlineImages ? { paragraphInlineImages: extracted.paragraphInlineImages } : {}),
        });
    }

    // 没有分页符（或只切出一块）时退回 TXT 那套标题启发式，别让整本书挤成一章
    if (chapters.length <= 1) {
        const { paragraphs } = extractTextFromHtml(html);
        if (paragraphs.length > 0) {
            const parsed = parseTxtContent(paragraphs.join("\n\n"), fileName);
            return { title: bookTitle, chapters: parsed.chapters };
        }
    }

    if (chapters.length === 0) {
        return { title: bookTitle, chapters: [{ title: "全文", paragraphs: ["（MOBI 解析失败，未找到文本内容）"] }] };
    }
    return { title: bookTitle, chapters };
}

const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "DD", "DT", "PRE", "SECTION", "ARTICLE", "FIGURE", "FIGCAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6",
]);

// ── 原书排版提取（EPUB / MOBI） ──
//
// 为什么只取「语义档位」而不是原书 CSS：
// 批注、划线、双语、书签全部按「章序号 + 段序号 + 段内字符区间」定位文字，
// 行元素还要带 data-charstart 供选区换算（见 reading-selection.ts）。
// 若把原书 CSS 交给浏览器自由执行，多列布局会让同一个文本节点横跨两栏、
// 浮动/绝对定位会让视觉顺序偏离 DOM 顺序、伪元素的 content 会在选中区里混进
// 幽灵字符——三种情况都会让字符偏移算错，批注就会指到别处。
// 所以这里和微信读书同一套思路：只取标题层级、对齐、缩进、引用、题记、脚注、
// 行内强调这些语义样式，而且一律不新增/删除字符，字符锚点因此始终稳定。

const HEADING_LEVEL_BY_TAG: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/** 这张图是嵌在句子里的，还是自己独立成段的？
 *
 *  判据只看一件事：它所在的那个块除了图片还有没有别的文字。
 *  有 → 是句子的一部分（脚注角标、行内装饰），该当行内小图；
 *  没有 → 是独立插图，该当整段大图。
 *
 *  两条排除：
 *  · <figure> 里的图一律算独立插图——figcaption 的文字会让「块里有文字」这条误判；
 *  · 尺寸判据在这里用不了（要解码后才知道），所以只按结构判断大小图，
 *    真正过小的装饰图另有丢弃规则兜底。 */
function isInlineImageNode(node: Element, body: HTMLElement): boolean {
    if (node.closest("figure")) return false;
    let block: Element | null = node.parentElement;
    while (block && block !== body && !BLOCK_TAGS.has(block.tagName)) block = block.parentElement;
    // 找不到块级祖先（直接挂在 body 上）当独立插图处理
    if (!block || block === body) return false;
    const text = (block.textContent || "").split(INLINE_IMAGE_CHAR).join("").trim();
    return text.length > 0;
}

/** 把 style="..." 拆成声明表。只认下面会用到的几个属性，不做完整 CSS 解析——
 *  原书真正的样式表（CSS 文件 / class）我们一概不执行，理由见上面那段注释。 */
function readStyleDeclarations(el: Element): Record<string, string> {
    const raw = el.getAttribute("style");
    if (!raw) return {};
    const out: Record<string, string> = {};
    for (const piece of raw.split(";")) {
        const sep = piece.indexOf(":");
        if (sep <= 0) continue;
        const key = piece.slice(0, sep).trim().toLowerCase();
        const value = piece.slice(sep + 1).trim().toLowerCase();
        if (key && value) out[key] = value;
    }
    return out;
}

/** 行内标签 / 行内 style → 强调位。返回 null 表示这个标签不改样式。 */
function inlineStyleForTag(tag: string, decls: Record<string, string>): Omit<ReadingInlineSpan, "start" | "end"> | null {
    const style: Omit<ReadingInlineSpan, "start" | "end"> = {};
    if (tag === "B" || tag === "STRONG") style.bold = true;
    else if (tag === "I" || tag === "EM" || tag === "CITE" || tag === "DFN" || tag === "VAR") style.italic = true;
    else if (tag === "U" || tag === "INS") style.underline = true;
    else if (tag === "S" || tag === "STRIKE" || tag === "DEL") style.strike = true;
    else if (tag === "SUP") style.sup = true;
    else if (tag === "SUB") style.sub = true;

    const weight = decls["font-weight"] || "";
    if (/(bold|bolder|[6-9]00)/.test(weight)) style.bold = true;
    const fontStyle = decls["font-style"] || "";
    if (fontStyle === "italic" || fontStyle === "oblique") style.italic = true;
    const decoration = `${decls["text-decoration"] || ""} ${decls["text-decoration-line"] || ""}`;
    if (/underline/.test(decoration)) style.underline = true;
    if (/line-through/.test(decoration)) style.strike = true;

    return Object.keys(style).length > 0 ? style : null;
}

/** 原书给这个块下的语义样式；什么都没看出来就返回 null（这段照旧用统一排版渲染）。 */
function detectBlockStyle(el: Element): ReadingBlockStyle | null {
    const style: ReadingBlockStyle = {};
    const tag = el.tagName;
    const decls = readStyleDeclarations(el);
    const hints = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`.toLowerCase();

    const heading = HEADING_LEVEL_BY_TAG[tag];
    if (heading) style.heading = heading;
    if (tag === "BLOCKQUOTE") style.quote = true;

    // epub:type 是最权威的语义提示，优先信它
    const epubType = `${el.getAttribute("epub:type") || ""} ${el.getAttribute("type") || ""}`.toLowerCase();
    if (/\b(footnote|endnote|rearnote)\b/.test(epubType)) style.footnote = true;
    if (/\b(epigraph|dedication|subtitle)\b/.test(epubType)) style.epigraph = true;
    if (/\b(titlepage|copyright-page|halftitlepage|colophon)\b/.test(epubType)) style.align = "center";

    const align = decls["text-align"] || "";
    if (align === "center" || align === "right") style.align = align;
    else if (!style.align && /\b(center|centered|text-center|align-center|title-?page|book-?title)\b/.test(hints)) style.align = "center";

    const indentDecl = decls["text-indent"];
    if (indentDecl !== undefined) {
        const amount = parseFloat(indentDecl);
        if (Number.isFinite(amount)) {
            if (amount < 0) {
                // 负缩进 = 首行悬挂（对话排版常见），按不缩进处理，别把整段推出去
                style.indent = 0;
            } else if (/em|rem|ch/.test(indentDecl)) {
                style.indent = amount >= 0.8 ? Math.min(4, Math.round(amount)) : 0;
            } else if (/px|pt|pc/.test(indentDecl)) {
                style.indent = amount >= 12 ? Math.min(4, Math.max(1, Math.round(amount / 16))) : 0;
            } else {
                style.indent = amount >= 0.8 ? Math.min(4, Math.round(amount)) : 0;
            }
        }
    } else if (/\b(no-?indent|indent-?0|flush)\b/.test(hints)) {
        style.indent = 0;
    } else if (/\bindent/.test(hints)) {
        style.indent = 2;
    }

    if (decls["font-weight"] && /(bold|bolder|[6-9]00)/.test(decls["font-weight"])) style.bold = true;
    if (decls["font-style"] === "italic" || decls["font-style"] === "oblique") style.italic = true;
    if (tag === "B" || tag === "STRONG") style.bold = true;
    if (/\b(bold|strong)\b/.test(hints)) style.bold = true;
    if (/\b(italic|emphasis)\b/.test(hints)) style.italic = true;
    // 整段引用：只有标签或 class 明确写了才认，别把「缩进」当成「引用」
    if (!style.quote && /\b(blockquote|quotation|epigraph-text)\b/.test(hints)) style.quote = true;

    return Object.keys(style).length > 0 ? style : null;
}

/** 逐字符累积一块的正文；span 的区间用「当前已累计的字符数」记，天然对齐最终文字。 */
type InlineAccumulator = {
    chars: string[];
    spans: ReadingInlineSpan[];
    /** 这一块里行内小图的顺序（值 = 本次提取的 imageSrcs 下标）。
     *  正文对应位置放一个 \uFFFC 占位符，两边一一对应。 */
    inlineImages: number[];
};

/** 行内图片占位符。刻意只占「一个字符」：正文里的字符偏移（批注、划线、
 *  选区换算）都按段落文字的下标算，一个字符换一张图才不会让后面的偏移全错。
 *  渲染时它变成一个 <span> 里塞零宽空格 + 图片：零宽空格本身占一个字符位，
 *  DOM 文字长度因此和段落文字严格对齐。 */
const INLINE_IMAGE_CHAR = "\uFFFC";

/** 追加一段文本节点的内容。空白按 HTML 语义折叠成单个空格，
 *  紧跟空格/换行之后的空白丢掉，免得缩进排版带出多余空格。 */
function appendText(acc: InlineAccumulator, raw: string): void {
    if (!raw) return;
    const last = acc.chars[acc.chars.length - 1];
    let text = raw.replace(/\s+/g, " ");
    if (!text) return;
    if ((acc.chars.length === 0 || last === " " || last === "\n") && text.startsWith(" ")) text = text.slice(1);
    if (!text) return;
    // 按下标逐「码元」入栈，不用 for...of：后者按码点迭代，代理对（生僻字/emoji）
    // 会被算成一个元素，行内样式的区间就会和最终文字的 length 对不上、整段偏移。
    for (let i = 0; i < text.length; i += 1) acc.chars.push(text[i]);
}

/** <br> → 段内换行。段落里允许出现 \n（TXT 的段落本来也是这么存的），
 *  分页与选区换算都已经按「\n 也占一个字符」处理，所以这里直接落进文字即可。 */
function appendLineBreak(acc: InlineAccumulator): void {
    if (acc.chars.length === 0) return;
    if (acc.chars[acc.chars.length - 1] === " ") acc.chars.pop();
    if (acc.chars.length === 0) return;
    if (acc.chars[acc.chars.length - 1] === "\n") return;
    acc.chars.push("\n");
}

function walkInline(acc: InlineAccumulator, node: Node): void {
    if (node.nodeType === 3) { appendText(acc, node.nodeValue || ""); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    // 注音只留被注的字，丢掉 <rt> 的拼音/<rp> 的括号——否则正文里会粘出一串拼音
    if (tag === "RT" || tag === "RP") return;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (tag === "BR") { appendLineBreak(acc); return; }
    // 插图已被换成占位标记；残留的图片元素不产出文字
    if (tag === "IMG" || tag === "IMAGE") return;

    // 行内小图（脚注角标、装饰符）：登记它的下标，再往下走——
    // 里面那个 \uFFFC 会作为普通字符落进正文
    const inlineIndex = el.getAttribute("data-reading-inline-img");
    if (inlineIndex !== null) {
        const parsed = Number(inlineIndex);
        if (Number.isFinite(parsed)) acc.inlineImages.push(parsed);
    }

    const style = inlineStyleForTag(tag, readStyleDeclarations(el));
    const start = acc.chars.length;
    for (const child of Array.from(el.childNodes)) walkInline(acc, child);
    if (style && acc.chars.length > start) {
        acc.spans.push({ start, end: acc.chars.length, ...style });
    }
}

/** 收尾：压掉连续空白/换行、去掉首尾空白，并把 span 的偏移同步换算过去。
 *  换算靠一张「原始位置 → 归一化位置」的映射表，保证 span 与最终文字严格对齐
 *  （这是批注锚点能不能落准的前提）。 */
function finalizeInline(acc: InlineAccumulator): { text: string; spans: ReadingInlineSpan[] } {
    const out: string[] = [];
    const map: number[] = new Array(acc.chars.length);
    for (let i = 0; i < acc.chars.length; i += 1) {
        const ch = acc.chars[i];
        const last = out[out.length - 1];
        if (ch === "\n") {
            if (out.length === 0) { map[i] = 0; continue; }
            if (last === "\n") { map[i] = out.length - 1; continue; }
            if (last === " ") out.pop();
            out.push("\n");
            map[i] = out.length - 1;
            continue;
        }
        if (ch === " ") {
            if (out.length === 0 || last === " " || last === "\n") {
                map[i] = Math.max(0, out.length - 1);
                continue;
            }
            out.push(" ");
            map[i] = out.length - 1;
            continue;
        }
        out.push(ch);
        map[i] = out.length - 1;
    }
    while (out.length > 0 && (out[out.length - 1] === " " || out[out.length - 1] === "\n")) out.pop();

    const text = out.join("");
    const translate = (index: number): number => {
        if (acc.chars.length === 0) return 0;
        const clamped = Math.max(0, Math.min(acc.chars.length - 1, index));
        const mapped = map[clamped];
        return Math.max(0, Math.min(text.length, mapped === undefined ? text.length : mapped));
    };

    const spans: ReadingInlineSpan[] = [];
    for (const span of acc.spans) {
        const start = translate(span.start);
        // end 是开区间，用「末字符的落点 + 1」换算，避免结尾被折叠时把区间算长
        const end = Math.max(start, Math.min(text.length, translate(span.end - 1) + 1));
        if (end <= start) continue;
        spans.push({ ...span, start, end });
    }
    return { text, spans };
}

/** 段落被（插图标记等）过滤掉若干条后，与它并行的样式/行内数组要跟着同一张掩码裁，
 *  否则下标会整体错位——那样批注和样式就全指到别的段落上去了。 */
function maskParagraphList<T>(list: T[] | undefined, mask: boolean[]): T[] | undefined {
    if (!Array.isArray(list)) return undefined;
    return list.filter((_, index) => mask[index] !== false);
}

/** 把行内小图的「本章下标」换算成「全书下标」，顺便把换算不出来的那几张
 *  连同它的占位字符一起删掉。
 *
 *  必须删：占位字符和序号列表是一一对应的，只要有一张图换算失败却被留在列表外，
 *  后面所有图就会整段串位（脚注角标显示成别的符号）。宁可少一张角标，不能串位。
 *  这一步只发生在导入期，此时还没有任何批注，所以改动字符数不会让已存锚点错位。 */
function pruneInlineImages(
    text: string,
    inlineImages: number[],
    mapIndex: (localIndex: number) => number | undefined,
): { text: string; inlineImages: number[] | undefined } {
    const kept: number[] = [];
    let out = "";
    let last = 0;
    let cursor = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== INLINE_IMAGE_CHAR) continue;
        const localIndex = inlineImages[cursor];
        cursor += 1;
        const mapped = localIndex === undefined ? undefined : mapIndex(localIndex);
        if (mapped === undefined) {
            out += text.slice(last, i);
            last = i + 1;
            continue;
        }
        kept.push(mapped);
    }
    if (kept.length === inlineImages.length) return { text, inlineImages: kept };
    out += text.slice(last);
    return { text: out, inlineImages: kept.length > 0 ? kept : undefined };
}

/** 把「被丢弃的行内小图」从正文里摘掉（连同它那个占位字符），并同步列表。
 *  丢弃只发生在导入时、此时还没有任何批注，所以改动字符数不会让已存锚点错位。 */
function stripDroppedInlineImages(
    text: string,
    inlineImages: number[] | undefined,
    dropped: Set<number>,
): { text: string; inlineImages: number[] | undefined } {
    if (!inlineImages || inlineImages.length === 0 || dropped.size === 0) return { text, inlineImages };
    const kept: number[] = [];
    let out = "";
    let last = 0;
    let cursor = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== INLINE_IMAGE_CHAR) continue;
        const index = inlineImages[cursor];
        cursor += 1;
        if (index === undefined) break; // 数据不一致，保底不再往下猜
        if (dropped.has(index)) {
            out += text.slice(last, i);
            last = i + 1;
            continue;
        }
        kept.push(index);
    }
    if (kept.length === inlineImages.length) return { text, inlineImages };
    out += text.slice(last);
    return { text: out, inlineImages: kept.length > 0 ? kept : undefined };
}

/** 一个叶子块的产物：正文 + 行内样式 + 块级样式 + 行内小图。
 *  插图标记和文字挤在同一块里时标记单独成段（和改动前一致），这时丢掉 spans 免得错位。 */
type ExtractedBlock = {
    text: string;
    spans: ReadingInlineSpan[];
    style: ReadingBlockStyle | null;
    inlineImages: number[];
};

/** extractTextFromDom 的产物。几个并行数组与 paragraphs 一一对应，
 *  只在书里确实带了相应内容时才给。 */
type ExtractedDom = {
    title: string;
    paragraphs: string[];
    paragraphStyles?: (ReadingBlockStyle | null)[];
    paragraphSpans?: (ReadingInlineSpan[] | null)[];
    /** 与 paragraphs 一一对应：这一段里的行内小图（值 = imageSrcs 下标，按出现顺序） */
    paragraphInlineImages?: (number[] | null)[];
    imageSrcs?: string[];
};

/** 正文提取（DOM 版）。
 *  正则版遇到嵌套块（<div><p>…</p></div>）会错位，且去标签时不插分隔符，
 *  相邻的行内元素会被粘成一坨（目录里的「八 革职」+「1」变成「八 革职1」）。
 *  这里只取「叶子块」——本身不再包含块级后代的元素——避免父块和子块各产出一次。
 *  每个块顺带取走原书的语义样式（detectBlockStyle）与行内强调（walkInline）。 */
function extractTextFromDom(html: string): ExtractedDom | null {
    if (typeof DOMParser === "undefined") return null;
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
        return null;
    }
    const body = doc.body;
    if (!body) return null;

    body.querySelectorAll("script, style, nav[*|type='toc'], nav.toc").forEach((node) => node.remove());

    const heading = body.querySelector("h1, h2, h3");
    const title = normalizeInlineText(heading?.textContent || doc.querySelector("title")?.textContent || "");

    // 插图分两类，处理方式完全不同：
    //  · 独立成段的图（<figure> 里的插图、独图一段）→ 换成「标记段落」，
    //    渲染成一整块大图，这是原来就有的行为；
    //  · 嵌在句子里的图（脚注角标、章节装饰符最典型）→ 换成单个占位字符，
    //    渲染成行内小图。这类图原来也被当成整段大图，于是正文里每几行就冒出
    //    一张巨图——一本满是角标图的书读起来全是图。
    const imageSrcs: string[] = [];
    body.querySelectorAll("img, image").forEach((node) => {
        const src = node.getAttribute("src")
            || node.getAttribute("xlink:href")
            || node.getAttribute("href")
            || "";
        if (!src.trim()) { node.remove(); return; }
        const imageIndex = imageSrcs.length;
        imageSrcs.push(src.trim());
        const target = node.tagName.toLowerCase() === "image" ? (node.closest("svg") || node) : node;

        if (isInlineImageNode(node, body)) {
            // 行内图：包一层带标记的 <span>，walkInline 见到它就登记下标，
            // 里面的 \uFFFC 作为普通字符进入正文，位置因此被完整保住
            const wrapper = doc.createElement("span");
            wrapper.setAttribute("data-reading-inline-img", String(imageIndex));
            wrapper.textContent = INLINE_IMAGE_CHAR;
            target.replaceWith(wrapper);
            return;
        }

        const placeholder = doc.createElement("p");
        placeholder.textContent = buildReadingImageMarker(imageIndex);
        // <image> 一般裹在 <svg> 里，整块换掉，免得留个空 svg
        target.replaceWith(placeholder);
    });

    const blocks: ExtractedBlock[] = [];
    const seenHeading = { done: false };

    /** 一块正文入列。图片标记和文字挤在同一块里时标记单独成段（和改动前一致：
     *  标记绝不能混进正文文字——那样既会显示成一个怪符号，也会被当成正文送进模型），
     *  这时行内样式的区间已经跟文字对不上了，丢掉 spans 比错位安全。 */
    const pushBlock = (
        text: string,
        spans: ReadingInlineSpan[],
        style: ReadingBlockStyle | null,
        inlineImages: number[],
    ) => {
        if (!text) return;
        if (!text.includes("\uFFFCimg:")) {
            blocks.push({ text, spans, style, inlineImages });
            return;
        }
        // 独立插图标记和文字挤在同一块：标记单独成段（一直如此）。
        // 切段之后行内图的下标可能对不上（块标记本身也以 \uFFFC 开头），
        // 这种情况下宁可丢掉这一块的行内图，也不能让它们指到别的图上。
        for (const piece of text.split(/(\uFFFCimg:\d+(?::\d+x\d+)?)/)) {
            const trimmed = piece.trim();
            if (!trimmed) continue;
            const isBlockMarker = Boolean(parseReadingImageMarker(trimmed));
            blocks.push({
                text: trimmed,
                spans: [],
                // 插图占位自己不带样式；后面的段落保留原块样式
                style: isBlockMarker ? null : style,
                inlineImages: [],
            });
        }
    };

    const readBlock = (node: Element, style: ReadingBlockStyle | null) => {
        const acc: InlineAccumulator = { chars: [], spans: [], inlineImages: [] };
        for (const child of Array.from(node.childNodes)) walkInline(acc, child);
        const { text, spans } = finalizeInline(acc);
        if (!text) return;
        // 章节标题已经单独拿出来当章名了，正文里再出现一次就是重复
        if (!seenHeading.done && node === heading && text === title) {
            seenHeading.done = true;
            return;
        }
        pushBlock(text, spans, style, acc.inlineImages);
    };

    const visit = (node: Element) => {
        const hasBlockChild = Array.from(node.children).some((child) => BLOCK_TAGS.has(child.tagName));
        if (hasBlockChild) {
            Array.from(node.children).forEach((child) => {
                if (BLOCK_TAGS.has(child.tagName)) visit(child);
            });
            return;
        }
        readBlock(node, detectBlockStyle(node));
    };
    Array.from(body.children).forEach((child) => {
        if (BLOCK_TAGS.has(child.tagName)) visit(child);
        else readBlock(child, null);
    });

    if (blocks.length === 0) {
        const plain = normalizeInlineText(body.textContent || "");
        if (plain) blocks.push({ text: plain, spans: [], style: null, inlineImages: [] });
    }

    // 一个带样式的块都没有（纯文本型 EPUB）时不给这套数组，渲染层直接走原来的
    // 统一排版，表现与改动前完全一致。
    const hasStyle = blocks.some((block) => block.style !== null || block.spans.length > 0);
    const hasInlineImages = blocks.some((block) => block.inlineImages.length > 0);
    return {
        title,
        paragraphs: blocks.map((block) => block.text),
        imageSrcs,
        ...(hasStyle
            ? {
                paragraphStyles: blocks.map((block) => block.style),
                paragraphSpans: blocks.map((block) => (block.spans.length > 0 ? block.spans : null)),
            }
            : {}),
        ...(hasInlineImages
            ? { paragraphInlineImages: blocks.map((block) => (block.inlineImages.length > 0 ? block.inlineImages : null)) }
            : {}),
    };
}

/** 行内文本归一：把标签间的换行/缩进压成单空格，但不吞掉正常的词间空格。 */
function normalizeInlineText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

/** Extract readable text from HTML/XHTML content. */
function extractTextFromHtml(html: string): ExtractedDom {
    const fromDom = extractTextFromDom(html);
    if (fromDom && fromDom.paragraphs.length > 0) return fromDom;

    // Try to extract title from <title> or <h1>-<h3>
    const titleMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
        || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]).trim() : "";

    // Extract text from <p>, <div>, <li> tags
    const paragraphs: string[] = [];
    const blockPattern = /<(?:p|div|li)[^>]*>([\s\S]*?)<\/(?:p|div|li)>/gi;
    let match;
    while ((match = blockPattern.exec(html)) !== null) {
        const text = stripHtmlTags(match[1]).trim();
        if (text.length > 0) paragraphs.push(text);
    }

    // Fallback: strip all tags and split by newlines
    if (paragraphs.length === 0) {
        const plainText = stripHtmlTags(html).trim();
        if (plainText) {
            const lines = plainText.split(/\n{2,}/).map(l => l.trim()).filter(l => l.length > 0);
            paragraphs.push(...lines);
        }
    }

    return { title, paragraphs };
}

function stripHtmlTags(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, " ");
}

// ── PDF Parsing ──

/**
 * Parse PDF file into chapters (pages) and paragraphs.
 * Each page becomes a "chapter" since PDFs don't have semantic chapters.
 */
export type PdfParagraphMeta = {
    text: string;
    pageNum: number;       // 1-based page number
    yRatio: number;        // 0-1 vertical position within the page (0=top, 1=bottom)
};
export const PDF_PAGES_PER_CHAPTER = 5;

export type ParsedPdfChunk = ParsedChapter & {
    startPage: number;
    endPage: number;
    pdfMeta: PdfParagraphMeta[];
};

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

async function openPdfDocument(source: PdfSource): Promise<{ pdf: any; dispose: () => Promise<void> }> {
    const pdfjsLib = await loadPdfjs();
    if (source instanceof Blob) {
        const url = URL.createObjectURL(source);
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        return {
            pdf,
            dispose: async () => {
                URL.revokeObjectURL(url);
            },
        };
    }

    const pdf = await pdfjsLib.getDocument(new Uint8Array(source)).promise;
    return {
        pdf,
        dispose: async () => {},
    };
}

async function readPdfBaseMeta(pdf: any, fileName?: string) {
    const bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    return {
        title: (info?.Title as string | undefined) || bookTitle,
        author: (info?.Author as string | undefined)?.trim() || undefined,
        totalPages: pdf.numPages,
    };
}

export async function inspectPdfFile(source: PdfSource, fileName?: string): Promise<ParsedBook & { totalPages: number }> {
    const { pdf, dispose } = await openPdfDocument(source);
    try {
        const base = await readPdfBaseMeta(pdf, fileName);
        const chapters: ParsedChapter[] = [];
        for (let startPage = 1; startPage <= base.totalPages; startPage += PDF_PAGES_PER_CHAPTER) {
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chapters.push({
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: [],
            });
        }
        return { title: base.title, author: base.author, totalPages: base.totalPages, chapters };
    } finally {
        try {
            await pdf.destroy?.();
        } catch {
            // Ignore cleanup failures from PDF.js.
        }
        await dispose();
    }
}

export async function parsePdfPageRange(
    source: PdfSource,
    options: { startPage: number; endPage: number; fileName?: string },
): Promise<{ title: string; author?: string; totalPages: number; chunks: ParsedPdfChunk[] }> {
    const { pdf, dispose } = await openPdfDocument(source);
    const base = await readPdfBaseMeta(pdf, options.fileName);
    const startPage = Math.max(1, Math.min(base.totalPages, options.startPage));
    const endPage = Math.max(startPage, Math.min(base.totalPages, options.endPage));
    const chunkMap = new Map<number, ParsedPdfChunk>();

    const ensureChunk = (pageNum: number) => {
        const chunkStart = Math.floor((pageNum - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        let chunk = chunkMap.get(chunkStart);
        if (!chunk) {
            const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chunk = {
                title: buildPdfChunkTitle(chunkStart, chunkEnd),
                startPage: chunkStart,
                endPage: chunkEnd,
                paragraphs: [],
                pdfMeta: [],
            };
            chunkMap.set(chunkStart, chunk);
        }
        return chunk;
    };

    for (let i = startPage; i <= endPage; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageHeight = viewport.height;
        const chunk = ensureChunk(i);

        const items = textContent.items as { str?: string; transform?: number[] }[];
        const lines: { text: string; y: number }[] = [];
        let currentLine = "";
        let currentY = -1;

        for (const item of items) {
            const str = item.str || "";
            if (!str.trim()) continue;
            const y = item.transform ? item.transform[5] : 0;

            if (currentY < 0 || Math.abs(y - currentY) < 3) {
                currentLine += str;
                if (currentY < 0) currentY = y;
            } else {
                if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });
                currentLine = str;
                currentY = y;
            }
        }
        if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });

        let paraText = "";
        let paraY = 0;
        for (let j = 0; j < lines.length; j += 1) {
            if (paraText === "") {
                paraText = lines[j].text;
                paraY = lines[j].y;
            } else {
                const gap = Math.abs(lines[j].y - lines[j - 1].y);
                if (gap > 20) {
                    if (paraText.length > 5) {
                        const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
                        chunk.pdfMeta.push(meta);
                        chunk.paragraphs.push(meta.text);
                    }
                    paraText = lines[j].text;
                    paraY = lines[j].y;
                } else {
                    paraText += " " + lines[j].text;
                }
            }
        }
        if (paraText.length > 5) {
            const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
            chunk.pdfMeta.push(meta);
            chunk.paragraphs.push(meta.text);
        }

        page.cleanup?.();
        if (i % 12 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    try {
        await pdf.destroy?.();
    } catch {
        // Ignore cleanup failures from PDF.js.
    }
    await dispose();

    return {
        title: base.title,
        author: base.author,
        totalPages: base.totalPages,
        chunks: [...chunkMap.values()].sort((a, b) => a.startPage - b.startPage),
    };
}
