"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { findScheme } from "@/lib/css-scheme-storage";
import {
    DAY_SET_ID,
    NIGHT_SET_ID,
    defaultEditSet,
    getNightBinding,
    listLookSets,
    lookSetName,
    setNightBinding,
    useActiveLookSet,
    useNightRevision,
} from "@/lib/night-mode";

/** day = 日间那份；night = 「日间模式」右边那套搭配的那份（是哪套看 target） */
export type NightSide = "day" | "night";

export type NightDraftState = {
    side: NightSide;
    setSide: (side: NightSide) => void;
    /** 右边那个选的是哪套搭配 */
    target: string;
    setTarget: (setId: string) => void;
    /** 那套搭配那份的草稿 */
    draft: string;
    setDraft: (value: string) => void;
    /** 那份没动过时，那套现在用的是哪个方案（给提示用） */
    schemeName: string | null;
    touched: boolean;
    /** 「应用」时调：改过就存成那套单独一份，清空就回到跟随日间。key 不传就用打开时那个 */
    commit: (key?: string) => void;
};

type DraftState = { key: string; target: string; revision: number; draft: string; schemeName: string | null; touched: boolean };

function readNightDraft(slotKey: string, target: string, revision: number, pickScheme?: (css: string) => string): DraftState {
    const binding = getNightBinding(slotKey, target);
    const base = { key: slotKey, target, revision, touched: false };
    if (binding?.kind === "own") return { ...base, draft: binding.value, schemeName: null };
    if (binding?.kind === "scheme") {
        const scheme = findScheme(binding.schemeId);
        const css = scheme?.css ?? "";
        return { ...base, draft: pickScheme ? pickScheme(css) : css, schemeName: scheme?.name ?? null };
    }
    return { ...base, draft: "", schemeName: null };
}

/** 各 CSS 编辑框里某套搭配那份：停在现在用的那套那一侧（换搭配了也跟着换）；格子或者选的那套换了就重新读。
 *  pickScheme：方案里存的不是直接能用的那段时（状态栏存的是一整包），从里面取出要的部分 */
export function useNightDraft(slotKey: string, pickScheme?: (css: string) => string): NightDraftState {
    const [side, setSide, target, setTarget] = useNightSide();
    // 搭配在别处（总表、小卷）改了，这里还没动过就重新读
    const revision = useNightRevision();
    const [state, setState] = useState(() => readNightDraft(slotKey, target, revision, pickScheme));
    let current = state;
    if (state.key !== slotKey || state.target !== target || (state.revision !== revision && !state.touched)) {
        current = readNightDraft(slotKey, target, revision, pickScheme);
        setState(current);
    }
    return {
        side,
        setSide,
        target,
        setTarget,
        draft: current.draft,
        setDraft: (value) => setState((prev) => ({ ...prev, draft: value, touched: true })),
        schemeName: current.schemeName,
        touched: current.touched,
        commit: (key) => {
            if (!current.touched) return;
            setNightBinding(key ?? slotKey, current.draft.trim() ? { kind: "own", value: current.draft } : null, current.target);
        },
    };
}

/** 编辑框顶上的「日间模式 | 某套 ▾」，右边那侧下面一行说明那套现在用的是什么 */
export function NightSideTabs({ state, dayValue, nightNote, hideSwitch }: {
    state: NightDraftState;
    dayValue: string;
    nightNote?: string;
    /** 切换条已经放在别处（日历、剧情的主题面板顶上），这里只要说明那一行 */
    hideSwitch?: boolean;
}) {
    const { side, setSide, target, setTarget, draft, touched, schemeName } = state;
    const name = lookSetName(target);
    let hint: React.ReactNode = null;
    if (side === "night") {
        if (!touched && schemeName) {
            hint = <>{name}现在用的是方案「{schemeName}」。在这里改就变成{name}单独一份。</>;
        } else if (!draft.trim()) {
            hint = (
                <>
                    {name}现在跟随日间。在这里写就是{name}单独一份。
                    {dayValue.trim() ? (
                        <button type="button" className="night-side-copy" onClick={() => state.setDraft(dayValue)}>从日间复制</button>
                    ) : null}
                </>
            );
        } else {
            hint = <>现在改的是{name}那份。清空就是{name}跟随日间。</>;
        }
    }
    if (hideSwitch) return hint ? <div className="night-side-hint night-side-hint-alone">{nightNote ? <>{nightNote}<br /></> : null}{hint}</div> : null;
    return (
        <div className="night-side">
            <NightSideSwitch side={side} onChange={setSide} target={target} onTarget={setTarget} />
            {hint ? <div className="night-side-hint">{nightNote ? <>{nightNote}<br /></> : null}{hint}</div> : null}
        </div>
    );
}

/** 「日间模式 | 某套 ▾」这一条：右边那个在另一侧时点一下切过来，已经在它这侧时点开挑别的搭配 */
export function NightSideSwitch({ side, onChange, target, onTarget }: {
    side: NightSide;
    onChange: (side: NightSide) => void;
    target: string;
    onTarget: (setId: string) => void;
}) {
    useNightRevision();
    const [menuOpen, setMenuOpen] = useState(false);
    const sets = listLookSets().filter((set) => set.id !== DAY_SET_ID);
    const canPick = sets.length > 1;
    return (
        <div className="night-side-tabs" role="tablist" aria-label="编辑日间还是哪套搭配那份">
            <button type="button" role="tab" aria-selected={side === "day"} data-on={side === "day" ? "true" : undefined} onClick={() => onChange("day")}>
                日间模式
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={side === "night"}
                aria-haspopup={canPick ? "menu" : undefined}
                data-on={side === "night" ? "true" : undefined}
                data-night="true"
                onClick={() => {
                    if (side !== "night") onChange("night");
                    else if (canPick) setMenuOpen((open) => !open);
                }}
            >
                {target === NIGHT_SET_ID ? "夜间模式" : lookSetName(target)}
                {canPick ? <ChevronDown size={13} aria-hidden="true" /> : null}
            </button>
            {menuOpen ? (
                <>
                    <button type="button" className="night-side-menu-scrim" aria-label="收起" onClick={() => setMenuOpen(false)} />
                    <div className="night-side-menu" role="menu">
                        {sets.map((set) => (
                            <button
                                key={set.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={set.id === target}
                                onClick={() => { onTarget(set.id); setMenuOpen(false); }}
                            >
                                <span className="look-set-dot" style={{ background: set.color }} aria-hidden="true" />
                                <span>{set.name}</span>
                                {set.id === target ? <span className="night-side-menu-check" aria-hidden="true">✓</span> : null}
                            </button>
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
}

/** 停在现在用的那套那一侧，换搭配了也跟着换；右边那个默认现在用的那套，用日间时默认夜间 */
export function useNightSide(): [NightSide, (side: NightSide) => void, string, (setId: string) => void] {
    const active = useActiveLookSet();
    const [side, setSide] = useState<NightSide>(active === DAY_SET_ID ? "day" : "night");
    const [target, setTarget] = useState(() => defaultEditSet());
    useEffect(() => {
        setSide(active === DAY_SET_ID ? "day" : "night");
        setTarget(defaultEditSet());
    }, [active]);
    return [side, setSide, target, setTarget];
}
