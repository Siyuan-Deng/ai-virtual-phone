"use client";

/** 用户挑的图片先压一道再存。手机原图动辄几 MB，而封面/头像在界面上
 *  只有几十到一百多像素宽，原图存进 IndexedDB 纯属浪费。
 *  任何一步不支持（老浏览器、非图片文件）就原样返回，不影响功能。 */
export async function compressReadingImage(blob: Blob, maxSize: number): Promise<Blob> {
    if (typeof window === "undefined" || typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") {
        return blob;
    }
    try {
        const bitmap = await createImageBitmap(blob);
        let width = bitmap.width;
        let height = bitmap.height;
        if (width > maxSize || height > maxSize) {
            const scale = maxSize / Math.max(width, height);
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) { bitmap.close(); return blob; }
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const compressed = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
        return compressed.size > 0 && compressed.size < blob.size ? compressed : blob;
    } catch {
        return blob;
    }
}

/** 已经够小、不值得再花一次编码成本的图：尺寸在限内且体积低于这个值就直接原样存。
 *  webp 重编码对这类图省不下多少空间，但每张都要走一次解码 + 编码，
 *  一本插图多的书累积起来就是导入卡顿的主要来源。 */
const READING_IMAGE_SKIP_COMPRESS_BYTES = 300 * 1024;

/**
 * 量尺寸 + 压缩，一次解码搞定。
 *
 * 原来这两件事各做一遍（measureImageBlob 解一次、compressReadingImage 再解一次），
 * 同一张图要被解码两次——解码是图片处理里最贵的一步，导入时每张图都付双份。
 * 这里合并成一次解码：尺寸取**原图**尺寸（正文按它算长宽比，不能被缩放后的值顶掉），
 * blob 取压缩结果；解码不了（SVG、老浏览器）就原样返回、尺寸记 0。
 */
export async function measureAndCompressReadingImage(
    blob: Blob,
    maxSize: number,
): Promise<{ blob: Blob; width: number; height: number }> {
    if (typeof window === "undefined" || typeof createImageBitmap === "undefined") {
        return { blob, width: 0, height: 0 };
    }
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return { blob, width: 0, height: 0 };
    }

    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    try {
        const withinLimit = sourceWidth <= maxSize && sourceHeight <= maxSize;
        if (withinLimit && blob.size <= READING_IMAGE_SKIP_COMPRESS_BYTES) {
            return { blob, width: sourceWidth, height: sourceHeight };
        }
        if (typeof OffscreenCanvas === "undefined") {
            return { blob, width: sourceWidth, height: sourceHeight };
        }
        const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return { blob, width: sourceWidth, height: sourceHeight };
        ctx.drawImage(bitmap, 0, 0, width, height);
        const compressed = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
        return {
            blob: compressed.size > 0 && compressed.size < blob.size ? compressed : blob,
            width: sourceWidth,
            height: sourceHeight,
        };
    } catch {
        return { blob, width: sourceWidth, height: sourceHeight };
    } finally {
        bitmap.close();
    }
}

/** 封面图最长边：列表里只有几十像素宽 */
export const READING_COVER_MAX_SIZE = 900;
/** 头像最长边：显示尺寸更小，再大也看不出来 */
export const READING_AVATAR_MAX_SIZE = 480;
/** 正文插图最长边：手机屏幕宽度的两倍足够清晰，再大只是占 IndexedDB */
export const READING_INLINE_IMAGE_MAX_SIZE = 1200;
