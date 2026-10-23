"use client";

// 搭配用到的几样小东西：小手机缩略图、「新建搭配 / 编辑搭配」弹窗、挑一套搭配的弹窗。
// 弹窗挂在 .phone-shell 上，样式和配置页里那些格子弹窗（night-sheet）一样。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
    DAY_SET_ID,
    LOOK_SET_COLORS,
    NIGHT_SET_ID,
    activeLookSet,
    createLookSet,
    findLookSet,
    listLookSets,
    updateLookSet,
    type LookSet,
} from "@/lib/night-mode";

export function useSheetHost(): HTMLElement | null {
    const [host, setHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setHost(document.querySelector<HTMLElement>(".phone-shell")); }, []);
    return host;
}

/** 小手机：日间、夜间照原来的样子；自己建的用挑的方案颜色 */
export function LookSetThumb({ set, mini }: { set: LookSet; mini?: boolean }) {
    const className = [
        "night-card-thumb",
        set.id === NIGHT_SET_ID ? "is-night" : "",
        set.builtin ? "" : "is-custom",
        mini ? "is-mini" : "",
    ].filter(Boolean).join(" ");
    return (
        <span className={className} style={set.builtin ? undefined : { ["--look-color" as string]: set.color }} aria-hidden="true">
            <i /><i /><i />
        </span>
    );
}

function Radio({ on }: { on: boolean }) {
    return <span className="night-card-radio" data-on={on ? "true" : undefined} aria-hidden="true" />;
}

const COPY_CHOICES = [
    { id: DAY_SET_ID, label: "复制日间" },
    { id: NIGHT_SET_ID, label: "复制夜间" },
    { id: "current", label: "复制当前" },
] as const;

/** 新建搭配（setId 不传）/ 编辑搭配（改名、换颜色） */
export function LookSetEditSheet({ setId, onClose, onDone }: { setId?: string; onClose: () => void; onDone?: (setId: string) => void }) {
    const host = useSheetHost();
    const editing = setId ? findLookSet(setId) : undefined;
    const [name, setName] = useState(editing?.name ?? "");
    const [color, setColor] = useState(editing?.color ?? LOOK_SET_COLORS[listLookSets().filter((set) => !set.builtin).length % LOOK_SET_COLORS.length]);
    const [copyFrom, setCopyFrom] = useState<string>(DAY_SET_ID);
    const canSave = Boolean(name.trim());

    const save = () => {
        if (!canSave) return;
        if (editing) {
            updateLookSet(editing.id, { name, color });
            onClose();
            onDone?.(editing.id);
            return;
        }
        const id = createLookSet({ name, color, copyFrom: copyFrom === "current" ? activeLookSet() : copyFrom });
        onClose();
        onDone?.(id);
    };

    if (!host) return null;
    return createPortal(
        <div className="night-sheet-overlay" onClick={onClose}>
            <div className="night-sheet" role="dialog" aria-label={editing ? "编辑搭配" : "新建搭配"} onClick={(event) => event.stopPropagation()}>
                <div className="night-sheet-grab" aria-hidden="true" />
                <h4>{editing ? "编辑搭配" : "新建搭配"}</h4>
                <input
                    className="night-sheet-input"
                    value={name}
                    placeholder="名字，比如雨天"
                    maxLength={12}
                    onChange={(event) => setName(event.target.value)}
                />
                {editing ? null : COPY_CHOICES.map((choice) => (
                    <button key={choice.id} type="button" className="night-sheet-choice" onClick={() => setCopyFrom(choice.id)}>
                        <Radio on={copyFrom === choice.id} />
                        <span>{choice.label}</span>
                    </button>
                ))}
                <div className="look-sheet-label">方案颜色：只更改此处预览配色，不影响实际美化</div>
                <div className="look-swatches" role="radiogroup" aria-label="方案颜色">
                    {LOOK_SET_COLORS.map((swatch) => (
                        <button
                            key={swatch}
                            type="button"
                            role="radio"
                            aria-checked={color === swatch}
                            aria-label={swatch}
                            data-on={color === swatch ? "true" : undefined}
                            style={{ background: swatch }}
                            onClick={() => setColor(swatch)}
                        />
                    ))}
                </div>
                <div className="night-sheet-actions">
                    <button type="button" onClick={onClose}>取消</button>
                    <button type="button" data-primary="true" disabled={!canSave} onClick={save}>{editing ? "保存" : "新建"}</button>
                </div>
            </div>
        </div>,
        host,
    );
}

/** 挑一套搭配（自动切换里「开始用哪套」「浅色 / 深色时用哪套」） */
export function LookSetPickSheet({ title, value, onPick, onClose }: { title: string; value: string; onPick: (setId: string) => void; onClose: () => void }) {
    const host = useSheetHost();
    if (!host) return null;
    return createPortal(
        <div className="night-sheet-overlay" onClick={onClose}>
            <div className="night-sheet" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
                <div className="night-sheet-grab" aria-hidden="true" />
                <h4>{title}</h4>
                {listLookSets().map((set) => (
                    <button key={set.id} type="button" className="night-sheet-choice" onClick={() => { onPick(set.id); onClose(); }}>
                        <Radio on={value === set.id} />
                        <span className="look-pick-name"><span className="look-set-dot" style={{ background: set.color }} aria-hidden="true" />{set.name}</span>
                    </button>
                ))}
            </div>
        </div>,
        host,
    );
}
