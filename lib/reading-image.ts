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

/** 封面图最长边：列表里只有几十像素宽 */
export const READING_COVER_MAX_SIZE = 900;
/** 头像最长边：显示尺寸更小，再大也看不出来 */
export const READING_AVATAR_MAX_SIZE = 480;
/** 正文插图最长边：手机屏幕宽度的两倍足够清晰，再大只是占 IndexedDB */
export const READING_INLINE_IMAGE_MAX_SIZE = 1200;
