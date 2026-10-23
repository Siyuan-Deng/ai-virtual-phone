"use client";

// 外观 App 最上面那张卡：日间 / 夜间两台小手机（点了就切），自动切换（按时间 / 跟随系统，直接在卡上调），
// 夜间套装入口。

import { ChevronRight } from "lucide-react";
import {
    loadNightModeState,
    loadNightSet,
    setNightModeManual,
    systemPrefersDark,
    updateNightAuto,
    useNightRevision,
} from "@/lib/night-mode";

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

export function NightModeCard({ onOpenSet }: { onOpenSet: () => void }) {
    useNightRevision();
    const state = loadNightModeState();
    const count = Object.keys(loadNightSet()).length;
    const systemDark = state.auto === "system" ? systemPrefersDark() : null;
    return (
        <div className="menu-group night-card">
            <div className="night-card-modes" role="radiogroup" aria-label="日间还是夜间">
                {([false, true] as const).map((night) => (
                    <button
                        key={night ? "night" : "day"}
                        type="button"
                        role="radio"
                        aria-checked={state.night === night}
                        className="night-card-mode"
                        onClick={() => { if (state.night !== night) setNightModeManual(night); }}
                    >
                        <span className={`night-card-thumb${night ? " is-night" : ""}`} aria-hidden="true">
                            <i /><i /><i />
                        </span>
                        <span className="night-card-mode-label">{night ? "夜间" : "日间"}</span>
                        <span className="night-card-radio" data-on={state.night === night ? "true" : undefined} aria-hidden="true" />
                    </button>
                ))}
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
                        <div className="menu-item night-card-row night-card-time">
                            <label className="night-time-box">
                                <span>开始</span>
                                <input
                                    type="time"
                                    className="night-time-input"
                                    aria-label="夜间开始"
                                    value={state.start}
                                    onChange={(event) => { if (event.target.value) updateNightAuto({ start: event.target.value }); }}
                                />
                            </label>
                            <label className="night-time-box">
                                <span>结束</span>
                                <input
                                    type="time"
                                    className="night-time-input"
                                    aria-label="回到日间"
                                    value={state.end}
                                    onChange={(event) => { if (event.target.value) updateNightAuto({ end: event.target.value }); }}
                                />
                            </label>
                        </div>
                    ) : systemDark === null ? (
                        <div className="menu-item night-card-row">
                            <span className="night-card-warn" role="alert">读不到手机的深浅色，跟随系统用不了</span>
                        </div>
                    ) : null}
                </>
            ) : null}
            <button type="button" className="menu-item night-card-row" onClick={onOpenSet}>
                <span className="menu-label-group">
                    <span className="menu-label">夜间套装</span>
                    <span className="menu-desc">{count ? `已经配了 ${count} 格` : "还没配，夜里和日间一样"}</span>
                </span>
                <span className="menu-right"><ChevronRight size={16} aria-hidden="true" /></span>
            </button>
        </div>
    );
}
