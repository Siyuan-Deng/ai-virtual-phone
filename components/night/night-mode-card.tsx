"use client";

// 外观 App 最上面那张卡：一排搭配的小手机（点了就换，多了左右滑，最后一个「＋」新建，建好进它的配置页），
// 自动切换（按时间：到几点开始用哪套，可以加好几个时间点；跟随系统：浅色 / 深色各用哪套）。
// 各套的配置页从「管理」进。

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
    DAY_SET_ID,
    findLookSet,
    listLookSets,
    loadNightModeState,
    setActiveLookSet,
    sortPoints,
    systemPrefersDark,
    updateNightAuto,
    useNightRevision,
    type AutoPoint,
} from "@/lib/night-mode";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { LookSetEditSheet, LookSetPickSheet, LookSetThumb } from "./look-set-sheets";

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            className="night-switch"
            data-on={on ? "true" : undefined}
            onClick={(event) => {
                event.stopPropagation();
                onChange(!on);
            }}
        >
            <i aria-hidden="true" />
        </button>
    );
}

/** 「● 雨天 ›」：点了挑一套 */
function SetPickButton({ setId, onClick }: { setId: string; onClick: () => void }) {
    const set = findLookSet(setId) ?? findLookSet(DAY_SET_ID)!;
    return (
        <button type="button" className="look-point-set" onClick={onClick}>
            <span className="look-set-dot" style={{ background: set.color }} aria-hidden="true" />
            <span>{set.name}</span>
            <ChevronRight size={15} aria-hidden="true" />
        </button>
    );
}

/** 新加的时间点挑一个还没用过的整点，从中午往后找 */
function freeTime(points: AutoPoint[]): string {
    const used = new Set(points.map((point) => point.time));
    for (let step = 0; step < 24; step += 1) {
        const time = `${String((12 + step) % 24).padStart(2, "0")}:00`;
        if (!used.has(time)) return time;
    }
    return "12:00";
}

type Picking = { kind: "point"; index: number } | { kind: "light" } | { kind: "dark" };

export function NightModeCard({ onOpenSet }: { onOpenSet: (setId: string) => void }) {
    useNightRevision();
    const [creating, setCreating] = useState(false);
    const [picking, setPicking] = useState<Picking | null>(null);
    const swipe = useSwipeActions(62);
    const state = loadNightModeState();
    const sets = listLookSets();
    const points = sortPoints(state.points);
    const systemDark = state.auto === "system" ? systemPrefersDark() : null;

    const savePoints = (next: AutoPoint[]) => updateNightAuto({ points: sortPoints(next) });
    const pickValue = picking?.kind === "point" ? points[picking.index]?.set ?? DAY_SET_ID
        : picking?.kind === "light" ? state.systemLight
            : picking?.kind === "dark" ? state.systemDark : DAY_SET_ID;

    return (
        <div className="menu-group night-card">
            <div className="look-strip">
                <div className="look-strip-inner" role="radiogroup" aria-label="用哪套搭配">
                    {sets.map((set) => (
                        <button
                            key={set.id}
                            type="button"
                            role="radio"
                            aria-checked={state.active === set.id}
                            className="night-card-mode"
                            onClick={() => { if (state.active !== set.id) setActiveLookSet(set.id); }}
                        >
                            <LookSetThumb set={set} />
                            <span className="night-card-mode-label">{set.name}</span>
                            <span className="night-card-radio" data-on={state.active === set.id ? "true" : undefined} aria-hidden="true" />
                        </button>
                    ))}
                    <button type="button" className="night-card-mode" onClick={() => setCreating(true)}>
                        <span className="night-card-thumb look-thumb-add" aria-hidden="true">+</span>
                        <span className="night-card-mode-label">新建</span>
                        <span className="night-card-radio look-radio-blank" aria-hidden="true" />
                    </button>
                </div>
            </div>
            <div className="menu-item night-card-row">
                <span className="menu-label">自动切换</span>
                <span className="menu-right">
                    <Switch
                        on={state.auto !== "off"}
                        label="自动切换"
                        onChange={(on) => updateNightAuto({ auto: on ? (state.lastAuto ?? "time") : "off" })}
                    />
                </span>
            </div>
            {state.auto !== "off" ? (
                <>
                    <div className="menu-item night-card-row">
                        <div className="night-card-seg" role="radiogroup" aria-label="怎么自动切换">
                            {(["time", "system"] as const).map((kind) => (
                                <button
                                    key={kind}
                                    type="button"
                                    role="radio"
                                    aria-checked={state.auto === kind}
                                    data-on={state.auto === kind ? "true" : undefined}
                                    onClick={() => { if (state.auto !== kind) updateNightAuto({ auto: kind }); }}
                                >
                                    {kind === "time" ? "按时间" : "跟随系统"}
                                </button>
                            ))}
                        </div>
                    </div>
                    {state.auto === "time" ? (
                        <div className="menu-item night-card-row look-points">
                            {points.map((point, index) => (
                                <SwipeActionRow
                                    key={`${index}:${point.time}`}
                                    controller={swipe}
                                    id={`point-${index}`}
                                    disabled={points.length <= 1}
                                    actions={(
                                        <button
                                            type="button"
                                            className="ui-swipe-action"
                                            data-variant="delete"
                                            onClick={() => { swipe.close(); savePoints(points.filter((_, i) => i !== index)); }}
                                        >
                                            删除
                                        </button>
                                    )}
                                >
                                    <div className="look-point">
                                        {/* 滚轮转的时候不存（一存就重新排序，行会跳走），收起来再存 */}
                                        <input
                                            type="time"
                                            className="look-point-time"
                                            aria-label="时间点"
                                            defaultValue={point.time}
                                            onBlur={(event) => {
                                                const time = event.target.value;
                                                if (time && time !== point.time) savePoints(points.map((item, i) => (i === index ? { ...item, time } : item)));
                                            }}
                                        />
                                        <span className="look-point-to">开始用</span>
                                        <SetPickButton setId={point.set} onClick={() => setPicking({ kind: "point", index })} />
                                    </div>
                                </SwipeActionRow>
                            ))}
                            <button
                                type="button"
                                className="look-point look-point-add"
                                onClick={() => savePoints([...points, { time: freeTime(points), set: DAY_SET_ID }])}
                            >
                                ＋ 添加时间点
                            </button>
                        </div>
                    ) : (
                        <>
                            {systemDark === null ? (
                                <div className="menu-item night-card-row">
                                    <span className="night-card-warn" role="alert">读不到手机的深浅色，跟随系统用不了</span>
                                </div>
                            ) : null}
                            <div className="menu-item night-card-row look-points">
                                <div className="look-point">
                                    <span className="look-point-to look-point-lead">浅色时用</span>
                                    <SetPickButton setId={state.systemLight} onClick={() => setPicking({ kind: "light" })} />
                                </div>
                                <div className="look-point">
                                    <span className="look-point-to look-point-lead">深色时用</span>
                                    <SetPickButton setId={state.systemDark} onClick={() => setPicking({ kind: "dark" })} />
                                </div>
                            </div>
                        </>
                    )}
                </>
            ) : null}

            {creating ? <LookSetEditSheet onClose={() => setCreating(false)} onDone={onOpenSet} /> : null}
            {picking ? (
                <LookSetPickSheet
                    title={picking.kind === "point" ? `${points[picking.index]?.time ?? ""} 开始用哪套` : picking.kind === "light" ? "浅色时用哪套" : "深色时用哪套"}
                    value={pickValue}
                    onClose={() => setPicking(null)}
                    onPick={(setId) => {
                        if (picking.kind === "point") savePoints(points.map((item, i) => (i === picking.index ? { ...item, set: setId } : item)));
                        else if (picking.kind === "light") updateNightAuto({ systemLight: setId });
                        else updateNightAuto({ systemDark: setId });
                    }}
                />
            ) : null}
        </div>
    );
}
