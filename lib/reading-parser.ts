// lib/reading-parser.ts — File parsing for TXT, EPUB, PDF.

import { buildReadingImageMarker, parseReadingImageMarker } from "./reading-inline-image";
import { READING_INLINE_IMAGE_MAX_SIZE, compressReadingImage } from "./reading-image";

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
/** 量一张图的原始像素尺寸。解码不了（SVG、老浏览器）就返回 null，按未知处理。 */
async function measureImageBlob(blob: Blob): Promise<{ width: number; height: number } | null> {
    if (typeof createImageBitmap === "undefined") return null;
    try {
        const bitmap = await createImageBitmap(blob);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
    } catch {
        return null;
    }
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
        const { title, paragraphs, imageSrcs } = extractTextFromHtml(html);
        if (paragraphs.length === 0) continue;

        let finalParagraphs = paragraphs;
        if (imageSrcs && imageSrcs.length > 0) {
            const chapterDir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
            const localToGlobal = new Map<number, number>();
            imageSrcs.forEach((src, localIndex) => {
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
            finalParagraphs = paragraphs.map((paragraph) => {
                const marker = parseReadingImageMarker(paragraph);
                if (!marker) return paragraph;
                const globalIndex = localToGlobal.get(marker.index);
                return globalIndex === undefined ? "" : buildReadingImageMarker(globalIndex);
            }).filter((paragraph) => paragraph !== "");
            if (finalParagraphs.length === 0) continue;
        }

        const fromToc = tocByPath.get(normalizeTocHref(href, rootDir));
        chapters.push({
            title: fromToc?.label || title || `第${chapters.length + 1}章`,
            paragraphs: finalParagraphs,
            ...(fromToc ? { tocLevel: fromToc.level } : {}),
        });
    }

    // 7. 取出插图的字节，顺便量一下原图尺寸（翻页分页要用它算这张图占多高）
    const images: ReadingParsedImage[] = [];
    const droppedImages = new Set<number>();
    for (let index = 0; index < imagePaths.length; index += 1) {
        const data = await zip.file(imagePaths[index])?.async("blob");
        if (!data || data.size === 0) { droppedImages.add(index); continue; }
        const measured = await measureImageBlob(data);
        // 1x1 透明占位、分隔线之类的小图没有阅读价值，只会在正文里留一行空白
        if (measured && (measured.width < 40 || measured.height < 40)) { droppedImages.add(index); continue; }
        const blob = await compressReadingImage(data, READING_INLINE_IMAGE_MAX_SIZE);
        images.push({ index, blob, width: measured?.width ?? 0, height: measured?.height ?? 0 });
    }

    if (images.length > 0 || droppedImages.size > 0) {
        const sizeByIndex = new Map(images.map((image) => [image.index, image]));
        for (const chapter of chapters) {
            chapter.paragraphs = chapter.paragraphs.map((paragraph) => {
                const marker = parseReadingImageMarker(paragraph);
                if (!marker) return paragraph;
                if (droppedImages.has(marker.index)) return "";
                const image = sizeByIndex.get(marker.index);
                return buildReadingImageMarker(marker.index, image?.width ?? 0, image?.height ?? 0);
            }).filter((paragraph) => paragraph !== "");
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
        const { title: pieceTitle, paragraphs } = extractTextFromHtml(piece);
        if (paragraphs.length === 0) continue;
        chapters.push({ title: pieceTitle || `第${chapters.length + 1}章`, paragraphs });
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

/** 插图标记可能和文字挤在同一个块里（典型是 <figure> 里图配图注）。
 *  把标记切出来单独成段，图和文字都不会丢；顺带保证标记绝不会混进正文文字里
 *  ——那样既会显示成一个怪符号，也会被当成正文送进模型。 */
function pushParagraphWithImages(paragraphs: string[], text: string): void {
    if (!text) return;
    if (!text.includes("\uFFFC")) { paragraphs.push(text); return; }
    for (const piece of text.split(/(\uFFFCimg:\d+(?::\d+x\d+)?)/)) {
        const trimmed = piece.trim();
        if (trimmed) paragraphs.push(trimmed);
    }
}

/** 正文提取（DOM 版）。
 *  正则版遇到嵌套块（<div><p>…</p></div>）会错位，且去标签时不插分隔符，
 *  相邻的行内元素会被粘成一坨（目录里的「八 革职」+「1」变成「八 革职1」）。
 *  这里只取「叶子块」——本身不再包含块级后代的元素——避免父块和子块各产出一次。 */
function extractTextFromDom(html: string): { title: string; paragraphs: string[]; imageSrcs?: string[] } | null {
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

    // 插图：原地换成一条「标记段落」，保住它在正文里的位置。
    // 下面的取文逻辑只看文字，图片元素本身不产出任何段落，不换的话图就没了。
    const imageSrcs: string[] = [];
    body.querySelectorAll("img, image").forEach((node) => {
        const src = node.getAttribute("src")
            || node.getAttribute("xlink:href")
            || node.getAttribute("href")
            || "";
        if (!src.trim()) { node.remove(); return; }
        const placeholder = doc.createElement("p");
        placeholder.textContent = buildReadingImageMarker(imageSrcs.length);
        // <image> 一般裹在 <svg> 里，整块换掉，免得留个空 svg
        const target = node.tagName.toLowerCase() === "image" ? (node.closest("svg") || node) : node;
        target.replaceWith(placeholder);
        imageSrcs.push(src.trim());
    });

    const paragraphs: string[] = [];
    const seenHeading = { done: false };
    const visit = (node: Element) => {
        const hasBlockChild = Array.from(node.children).some((child) => BLOCK_TAGS.has(child.tagName));
        if (hasBlockChild) {
            Array.from(node.children).forEach((child) => {
                if (BLOCK_TAGS.has(child.tagName)) visit(child);
            });
            return;
        }
        const text = normalizeInlineText(node.textContent || "");
        if (!text) return;
        // 章节标题已经单独拿出来当章名了，正文里再出现一次就是重复
        if (!seenHeading.done && node === heading && text === title) {
            seenHeading.done = true;
            return;
        }
        pushParagraphWithImages(paragraphs, text);
    };
    Array.from(body.children).forEach((child) => {
        if (BLOCK_TAGS.has(child.tagName)) visit(child);
        else {
            pushParagraphWithImages(paragraphs, normalizeInlineText(child.textContent || ""));
        }
    });

    if (paragraphs.length === 0) {
        const plain = normalizeInlineText(body.textContent || "");
        if (plain) paragraphs.push(plain);
    }
    return { title, paragraphs, imageSrcs };
}

/** 行内文本归一：把标签间的换行/缩进压成单空格，但不吞掉正常的词间空格。 */
function normalizeInlineText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

/** Extract readable text from HTML/XHTML content. */
function extractTextFromHtml(html: string): { title: string; paragraphs: string[]; imageSrcs?: string[] } {
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
