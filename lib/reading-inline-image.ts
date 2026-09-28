/** EPUB 正文里的插图。
 *
 *  章节的正文结构是 string[]（一段一条），插图必须混在段落序列里才能保持
 *  它在原文中的位置。所以用一条「标记段落」占位，段落数组本身不变形：
 *
 *      ￼img:3:800x1200
 *
 *  U+FFFC 是 Unicode 的 OBJECT REPLACEMENT CHARACTER——本来就是「这里有个
 *  非文字对象」的意思，正文里不可能出现，不会和真的文字撞上。
 *  尺寸写进标记里，翻页模式分页时要用它算这张图占多高，而分页是同步的，
 *  没法等图片解码。 */
const MARKER_PATTERN = /^￼img:(\d+)(?::(\d+)x(\d+))?$/;

export type ReadingImageRef = {
    index: number;
    /** 原图像素宽高；老数据或解码失败时是 0，按未知处理 */
    width: number;
    height: number;
};

export function buildReadingImageMarker(index: number, width = 0, height = 0): string {
    return width > 0 && height > 0 ? `￼img:${index}:${width}x${height}` : `￼img:${index}`;
}

/** 这一段是不是插图占位；不是就返回 null */
export function parseReadingImageMarker(text: string): ReadingImageRef | null {
    const matched = MARKER_PATTERN.exec(text.trim());
    if (!matched) return null;
    return {
        index: Number(matched[1]),
        width: Number(matched[2] || 0),
        height: Number(matched[3] || 0),
    };
}

export function isReadingImageParagraph(text: string): boolean {
    return parseReadingImageMarker(text) !== null;
}

/** 给模型看的正文里不该出现这种占位符 */
export function describeReadingImageParagraph(): string {
    return "（此处是一张插图）";
}

/** 一本书的插图在资源库里的键 */
export function readingImageAssetKey(bookId: string, index: number): string {
    return `bookimg:${bookId}:${index}`;
}

export function readingImageAssetPrefix(bookId: string): string {
    return `bookimg:${bookId}:`;
}
