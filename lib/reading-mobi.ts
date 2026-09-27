"use client";

// MOBI（PalmDOC 容器）解包。只负责把二进制还原成 HTML 文本，
// 分章和取正文仍然走 reading-parser 里 EPUB 那套，两种格式表现一致。

const PDB_HEADER_SIZE = 78;
const RECORD_INFO_SIZE = 8;
const PALMDOC_HEADER_SIZE = 16;

export type MobiDocument = {
    html: string;
    /** MOBI 头里的完整书名，取不到时为空串 */
    title: string;
};

function readU16(view: DataView, offset: number): number {
    return view.getUint16(offset, false);
}

function readU32(view: DataView, offset: number): number {
    return view.getUint32(offset, false);
}

/** PalmDOC LZ77。压缩类型 2 用的就是这个，类型 1 是不压缩。 */
function decompressPalmDoc(input: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 0;
    while (i < input.length) {
        const byte = input[i++];
        if (byte === 0) {
            out.push(0);
        } else if (byte <= 8) {
            // 后面这 byte 个字节原样输出
            for (let n = 0; n < byte && i < input.length; n += 1) out.push(input[i++]);
        } else if (byte <= 0x7f) {
            out.push(byte);
        } else if (byte <= 0xbf) {
            // 两字节回溯引用：距离 11 位，长度 3 位（+3）
            if (i >= input.length) break;
            const pair = (byte << 8) | input[i++];
            const distance = (pair >> 3) & 0x07ff;
            const length = (pair & 0x07) + 3;
            if (distance === 0 || distance > out.length) break;
            for (let n = 0; n < length; n += 1) out.push(out[out.length - distance]);
        } else {
            // 0xC0-0xFF：空格 + 该字节异或 0x80
            out.push(0x20, byte ^ 0x80);
        }
    }
    return Uint8Array.from(out);
}

function decodeBytes(bytes: Uint8Array, encoding: number): string {
    const label = encoding === 1252 ? "windows-1252" : "utf-8";
    try {
        return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
}

export function parseMobiDocument(buffer: ArrayBuffer): MobiDocument {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < PDB_HEADER_SIZE) throw new Error("MOBI 文件过小或已损坏");

    const view = new DataView(buffer);
    const recordCount = readU16(view, 76);
    if (recordCount < 1) throw new Error("MOBI 文件里没有记录");

    const offsets: number[] = [];
    for (let i = 0; i < recordCount; i += 1) {
        const base = PDB_HEADER_SIZE + i * RECORD_INFO_SIZE;
        if (base + 4 > bytes.length) throw new Error("MOBI 记录表被截断");
        offsets.push(readU32(view, base));
    }
    offsets.push(bytes.length);

    const record0Start = offsets[0];
    if (record0Start + PALMDOC_HEADER_SIZE > bytes.length) throw new Error("MOBI 头被截断");

    const compression = readU16(view, record0Start);
    const textLength = readU32(view, record0Start + 4);
    const textRecordCount = readU16(view, record0Start + 8);
    const encryption = readU16(view, record0Start + 12);

    if (encryption !== 0) throw new Error("这本 MOBI 有 DRM 保护，无法解析");
    if (compression === 17480) throw new Error("这本 MOBI 用的是 HUFF/CDIC 压缩，暂不支持");
    if (compression !== 1 && compression !== 2) throw new Error(`不认识的 MOBI 压缩方式：${compression}`);

    // MOBI 扩展头（紧跟 PalmDOC 头）。没有也能读，只是拿不到书名和编码。
    let encoding = 65001;
    let title = "";
    const mobiStart = record0Start + PALMDOC_HEADER_SIZE;
    const hasMobiHeader = mobiStart + 4 <= bytes.length
        && String.fromCharCode(bytes[mobiStart], bytes[mobiStart + 1], bytes[mobiStart + 2], bytes[mobiStart + 3]) === "MOBI";
    if (hasMobiHeader) {
        encoding = readU32(view, mobiStart + 12);
        const nameOffset = readU32(view, mobiStart + 68);
        const nameLength = readU32(view, mobiStart + 72);
        const nameStart = record0Start + nameOffset;
        if (nameLength > 0 && nameStart + nameLength <= bytes.length) {
            title = decodeBytes(bytes.subarray(nameStart, nameStart + nameLength), encoding).trim();
        }
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 1; i <= textRecordCount && i < offsets.length - 1; i += 1) {
        const raw = bytes.subarray(offsets[i], offsets[i + 1]);
        const piece = compression === 2 ? decompressPalmDoc(raw) : raw;
        chunks.push(piece);
        total += piece.length;
    }

    const merged = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) { merged.set(chunk, cursor); cursor += chunk.length; }
    const limited = textLength > 0 && textLength < merged.length ? merged.subarray(0, textLength) : merged;

    const html = decodeBytes(limited, encoding);
    if (!html.trim()) throw new Error("MOBI 正文为空，可能是不支持的变体");
    return { html, title };
}
