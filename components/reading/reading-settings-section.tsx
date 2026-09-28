"use client";

import type { ReactNode } from "react";

type Props = {
    icon: ReactNode;
    title: string;
    /** 收起时右边那行小字，一眼看出这块现在是什么设置 */
    summary?: string;
    defaultOpen?: boolean;
    children: ReactNode;
};

/** 阅读设置 / 阅读外观里的一块。默认收起——两个弹窗都长到要翻半天，
 *  平时只需要看见有哪些块，点开再调。 */
export function ReadingSettingsSection({ icon, title, summary, defaultOpen = false, children }: Props) {
    return (
        <details className="reading-fold reading-settings-fold" open={defaultOpen}>
            <summary className="reading-fold-summary">
                <span className="reading-settings-fold-title">
                    {icon}
                    <span>{title}</span>
                </span>
                {summary && <span className="reading-settings-fold-hint">{summary}</span>}
            </summary>
            <div className="reading-fold-body">{children}</div>
        </details>
    );
}
