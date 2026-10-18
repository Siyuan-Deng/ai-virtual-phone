// 聊天截图：把选中的几条消息拼成一张「手机截屏」——顶上标题栏，中间这几条，底下输入框和工具栏。
// 用的是聊天页当下真实的 DOM：在屏幕外照原样搭一个台子（同样的 session 类名，美化 CSS 照样生效），
// 再交给 modern-screenshot 画成图。背景按一屏的大小截一块，消息多了往下一块块接上，不会被拉大。

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
};

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
        el.removeAttribute("data-active");
        el.removeAttribute("data-highlight");
    }
    // 输入框里打了一半的字不带上，留占位提示
    root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input").forEach((field) => {
        field.value = "";
        field.textContent = "";
    });
    return root;
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
        if (/^https?:/i.test(src) && !src.startsWith(location.origin)) image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

/** 头像、图片先缩到显示尺寸再嵌进去：同一张头像每条消息都会嵌一份，原图大的话整张图会大到手机画不出来 */
async function shrinkImages(stage: HTMLElement, scale: number): Promise<void> {
    const cache = new Map<string, Promise<string | null>>();
    const shrink = async (src: string, width: number, height: number): Promise<string | null> => {
        const image = await loadImage(src);
        if (!image || !image.naturalWidth || !image.naturalHeight) return null;
        // 等比缩到刚好盖住显示框（裁切交给原来的 object-fit）
        const ratio = Math.min(1, Math.max(width / image.naturalWidth, height / image.naturalHeight));
        if (ratio > 0.8 && src.length < 300_000) return null;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
            return /^data:image\/jpe?g|\.jpe?g(\?|$)/i.test(src)
                ? canvas.toDataURL("image/jpeg", 0.9)
                : canvas.toDataURL("image/png");
        } catch {
            return null; // 跨域图画不出来，原样留着
        }
    };
    await Promise.all(Array.from(stage.querySelectorAll("img")).map(async (img) => {
        const src = img.currentSrc || img.src;
        const rect = img.getBoundingClientRect();
        if (!src || src.startsWith("data:image/svg") || !rect.width || !rect.height) return;
        const width = Math.ceil(rect.width * scale);
        const height = Math.ceil(rect.height * scale);
        const key = `${src}|${width}x${height}`;
        if (!cache.has(key)) cache.set(key, shrink(src, width, height));
        const smaller = await cache.get(key);
        if (smaller) {
            img.removeAttribute("srcset");
            img.src = smaller;
        }
    }));
}

/** 画出截图。台子搭在 wrapper 旁边（继承到的字体、变量都一样），用完就拆 */
export async function renderChatScreenshot(parts: ChatScreenshotParts): Promise<HTMLCanvasElement> {
    const { domToCanvas } = await import("modern-screenshot");
    const { wrapper, header, headerExtras, body, rows, inputBar } = parts;
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
    for (const row of rows) list.appendChild(cleanClone(row.cloneNode(true) as HTMLElement));
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
        const height = Math.ceil(stage.getBoundingClientRect().height);
        const scale = Math.max(1, Math.min(
            window.devicePixelRatio || 2,
            3,
            Math.sqrt(MAX_CANVAS_AREA / (width * height)),
            MAX_CANVAS_SIDE / height,
        ));

        const tile = await domToCanvas(probe, { scale, backgroundColor: baseColor, timeout: 15000 });
        probe.remove();
        force(stage, {
            "background-image": `url(${tile.toDataURL("image/jpeg", 0.92)})`,
            "background-size": `${width}px ${screenHeight}px`,
            "background-repeat": "repeat-y",
            "background-position": "0 0",
            "background-attachment": "scroll",
        });

        await shrinkImages(stage, scale);
        return await domToCanvas(stage, {
            scale,
            width,
            height,
            backgroundColor: baseColor,
            timeout: 15000,
            maximumCanvasSize: MAX_CANVAS_AREA,
        });
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
