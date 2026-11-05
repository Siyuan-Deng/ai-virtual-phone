"use client";

export const THOUGHT_BUBBLE_PATH = "M7.5 15.5a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 17.2 6.6a4.5 4.5 0 0 1-.2 8.9z";
export const THOUGHT_BUBBLE_DOTS = [[8.5, 19, 1.5], [4.5, 21.5, 0.75]] as const;

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
