"use client";

// 一整朵圆云（一圈六个弧，底下也是鼓的），左下两个小圈
export const THOUGHT_BUBBLE_PATH = "M5.1 8.6A3.11 3.11 0 0 1 9.05 4.18A4.15 4.15 0 0 1 16.95 4.18A3.11 3.11 0 0 1 20.9 8.6A3.26 3.26 0 0 1 16.95 13.02A4.54 4.54 0 0 1 9.05 13.02A3.26 3.26 0 0 1 5.1 8.6z";
export const THOUGHT_BUBBLE_DOTS = [[7.2, 18.9, 1.5], [3.9, 21.5, 0.9]] as const;

/** {{user}}思维链的图标：思考气泡。lucide 没有这个图形，参数和它保持一致 */
export function ThoughtBubbleIcon({ size = 24, strokeWidth = 1.5, color = "currentColor", className }: {
    size?: number;
    strokeWidth?: number;
    color?: string;
    className?: string;
}) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={THOUGHT_BUBBLE_PATH} />
            {THOUGHT_BUBBLE_DOTS.map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}
        </svg>
    );
}
