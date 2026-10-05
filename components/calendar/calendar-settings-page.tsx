"use client";

// 日历设置：原来是「用户日历与备忘录增强」插件在 聊天→设置→扩展插件 里的那张设置表。
// 字段、文案、顺序原样照搬；版式也沿用插件管理页的 PluginSettingRow，
// 外加插件自己对那张表做的两处改动：数字框拉满宽度、节假日颜色换成色板
// （对应节假日没开时整行隐藏）。

import type { ReactNode } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import { normalizeCalendarConfig, type CalendarConfig } from "@/lib/calendar-storage";
import { MEMO_BANNER_COLORS } from "./calendar-tools";

type NumberKey = "nearMinutes" | "futureDays" | "maxEvents";

const BANNER_KEYS = new Set(MEMO_BANNER_COLORS.map((color) => color.key));

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="menu-label">{label}</span>
            {description && <span className="menu-desc">{description}</span>}
            {children}
        </div>
    );
}

function ToggleRow({ label, description, checked, onChange }: {
    label: string;
    description?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="menu-label-group">
                <span className="menu-label">{label}</span>
                {description && <span className="menu-desc">{description}</span>}
            </div>
            <Toggle checked={checked} onChange={onChange} />
        </div>
    );
}

function HolidayColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (key: string) => void }) {
    const current = BANNER_KEYS.has(value) ? value : "auto";
    return (
        <div className="calendar-color-picker caltool-settings-color-picker">
            {MEMO_BANNER_COLORS.map((color) => (
                <button
                    key={color.key}
                    type="button"
                    className={`calendar-color-swatch${color.key === "auto" ? " calendar-color-swatch-auto" : ""}`}
                    data-color={color.key === "auto" ? undefined : color.key}
                    data-active={current === color.key ? "true" : "false"}
                    title={color.label}
                    aria-label={`${label}：${color.label}`}
                    onClick={() => onChange(color.key)}
                >
                    {color.key === "auto" ? "自动" : null}
                </button>
            ))}
        </div>
    );
}

export function CalendarSettingsPage({
    config,
    onChange,
    onBack,
}: {
    config: CalendarConfig;
    onChange: (next: CalendarConfig) => void;
    onBack: () => void;
}) {
    const set = (patch: Partial<CalendarConfig>) => onChange(normalizeCalendarConfig({ ...config, ...patch }));

    const numberField = (key: NumberKey) => (
        <input
            // 失焦才保存，和插件设置页一样；存进去会被夹到合法范围，key 跟着值变好让框里显示夹过的数
            key={`${key}:${config[key]}`}
            className="ui-input caltool-settings-full-input"
            type="number"
            inputMode="numeric"
            defaultValue={config[key]}
            onBlur={(event) => set({ [key]: Number(event.target.value) || 0 } as Partial<CalendarConfig>)}
        />
    );

    return (
        // 日历外壳是 flex 列布局，page-shell 自带 position: relative，直接放进去只会占半屏；
        // 外面套一层铺满的底
        <div className="calendar-settings-layer">
            <PageShell title="日历设置" onBack={onBack}>
                {/* 已经是单独一页了，内容直接铺在页面上，不再垫一层圆角卡片 */}
                <div className="calendar-settings-body">
                    <Row label="角色读取范围">
                        <select
                            className="ui-select"
                            value={config.scope}
                            onChange={(event) => set({ scope: event.target.value as CalendarConfig["scope"] })}
                        >
                            <option value="chat_and_story">聊天 + 群聊 + 剧情</option>
                            <option value="chat_only">仅聊天与群聊</option>
                            <option value="story_only">仅剧情</option>
                        </select>
                    </Row>
                    <Row
                        label="提前提醒分钟数"
                        description="进入日程开始/待办截止前 N 分钟后，每个获准角色只主动提醒一次；全天未完成待办按当天 24:00 计算。0 为关闭，范围 0–1440。"
                    >
                        {numberField("nearMinutes")}
                    </Row>
                    <Row label="读取未来天数" description="今天至未来 N 天，范围 1–31。带截止日期的备忘录待办也使用这个范围。">
                        {numberField("futureDays")}
                    </Row>
                    <Row label="每轮最多日程数" description="限制提示词长度，范围 1–150。">
                        {numberField("maxEvents")}
                    </Row>
                    <Row label="日历每周起始日" description="只调整日历的显示顺序，不改变日程日期。">
                        <select
                            className="ui-select"
                            value={config.weekStartDay}
                            onChange={(event) => set({ weekStartDay: event.target.value === "sunday" ? "sunday" : "monday" })}
                        >
                            <option value="monday">周一</option>
                            <option value="sunday">周日</option>
                        </select>
                    </Row>
                    <ToggleRow
                        label="包含今天已结束日程"
                        checked={config.includePastToday}
                        onChange={(value) => set({ includePastToday: value })}
                    />
                    <ToggleRow
                        label="中国法定节日"
                        description="纯离线按现行法定节日本日与农历计算；不含每年另行公布的调休、补班安排。"
                        checked={config.chinaHolidays}
                        onChange={(value) => set({ chinaHolidays: value })}
                    />
                    <ToggleRow
                        label="Ontario 公共假日"
                        description="纯离线计算 Ontario 九个法定公共假日的实际日期。"
                        checked={config.ontarioHolidays}
                        onChange={(value) => set({ ontarioHolidays: value })}
                    />
                    {config.chinaHolidays ? (
                        <Row label="中国节假日横幅颜色" description="选择中国节假日在日历详情页中的 Banner 颜色。">
                            <HolidayColorPicker
                                label="中国节假日横幅颜色"
                                value={config.chinaHolidayColor}
                                onChange={(key) => set({ chinaHolidayColor: key })}
                            />
                        </Row>
                    ) : null}
                    {config.ontarioHolidays ? (
                        <Row label="Ontario 节假日横幅颜色" description="选择 Ontario 节假日在日历详情页中的 Banner 颜色。">
                            <HolidayColorPicker
                                label="Ontario 节假日横幅颜色"
                                value={config.ontarioHolidayColor}
                                onChange={(key) => set({ ontarioHolidayColor: key })}
                            />
                        </Row>
                    ) : null}
                </div>
            </PageShell>
        </div>
    );
}
