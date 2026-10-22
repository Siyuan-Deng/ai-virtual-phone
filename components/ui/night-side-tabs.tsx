"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { findScheme } from "@/lib/css-scheme-storage";
import { getNightBinding, setNightBinding, useNightActive, useNightRevision } from "@/lib/night-mode";

export type NightSide = "day" | "night";

export type NightDraftState = {
    side: NightSide;
    setSide: (side: NightSide) => void;
    /** 夜间那份的草稿 */
    draft: string;
    setDraft: (value: string) => void;
    /** 夜间那份没动过时，夜里现在用的是什么（给提示用） */
    schemeName: string | null;
    touched: boolean;
    /** 「应用」时调：夜间那份改过就存成单独一份，清空就回到跟白天一样。key 不传就用打开时那个 */
    commit: (key?: string) => void;
};

type DraftState = { key: string; revision: string; draft: string; schemeName: string | null; touched: boolean };

function readNightDraft(slotKey: string, revision: string, pickScheme?: (css: string) => string): DraftState {
    const binding = getNightBinding(slotKey);
    if (binding?.kind === "own") return { key: slotKey, revision, draft: binding.value, schemeName: null, touched: false };
    if (binding?.kind === "scheme") {
        const scheme = findScheme(binding.schemeId);
        const css = scheme?.css ?? "";
        return { key: slotKey, revision, draft: pickScheme ? pickScheme(css) : css, schemeName: scheme?.name ?? null, touched: false };
    }
    return { key: slotKey, revision, draft: "", schemeName: null, touched: false };
}

/** 各 CSS 编辑框的夜间那份：停在现在的模式那一侧（白天 / 夜间切了也跟着换）；格子换了（比如剧情换了角色）就重新读。
 *  pickScheme：方案里存的不是直接能用的那段时（状态栏存的是一整包），从里面取出要的部分 */
export function useNightDraft(slotKey: string, pickScheme?: (css: string) => string): NightDraftState {
    const nightActive = useNightActive();
    const [side, setSide] = useState<NightSide>(nightActive ? "night" : "day");
    useEffect(() => { setSide(nightActive ? "night" : "day"); }, [nightActive]);
    // 夜间套装在别处（总表、小卷）改了，这里还没动过就重新读
    const revision = useNightRevision();
    const [state, setState] = useState(() => readNightDraft(slotKey, revision, pickScheme));
    let current = state;
    if (state.key !== slotKey || (state.revision !== revision && !state.touched)) {
        current = readNightDraft(slotKey, revision, pickScheme);
        setState(current);
    }
    return {
        side,
        setSide,
        draft: current.draft,
        setDraft: (value) => setState((prev) => ({ ...prev, draft: value, touched: true })),
        schemeName: current.schemeName,
        touched: current.touched,
        commit: (key) => {
            if (!current.touched) return;
            setNightBinding(key ?? slotKey, current.draft.trim() ? { kind: "own", value: current.draft } : null);
        },
    };
}

/** 编辑框顶上的「白天 | 夜间」，夜间那侧下面一行说明现在夜里用的是什么 */
export function NightSideTabs({ state, dayValue, nightNote }: { state: NightDraftState; dayValue: string; nightNote?: string }) {
    const { side, setSide, draft, touched, schemeName } = state;
    let hint: React.ReactNode = null;
    if (side === "night") {
        if (!touched && schemeName) {
            hint = <>夜间现在用的是方案「{schemeName}」。在这里改就变成夜间单独一份。</>;
        } else if (!draft.trim()) {
            hint = (
                <>
                    夜间现在跟白天一样。在这里写就是夜间单独一份。
                    {dayValue.trim() ? (
                        <button type="button" className="night-side-copy" onClick={() => state.setDraft(dayValue)}>从白天复制</button>
                    ) : null}
                </>
            );
        } else {
            hint = <>现在改的是夜间那份。清空就是夜里跟白天一样。</>;
        }
    }
    return (
        <div className="night-side">
            <div className="night-side-tabs" role="tablist" aria-label="编辑白天还是夜间那份">
                <button type="button" role="tab" aria-selected={side === "day"} data-on={side === "day" ? "true" : undefined} onClick={() => setSide("day")}>
                    <Sun size={13} aria-hidden="true" />白天
                </button>
                <button type="button" role="tab" aria-selected={side === "night"} data-on={side === "night" ? "true" : undefined} data-night="true" onClick={() => setSide("night")}>
                    <Moon size={13} aria-hidden="true" />夜间
                </button>
            </div>
            {hint ? <div className="night-side-hint">{nightNote ? <>{nightNote}<br /></> : null}{hint}</div> : null}
        </div>
    );
}
