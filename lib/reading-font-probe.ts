"use client";

/** 探测字体是否在这台设备上真的有效果。
 *
 *  背景：iOS Safari 只把很少几个字体开放给网页，写了 "Kaiti SC" 这种名字，
 *  系统没有就静默回落——CSS 里一切正常，屏幕上却什么都没变。设置里必须
 *  如实告诉用户「这一项在你这台设备上没效果」，否则就是个假开关。
 *
 *  做法：用 canvas 量同一串文字在「目标字体栈」和「系统默认字体」下的宽度。
 *  两者完全一样，就说明这一项在本机跟系统默认没有区别。探测串必须带拉丁字母
 *  和数字——中文是等宽的，只用中文量任何字体宽度都一样，量不出差别。 */
const PROBE_TEXT = "春江花月夜 Reading 123 Wg";
const PROBE_SIZE = 40;

let canvasContext: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
    if (canvasContext !== undefined) return canvasContext;
    try {
        canvasContext = document.createElement("canvas").getContext("2d");
    } catch {
        canvasContext = null;
    }
    return canvasContext;
}

function measure(stack: string): number | null {
    const ctx = getContext();
    if (!ctx) return null;
    ctx.font = `${PROBE_SIZE}px ${stack}`;
    return Math.round(ctx.measureText(PROBE_TEXT).width * 100) / 100;
}

/** 这个字体栈在本机是不是和系统默认长得一模一样（= 选了也白选）。
 *  测不了（没有 canvas、服务端渲染）时返回 false，宁可不提示也不误报。 */
export function isFontStackIneffective(stack: string, baselineStack: string): boolean {
    if (typeof document === "undefined") return false;
    const target = measure(stack);
    const baseline = measure(baselineStack);
    if (target === null || baseline === null) return false;
    return target === baseline;
}
