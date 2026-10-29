"use client";

// 外观 → 某套搭配（夜间、自己建的雨天……）的配置页。上面是外观和各 App 的格子（一格一行）；
// 下面是角色：一个角色一行，点进去是这个角色在聊天、剧情里能配的几格。点一格从底下弹出来挑这套用什么。
// 和各编辑框顶上的「日间模式 | 某套搭配」存的是同一份（lib/night-mode 里那套搭配的格子）。

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Search } from "lucide-react";
import { getSchemes, findScheme } from "@/lib/css-scheme-storage";
import { NIGHT_SET_ID, getNightBinding, loadNightSet, lookSetName, nightSlotKeys, setNightBinding, useNightRevision, type NightBinding } from "@/lib/night-mode";
import { NIGHT_THEME_GROUP_LABELS, NIGHT_THEME_GROUPS, type NightThemeGroup } from "@/lib/night-theme";
import { loadChatSessions, type ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadStorySessions, type StorySession } from "@/lib/story-storage";
import { loadBindingConfig, loadRegexes, resolveBinding } from "@/lib/settings-storage";
import { getStatusRegionConfig, STATUS_REGION_SCHEME_TARGET } from "@/lib/chat-status-region";
import { loadMascotSettings } from "@/lib/mascot-settings";
import { loadReadingCustomCss } from "@/lib/reading-custom-css";
import { readThemeProfile } from "@/lib/theme-storage";
import { CALENDAR_THEMES } from "@/lib/calendar-storage";
import { kvGet } from "@/lib/kv-db";

/**
 * css / status：跟随日间 · 存过的方案 · 单独一份（这里就能写）
 * regex：跟随日间 · 换一套（多选）
 * bg：跟随日间 · 单独一张图
 * calendarTheme：跟随日间 · 另选一个主题
 * look / theme：单独一份要回原来的地方切到这套搭配改，这里只能看、清掉
 */
type SlotKind = "css" | "status" | "regex" | "bg" | "calendarTheme" | "look" | "theme";

type SlotRow = {
    key: string;
    label: string;
    kind: SlotKind;
    /** 存过的方案按这个分类（CSSSchemeBar 的 target） */
    schemeTarget?: string;
    /** 日间那份：「从日间复制」用 */
    dayValue?: () => string;
    /** 状态栏：日间那份要 AI 输出什么，换方案时比一比 */
    dayContract?: string;
    /** 正则：日间绑的那几个 */
    dayRegexIds?: string[];
    /** look / theme：去哪里改这套那份（{name} 换成搭配名） */
    where?: string;
};

type SlotSection = { title: string; rows: SlotRow[] };

export type NightEntity = { id: string; name: string; sections: SlotSection[] };

function statusSchemeContract(css: string): string {
    try {
        const parsed = JSON.parse(css) as { contract?: unknown };
        return typeof parsed.contract === "string" ? parsed.contract : "";
    } catch {
        return "";
    }
}

function regexNames(ids: string[]): string {
    const all = loadRegexes();
    const names = ids.map((id) => all.find((regex) => regex.id === id)?.name).filter(Boolean);
    return names.length ? names.join("、") : "不用正则";
}

function parseIds(value: string): string[] {
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

/** 一格右边那行小字：这套用的是什么 */
function slotValueText(row: SlotRow, binding: NightBinding | undefined): string {
    if (!binding) return "跟随日间";
    if (binding.kind === "scheme") return findScheme(binding.schemeId)?.name || "方案已删";
    if (row.kind === "regex") return regexNames(parseIds(binding.value));
    if (row.kind === "bg") return "单独一张";
    if (row.kind === "calendarTheme") return CALENDAR_THEMES.find((theme) => theme.id === binding.value)?.name || "单独一份";
    return "单独一份";
}

function buildAppSections(): SlotSection[] {
    const theme = readThemeProfile();
    const themeRows: SlotRow[] = (Object.keys(NIGHT_THEME_GROUPS) as NightThemeGroup[]).map((group) => (
        group === "theme.css"
            ? { key: group, label: NIGHT_THEME_GROUP_LABELS[group], kind: "css", schemeTarget: "global", dayValue: () => theme.globalCustomCSS || "" }
            : { key: group, label: NIGHT_THEME_GROUP_LABELS[group], kind: "theme", where: "切到{name}，在外观里改这一项" }
    ));
    const appRows: SlotRow[] = [
        { key: nightSlotKeys.chatApp, label: "聊天 App 全局 CSS", kind: "css", schemeTarget: "chat_app", dayValue: () => kvGet("chat-app-custom-css") || "" },
        { key: nightSlotKeys.calendarTheme, label: "日历主题", kind: "calendarTheme" },
        { key: nightSlotKeys.calendar, label: "日历 CSS", kind: "css", schemeTarget: "calendar", dayValue: () => kvGet("calendar-custom-css") || "" },
        { key: nightSlotKeys.music, label: "音乐 CSS", kind: "css", schemeTarget: "music", dayValue: () => kvGet("music-custom-css") || "" },
        { key: nightSlotKeys.reading, label: "阅读 CSS", kind: "css", schemeTarget: "reading", dayValue: () => loadReadingCustomCss() },
        { key: nightSlotKeys.mascot, label: "小卷聊天 CSS", kind: "css", schemeTarget: "chat_session", dayValue: () => loadMascotSettings().chatCustomCSS || "" },
    ];
    return [
        { title: "外观（全局）", rows: themeRows },
        { title: "各 App", rows: appRows },
    ];
}

function chatRows(session: ChatSession, dayRegexIds: string[]): SlotRow[] {
    const rows: SlotRow[] = [
        { key: nightSlotKeys.chatSession(session.id), label: "聊天窗 CSS", kind: "css", schemeTarget: "chat_session", dayValue: () => session.customCSS || "" },
    ];
    const status = getStatusRegionConfig(session.id);
    if (status.mode === "custom" && status.renderHtml.trim()) {
        rows.push({
            key: nightSlotKeys.chatStatus(session.id), label: "状态栏", kind: "status",
            schemeTarget: STATUS_REGION_SCHEME_TARGET, dayValue: () => status.renderHtml, dayContract: status.contract,
        });
    }
    rows.push({ key: nightSlotKeys.chatBg(session.id), label: "聊天背景", kind: "bg" });
    rows.push({ key: nightSlotKeys.chatRegex(session.id), label: "正则", kind: "regex", dayRegexIds });
    return rows;
}

function storyRows(session: StorySession, main: StorySession | undefined, dayRegexIds: string[]): SlotRow[] {
    return [
        {
            key: nightSlotKeys.story(session.id), label: "CSS", kind: "css", schemeTarget: "story",
            dayValue: () => session.customCSS ?? main?.customCSS ?? "",
        },
        { key: nightSlotKeys.storyRegex(session.id), label: "正则", kind: "regex", dayRegexIds },
        { key: nightSlotKeys.storyLook(session.id), label: "显示选项", kind: "look", where: "在剧情侧栏的显示选项里切到「{name}」改" },
    ];
}

/** 能配搭配的角色（和群聊）：有聊天或剧情的才列 */
export function buildNightEntities(): NightEntity[] {
    const characters = loadCharacters();
    const bindings = loadBindingConfig();
    const sessions = loadChatSessions();
    const storySessions = loadStorySessions();
    const entities: NightEntity[] = [];

    for (const character of characters) {
        const sections: SlotSection[] = [];
        const chatSessions = sessions.filter((session) => !session.isGroup && session.contactId === character.id);
        const chatRegexIds = resolveBinding(bindings, character.id, "chat").regexIds || [];
        chatSessions.forEach((session, index) => {
            sections.push({ title: chatSessions.length > 1 ? `聊天 ${index + 1}` : "聊天", rows: chatRows(session, chatRegexIds) });
        });
        const own = storySessions.filter((session) => session.characterId === character.id);
        const main = own.find((session) => session.kind !== "extra");
        const extra = own.find((session) => session.kind === "extra");
        // 剧情的日间正则：剧情单独绑过就用它，没有就跟角色的绑定走（和剧情引擎一样）
        const storyOverride = bindings.characterBindings.find((item) => item.characterId === character.id)?.appOverrides.story?.regexIds;
        const storyRegexIds = storyOverride && storyOverride.length > 0 ? storyOverride : resolveBinding(bindings, character.id, "story").regexIds || [];
        if (main) sections.push({ title: "剧情 · 正篇", rows: storyRows(main, undefined, storyRegexIds) });
        if (extra) {
            const extraRegexIds = extra.extraConfig?.bindings?.regexIds ?? storyRegexIds;
            sections.push({ title: "剧情 · 番外", rows: storyRows(extra, main, extraRegexIds) });
        }
        if (sections.length) entities.push({ id: character.id, name: character.name || "未命名角色", sections });
    }

    const groupRegexIds = resolveBinding(bindings, undefined, "group_chat").regexIds || [];
    for (const session of sessions.filter((item) => item.isGroup)) {
        entities.push({
            id: `group:${session.id}`,
            name: session.groupName || "群聊",
            sections: [{ title: "聊天", rows: chatRows(session, groupRegexIds) }],
        });
    }
    return entities;
}

function entityConfigured(entity: NightEntity, set: Record<string, NightBinding>): boolean {
    return entity.sections.some((section) => section.rows.some((row) => set[row.key]));
}

function SlotRows({ setId, rows, onOpen }: { setId: string; rows: SlotRow[]; onOpen: (row: SlotRow) => void }) {
    const set = loadNightSet(setId);
    return (
        <div className="menu-group">
            {rows.map((row) => (
                <button key={row.key} type="button" className="menu-item night-card-row" onClick={() => onOpen(row)}>
                    <span className="menu-label night-set-label">{row.label}</span>
                    <span className="menu-right">
                        <span className="menu-desc night-set-value">{slotValueText(row, set[row.key])}</span>
                        <ChevronRight size={16} aria-hidden="true" />
                    </span>
                </button>
            ))}
        </div>
    );
}

function useSheetHost(): HTMLElement | null {
    const [host, setHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setHost(document.querySelector<HTMLElement>(".phone-shell")); }, []);
    return host;
}

/** 外观 → 某套搭配 */
export function NightSetPage({ setId, onOpenEntity }: { setId: string; onOpenEntity: (entity: NightEntity) => void }) {
    useNightRevision();
    const host = useSheetHost();
    const [sheet, setSheet] = useState<SlotRow | null>(null);
    const [batchOpen, setBatchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [onlyConfigured, setOnlyConfigured] = useState(false);
    const set = loadNightSet(setId);
    const appSections = buildAppSections();
    const entities = buildNightEntities();
    const shown = entities.filter((entity) => (
        (!query.trim() || entity.name.toLowerCase().includes(query.trim().toLowerCase()))
        && (!onlyConfigured || entityConfigured(entity, set))
    ));

    return (
        <div className="night-page">
            {appSections.map((section) => (
                <section key={section.title} className="night-set-group">
                    <h3 className="appearance-menu-section-title">{section.title}</h3>
                    <SlotRows setId={setId} rows={section.rows} onOpen={setSheet} />
                </section>
            ))}

            {entities.length ? (
                <section className="night-set-group">
                    <div className="night-set-group-head">
                        <h3 className="appearance-menu-section-title">角色</h3>
                        <button
                            type="button"
                            className="night-set-filter"
                            data-on={onlyConfigured ? "true" : undefined}
                            aria-pressed={onlyConfigured}
                            onClick={() => setOnlyConfigured((value) => !value)}
                        >
                            {onlyConfigured ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : null}
                            筛选已配置角色
                        </button>
                        <button type="button" onClick={() => setBatchOpen(true)}>批量设置</button>
                    </div>
                    <label className="night-set-search">
                        <Search size={14} aria-hidden="true" />
                        <input value={query} placeholder="搜角色" onChange={(event) => setQuery(event.target.value)} />
                    </label>
                    <div className="menu-group">
                        {shown.length ? shown.map((entity) => (
                            <button key={entity.id} type="button" className="menu-item night-card-row" onClick={() => onOpenEntity(entity)}>
                                <span className="menu-label night-set-label">{entity.name}</span>
                                <span className="menu-right">
                                    {entityConfigured(entity, set) ? <span className="menu-desc night-set-value">已配置</span> : null}
                                    <ChevronRight size={16} aria-hidden="true" />
                                </span>
                            </button>
                        )) : <div className="menu-item night-set-empty">{onlyConfigured ? "还没有配置过的角色" : "没有找到这个角色"}</div>}
                    </div>
                </section>
            ) : null}

            {sheet && host ? createPortal(<NightSlotSheet setId={setId} row={sheet} keys={[sheet.key]} onClose={() => setSheet(null)} />, host) : null}
            {batchOpen && host ? createPortal(<NightBatchSheet setId={setId} entities={entities} onClose={() => setBatchOpen(false)} />, host) : null}
        </div>
    );
}

/** 点进一个角色：聊天、剧情 · 正篇、剧情 · 番外 */
export function NightEntityPage({ setId, entityId }: { setId: string; entityId: string }) {
    useNightRevision();
    const host = useSheetHost();
    const [sheet, setSheet] = useState<SlotRow | null>(null);
    const entity = buildNightEntities().find((item) => item.id === entityId);
    if (!entity) return <div className="night-page"><p className="night-page-note">这个角色已经不在了。</p></div>;
    return (
        <div className="night-page">
            {entity.sections.map((section) => (
                <section key={section.title} className="night-set-group">
                    <h3 className="appearance-menu-section-title">{section.title}</h3>
                    <SlotRows setId={setId} rows={section.rows} onOpen={setSheet} />
                </section>
            ))}
            {sheet && host ? createPortal(<NightSlotSheet setId={setId} row={sheet} keys={[sheet.key]} onClose={() => setSheet(null)} />, host) : null}
        </div>
    );
}

type Choice = "same" | "scheme" | "own";

function Radio({ on }: { on: boolean }) {
    return <span className="night-card-radio" data-on={on ? "true" : undefined} aria-hidden="true" />;
}

/** 点一格从底下弹出来：这套搭配用什么。extra：标题下面多放的东西（批量设置挑项目） */
function NightSlotSheet({ setId, row, keys, onClose, extra }: { setId: string; row: SlotRow; keys: string[]; onClose: () => void; extra?: ReactNode }) {
    const name = lookSetName(setId);
    const where = (row.where ?? "在原来的地方切到{name}改").replace("{name}", name);
    const single = keys.length === 1 ? getNightBinding(keys[0], setId) : undefined;
    const [choice, setChoice] = useState<Choice>(() => single?.kind ?? "same");
    const [schemeId, setSchemeId] = useState(single?.kind === "scheme" ? single.schemeId : "");
    const [ownText, setOwnText] = useState(single?.kind === "own" && row.kind !== "regex" ? single.value : "");
    const [regexIds, setRegexIds] = useState<string[]>(() => (
        single?.kind === "own" && row.kind === "regex" ? parseIds(single.value) : [...(row.dayRegexIds ?? [])]
    ));
    const [bgPreview, setBgPreview] = useState<string | null>(null);
    const schemes = row.schemeTarget ? getSchemes(row.schemeTarget) : [];
    const allRegexes = row.kind === "regex" ? loadRegexes() : [];

    // 聊天背景：已经存了这套那张就先显示出来
    useEffect(() => {
        if (row.kind !== "bg" || !ownText) { setBgPreview(null); return; }
        let cancelled = false;
        void import("@/lib/chat-asset-storage")
            .then(({ getChatImageFromIndexedDB }) => getChatImageFromIndexedDB(ownText))
            .then((url) => { if (!cancelled) setBgPreview(url); });
        return () => { cancelled = true; };
    }, [row.kind, ownText]);

    const schemeMismatch = row.kind === "status" && choice === "scheme" && schemeId
        ? (() => {
            const scheme = schemes.find((item) => item.id === schemeId);
            const contract = scheme ? statusSchemeContract(scheme.css).trim() : "";
            return Boolean(contract && row.dayContract !== undefined && contract !== row.dayContract.trim());
        })()
        : false;

    const ownAvailable = row.kind === "look" || row.kind === "theme" ? single?.kind === "own" : true;
    const canSave =
        choice === "same"
        || (choice === "scheme" && Boolean(schemeId))
        || (choice === "own" && (
            row.kind === "regex" ? true
                : row.kind === "look" || row.kind === "theme" ? ownAvailable
                    : Boolean(ownText.trim())
        ));

    const save = () => {
        let binding: NightBinding | null = null;
        if (choice === "scheme") binding = { kind: "scheme", schemeId };
        if (choice === "own") {
            if (row.kind === "regex") binding = { kind: "own", value: JSON.stringify(regexIds) };
            else if (row.kind === "look" || row.kind === "theme") binding = single ?? null;
            else binding = { kind: "own", value: ownText };
        }
        for (const key of keys) setNightBinding(key, binding, setId);
        onClose();
    };

    const dayRegexText = row.kind === "regex" ? (row.dayRegexIds?.length ? regexNames(row.dayRegexIds) : "日间没有绑正则") : "";

    return (
        <div className="night-sheet-overlay" onClick={onClose}>
            <div className="night-sheet" role="dialog" aria-label={`${row.label} ${name}用什么`} onClick={(event) => event.stopPropagation()}>
                <div className="night-sheet-grab" aria-hidden="true" />
                <h4>{row.label}</h4>
                <div className="night-sheet-sub">{keys.length > 1 ? `一起设 ${keys.length} 个，${name}用什么` : `${name}用什么`}</div>
                {extra}

                <button type="button" className="night-sheet-choice" onClick={() => setChoice("same")}>
                    <Radio on={choice === "same"} />
                    <span>跟随日间模式{dayRegexText ? <small>{dayRegexText}</small> : null}</span>
                </button>

                {row.schemeTarget ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("scheme")}>
                            <Radio on={choice === "scheme"} />
                            <span>{row.kind === "status" ? "用存过的状态栏方案" : "用存过的方案"}</span>
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
                        {schemeMismatch ? <div className="night-sheet-warn">这个方案要 AI 输出的字段和日间那份不一样，用{name}时可能有几项是空的。</div> : null}
                    </>
                ) : null}

                {row.kind === "calendarTheme" ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("own")}>
                            <Radio on={choice === "own"} />
                            <span>{name}用另一个主题</span>
                        </button>
                        {choice === "own" ? (
                            <div className="night-sheet-chips">
                                {CALENDAR_THEMES.map((theme) => (
                                    <button key={theme.id} type="button" data-on={ownText === theme.id ? "true" : undefined} onClick={() => setOwnText(theme.id)}>
                                        {theme.name}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </>
                ) : row.kind === "regex" ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("own")}>
                            <Radio on={choice === "own"} />
                            <span>换一套</span>
                        </button>
                        {choice === "own" ? (
                            <>
                                <div className="night-sheet-checks">
                                    {allRegexes.length ? allRegexes.map((regex) => {
                                        const on = regexIds.includes(regex.id);
                                        return (
                                            <button
                                                key={regex.id}
                                                type="button"
                                                role="checkbox"
                                                aria-checked={on}
                                                onClick={() => setRegexIds((ids) => (on ? ids.filter((id) => id !== regex.id) : [...ids, regex.id]))}
                                            >
                                                <span className="night-sheet-box" data-on={on ? "true" : undefined} aria-hidden="true" />
                                                {regex.name || "未命名正则"}
                                            </button>
                                        );
                                    }) : <span className="night-sheet-empty">还没有正则</span>}
                                </div>
                                <div className="night-sheet-warn">{setId === NIGHT_SET_ID ? "如果夜间模式正则的替换字符串与白天有出入，请自行切换对应世界书。" : `如果${name}正则的替换字符串与日间有出入，请自行切换对应世界书。`}</div>
                            </>
                        ) : null}
                    </>
                ) : row.kind === "bg" ? (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("own")}>
                            <Radio on={choice === "own"} />
                            <span>{name}单独一张</span>
                        </button>
                        {choice === "own" ? (
                            <div className="night-sheet-own">
                                {bgPreview ? <img className="night-sheet-bg" src={bgPreview} alt={`${name}背景`} /> : null}
                                <label className="night-side-copy">
                                    {ownText ? "换一张" : "选一张图"}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        hidden
                                        onChange={(event) => {
                                            const file = event.target.files?.[0];
                                            event.target.value = "";
                                            if (!file) return;
                                            void import("@/lib/chat-asset-storage")
                                                .then(({ saveChatImageToIndexedDB }) => saveChatImageToIndexedDB(file))
                                                .then((id) => setOwnText(id))
                                                .catch(() => alert("图片保存失败，请重试"));
                                        }}
                                    />
                                </label>
                            </div>
                        ) : null}
                    </>
                ) : row.kind === "look" || row.kind === "theme" ? (
                    <button type="button" className="night-sheet-choice" disabled={!ownAvailable} onClick={() => setChoice("own")}>
                        <Radio on={choice === "own"} />
                        <span>
                            {name}单独一份
                            <small>{ownAvailable ? `已经有一份了；${where}` : where}</small>
                        </span>
                    </button>
                ) : (
                    <>
                        <button type="button" className="night-sheet-choice" onClick={() => setChoice("own")}>
                            <Radio on={choice === "own"} />
                            <span>{row.kind === "status" ? `${name}单独一份（渲染代码）` : `${name}单独一份`}</span>
                        </button>
                        {choice === "own" ? (
                            <div className="night-sheet-own">
                                <textarea
                                    value={ownText}
                                    onChange={(event) => setOwnText(event.target.value)}
                                    placeholder={row.kind === "status" ? `${name}用的状态栏渲染代码（HTML）` : `${name}用的 CSS`}
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                />
                                {keys.length === 1 && row.dayValue && row.dayValue().trim() ? (
                                    <button type="button" className="night-side-copy" onClick={() => setOwnText(row.dayValue!())}>从日间复制</button>
                                ) : null}
                            </div>
                        ) : null}
                    </>
                )}

                <div className="night-sheet-actions">
                    <button type="button" onClick={onClose}>取消</button>
                    <button type="button" data-primary="true" disabled={!canSave} onClick={save}>保存</button>
                </div>
            </div>
        </div>
    );
}

const BATCH_PROJECTS = [
    { id: "chat", label: "聊天窗 CSS", target: "chat_session", match: (title: string, row: SlotRow) => title.startsWith("聊天") && row.kind === "css" },
    { id: "storyMain", label: "剧情正篇 CSS", target: "story", match: (title: string, row: SlotRow) => title === "剧情 · 正篇" && row.kind === "css" },
    { id: "storyExtra", label: "剧情番外 CSS", target: "story", match: (title: string, row: SlotRow) => title === "剧情 · 番外" && row.kind === "css" },
] as const;

/** 批量设置：挑一项，所有角色的这一格一起设 */
function NightBatchSheet({ setId, entities, onClose }: { setId: string; entities: NightEntity[]; onClose: () => void }) {
    const [projectId, setProjectId] = useState<(typeof BATCH_PROJECTS)[number]["id"]>("chat");
    const project = BATCH_PROJECTS.find((item) => item.id === projectId)!;
    const keys = entities.flatMap((entity) => entity.sections.flatMap((section) => (
        section.rows.filter((row) => project.match(section.title, row)).map((row) => row.key)
    )));
    return (
        <NightSlotSheet
            key={projectId}
            setId={setId}
            row={{ key: "", label: "批量设置", kind: "css", schemeTarget: project.target }}
            keys={keys}
            onClose={onClose}
            extra={(
                <div className="night-sheet-chips night-batch-projects">
                    {BATCH_PROJECTS.map((item) => (
                        <button key={item.id} type="button" data-on={item.id === projectId ? "true" : undefined} onClick={() => setProjectId(item.id)}>
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        />
    );
}
