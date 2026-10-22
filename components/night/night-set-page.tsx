"use client";

// 外观 → 夜间套装：所有能配夜间那份的格子都在这一页，点一格从底下弹出来挑夜里用什么。
// 和各编辑框顶上的「白天 | 夜间」存的是同一份（lib/night-mode 的夜间套装）。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Moon } from "lucide-react";
import { getSchemes, findScheme } from "@/lib/css-scheme-storage";
import { getNightBinding, loadNightSet, nightSlotKeys, setNightBinding, useNightRevision, type NightBinding } from "@/lib/night-mode";
import { NIGHT_THEME_GROUP_LABELS, NIGHT_THEME_GROUPS, type NightThemeGroup } from "@/lib/night-theme";
import { loadChatSessions } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadStorySessions } from "@/lib/story-storage";
import { loadRegexes } from "@/lib/settings-storage";
import { getStatusRegionConfig, STATUS_REGION_SCHEME_TARGET } from "@/lib/chat-status-region";
import { loadMascotSettings } from "@/lib/mascot-settings";
import { loadReadingCustomCss } from "@/lib/reading-custom-css";
import { readThemeProfile } from "@/lib/theme-storage";
import { kvGet } from "@/lib/kv-db";

/** theme：不在这里写，切到夜间以后在原来的地方改（外观、聊天背景、剧情显示选项） */
type SlotKind = "css" | "theme" | "status" | "regex";

type SlotRow = {
    key: string;
    label: string;
    /** 名字前面的小方块（角色名第一个字） */
    badge?: string;
    kind: SlotKind;
    /** 存过的方案按这个分类（CSSSchemeBar 的 target） */
    schemeTarget?: string;
    /** 白天那份：「从白天复制」、状态栏比对提示词用 */
    dayValue?: () => string;
    /** 状态栏：白天那份要 AI 输出什么，换方案时比一比 */
    dayContract?: string;
    /** theme 类：去哪里改夜间那份 */
    where?: string;
};

type SlotGroup = { title: string; rows: SlotRow[]; batch?: { label: string; kind: SlotKind; schemeTarget?: string } };

function statusSchemeParts(css: string): { contract: string; renderHtml: string } {
    try {
        const parsed = JSON.parse(css) as { contract?: unknown; renderHtml?: unknown };
        return {
            contract: typeof parsed.contract === "string" ? parsed.contract : "",
            renderHtml: typeof parsed.renderHtml === "string" ? parsed.renderHtml : "",
        };
    } catch {
        return { contract: "", renderHtml: "" };
    }
}

/** 正则会不会影响显示：有 AI 输出位置、不是只进提示词的规则 */
function regexAffectsDisplay(rules: { placement: number[]; promptOnly?: boolean; disabled: boolean }[]): boolean {
    return rules.some((rule) => !rule.disabled && rule.placement?.includes(2) && !rule.promptOnly);
}

function buildGroups(): SlotGroup[] {
    const characters = loadCharacters();
    const nameOf = (id: string) => characters.find((character) => character.id === id)?.name || "";
    const theme = readThemeProfile();

    const themeRows: SlotRow[] = (Object.keys(NIGHT_THEME_GROUPS) as NightThemeGroup[]).map((group) => (
        group === "theme.css"
            ? { key: group, label: NIGHT_THEME_GROUP_LABELS[group], kind: "css", schemeTarget: "global", dayValue: () => theme.globalCustomCSS || "" }
            : { key: group, label: NIGHT_THEME_GROUP_LABELS[group], kind: "theme", where: "在外观里改这一项" }
    ));

    const sessions = loadChatSessions();
    const chatRows: SlotRow[] = [{
        key: nightSlotKeys.chatApp, label: "聊天 App 全局 CSS", kind: "css", schemeTarget: "chat_app",
        dayValue: () => kvGet("chat-app-custom-css") || "",
    }];
    for (const session of sessions) {
        const name = session.isGroup ? (session.groupName || "群聊") : (session.alias || nameOf(session.contactId) || "聊天");
        chatRows.push({
            key: nightSlotKeys.chatSession(session.id), label: `${name} · 聊天窗 CSS`, badge: name.slice(0, 1), kind: "css",
            schemeTarget: "chat_session", dayValue: () => session.customCSS || "",
        });
        // 聊天背景：白天有图、或者夜间已经换过的才列出来，免得一长串
        if (session.backgroundImage || getNightBinding(nightSlotKeys.chatBg(session.id))) {
            chatRows.push({
                key: nightSlotKeys.chatBg(session.id), label: `${name} · 聊天背景`, badge: name.slice(0, 1), kind: "theme",
                where: "在聊天信息里换聊天背景",
            });
        }
        const status = getStatusRegionConfig(session.id);
        if (status.mode === "custom" && status.renderHtml.trim()) {
            chatRows.push({
                key: nightSlotKeys.chatStatus(session.id), label: `${name} · 状态栏`, badge: name.slice(0, 1), kind: "status",
                schemeTarget: STATUS_REGION_SCHEME_TARGET, dayValue: () => status.renderHtml, dayContract: status.contract,
            });
        }
    }

    const storySessions = loadStorySessions();
    const storyRows: SlotRow[] = storySessions.flatMap((session): SlotRow[] => {
        const name = nameOf(session.characterId) || "剧情";
        const part = session.kind === "extra" ? "番外" : "正篇";
        const main = session.kind === "extra" ? storySessions.find((item) => item.characterId === session.characterId && item.kind !== "extra") : undefined;
        return [
            {
                key: nightSlotKeys.story(session.id), label: `${name} · ${part} CSS`, badge: name.slice(0, 1),
                kind: "css", schemeTarget: "story", dayValue: () => session.customCSS ?? main?.customCSS ?? "",
            },
            {
                key: nightSlotKeys.storyLook(session.id), label: `${name} · ${part}显示选项`, badge: name.slice(0, 1),
                kind: "theme", where: "在剧情侧栏的显示选项里改（主题、背景、文字颜色、纸张、字体）",
            },
        ];
    });

    const otherRows: SlotRow[] = [
        { key: nightSlotKeys.calendarTheme, label: "日历主题", kind: "theme", where: "在日历的主题面板里选" },
        { key: nightSlotKeys.calendar, label: "日历 CSS", kind: "css", schemeTarget: "calendar", dayValue: () => kvGet("calendar-custom-css") || "" },
        { key: nightSlotKeys.music, label: "音乐 CSS", kind: "css", schemeTarget: "music", dayValue: () => kvGet("music-custom-css") || "" },
        { key: nightSlotKeys.reading, label: "阅读 CSS", kind: "css", schemeTarget: "reading", dayValue: () => loadReadingCustomCss() },
        { key: nightSlotKeys.mascot, label: "小卷聊天 CSS", kind: "css", schemeTarget: "chat_session", dayValue: () => loadMascotSettings().chatCustomCSS || "" },
    ];

    const regexRows: SlotRow[] = loadRegexes()
        .filter((regex) => regexAffectsDisplay(regex.rules))
        .map((regex) => ({ key: nightSlotKeys.regex(regex.id), label: regex.name || "未命名正则", kind: "regex" as const }));

    const groups: SlotGroup[] = [
        { title: "外观（全局）", rows: themeRows },
        { title: "聊天", rows: chatRows, batch: { label: "全部聊天窗设成…", kind: "css", schemeTarget: "chat_session" } },
        { title: "剧情", rows: storyRows, batch: storyRows.filter((row) => row.kind === "css").length > 1 ? { label: "全部 CSS 设成…", kind: "css", schemeTarget: "story" } : undefined },
        { title: "其他 App", rows: otherRows },
        { title: "正则（只换显示）", rows: regexRows },
    ];
    return groups.filter((group) => group.rows.length > 0);
}

function bindingChip(binding: NightBinding | undefined): { text: string; tone: "same" | "scheme" | "own" } {
    if (!binding) return { text: "跟白天", tone: "same" };
    if (binding.kind === "own") return { text: "单独一份", tone: "own" };
    if (binding.kind === "scheme") return { text: findScheme(binding.schemeId)?.name || "方案已删", tone: "scheme" };
    const target = loadRegexes().find((regex) => regex.id === binding.targetId);
    return { text: `换成「${target?.name || "已删"}」`, tone: "scheme" };
}

export function NightSetPage() {
    useNightRevision();
    const [groups, setGroups] = useState<SlotGroup[]>(() => buildGroups());
    const [editing, setEditing] = useState<{ row: SlotRow; keys: string[] } | null>(null);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    useEffect(() => { setPortalTarget(document.querySelector<HTMLElement>(".phone-shell")); }, []);
    const set = loadNightSet();
    const count = Object.keys(set).length;

    return (
        <div className="night-page">
            <div className="night-set-summary">
                <Moon size={20} aria-hidden="true" />
                <span>
                    <b>夜间套装</b>
                    {count ? `切到夜间时换 ${count} 格，没配的夜里跟白天一样` : "还没配，夜里和白天一样"}
                </span>
            </div>
            {groups.map((group) => (
                <section key={group.title} className="night-set-group">
                    <div className="night-set-group-head">
                        <h3 className="appearance-menu-section-title">{group.title}</h3>
                        {group.batch ? (
                            <button
                                type="button"
                                onClick={() => {
                                    const rows = group.rows.filter((row) => row.schemeTarget === group.batch?.schemeTarget);
                                    setEditing({
                                        row: { key: "", label: group.batch!.label.replace("…", ""), kind: group.batch!.kind, schemeTarget: group.batch!.schemeTarget },
                                        keys: rows.map((row) => row.key),
                                    });
                                }}
                            >
                                {group.batch.label}
                            </button>
                        ) : null}
                    </div>
                    <div className="menu-group">
                        {group.rows.map((row) => {
                            const chip = bindingChip(set[row.key]);
                            return (
                                <button key={row.key} type="button" className="menu-item night-card-row" onClick={() => setEditing({ row, keys: [row.key] })}>
                                    {row.badge ? <span className="night-set-badge" aria-hidden="true">{row.badge}</span> : null}
                                    <span className="menu-label night-set-label">{row.label}</span>
                                    <span className="menu-right">
                                        <span className="night-set-chip" data-tone={chip.tone}>{chip.text}</span>
                                        <ChevronRight size={16} aria-hidden="true" />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            ))}
            {editing && portalTarget ? createPortal(
                <NightSlotSheet
                    row={editing.row}
                    keys={editing.keys}
                    onClose={() => {
                        setEditing(null);
                        setGroups(buildGroups());
                    }}
                />,
                portalTarget,
            ) : null}
        </div>
    );
}

type Choice = "same" | "scheme" | "own" | "swap";

function NightSlotSheet({ row, keys, onClose }: { row: SlotRow; keys: string[]; onClose: () => void }) {
    const single = keys.length === 1 ? getNightBinding(keys[0]) : undefined;
    const [choice, setChoice] = useState<Choice>(() => (single ? (single.kind as Choice) : "same"));
    const [schemeId, setSchemeId] = useState(single?.kind === "scheme" ? single.schemeId : "");
    const [targetId, setTargetId] = useState(single?.kind === "swap" ? single.targetId : "");
    const [ownText, setOwnText] = useState(single?.kind === "own" ? single.value : "");
    const schemes = row.schemeTarget ? getSchemes(row.schemeTarget) : [];
    const regexes = row.kind === "regex" ? loadRegexes().filter((regex) => nightSlotKeys.regex(regex.id) !== row.key) : [];
    const ownLabel = row.kind === "status" ? "夜间单独一份（渲染代码）" : "夜间单独一份";

    // 状态栏：挑的方案要 AI 输出的东西和白天那份不一样，夜里可能显示不全
    const schemeMismatch = row.kind === "status" && choice === "scheme" && schemeId
        ? (() => {
            const scheme = schemes.find((item) => item.id === schemeId);
            const contract = scheme ? statusSchemeParts(scheme.css).contract.trim() : "";
            return Boolean(contract && row.dayContract !== undefined && contract !== row.dayContract.trim());
        })()
        : false;

    const canSave =
        choice === "same" ||
        (choice === "scheme" && Boolean(schemeId)) ||
        (choice === "swap" && Boolean(targetId)) ||
        (choice === "own" && (row.kind === "theme" ? single?.kind === "own" : Boolean(ownText.trim())));

    const save = () => {
        let binding: NightBinding | null = null;
        if (choice === "scheme") binding = { kind: "scheme", schemeId };
        if (choice === "swap") binding = { kind: "swap", targetId };
        if (choice === "own") binding = row.kind === "theme" ? (single ?? null) : { kind: "own", value: ownText };
        for (const key of keys) setNightBinding(key, binding);
        onClose();
    };

    return (
        <div className="night-sheet-overlay" onClick={onClose}>
            <div className="night-sheet" role="dialog" aria-label={`${row.label} 夜间用什么`} onClick={(event) => event.stopPropagation()}>
                <div className="night-sheet-grab" aria-hidden="true" />
                <h4>{row.label}</h4>
                <div className="night-sheet-sub">
                    {keys.length > 1 ? `一起设 ${keys.length} 格，夜间用什么` : "夜间用什么"}
                </div>

                <button type="button" className="night-sheet-choice" onClick={() => setChoice("same")}>
                    <span className="night-card-radio" data-on={choice === "same" ? "true" : undefined} aria-hidden="true" />
                    <span>跟白天一样<small>夜里不换</small></span>
                </button>

                {row.kind === "regex" ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("swap")}>
                            <span className="night-card-radio" data-on={choice === "swap" ? "true" : undefined} aria-hidden="true" />
                            <span>夜里换成另一个正则<small>只换显示效果，不改发给 AI 的提示词</small></span>
                        </button>
                        {choice === "swap" ? (
                            <div className="night-sheet-chips">
                                {regexes.length ? regexes.map((regex) => (
                                    <button key={regex.id} type="button" data-on={targetId === regex.id ? "true" : undefined} onClick={() => setTargetId(regex.id)}>
                                        {regex.name || "未命名正则"}
                                    </button>
                                )) : <span className="night-sheet-empty">还没有别的正则可换</span>}
                            </div>
                        ) : null}
                        {choice === "swap" ? (
                            <div className="night-sheet-warn">如果两个正则要的状态栏写法（提示词里让 AI 输出的格式）不一样，夜里可能显示不对。</div>
                        ) : null}
                    </>
                ) : null}

                {row.schemeTarget ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("scheme")}>
                            <span className="night-card-radio" data-on={choice === "scheme" ? "true" : undefined} aria-hidden="true" />
                            <span>
                                {row.kind === "status" ? "用存过的状态栏方案的长相" : "用存过的方案"}
                                <small>{row.kind === "status" ? "只换渲染，AI 照白天的格式输出" : "就是编辑框左下角「存方案」存的"}</small>
                            </span>
                        </button>
                        {choice === "scheme" ? (
                            <div className="night-sheet-chips">
                                {schemes.length ? schemes.map((scheme) => (
                                    <button key={scheme.id} type="button" data-on={schemeId === scheme.id ? "true" : undefined} onClick={() => setSchemeId(scheme.id)}>
                                        {scheme.name}
                                    </button>
                                )) : <span className="night-sheet-empty">这一类还没存过方案</span>}
                            </div>
                        ) : null}
                        {schemeMismatch ? (
                            <div className="night-sheet-warn">这个方案要 AI 输出的字段和白天那份不一样，夜里可能有几项是空的。</div>
                        ) : null}
                    </>
                ) : null}

                {row.kind !== "regex" ? (
                    <button type="button" className="night-sheet-choice" onClick={() => setChoice("own")}>
                        <span className="night-card-radio" data-on={choice === "own" ? "true" : undefined} aria-hidden="true" />
                        <span>
                            {ownLabel}
                            <small>
                                {row.kind === "theme"
                                    ? (single?.kind === "own" ? `已经有一份了；切到夜间，${row.where ?? "在原来的地方改"}就是改它` : `切到夜间，${row.where ?? "在原来的地方改"}，就是夜间单独一份`)
                                    : "在这里写，或者回到原来的编辑框，切到「夜间」写"}
                            </small>
                        </span>
                    </button>
                ) : null}
                {choice === "own" && row.kind !== "theme" ? (
                    <div className="night-sheet-own">
                        <textarea
                            value={ownText}
                            onChange={(event) => setOwnText(event.target.value)}
                            placeholder={row.kind === "status" ? "夜间用的状态栏渲染代码（HTML）" : "夜间用的 CSS"}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                        />
                        {keys.length === 1 && row.dayValue && row.dayValue().trim() ? (
                            <button type="button" className="night-side-copy" onClick={() => setOwnText(row.dayValue!())}>从白天复制</button>
                        ) : null}
                    </div>
                ) : null}

                <div className="night-sheet-actions">
                    <button type="button" onClick={onClose}>取消</button>
                    <button type="button" data-primary="true" disabled={!canSave} onClick={save}>保存</button>
                </div>
            </div>
        </div>
    );
}
