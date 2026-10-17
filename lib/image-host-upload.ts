"use client";

/**
 * 分享图片的「图床」出口——用户在选择弹窗里主动选「通过图床保存」时才会走到这里。
 *
 * 背景：有些安卓 WebView / 壳把下载交给自家原生下载器（OkHttp），那个下载器只认
 * http(s)，页面内用 canvas 现做的 blob: 图片一律拒收，报
 *   Expected URL scheme 'http' or 'https' but was 'blob'
 * 同一个下载函数导出 .md 却是好的——文本不走那条图片分流。
 *
 * 既然它认 http(s)，那就在这一步把图变成一条真的 http(s)：上传到站点自带的图床
 * 接口、拿回直链再交给下载器（见 download-utils 的 saveImageBlobViaHost）。
 *
 * 注意：这一步会把图片上传到公网，所以不由程序默认触发。需要在部署平台配置
 * IMGBB_API_KEY。图床偶尔会连不上，而这一步卡住会让保存一直转圈，所以：
 *   ① 每次请求都带超时——连不上就快速失败，别让用户干等；
 *   ② 网络类失败自动重试，配置类错误（没配 key 等）不重试，
 *      因为重试多少次结果都一样，只是白白多等。
 */

/** 图床副本的有效期：1 天。图存到本地之后就不再需要这条外链，
 *  设个期限让它自己过期，免得私人批注一直挂在公网。 */
const UPLOAD_EXPIRATION_SECONDS = 24 * 60 * 60;

/** 单次上传的超时。图不大（一两 MB），20 秒还没回来说明链路有问题。 */
const UPLOAD_TIMEOUT_MS = 20_000;
/** 总尝试次数（首次 + 重试）。 */
const UPLOAD_ATTEMPTS = 3;
/** 重试间隔，逐次拉长。 */
const RETRY_DELAY_MS = [1200, 3000];

/** 这些是配置或参数问题，重试也不会变——直接失败，别浪费时间。 */
function isFatalUploadError(message: string): boolean {
    return /未启用图床|缺少 ImgBB API Key|不支持的图片类型|图片文件为空|图片超过|url 不合法/.test(message);
}

/** 图床上传要用的那份凭证，来源是「图像生成 → Image Hosting」里的同一份设置。
 *
 *  以前 key 只从服务端环境变量 IMGBB_API_KEY 读：自部署用户明明在设置界面填过
 *  ImgBB Key，保存卡片时却仍然报「缺少 ImgBB API Key」——两处配置各说各话。
 *  现在客户端先把设置里的 key 一起提交（服务端也认这个字段，见
 *  app/api/image-hosting/imgbb/route.ts），环境变量只作为服务端兜底继续保留。
 *
 *  每次上传都重新读设置，用户改完 key 不用刷新页面。 */
function resolveHostingCredentials(): { apiKey: string; expirationSeconds: number } {
    const hosting = loadImageGenerationSettings()?.imageHosting;
    if (!hosting || hosting.provider !== "imgbb") {
        throw new Error("未启用图床：请先在 设置 → 图像生成 → Image Hosting 选择 ImgBB 并填写 API Key");
    }
    const apiKey = (hosting.imgbbApiKey || "").trim();
    if (!apiKey) {
        throw new Error("缺少 ImgBB API Key：请到 设置 → 图像生成 → Image Hosting 填写");
    }
    // 设置里 0 表示「不过期」，但这条通道只是给宿主下载器用的中转，
    // 图存进相册后再没有留外链的理由，所以仍然按内置的 1 天兜底。
    const configured = Math.floor(Number(hosting.defaultExpirationSeconds) || 0);
    return { apiKey, expirationSeconds: configured > 0 ? configured : UPLOAD_EXPIRATION_SECONDS };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadOnce(blob: Blob, filename: string): Promise<string> {
    // 凭证问题在这里就抛，不占一次网络请求；重试逻辑会把它当致命错误直接退出
    const { apiKey, expirationSeconds } = resolveHostingCredentials();
    const form = new FormData();
    form.set("file", new File([blob], filename, { type: blob.type || "image/png" }));
    form.set("name", filename);
    form.set("apiKey", apiKey);
    form.set("expiration", String(expirationSeconds));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const res = await fetch("/api/image-hosting/imgbb", {
            method: "POST",
            body: form,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => null) as { url?: string; error?: string } | null;
        const url = typeof data?.url === "string" ? data.url : "";
        if (!res.ok || !/^https?:\/\//.test(url)) {
            throw new Error(data?.error || `图床上传失败（HTTP ${res.status}）`);
        }
        return url;
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`图床连接超时（${UPLOAD_TIMEOUT_MS / 1000} 秒无响应）`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export async function uploadImageForDownload(blob: Blob, filename: string): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
        try {
            return await uploadOnce(blob, filename);
        } catch (err) {
            lastError = err;
            const message = err instanceof Error ? err.message : String(err);
            // 配置类错误不用重试；已经是最后一次也不再等
            if (isFatalUploadError(message) || attempt + 1 >= UPLOAD_ATTEMPTS) break;
            await sleep(RETRY_DELAY_MS[attempt] ?? 3000);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("图床上传失败");
}
