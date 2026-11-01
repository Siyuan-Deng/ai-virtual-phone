// 聊天截图：把选中的几条消息拼成一张「手机截屏」——顶上标题栏，中间这几条，底下输入框和工具栏。
// 用的是聊天页当下真实的 DOM：在屏幕外照原样搭一个台子（同样的 session 类名，美化 CSS 照样生效），
// 再交给 modern-screenshot 画成图。背景按一屏的大小截一块，消息多了往下一块块接上，不会被拉大。

import { scopeSessionCSS } from "./css-scoper";

/** iOS Safari 画布面积上限是 16,777,216 像素，留一点余量；单边也别超过 32k */
const MAX_CANVAS_AREA = 16_000_000;
const MAX_CANVAS_SIDE = 32_000;

export type ChatScreenshotParts = {
    /** 聊天页最外层（带 session-xxx 的那个）：台子照它的类名、属性、行内样式搭 */
    wrapper: HTMLElement;
    header: HTMLElement | null;
    /** 标题栏下面插件占的那几条，没有就空 */
    headerExtras: HTMLElement[];
    /** 消息列表本身（只借它的类名和间距，不带里面的东西） */
    body: HTMLElement;
    /** 选中的消息，按列表里的顺序；每个是一整组（时间条 + 气泡） */
    rows: HTMLElement[];
    inputBar: HTMLElement | null;
    /** 另外单独截成透明底小图的元素（在 rows 里面）：片刻纪事里非文字消息原样放 */
    snapTargets?: HTMLElement[];
};

export type ChatSnap = { blob: Blob; width: number; height: number };

export type ChatScreenshotResult = {
    canvas: HTMLCanvasElement;
    /** 跟 snapTargets 一一对应，截不出来的是 null */
    snaps: Array<ChatSnap | null>;
};

/** 自定义状态栏等它交 HTML 最多等这么久；别的 iframe 不认这个请求，就按超时算 */
const FRAME_SNAPSHOT_TIMEOUT = 800;

/** 自定义状态栏在沙盒 iframe 里，外面读不到、也画不进截图：请它把当下画好的 HTML 交出来 */
function snapshotFrame(frame: HTMLIFrameElement): Promise<string | null> {
    const target = frame.contentWindow;
    if (!target) return Promise.resolve(null);
    return new Promise((resolve) => {
        const finish = (html: string | null) => {
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve(html);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== target) return;
            const data = event.data as { source?: unknown; type?: unknown; html?: unknown } | null;
            if (data?.source === "chat-status-frame" && data.type === "snapshot" && typeof data.html === "string") finish(data.html);
        };
        const timer = window.setTimeout(() => finish(null), FRAME_SNAPSHOT_TIMEOUT);
        window.addEventListener("message", onMessage);
        target.postMessage({ source: "chat-status-frame", type: "snapshot" }, "*");
    });
}

let frameSeq = 0;

/** 沙盒里的东西要搬进主页面：会自己跑起来的（脚本、内嵌框、事件属性、javascript: 链接）一律拿掉，截图只要它长什么样。
 *  <style> 已经收走、套好作用域另放了，原处的也拿掉，免得不带作用域漏到外面 */
function makeInert(doc: Document): void {
    doc.querySelectorAll("script, style, iframe, frame, object, embed, base, meta, link").forEach(node => node.remove());
    for (const el of Array.from(doc.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) el.removeAttribute(attr.name);
            else if (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
    }
}

/** 照着 iframe 里的 html / body 搭一层：class、id、行内样式这些原样带上，再挂上台子自己的类名 */
function mirrorElement(source: Element, className: string): HTMLElement {
    const el = document.createElement("div");
    for (const attr of Array.from(source.attributes)) el.setAttribute(attr.name, attr.value);
    el.className = [className, source.getAttribute("class")].filter(Boolean).join(" ");
    return el;
}

/** 把交出来的 HTML 摆回 iframe 原来的位置：样式关在自己的框里，iframe 里那套默认字体、body 外边距照旧。
 *  html 和 body 各搭一层：状态栏里点开翻译这类开关常把 class 挂在 body 上，`.show-trans .xxx` 要 body 在外面一层才对得上 */
function frameReplacement(html: string, width: number, height: number): HTMLElement {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const css = Array.from(doc.querySelectorAll("style")).map(node => node.textContent || "").join("\n");
    makeInert(doc);
    const scope = `chat-capture-frame-${++frameSeq}`;
    const box = document.createElement("div");
    box.style.cssText = `all: initial; display: block; width: ${width}px; height: ${height}px; overflow: hidden;`;
    const style = document.createElement("style");
    style.textContent = `.${scope}{display:block;}\n.${scope}-body{display:block;margin:8px;}\n${scopeSessionCSS(css, `.${scope}`, `.${scope}-body`)}`;
    const root = mirrorElement(doc.documentElement, scope);
    const body = mirrorElement(doc.body, `${scope}-body`);
    body.append(...Array.from(doc.body.childNodes, node => document.importNode(node, true)));
    root.appendChild(body);
    box.append(style, root);
    return box;
}

/** 行内 !important：美化 CSS 里写了 !important 也压得住 */
function force(el: HTMLElement, styles: Record<string, string>): void {
    for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, "important");
}

/** 只要外壳：类名、属性、行内样式（背景图和 JS 写进去的 CSS 变量都在这里） */
function shellOf(source: HTMLElement): HTMLElement {
    const shell = source.cloneNode(false) as HTMLElement;
    shell.removeAttribute("id");
    shell.removeAttribute("data-loading");
    shell.removeAttribute("data-settings-open");
    return shell;
}

/** 多选的勾、长按选中、跳转高亮这些临时状态不进截图；id 去掉免得和真的那份重复 */
function cleanClone(root: HTMLElement): HTMLElement {
    root.querySelectorAll(".chat-multi-select-check").forEach(node => node.remove());
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
        el.removeAttribute("id");
        el.removeAttribute("data-multi-select");
        el.removeAttribute("data-selected");
        // 展开状态栏的那颗心也用 data-active 标红，它要留着
        if (!el.classList.contains("chat-monologue-heart")) el.removeAttribute("data-active");
        el.removeAttribute("data-highlight");
    }
    // 输入框里打了一半的字不带上，留占位提示
    root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input").forEach((field) => {
        field.value = "";
        field.textContent = "";
    });
    return root;
}

/** 单行省略号（不换行 + 超出藏起来 + 省略号，比如引用那块小灰牌）：截图库在 iPhone 上画出来的字比页面上宽一点点，
 *  放得下的也会把最后几个字省略掉，放不下的省略得更早（截图库只在 Chrome 里修了前一种）。
 *  这里照页面上量好的定下来：放得下的不用省略号；放不下的量好页面上截到哪个字，自己补上「…」。
 *  画宽的那一点点落在框的右内边距里，不出框 */
function settleEllipsis(stage: HTMLElement): void {
    for (const el of Array.from(stage.querySelectorAll<HTMLElement>("*"))) {
        const style = getComputedStyle(el);
        if (style.textOverflow !== "ellipsis" || !/^(nowrap|pre)$/.test(style.whiteSpace) || style.overflowX === "visible") continue;
        const fits = el.scrollWidth <= el.clientWidth;
        el.normalize();
        // 里面就是一段字的才自己补（::before / ::after 加的字不算在里面）
        const node = el.firstChild;
        if (!fits && !(node instanceof Text && el.childNodes.length === 1)) continue;
        const width = style.width;
        // 先关掉省略号再量：开着的时候量出来的只有看得见的那一截
        force(el, { "text-overflow": "clip" });
        if (fits || !(node instanceof Text)) continue;
        const text = node.data;
        const ellipsis = document.createElement("span");
        ellipsis.textContent = "…";
        el.appendChild(ellipsis);
        const ellipsisWidth = ellipsis.getBoundingClientRect().width;
        ellipsis.remove();
        const box = el.getBoundingClientRect();
        const limit = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) - ellipsisWidth + 0.5;
        const range = document.createRange();
        const endOf = (index: number) => {
            range.setStart(node, 0);
            range.setEnd(node, index);
            const rects = range.getClientRects();
            return rects.length ? rects[rects.length - 1].right : box.left;
        };
        // 放得下的最长一段：二分找
        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (endOf(mid) <= limit) low = mid;
            else high = mid - 1;
        }
        // emoji 这种两个字符的别拆成半个
        if (low > 0 && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
        node.data = `${text.slice(0, low)}…`;
        // 字变短了，宽度跟着内容走的框（引用灰牌）会缩，钉回页面上的宽
        force(el, { width, "min-width": width, "max-width": width });
    }
}

/** 从下往上找第一层不透明的底色，当整张图的底 */
function baseColorOf(el: HTMLElement): string {
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color && color !== "transparent" && !/rgba?\([^)]*,\s*0\)$/.test(color)) return color;
    }
    return "#ffffff";
}

function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** 别的网站上的图（表情包图床、外链头像）：页面上看得见，可截图要读出图片数据，对方不让跨站读就是一片空白。
 *  先直接读，读不到让自家服务器代取一次；本地的（data / blob / 同源）原样返回 */
async function readableImageUrl(src: string): Promise<string | null> {
    if (!/^https?:/i.test(src) || src.startsWith(location.origin)) return src;
    try {
        const res = await fetch(src, { mode: "cors", cache: "force-cache" });
        if (res.ok) return await blobToDataUrl(await res.blob());
    } catch {
        // 不让跨站读，走代理
    }
    try {
        const res = await fetch("/api/tool-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: src, method: "GET", timeoutMs: 15000 }),
        });
        const payload = res.ok ? await res.json() as { _binary?: boolean; contentType?: string; data?: string } : null;
        if (payload?._binary && payload.data) return `data:${payload.contentType || "image/png"};base64,${payload.data}`;
    } catch {
        // 代理也拿不到，只好空着
    }
    return null;
}

/** 截之前把图都换成读得出数据的本地版本，顺便缩到显示尺寸：
 *  同一张头像每条消息都会嵌一份，原图大的话整张图会大到手机画不出来 */
async function prepareImages(stage: HTMLElement, scale: number): Promise<void> {
    const readable = new Map<string, Promise<string | null>>();
    const sized = new Map<string, Promise<string | null>>();
    const prepare = async (src: string, width: number, height: number): Promise<string | null> => {
        if (!readable.has(src)) readable.set(src, readableImageUrl(src));
        const local = await readable.get(src);
        if (!local) return null;
        const image = await loadImage(local);
        if (!image || !image.naturalWidth || !image.naturalHeight) return local;
        // 等比缩到刚好盖住显示框（裁切交给原来的 object-fit）
        const ratio = Math.min(1, Math.max(width / image.naturalWidth, height / image.naturalHeight));
        if (ratio > 0.8 && local.length < 300_000) return local;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const ctx = canvas.getContext("2d");
        if (!ctx) return local;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
            return /^data:image\/jpe?g|\.jpe?g(\?|$)/i.test(local) || /\.jpe?g(\?|$)/i.test(src)
                ? canvas.toDataURL("image/jpeg", 0.9)
                : canvas.toDataURL("image/png");
        } catch {
            return local;
        }
    };
    await Promise.all(Array.from(stage.querySelectorAll("img")).map(async (img) => {
        const src = img.currentSrc || img.src;
        const rect = img.getBoundingClientRect();
        if (!src || src.startsWith("data:image/svg") || !rect.width || !rect.height) return;
        const width = Math.ceil(rect.width * scale);
        const height = Math.ceil(rect.height * scale);
        const key = `${src}|${width}x${height}`;
        if (!sized.has(key)) sized.set(key, prepare(src, width, height));
        const next = await sized.get(key);
        if (next && next !== src) {
            // 钉住原来的显示尺寸：换成缩过的图以后，w-auto 的图不会跟着新尺寸变大变小
            img.style.setProperty("width", `${rect.width}px`);
            img.style.setProperty("height", `${rect.height}px`);
            img.removeAttribute("srcset");
            img.src = next;
        }
    }));
}

/** 画出截图。台子搭在 wrapper 旁边（继承到的字体、变量都一样），用完就拆 */
export async function renderChatScreenshot(parts: ChatScreenshotParts): Promise<ChatScreenshotResult> {
    const { domToBlob, domToCanvas } = await import("modern-screenshot");
    const { wrapper, header, headerExtras, body, rows, inputBar, snapTargets = [] } = parts;
    const host = wrapper.parentElement;
    if (!host || rows.length === 0) throw new Error("没有可以截的消息");

    const screen = wrapper.getBoundingClientRect();
    const width = Math.round(screen.width);
    const screenHeight = Math.round(screen.height);
    const baseColor = baseColorOf(wrapper);
    const bodyStyle = getComputedStyle(body);
    const headerHeight = (header?.offsetHeight ?? 0) + headerExtras.reduce((sum, el) => sum + el.offsetHeight, 0);
    // 列表顶上本来留了「标题栏高度 + 一点空」，这里标题栏不再盖在上面，只留那一点空
    const padTop = Math.min(48, Math.max(12, parseFloat(bodyStyle.paddingTop) - headerHeight));
    const padBottom = Math.min(40, Math.max(12, parseFloat(bodyStyle.paddingBottom)));

    // 一个 0×0 的框把台子藏起来：台子本身在 (0,0)，不用再改它的位置
    const holder = document.createElement("div");
    force(holder, { position: "fixed", left: "0", top: "0", width: "0", height: "0", overflow: "hidden", "pointer-events": "none", "z-index": "-1" });

    const placeShell = (shell: HTMLElement, height: string, minHeight: string) => {
        force(shell, {
            position: "absolute", left: "0", top: "0", right: "auto", bottom: "auto",
            width: `${width}px`, height, "min-height": minHeight, "max-height": "none",
            margin: "0", transform: "none", overflow: "hidden",
        });
    };

    // 背景：一个没有消息的空聊天页，一屏大小，截下来当一块砖
    const probe = shellOf(wrapper);
    probe.classList.add("chat-capture-probe");
    placeShell(probe, `${screenHeight}px`, `${screenHeight}px`);
    const probeBody = body.cloneNode(false) as HTMLElement;
    probeBody.removeAttribute("id");
    force(probeBody, { position: "absolute", inset: "0", overflow: "hidden" });
    probe.appendChild(probeBody);

    // 截图的台子：标题栏、选中的消息、输入栏从上往下排，不再叠着；有多少消息就多高
    const stage = shellOf(wrapper);
    stage.classList.add("chat-capture-stage");
    placeShell(stage, "auto", "0");
    force(stage, { display: "flex", "flex-direction": "column", "background-color": baseColor });
    const flow = { position: "relative", inset: "auto", top: "auto", left: "auto", right: "auto", bottom: "auto", width: "100%", flex: "none", transform: "none", margin: "0" };
    for (const part of [header, ...headerExtras]) {
        if (!part) continue;
        const clone = cleanClone(part.cloneNode(true) as HTMLElement);
        force(clone, flow);
        stage.appendChild(clone);
    }
    const list = body.cloneNode(false) as HTMLElement;
    list.removeAttribute("id");
    force(list, {
        ...flow, flex: "1 0 auto", height: "auto", "min-height": "0", "max-height": "none", overflow: "visible",
        "padding-top": `${padTop}px`, "padding-bottom": `${padBottom}px`,
        // 列表自己的背景已经在砖里了
        "background-color": "transparent", "background-image": "none",
    });
    // 展开着的自定义状态栏：先把 HTML 要过来，克隆里的 iframe 换成它
    const frameShots = await Promise.all(rows.map(row => Promise.all(
        Array.from(row.querySelectorAll("iframe")).map(async (frame) => {
            const rect = frame.getBoundingClientRect();
            const html = await snapshotFrame(frame);
            return html ? { html, width: rect.width, height: rect.height } : null;
        }),
    )));
    // 要单独截的元素先做个记号，克隆里照记号找回来
    snapTargets.forEach((target, index) => target.setAttribute("data-capture-snap", String(index)));
    try {
        rows.forEach((row, rowIndex) => {
            const clone = cleanClone(row.cloneNode(true) as HTMLElement);
            Array.from(clone.querySelectorAll("iframe")).forEach((frame, frameIndex) => {
                const shot = frameShots[rowIndex][frameIndex];
                if (shot) frame.replaceWith(frameReplacement(shot.html, shot.width, shot.height));
            });
            list.appendChild(clone);
        });
    } finally {
        snapTargets.forEach(target => target.removeAttribute("data-capture-snap"));
    }
    stage.appendChild(list);
    if (inputBar) {
        const clone = cleanClone(inputBar.cloneNode(true) as HTMLElement);
        force(clone, flow);
        stage.appendChild(clone);
    }

    holder.append(probe, stage);
    host.appendChild(holder);
    try {
        await nextFrame();
        settleEllipsis(stage);
        const height = Math.ceil(stage.getBoundingClientRect().height);
        const scale = Math.max(1, Math.min(
            window.devicePixelRatio || 2,
            3,
            Math.sqrt(MAX_CANVAS_AREA / (width * height)),
            MAX_CANVAS_SIDE / height,
        ));

        // 截图库自己去取的图（背景图这类 CSS 里的）也走同一条路：读不到就代取
        const fetchFn = async (url: string) => {
            const local = await readableImageUrl(url);
            return local && local !== url ? local : false;
        };
        const tile = await domToCanvas(probe, { scale, backgroundColor: baseColor, timeout: 15000, fetchFn });
        probe.remove();
        force(stage, {
            "background-image": `url(${tile.toDataURL("image/jpeg", 0.92)})`,
            "background-size": `${width}px ${screenHeight}px`,
            "background-repeat": "repeat-y",
            "background-position": "0 0",
            "background-attachment": "scroll",
        });

        await prepareImages(stage, scale);
        const canvas = await domToCanvas(stage, {
            scale,
            width,
            height,
            backgroundColor: baseColor,
            timeout: 15000,
            maximumCanvasSize: MAX_CANVAS_AREA,
            fetchFn,
        });

        const snapScale = Math.max(2, Math.min(window.devicePixelRatio || 2, 3));
        const snaps: Array<ChatSnap | null> = [];
        for (let index = 0; index < snapTargets.length; index += 1) {
            const el = stage.querySelector<HTMLElement>(`[data-capture-snap="${index}"]`);
            const rect = el?.getBoundingClientRect();
            const blob = el && rect?.width && rect.height
                ? await domToBlob(el, {
                    scale: snapScale,
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height),
                    backgroundColor: null,
                    type: "image/png",
                    timeout: 15000,
                    fetchFn,
                    // 气泡、系统提示的 max-width 是百分比，单独截时会按小图自己的宽去算，字就挤折了
                    style: { maxWidth: "none", minWidth: "0", margin: "0" },
                }).catch(() => null)
                : null;
            snaps.push(blob && rect ? { blob, width: Math.round(rect.width), height: Math.round(rect.height) } : null);
        }
        return { canvas, snaps };
    } finally {
        holder.remove();
    }
}

export function chatScreenshotToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => (blob ? resolve(blob) : reject(new Error("图片生成失败"))),
            "image/jpeg",
            0.92,
        );
    });
}
