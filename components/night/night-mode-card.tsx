"use client";

// 外观 App 最上面那张卡：白天 / 夜间两台小手机（点了就切），自动切换开关，夜间套装入口。
// 还有点进「自动切换」以后那一页。

import { ChevronRight, Moon, Sun } from "lucide-react";
import {
    loadNightModeState,
    loadNightSet,
    setNightModeManual,
    systemPrefersDark,
    updateNightAuto,
    useNightRevision,
    type NightAutoKind,
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

export function nightAutoLabel(kind: NightAutoKind, start: string, end: string): string {
    if (kind === "system") return "跟着手机系统";
    return `${start} – ${end}`;
}

export function NightModeCard({ onOpenAuto, onOpenSet }: { onOpenAuto: () => void; onOpenSet: () => void }) {
    useNightRevision();
    const state = loadNightModeState();
    const count = Object.keys(loadNightSet()).length;
    return (
        <div className="menu-group night-card">
            <div className="night-card-modes" role="radiogroup" aria-label="白天还是夜间">
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
                        <span className="night-card-mode-label">
                            {night ? <Moon size={12} aria-hidden="true" /> : <Sun size={12} aria-hidden="true" />}
                            {night ? "夜间" : "白天"}
                        </span>
                        <span className="night-card-radio" data-on={state.night === night ? "true" : undefined} aria-hidden="true" />
                    </button>
                ))}
            </div>
            <div className="menu-item night-card-row">
                <span className="menu-label-group">
                    <span className="menu-label">自动切换</span>
                    <span className="menu-desc">到点自己换</span>
                </span>
                <span className="menu-right">
                    <Switch
                        on={state.auto !== "off"}
                        label="自动切换"
                        onChange={(on) => updateNightAuto({ auto: on ? (state.lastAuto ?? "time") : "off" })}
                    />
                </span>
            </div>
            {state.auto !== "off" ? (
                <button type="button" className="menu-item night-card-row" onClick={onOpenAuto}>
                    <span className="menu-label">{state.auto === "system" ? "方式" : "时间"}</span>
                    <span className="menu-right">
                        <span className="menu-desc">{nightAutoLabel(state.auto, state.start, state.end)}</span>
                        <ChevronRight size={16} aria-hidden="true" />
                    </span>
                </button>
            ) : null}
            <button type="button" className="menu-item night-card-row" onClick={onOpenSet}>
                <span className="menu-label-group">
                    <span className="menu-label">夜间套装</span>
                    <span className="menu-desc">{count ? `已经配了 ${count} 格` : "还没配，夜里和白天一样"}</span>
                </span>
                <span className="menu-right"><ChevronRight size={16} aria-hidden="true" /></span>
            </button>
        </div>
    );
}

export function NightAutoPage() {
    useNightRevision();
    const state = loadNightModeState();
    const systemDark = systemPrefersDark();
    return (
        <div className="night-page">
            <div className="menu-group">
                <button type="button" className="menu-item night-card-row" onClick={() => updateNightAuto({ auto: "time" })}>
                    <span className="night-card-radio" data-on={state.auto === "time" ? "true" : undefined} aria-hidden="true" />
                    <span className="menu-label">按时间</span>
                </button>
                {state.auto === "time" ? (
                    <>
                        <label className="menu-item night-card-row night-time-row">
                            <span className="menu-label">夜间开始</span>
                            <input
                                type="time"
                                className="night-time-input"
                                value={state.start}
                                onChange={(event) => { if (event.target.value) updateNightAuto({ start: event.target.value }); }}
                            />
                        </label>
                        <label className="menu-item night-card-row night-time-row">
                            <span className="menu-label">回到白天</span>
                            <input
                                type="time"
                                className="night-time-input"
                                value={state.end}
                                onChange={(event) => { if (event.target.value) updateNightAuto({ end: event.target.value }); }}
                            />
                        </label>
                    </>
                ) : null}
                <button type="button" className="menu-item night-card-row" onClick={() => updateNightAuto({ auto: "system" })}>
                    <span className="night-card-radio" data-on={state.auto === "system" ? "true" : undefined} aria-hidden="true" />
                    <span className="menu-label-group">
                        <span className="menu-label">跟着手机系统</span>
                        <span className="menu-desc">
                            {systemDark === null
                                ? "这个浏览器读不到手机的深浅色"
                                : `手机切深色模式，这里也切（手机现在是${systemDark ? "深色" : "浅色"}）`}
                        </span>
                    </span>
                </button>
            </div>
            <p className="night-page-note">
                自动开着时手动点了白天 / 夜间，{state.auto === "system" ? "到手机下次切换之前" : "到下一个时间点之前"}听你的；之后照常自动切。
            </p>
        </div>
    );
}
