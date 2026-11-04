// 自定义开屏的文字动效和舞台。React 不管这里面的 DOM：开屏、编辑器、开屏库缩略图都把一个空 div 交过来。
// 前 16 种动效的参数来自 Moving Letters（Tobias Ahlin，MIT，https://tobiasahlin.com/moving-letters/），
// 改成了用浏览器自带的 Web Animations API，动完停住不循环，不需要 anime.js。

export type SplashTextDir = "h" | "v";
export type SplashMotion = "none" | "fade" | "zoom" | "settle" | "bright";

export type SplashTextLayer = {
    id: string;
    text: string;
    /** 文字块中心的位置，占舞台宽高的百分比 */
    x: number;
    y: number;
    /** 按 390 宽的屏幕算的字号，舞台宽度变了等比缩放 */
    size: number;
    color: string;
    font: string;
    effect: string;
    /** 第几秒开始 */
    start: number;
    dir: SplashTextDir;
    /** 1 = 原速，2 = 两倍速 */
    speed: number;
};

export type SplashStageConfig = {
    bgColor: string;
    motion: SplashMotion;
    /** 压暗，0–70 */
    shade: number;
    texts: SplashTextLayer[];
};

type Split = "char" | "word" | "plain" | "stack";

type Ctx = {
    inner: HTMLElement;
    units: HTMLElement[];
    words: HTMLElement[];
    lines: HTMLElement[];
    fs: number;
    color: string;
    vertical: boolean;
    t0: number;
    pace: number;
    /** 舞台比 390 宽多少 */
    k: number;
    anims: Animation[];
    end: number;
};

export type SplashEffect = {
    id: string;
    name: string;
    split?: Split;
    mask?: boolean;
    run: (c: Ctx) => void;
};

const STAGE_BASE_WIDTH = 390;
const EXPO = "cubic-bezier(.19,1,.22,1)";
const IN_EXPO = "cubic-bezier(.95,.05,.8,.04)";
const IN_OUT = "cubic-bezier(.87,0,.13,1)";
const CIRC = "cubic-bezier(.08,.82,.17,1)";
const QUAD = "cubic-bezier(.45,.03,.52,.96)";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function graphemes(text: string): string[] {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
        return Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text), (part) => part.segment);
    }
    return Array.from(text);
}

function hasCjk(text: string): boolean {
    return /[㐀-鿿぀-ヿ가-힯]/.test(text);
}

/** 拆成词：按空格和标点；中文没有分隔时一个字算一个词 */
function wordsOf(text: string): string[] {
    const parts = text.trim().split(/\s+/).flatMap((part) => part.match(/[^，。、！？；：,.!?;:]+[，。、！？；：,.!?;:]*|[，。、！？；：,.!?;:]+/g) ?? []);
    if (parts.length === 1 && hasCjk(parts[0]) && graphemes(parts[0]).length > 1) return graphemes(parts[0]);
    return parts.length ? parts : [" "];
}

function elastic(t: number): number {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - Math.pow(2, -8.5 * t) * Math.cos(t * Math.PI * 3.2);
}

/** Web Animations 没有弹性缓动，取样成一串关键帧 */
function spring(make: (v: number) => string, steps = 30): Keyframe[] {
    const frames: Keyframe[] = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        frames.push({ transform: make(elastic(t)), offset: t });
    }
    return frames;
}

function animate(c: Ctx, node: Element, frames: Keyframe[], duration: number, delay = 0, easing = "linear", fill: FillMode = "both"): void {
    c.anims.push(node.animate(frames, { duration: duration * c.pace, delay: c.t0 + delay * c.pace, easing, fill }));
    c.end = Math.max(c.end, c.t0 + (delay + duration) * c.pace);
}

/** 字多的时候收紧间隔，整段不超过 1.5 秒 */
function stagger(c: Ctx, base: number): number {
    return Math.min(base, 1500 / Math.max(1, c.units.length - 1));
}

const cross = (c: Ctx, v: string) => (c.vertical ? `translateX(${v})` : `translateY(${v})`);
const along = (c: Ctx, v: string) => (c.vertical ? `translateY(${v})` : `translateX(${v})`);
const stretch = (c: Ctx, v: number) => (c.vertical ? `scaleY(${v})` : `scaleX(${v})`);

function decoLine(c: Ctx, pos: "start" | "end" | "mid"): HTMLElement {
    const line = el("i", "splash-deco");
    const thick = `${Math.max(2, Math.round(c.fs * 0.05))}px`;
    if (c.vertical) {
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = thick;
        if (pos === "start") line.style.right = "-.2em";
        else if (pos === "end") line.style.left = "-.2em";
        else line.style.left = "50%";
    } else {
        line.style.left = "0";
        line.style.right = "0";
        line.style.height = thick;
        if (pos === "start") line.style.top = "-.14em";
        else if (pos === "end") line.style.bottom = "-.14em";
        else line.style.top = "50%";
    }
    line.style.transformOrigin = pos === "mid" ? "50% 50%" : "0 0";
    c.inner.append(line);
    return line;
}

function unitBox(unit: HTMLElement): { x: number; y: number; w: number; h: number } {
    const line = unit.closest<HTMLElement>(".splash-ln");
    const parent = unit.parentElement;
    const box = parent?.classList.contains("splash-um") ? parent : unit;
    return { x: box.offsetLeft + (line?.offsetLeft ?? 0), y: box.offsetTop + (line?.offsetTop ?? 0), w: box.offsetWidth, h: box.offsetHeight };
}

export const SPLASH_EFFECTS: SplashEffect[] = [
    {
        id: "ml1", name: "双线弹入", run(c) {
            const s = stagger(c, 70);
            c.units.forEach((u, i) => animate(c, u, [{ transform: "scale(.3)", opacity: 0 }, { transform: "none", opacity: 1 }], 600, s * (i + 1), EXPO));
            const t = Math.max(0, s * c.units.length + 600 - 875);
            [decoLine(c, "start"), decoLine(c, "end")].forEach((line, i) => animate(c, line, [{ transform: stretch(c, 0), opacity: 0.5 }, { transform: stretch(c, 1), opacity: 1 }], 700, t + 80 * (1 - i), EXPO));
        },
    },
    {
        id: "ml2", name: "由大落定", run(c) {
            const s = stagger(c, 70);
            c.units.forEach((u, i) => animate(c, u, [{ transform: "scale(4)", opacity: 0 }, { transform: "none", opacity: 1 }], 950, s * i, EXPO));
        },
    },
    {
        id: "ml3", name: "逐字浮现", run(c) {
            const s = stagger(c, 130);
            c.units.forEach((u, i) => animate(c, u, [{ opacity: 0 }, { opacity: 1 }], 1500, s * (i + 1), QUAD));
        },
    },
    {
        id: "ml4", name: "逐词闪现", split: "stack", run(c) {
            const n = c.words.length;
            const d = Math.min(1, 3 / n);
            let t = 0;
            c.words.forEach((word, i) => {
                animate(c, word, [{ opacity: 0, transform: "scale(.2)" }, { opacity: 1, transform: "none" }], 700 * d, t, EXPO);
                if (i < n - 1) animate(c, word, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(3)" }], 500 * d, t + 1050 * d, IN_EXPO, "forwards");
                t += 1550 * d;
            });
        },
    },
    {
        id: "ml5", name: "中线分开", run(c) {
            const h = c.vertical ? c.inner.offsetWidth : c.inner.offsetHeight;
            const d = h / 2 + c.fs * 0.08;
            const place = (v: number) => (c.vertical ? `translateX(${v}px) scaleY(1)` : `translateY(${v}px) scaleX(1)`);
            ([-1, 1] as const).forEach((side) => {
                animate(c, decoLine(c, "mid"), [
                    { transform: c.vertical ? "translateX(0) scaleY(0)" : "translateY(0) scaleX(0)", opacity: 0.5, offset: 0, easing: IN_OUT },
                    { transform: place(0), opacity: 1, offset: 0.54, easing: EXPO },
                    { transform: place(side * d), opacity: 1, offset: 1 },
                ], 1300);
            });
            const half = Math.ceil(c.units.length / 2);
            c.units.forEach((u, i) => animate(c, u, [{ transform: along(c, `${i < half ? 0.5 : -0.5}em`), opacity: 0 }, { transform: "none", opacity: 1 }], 700, 760, EXPO));
        },
    },
    {
        id: "ml6", name: "自下升起", mask: true, run(c) {
            const s = stagger(c, 50);
            c.units.forEach((u, i) => animate(c, u, spring((v) => cross(c, `${(1 - v) * 1.3}em`)), 950, s * i));
        },
    },
    {
        id: "ml7", name: "翻转立起", mask: true, run(c) {
            const s = stagger(c, 50);
            c.units.forEach((u, i) => {
                u.style.transformOrigin = "0 100%";
                animate(c, u, [{ transform: "translate(.55em,1.1em) rotate(180deg)" }, { transform: "none" }], 750, s * i, EXPO);
            });
        },
    },
    {
        id: "ml8", name: "圆环绽开", split: "plain", run(c) {
            const box = Math.max(c.inner.offsetWidth, c.inner.offsetHeight) * 1.3 + c.fs;
            const ring = (className: string) => {
                const node = el("i", className);
                node.style.width = node.style.height = `${box}px`;
                node.style.left = node.style.top = "50%";
                node.style.marginLeft = node.style.marginTop = `${-box / 2}px`;
                c.inner.prepend(node);
                return node;
            };
            const flash = ring("splash-ring is-flash");
            const solid = ring("splash-ring");
            const dashed = ring("splash-ring is-dashed");
            animate(c, flash, [{ transform: "scale(0)", opacity: 0.9 }, { transform: "scale(1.5)", opacity: 0 }], 1100, 0, IN_OUT);
            animate(c, solid, [{ transform: "scale(0)" }, { transform: "none" }], 1100, 100, IN_OUT);
            animate(c, dashed, [{ transform: "scale(0)" }, { transform: "scale(1.1)" }], 1100, 420, EXPO);
            c.anims.push(dashed.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 9000, iterations: Infinity, delay: c.t0 }));
            c.lines.forEach((line) => animate(c, line, spring((v) => `scale(${v})`), 1200, 680));
        },
    },
    {
        id: "ml9", name: "弹跳出现", run(c) {
            const s = stagger(c, 45);
            c.units.forEach((u, i) => animate(c, u, spring((v) => `scale(${v})`), 1200, s * (i + 1)));
        },
    },
    {
        id: "ml10", name: "翻牌", run(c) {
            const s = stagger(c, 45);
            c.units.forEach((u, i) => animate(c, u, spring((v) => `perspective(420px) rotateY(${-90 * (1 - v)}deg)`), 1300, s * i));
        },
    },
    {
        id: "ml11", name: "光标扫过", run(c) {
            const length = c.vertical ? c.inner.offsetHeight : c.inner.offsetWidth;
            const bar = el("i", "splash-deco");
            const thick = `${Math.max(2, Math.round(c.fs * 0.05))}px`;
            if (c.vertical) {
                bar.style.left = "0";
                bar.style.right = "0";
                bar.style.top = "0";
                bar.style.height = thick;
            } else {
                bar.style.top = "0";
                bar.style.bottom = "0";
                bar.style.left = "0";
                bar.style.width = thick;
            }
            c.inner.append(bar);
            const move = (v: number) => (c.vertical ? `translateY(${v}px)` : `translateX(${v}px)`);
            animate(c, bar, [
                { transform: `${c.vertical ? "scaleX(0)" : "scaleY(0)"} ${move(0)}`, opacity: 0.5, offset: 0, easing: EXPO },
                { transform: `scale(1) ${move(0)}`, opacity: 1, offset: 0.42, easing: EXPO },
                { transform: `scale(1) ${move(length + 4)}`, opacity: 1, offset: 0.82 },
                { transform: `scale(1) ${move(length + 4)}`, opacity: 0, offset: 1 },
            ], 1700);
            const s = stagger(c, 34);
            c.units.forEach((u, i) => animate(c, u, [{ opacity: 0 }, { opacity: 1 }], 600, 740 + s * (i + 1), EXPO));
        },
    },
    {
        id: "ml12", name: "横向滑入", run(c) {
            const s = stagger(c, 30);
            c.units.forEach((u, i) => animate(c, u, [{ transform: along(c, `${40 * c.k}px`), opacity: 0 }, { transform: "none", opacity: 1 }], 1200, 200 + s * i, EXPO));
        },
    },
    {
        id: "ml13", name: "缓缓上浮", run(c) {
            const s = stagger(c, 30);
            c.units.forEach((u, i) => animate(c, u, [{ transform: cross(c, "1.6em"), opacity: 0 }, { transform: "none", opacity: 1 }], 1400, 100 + s * i, EXPO));
        },
    },
    {
        id: "ml14", name: "划线带出", run(c) {
            animate(c, decoLine(c, "end"), [{ transform: stretch(c, 0), opacity: 0.5 }, { transform: stretch(c, 1), opacity: 1 }], 900, 0, IN_OUT);
            const s = stagger(c, 25);
            c.units.forEach((u, i) => animate(c, u, [{ transform: `${along(c, `${40 * c.k}px`)} ${stretch(c, 0.3)}`, opacity: 0 }, { transform: "none", opacity: 1 }], 800, 450 + s * i, EXPO));
        },
    },
    {
        id: "ml15", name: "逐词砸入", split: "word", run(c) {
            const gap = Math.min(800, 1800 / Math.max(1, c.words.length - 1));
            c.words.forEach((word, i) => animate(c, word, [{ transform: "scale(7)", opacity: 0 }, { transform: "none", opacity: 1 }], 800, gap * i, CIRC));
        },
    },
    {
        id: "ml16", name: "自上落下", mask: true, run(c) {
            const s = stagger(c, 30);
            c.units.forEach((u, i) => animate(c, u, [{ transform: cross(c, "-1.5em") }, { transform: "none" }], 1400, s * i, EXPO));
        },
    },
    {
        id: "type", name: "打字机", run(c) {
            const n = c.units.length;
            if (!n) return;
            const s = stagger(c, 110);
            const caret = el("i", "splash-caret");
            if (c.vertical) {
                caret.style.width = "1em";
                caret.style.height = "2px";
            } else {
                caret.style.width = `${Math.max(2, Math.round(c.fs * 0.06))}px`;
                caret.style.height = "1.15em";
            }
            c.inner.append(caret);
            const place = (x: number, y: number) => `translate(${x}px,${y}px)`;
            const first = unitBox(c.units[0]);
            const frames: Keyframe[] = [{ transform: place(first.x, first.y), offset: 0, easing: "steps(1,end)" }];
            c.units.forEach((u, i) => {
                const box = unitBox(u);
                frames.push({ transform: c.vertical ? place(box.x, box.y + box.h) : place(box.x + box.w, box.y), offset: (i + 1) / n, easing: "steps(1,end)" });
                animate(c, u, [{ opacity: 0 }, { opacity: 1 }], 1, s * i);
            });
            animate(c, caret, frames, Math.max(1, s * n));
            c.anims.push(caret.animate(
                [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }],
                { duration: 640 * c.pace, delay: c.t0 + s * n * c.pace, iterations: 3, fill: "forwards" },
            ));
            c.end = Math.max(c.end, c.t0 + (s * n + 1920) * c.pace);
        },
    },
    {
        id: "blur", name: "模糊聚焦", run(c) {
            const s = stagger(c, 70);
            c.units.forEach((u, i) => animate(c, u, [{ filter: "blur(12px)", opacity: 0, transform: "scale(1.12)" }, { filter: "blur(0)", opacity: 1, transform: "none" }], 1000, s * i, "cubic-bezier(.22,1,.36,1)"));
        },
    },
    {
        id: "track", name: "字距收拢", run(c) {
            c.lines.forEach((line) => {
                const units = Array.from(line.querySelectorAll<HTMLElement>(".splash-u"));
                if (!units.length) return;
                const boxes = units.map(unitBox);
                const last = boxes[boxes.length - 1];
                const start = c.vertical ? boxes[0].y : boxes[0].x;
                const end = c.vertical ? last.y + last.h : last.x + last.w;
                const mid = (start + end) / 2;
                units.forEach((u, i) => {
                    const box = boxes[i];
                    const d = ((c.vertical ? box.y + box.h / 2 : box.x + box.w / 2) - mid) * 0.9;
                    animate(c, u, [{ transform: along(c, `${d}px`), opacity: 0 }, { transform: "none", opacity: 1 }], 1800, 0, EXPO);
                });
            });
        },
    },
    {
        id: "wipe", name: "擦除显现", split: "plain", run(c) {
            c.lines.forEach((line, i) => animate(c, line, c.vertical
                ? [{ clipPath: "inset(0 -.3em 100% -.3em)" }, { clipPath: "inset(0 -.3em 0 -.3em)" }]
                : [{ clipPath: "inset(-.3em 100% -.3em 0)" }, { clipPath: "inset(-.3em 0 -.3em 0)" }], 1200, i * 220, IN_OUT));
        },
    },
    {
        id: "glitch", name: "故障闪烁", split: "plain", run(c) {
            const jitter = [[-4, 2], [5, -1], [-2, -3], [6, 2], [-5, 1], [3, -2], [-2, 1], [1, 0]];
            c.lines.forEach((line) => {
                const frames: Keyframe[] = [{ opacity: 0, offset: 0, easing: "steps(1,end)" }];
                jitter.forEach(([x, y], i) => frames.push({
                    opacity: i % 3 === 1 ? 0.45 : 1,
                    transform: `translate(${x * 0.5}px,${y * 0.4}px)`,
                    textShadow: `${x}px 0 #ff2d55,${-x}px 0 #00e5ff`,
                    offset: (i + 1) / (jitter.length + 1),
                    easing: "steps(1,end)",
                }));
                frames.push({ opacity: 1, transform: "none", textShadow: "0 0 0 transparent", offset: 1 });
                animate(c, line, frames, 1100);
            });
        },
    },
    {
        id: "shine", name: "微光扫过", split: "plain", run(c) {
            c.lines.forEach((line, i) => {
                line.style.backgroundImage = `linear-gradient(105deg,${c.color} 44%,#fff 50%,color-mix(in srgb,${c.color} 28%,transparent) 56%)`;
                line.style.backgroundSize = "320% 100%";
                line.style.webkitBackgroundClip = "text";
                line.style.backgroundClip = "text";
                line.style.webkitTextFillColor = "transparent";
                animate(c, line, [
                    { opacity: 0, backgroundPosition: "100% 0", offset: 0 },
                    { opacity: 1, backgroundPosition: "100% 0", offset: 0.22, easing: "ease-in-out" },
                    { opacity: 1, backgroundPosition: "0% 0", offset: 1 },
                ], 2200, i * 180);
            });
        },
    },
];

const FALLBACK_EFFECT = SPLASH_EFFECTS.find((effect) => effect.id === "blur") ?? SPLASH_EFFECTS[0];

export function findSplashEffect(id: string): SplashEffect {
    return SPLASH_EFFECTS.find((effect) => effect.id === id) ?? FALLBACK_EFFECT;
}

export const SPLASH_BUILTIN_FONTS = [
    { id: "song", name: "宋体", family: '"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",serif', weight: 600 },
    { id: "hei", name: "黑体", family: '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif', weight: 600 },
    { id: "serif", name: "衬线", family: '"Instrument Serif",Georgia,"Songti SC",serif', weight: 400 },
    { id: "mono", name: "等宽", family: '"JetBrains Mono",ui-monospace,Menlo,"PingFang SC",monospace', weight: 400 },
];

/** 上传字体注册到 document.fonts 时用的名字 */
export function splashUploadedFamily(fontId: string): string {
    return `FloatSplashFont-${fontId}`;
}

function fontStyle(fontId: string): { family: string; weight: number } {
    const builtin = SPLASH_BUILTIN_FONTS.find((font) => font.id === fontId);
    if (builtin) return builtin;
    return { family: `"${splashUploadedFamily(fontId)}",${SPLASH_BUILTIN_FONTS[0].family}`, weight: 400 };
}

function buildText(inner: HTMLElement, text: string, effect: SplashEffect): Pick<Ctx, "units" | "words" | "lines"> {
    const lines = text.split("\n").filter((line) => line.trim());
    if (!lines.length) lines.push(" ");
    if (effect.split === "stack") {
        const stack = el("div", "splash-stack");
        const words = lines.flatMap(wordsOf);
        // 闪完停在整句上，不然开屏最后只剩一个字
        if (words.length > 1) words.push(lines.join("\n"));
        words.forEach((word) => {
            const node = el("span", "splash-w");
            node.textContent = word;
            stack.append(node);
        });
        inner.append(stack);
        return { units: [], words: Array.from(stack.children) as HTMLElement[], lines: [stack] };
    }
    const units: HTMLElement[] = [];
    const words: HTMLElement[] = [];
    const lineNodes: HTMLElement[] = [];
    lines.forEach((line) => {
        const node = el("div", "splash-ln");
        lineNodes.push(node);
        inner.append(node);
        if (effect.split === "plain") {
            node.textContent = line;
            return;
        }
        if (effect.split === "word") {
            wordsOf(line).forEach((word, i) => {
                if (i && !hasCjk(word)) node.append(" ");
                const item = el("span", "splash-w");
                item.textContent = word;
                node.append(item);
                words.push(item);
            });
            return;
        }
        graphemes(line).forEach((char) => {
            if (char === " ") {
                const space = el("span", "splash-sp");
                space.innerHTML = "&nbsp;";
                node.append(space);
                return;
            }
            const unit = el("span", "splash-u");
            unit.textContent = char;
            units.push(unit);
            if (effect.mask) {
                const mask = el("span", "splash-um");
                mask.append(unit);
                node.append(mask);
            } else {
                node.append(unit);
            }
        });
    });
    return { units, words, lines: lineNodes };
}

function stageScale(root: HTMLElement): number {
    return (root.clientWidth || STAGE_BASE_WIDTH) / STAGE_BASE_WIDTH;
}

function makeInner(layer: SplashTextLayer, k: number): HTMLElement {
    const inner = el("div", `splash-t-inner${layer.dir === "v" ? " is-vertical" : ""}`);
    const font = fontStyle(layer.font);
    inner.style.fontFamily = font.family;
    inner.style.fontWeight = String(font.weight);
    inner.style.fontSize = `${layer.size * k}px`;
    inner.style.color = layer.color;
    return inner;
}

/** 搭好舞台：背景、压暗、每段文字的空壳（data-text-id）。文字内容由 play / still 填 */
export function buildSplashStage(root: HTMLElement, config: SplashStageConfig, imageUrl: string | null): void {
    root.textContent = "";
    const bg = el("div", "splash-stage-bg");
    bg.style.backgroundColor = config.bgColor;
    if (imageUrl) bg.style.backgroundImage = `url("${imageUrl}")`;
    const shade = el("div", "splash-stage-shade");
    shade.style.opacity = String(config.shade / 100);
    root.append(bg, shade);
    config.texts.forEach((layer) => {
        const host = el("div", "splash-text");
        host.dataset.textId = layer.id;
        host.style.left = `${layer.x}%`;
        host.style.top = `${layer.y}%`;
        root.append(host);
    });
}

/** 图片比开屏开始得晚：到了再铺上去 */
export function applySplashImage(root: HTMLElement, imageUrl: string): void {
    const bg = root.querySelector<HTMLElement>(".splash-stage-bg");
    if (bg) bg.style.backgroundImage = `url("${imageUrl}")`;
}

function hostOf(root: HTMLElement, layerId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-text-id="${CSS.escape(layerId)}"]`);
}

/** 不动，直接画最后的样子：开屏库的缩略图用 */
export function stillSplashStage(root: HTMLElement, config: SplashStageConfig, imageUrl: string | null): void {
    buildSplashStage(root, config, imageUrl);
    const k = stageScale(root);
    config.texts.forEach((layer) => {
        const host = hostOf(root, layer.id);
        if (!host || !layer.text.trim()) return;
        const inner = makeInner(layer, k);
        inner.textContent = layer.text;
        host.append(inner);
    });
}

export type SplashPlayback = { endMs: number; stop: () => void };

/** 舞台已经 build 好：播背景入场和每段文字的动效 */
export function playSplashStage(root: HTMLElement, config: SplashStageConfig): SplashPlayback {
    const k = stageScale(root);
    const anims: Animation[] = [];
    const bg = root.querySelector<HTMLElement>(".splash-stage-bg");
    const push = (frames: Keyframe[], options: KeyframeAnimationOptions) => {
        if (bg) anims.push(bg.animate(frames, { fill: "both", ...options }));
    };
    if (config.motion === "fade") push([{ opacity: 0 }, { opacity: 1 }], { duration: 1400, easing: "ease-out" });
    if (config.motion === "zoom") push([{ transform: "scale(1)" }, { transform: "scale(1.09)" }], { duration: 9000, easing: "cubic-bezier(.2,.6,.3,1)" });
    if (config.motion === "settle") push([{ transform: "scale(1.16)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 2200, easing: EXPO });
    if (config.motion === "bright") push([{ filter: "brightness(.25)" }, { filter: "brightness(1)" }], { duration: 2400, easing: "ease-in-out" });

    let endMs = config.motion === "none" ? 0 : 1400;
    config.texts.forEach((layer) => {
        const host = hostOf(root, layer.id);
        if (!host || !layer.text.trim()) return;
        const effect = findSplashEffect(layer.effect);
        host.textContent = "";
        const inner = makeInner(layer, k);
        const parts = buildText(inner, layer.text, effect);
        host.append(inner);
        const ctx: Ctx = {
            ...parts,
            inner,
            fs: layer.size * k,
            color: layer.color,
            vertical: layer.dir === "v",
            t0: layer.start * 1000,
            pace: 1 / (layer.speed || 1),
            k,
            anims,
            end: 0,
        };
        effect.run(ctx);
        endMs = Math.max(endMs, ctx.end);
    });

    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        anims.forEach((anim) => {
            if (anim.effect?.getComputedTiming().endTime === Infinity) anim.cancel();
            else anim.finish();
        });
        endMs = 0;
    }
    return {
        endMs,
        stop: () => anims.forEach((anim) => {
            try {
                anim.cancel();
            } catch {
                // 已经结束的动画取消不了也没关系
            }
        }),
    };
}
