// lib/music-listen-together.ts
// 「一起听」核心：上下文组装、LLM 短评与切歌决策、弹幕历史、情绪记忆、出口清洗、会话持久化。
//
// 改这个文件之前先读这三条铁律（全是踩过的坑）：
// 1. 一律走 simpleLLMCall + 角色自身绑定的 API 配置，绝不走聊天引擎的预设系统组装。
//    角色扮演预设里的输出格式规则会把「一句话短评」带成聊天腔 / 长段落 / 括号动作。
// 2. 称呼零硬编码：任何 prompt 位置都不许出现「主人」这类具体称呼——
//    称呼只能来自用户身份设置（resolveUserIdentity），否则换个身份就穿帮。
// 3. prompt 里的约束挡不住模型，格式和长度必须在代码层兜底：
//    出口一律过 sanitizeListenText，防复读一律过 isListenDuplicate。

import { simpleLLMCall } from "./api-helpers";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { loadCharacterTaste, tasteToPromptBlock } from "./character-music-taste";
import { kvGet, kvSet } from "./kv-db";
import type { Character } from "./character-types";
import type { MusicTrack } from "./music-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { renderUserNameMacro } from "./user-macro";

// ── 存储键 ─────────────────────────────────────────────
// 全部走 kv-db（IndexedDB AiPhoneKvDB / entries，in-line key，value 是 JSON 字符串）。
const HISTORY_KEY = "music-listen-together-v1";           // 每首歌的弹幕历史
const MOOD_KEY = "music-listen-together-mood-v1";         // 角色 × 歌 的情绪记忆
const SESSION_KEY = "music-listen-together-session-v1";   // 会话：是否开启 / 哪些角色 / 发言间隔
const SELECTED_KEY = "music-listen-together-selected-v1"; // 上次勾选的角色
const RELATION_KEY = "music-listen-together-relation-v1"; // 角色距离 / 累计时长 / 最近一起听

export type ListenRelation = {
    characterId: string;
    distanceKm: number | null; // null = 就在身边
    listenedSeconds: number;
    lastListenedAt: number;
};

type ListenRelationStore = Record<string, ListenRelation>;

// ── 容量与预算 ─────────────────────────────────────────
export const BUBBLE_MAX_CHARS = 80;       // 单条弹幕上限（出口截断）
const HISTORY_MAX_TRACKS = 30;            // 历史最多记 30 首歌
const HISTORY_PER_TRACK = 50;             // 每首最多 50 条弹幕
const MOOD_MAX_ENTRIES = 300;             // 情绪记忆全局 300 条
const PERSONA_BUDGET = 1200;              // persona 注入预算（字）
const LYRICS_BUDGET = 240;                // 歌词注入预算（字）
const RECENT_BUBBLE_LIMIT = 6;            // 接话上下文：最近几条
const RETRY_ON_DUPLICATE = true;          // 复读后是否重试一次

// ── 类型 ───────────────────────────────────────────────

export type ListenBubble = {
    id: string;
    characterId: string;
    characterName: string;
    text: string;
    at: number;
    /** comment=普通点评，skip=提议切歌，user=用户自己说的话 */
    kind: "comment" | "skip" | "user";
};

type ListenHistoryStore = Record<string, { bubbles: ListenBubble[]; updatedAt: number }>;

export type ListenMoodEntry = {
    characterId: string;
    trackId: string;
    /** 陪听过几次 */
    plays: number;
    /** 最近两句点评（只记可观测输出，不做情感分析） */
    lastLines: string[];
    /** 主动提过几次切歌 */
    skipWanted: number;
    /** 被用户拒过几次 */
    skipDenied: number;
    updatedAt: number;
};

export type ListenSession = {
    active: boolean;
    characterIds: string[];
    /** 自动发言间隔（秒） */
    intervalMin: number;
    intervalMax: number;
    startedAt: number;
};

export type ListenCommentResult = { text: string | null; error?: string };
export type ListenSkipDecision = { skip: boolean; reason: string; error?: string };

// ── 会话 ───────────────────────────────────────────────

const DEFAULT_SESSION: ListenSession = {
    active: false,
    characterIds: [],
    intervalMin: 25,
    intervalMax: 60,
    startedAt: 0,
};

export function loadListenSession(): ListenSession {
    try {
        const raw = kvGet(SESSION_KEY);
        if (!raw) return { ...DEFAULT_SESSION };
        const parsed = JSON.parse(raw) as Partial<ListenSession>;
        const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : 0;
        const characterIds = Array.isArray(parsed.characterIds)
            ? parsed.characterIds.filter((id): id is string => typeof id === "string")
            : [];
        // 旧版本会在仅选择角色时写入 active=true；没有开始时间的一律视为未开始。
        const active = parsed.active === true && startedAt > 0 && characterIds.length > 0;
        const session = {
            active,
            characterIds,
            intervalMin: clampNumber(parsed.intervalMin, 5, 300, DEFAULT_SESSION.intervalMin),
            intervalMax: clampNumber(parsed.intervalMax, 5, 600, DEFAULT_SESSION.intervalMax),
            startedAt,
        };
        if (parsed.active === true && !active) kvSet(SESSION_KEY, JSON.stringify(session));
        return session;
    } catch {
        return { ...DEFAULT_SESSION };
    }
}

export function saveListenSession(session: ListenSession): void {
    kvSet(SESSION_KEY, JSON.stringify({
        ...session,
        intervalMax: Math.max(session.intervalMin, session.intervalMax),
    }));
}

export function loadSelectedCharacterIds(): string[] {
    try {
        const raw = kvGet(SELECTED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

export function saveSelectedCharacterIds(ids: string[]): void {
    kvSet(SELECTED_KEY, JSON.stringify(ids));
}

function loadRelationStore(): ListenRelationStore {
    try {
        const raw = kvGet(RELATION_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ListenRelationStore : {};
    } catch {
        return {};
    }
}

function saveRelationStore(store: ListenRelationStore): void {
    kvSet(RELATION_KEY, JSON.stringify(store));
}

export function getListenRelation(characterId: string): ListenRelation {
    const stored = loadRelationStore()[characterId];
    return stored ?? {
        characterId,
        distanceKm: null,
        listenedSeconds: 0,
        lastListenedAt: 0,
    };
}

export function saveListenDistance(characterId: string, distanceKm: number | null): void {
    if (!characterId) return;
    const store = loadRelationStore();
    store[characterId] = { ...getListenRelation(characterId), distanceKm: distanceKm === null ? null : Math.max(0, Math.round(distanceKm * 10) / 10) };
    saveRelationStore(store);
}

export function addListenDuration(characterIds: string[], seconds: number): void {
    const duration = Math.max(0, Math.min(60, seconds));
    if (duration <= 0 || characterIds.length === 0) return;
    const store = loadRelationStore();
    const now = Date.now();
    for (const characterId of characterIds) {
        const relation = store[characterId] ?? getListenRelation(characterId);
        store[characterId] = { ...relation, listenedSeconds: relation.listenedSeconds + duration, lastListenedAt: now };
    }
    saveRelationStore(store);
}

export function markListenStarted(characterIds: string[]): void {
    if (characterIds.length === 0) return;
    const store = loadRelationStore();
    const now = Date.now();
    for (const characterId of characterIds) {
        const relation = store[characterId] ?? getListenRelation(characterId);
        store[characterId] = { ...relation, lastListenedAt: now };
    }
    saveRelationStore(store);
}

export function formatListenDuration(seconds: number): string {
    const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
    if (totalMinutes < 60) return `${totalMinutes} 分钟`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

// ── API 配置解析 ───────────────────────────────────────
// 只取角色聊天绑定解析出来的 API 配置（不取预设 / 正则 / 世界书）。

export function resolveCharacterApiConfig(characterId: string) {
    const slot = resolveBinding(loadBindingConfig(), characterId, "music");
    if (!slot.apiConfigId) return null;
    return loadApiConfigs().find(config => config.id === slot.apiConfigId) ?? null;
}

/** 解析「身边这个人」的称呼：只来自用户身份设置，取不到就返回空串由上层兜底。 */
export function resolveUserLabel(characterId: string): string {
    return resolveUserIdentity(characterId, "music")?.name?.trim() || "";
}

// ── 文本工具 ───────────────────────────────────────────

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** 剥掉 LRC 时间戳，留纯歌词文本 */
export function stripLrcTimestamps(lyrics: string): string {
    if (!lyrics) return "";
    return lyrics
        .split("\n")
        .map(line => line.replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, "").trim())
        .filter(line => line.length > 0)
        .join("\n");
}

/**
 * persona 裁剪：优先保留「说话风格」类小节，其余按顺序填满预算。
 * persona 全量注入会让短评任务的 prompt 膨胀到几千 token，且角色会被设定里
 * 的场景/剧情描述带跑，所以这里做预算裁剪。
 */
export function trimPersona(persona: string, budget = PERSONA_BUDGET): string {
    const text = (persona || "").trim();
    if (!text) return "";
    if (text.length <= budget) return text;

    const sections = text.split(/\n(?=\s*(?:#|【|■|◆|-{2,}|[一二三四五六七八九十]+、|\d+[.、]))/);
    const styleRe = /(说话|语言|口吻|语气|措辞|风格|口癖|习惯用|交流方式)/;
    const kept: string[] = [];
    let used = 0;
    // 第一轮：必保的说话风格小节
    for (const section of sections) {
        if (!styleRe.test(section.slice(0, 40))) continue;
        if (used + section.length > budget) continue;
        kept.push(section);
        used += section.length;
    }
    // 第二轮：按原顺序填充剩余预算
    for (const section of sections) {
        if (kept.includes(section)) continue;
        if (used + section.length > budget) continue;
        kept.push(section);
        used += section.length;
    }
    const merged = sections.filter(section => kept.includes(section)).join("\n").trim();
    // 极端情况：切完还是超（没有小节结构），直接硬截
    return merged.length > budget ? `${merged.slice(0, budget)}…` : merged;
}

const MOOD_WORDS = [
    "爱", "喜欢", "错过", "孤独", "夜", "雨", "遗憾", "释怀", "奔跑", "告别",
    "想念", "自由", "坠落", "温柔", "炽热", "沉默", "远方", "青春", "回家",
    "别走", "再见", "等待", "忘记", "月亮", "风", "海", "旧", "梦",
];

/** 歌词情绪关键词：只做词表命中计数，不调模型（省 token、保持确定性）。 */
export function analyzeLyricMood(lyrics: string): string {
    const text = stripLrcTimestamps(lyrics);
    if (!text) return "";
    const hits: { word: string; count: number }[] = [];
    for (const word of MOOD_WORDS) {
        let count = 0;
        let from = 0;
        while (true) {
            const idx = text.indexOf(word, from);
            if (idx < 0) break;
            count += 1;
            from = idx + word.length;
        }
        if (count > 0) hits.push({ word, count });
    }
    if (hits.length === 0) return "";
    hits.sort((a, b) => b.count - a.count);
    return hits.slice(0, 4).map(hit => hit.word).join("、");
}

// ── 出口清洗 ───────────────────────────────────────────

/** 括号动作：（……）、()、【】、[] 之类的动作描写一律剥掉 */
const BRACKET_ACTION_RE = /（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g;
const QUOTE_RE = /[「」『』“”"'‘’《》]/g;
const SENTENCE_END = /[。！？!?…~～，,、；;]/;

/** 长文本按句读截断，尽量停在标点上 */
function truncateAtPunct(text: string, limit: number): string {
    const slice = text.slice(0, limit);
    const floor = Math.floor(limit * 0.5);
    for (let i = slice.length - 1; i >= floor; i -= 1) {
        if (SENTENCE_END.test(slice[i])) {
            return slice.slice(0, i + 1).replace(/[，,、；;]$/, "");
        }
    }
    return `${slice}…`;
}

/**
 * 弹幕出口清洗：剥代码块 / HTML / markdown / 括号动作 / 引号 / 开头省略号，
 * 80 字截断到最近句读。prompt 已经要求过一遍，这里是代码层兜底——
 * 模型换个姿势漏格式就靠它拦。
 */
export function sanitizeListenText(raw: string): string {
    if (!raw) return "";
    let text = String(raw);
    text = text.replace(/```[\s\S]*?```/g, " ");              // 代码块
    text = text.replace(/<[^>]*>/g, " ");                     // HTML 标签
    text = text.replace(/^\s*[^\s：:]{1,14}\s*[：:]\s*/, "");   // 开头的「角色名：」
    text = text.replace(/^[#>\-*\s]+/, "");                   // 标题 / 列表符号
    text = text.replace(/\*\*|__|~~|`/g, "");                 // markdown 强调
    text = text.replace(BRACKET_ACTION_RE, " ");              // 括号动作
    text = text.replace(QUOTE_RE, "");                        // 引号书名号
    text = text.replace(/\s*\n+\s*/g, " ");                   // 换行压平
    text = text.replace(/^[\s…\.·、]+/, "");                  // 开头省略号
    text = text.replace(/\s{2,}/g, " ").trim();
    if (text.length > BUBBLE_MAX_CHARS) text = truncateAtPunct(text, BUBBLE_MAX_CHARS);
    return text.trim();
}

/** 繁简归一用的最小映射：只覆盖短评里高频出现的字，命中不了也不影响主流程。 */
const TRAD_TO_SIMP: Record<string, string> = {
    "這": "这", "麼": "么", "們": "们", "時": "时", "過": "过", "還": "还",
    "會": "会", "來": "来", "為": "为", "說": "说", "聽": "听", "聲": "声",
    "點": "点", "覺": "觉", "讓": "让", "愛": "爱", "誰": "谁", "開": "开",
    "關": "关", "頭": "头", "長": "长", "裡": "里", "樣": "样", "個": "个",
    "經": "经", "總": "总", "與": "与", "對": "对", "買": "买", "賣": "卖",
    "幾": "几", "興": "兴", "傷": "伤", "詞": "词", "節": "节", "錄": "录",
    "轉": "转", "惱": "恼", "捨": "舍", "棄": "弃", "願": "愿", "夢": "梦",
    "舊": "旧", "憶": "忆", "燈": "灯", "熱": "热", "涼": "凉", "靜": "静",
    "發": "发", "現": "现", "實": "实", "後": "后", "從": "从", "嗎": "吗",
    "囉": "啰", "別": "别", "噠": "哒", "該": "该", "給": "给", "話": "话",
};

function normalizeForCompare(text: string): string {
    return String(text || "")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, "")
        .split("")
        .map(ch => TRAD_TO_SIMP[ch] ?? ch)
        .join("");
}

function bigrams(text: string): Set<string> {
    const grams = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
    if (text.length === 1) grams.add(text);
    return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
}

/**
 * 防复读：小写 + 繁简归一 + 去标点后，
 * 包含关系或 bigram Jaccard ≥ 0.3 判重。
 */
export function isListenDuplicate(text: string, recent: string[]): boolean {
    const target = normalizeForCompare(text);
    if (!target) return true;
    const targetGrams = bigrams(target);
    for (const prev of recent) {
        const other = normalizeForCompare(prev);
        if (!other) continue;
        if (target === other) return true;
        if (target.includes(other) || other.includes(target)) return true;
        if (jaccard(targetGrams, bigrams(other)) >= 0.3) return true;
    }
    return false;
}

// ── 弹幕历史 ───────────────────────────────────────────

function loadHistoryStore(): ListenHistoryStore {
    try {
        const raw = kvGet(HISTORY_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as ListenHistoryStore;
    } catch {
        return {};
    }
}

function saveHistoryStore(store: ListenHistoryStore): void {
    const entries = Object.entries(store)
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
        .slice(0, HISTORY_MAX_TRACKS);
    kvSet(HISTORY_KEY, JSON.stringify(Object.fromEntries(entries)));
}

/** 某首歌已有的弹幕（旧 → 新） */
export function getListenHistory(trackId: string): ListenBubble[] {
    if (!trackId) return [];
    return loadHistoryStore()[trackId]?.bubbles ?? [];
}

/**
 * 追加一条弹幕。
 * 新行为（点歌、接龙等）也必须写回历史——历史既是接话上下文，也是防复读的数据源，
 * 不写回去就享受不到连续性，还会复读。
 */
export function appendListenHistory(trackId: string, bubble: ListenBubble): void {
    if (!trackId) return;
    const store = loadHistoryStore();
    const entry = store[trackId] ?? { bubbles: [], updatedAt: 0 };
    const bubbles = [...entry.bubbles, bubble].slice(-HISTORY_PER_TRACK);
    store[trackId] = { bubbles, updatedAt: Date.now() };
    saveHistoryStore(store);
}

/** 最近几条弹幕文本，给接话和防复读用 */
export function getRecentBubbleTexts(trackId: string, limit = RECENT_BUBBLE_LIMIT): string[] {
    return getListenHistory(trackId).slice(-limit).map(bubble => bubble.text);
}

// ── 情绪记忆 ───────────────────────────────────────────
// 只记可观测的行为信号：听过次数 / 最近两句点评 / 想切次数 / 被拒次数。
// 不做 LLM 情感分析（token 花在这上面不划算，且结论不稳定）。

function isMoodEntry(value: unknown): value is ListenMoodEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<ListenMoodEntry>;
    return typeof entry.characterId === "string" && typeof entry.trackId === "string";
}

function loadMoodStore(): ListenMoodEntry[] {
    try {
        const raw = kvGet(MOOD_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(isMoodEntry) : [];
    } catch {
        return [];
    }
}

function saveMoodStore(entries: ListenMoodEntry[]): void {
    const trimmed = [...entries]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MOOD_MAX_ENTRIES);
    kvSet(MOOD_KEY, JSON.stringify(trimmed));
}

function findMood(entries: ListenMoodEntry[], characterId: string, trackId: string): ListenMoodEntry | undefined {
    return entries.find(entry => entry.characterId === characterId && entry.trackId === trackId);
}

export function getMood(characterId: string, trackId: string): ListenMoodEntry | null {
    return findMood(loadMoodStore(), characterId, trackId) ?? null;
}

function upsertMood(characterId: string, trackId: string, patch: (entry: ListenMoodEntry) => ListenMoodEntry): void {
    if (!characterId || !trackId) return;
    const store = loadMoodStore();
    const existing = findMood(store, characterId, trackId);
    const base: ListenMoodEntry = existing ?? {
        characterId,
        trackId,
        plays: 0,
        lastLines: [],
        skipWanted: 0,
        skipDenied: 0,
        updatedAt: Date.now(),
    };
    const next = { ...patch(base), updatedAt: Date.now() };
    const rest = store.filter(entry => !(entry.characterId === characterId && entry.trackId === trackId));
    saveMoodStore([...rest, next]);
}

/** 开始陪听某首歌：听过次数 +1 */
export function markTrackListened(characterId: string, trackId: string): void {
    upsertMood(characterId, trackId, entry => ({ ...entry, plays: entry.plays + 1 }));
}

/** 记一句点评（只留最近两句） */
export function markCommentLine(characterId: string, trackId: string, line: string): void {
    const text = line.trim();
    if (!text) return;
    upsertMood(characterId, trackId, entry => ({
        ...entry,
        lastLines: [...entry.lastLines, text].slice(-2),
    }));
}

export function markSkipWanted(characterId: string, trackId: string): void {
    upsertMood(characterId, trackId, entry => ({ ...entry, skipWanted: entry.skipWanted + 1 }));
}

export function markSkipDenied(characterId: string, trackId: string): void {
    upsertMood(characterId, trackId, entry => ({ ...entry, skipDenied: entry.skipDenied + 1 }));
}

/**
 * 情绪记忆块：首次听某首歌不注入（省 token，也没内容可注）。
 * 被拒过的角色要明确提示「别再主动提」——否则用户拒一次它还会继续提。
 */
export function buildMoodBlock(characterId: string, trackId: string): string {
    const mood = getMood(characterId, trackId);
    if (!mood) return "";
    const isFirstTime = mood.plays <= 1 && mood.lastLines.length === 0
        && mood.skipWanted === 0 && mood.skipDenied === 0;
    if (isFirstTime) return "";
    const lines: string[] = [];
    if (mood.plays > 1) lines.push(`这首歌你已经陪着听过 ${mood.plays} 次了。`);
    if (mood.lastLines.length > 0) {
        lines.push(`你前几轮说过：${mood.lastLines.map(line => `「${line}」`).join("")}。别重复这些说法。`);
    }
    if (mood.skipWanted > 0) lines.push(`你之前主动提过 ${mood.skipWanted} 次想换歌。`);
    if (mood.skipDenied > 0) {
        lines.push(`其中 ${mood.skipDenied} 次被对方拒了，这首歌就别再主动提换歌，除非对方先开口。`);
    }
    return lines.join("\n");
}

// ── 上下文组装 ─────────────────────────────────────────

export type ListenContextInput = {
    character: Character;
    track: MusicTrack;
    userLabel: string;
};

/**
 * system prompt 的公共部分：世界观 → persona → personality → 身边人 → 歌曲简报 →
 * 歌词情绪 → 情绪记忆 → 刚才的弹幕 → 禁复读黑名单。
 * 缺任何一环角色都会退化成客服腔或复读机。
 */
function buildSharedContext(input: ListenContextInput, recentTexts: string[]): string[] {
    const { character, track, userLabel } = input;
    const lines: string[] = [];

    const relations = formatCharacterRelationsForPrompt(character.id);
    if (relations.trim()) {
        lines.push("【世界观与人物关系】", renderUserNameMacro(relations, userLabel), "");
    }

    const persona = trimPersona(character.persona || "");
    if (persona) {
        lines.push("【你的人设】", renderUserNameMacro(persona, userLabel), "");
    }

    const personality = (character.personality || "").trim();
    if (personality) {
        lines.push("【你的性格】", renderUserNameMacro(personality, userLabel), "");
    }

    if (userLabel) {
        lines.push(`【身边这个人】对方叫「${userLabel}」。你说话的对象就是这个人，称呼照平时的习惯来，别换别的叫法。`, "");
    } else {
        lines.push("【身边这个人】对方就是正在听歌的这个人。你说话的对象是这个人，称呼照平时的习惯来。", "");
    }

    const brief: string[] = [`歌名：《${track.title || "未知曲目"}》`];
    if (track.artist) brief.push(`歌手：${track.artist}`);
    if (track.album) brief.push(`专辑：${track.album}`);
    const plainLyrics = stripLrcTimestamps(track.lyrics || "");
    if (plainLyrics) {
        const snippet = plainLyrics.slice(0, LYRICS_BUDGET);
        brief.push(`歌词片段：${snippet}${plainLyrics.length > LYRICS_BUDGET ? "…" : ""}`);
    }
    lines.push("【正在听的歌】", brief.join("\n"), "");

    const moodWords = analyzeLyricMood(track.lyrics || "");
    if (moodWords) {
        lines.push(`【歌词气质】歌词里反复出现的情绪词：${moodWords}。可以顺着这个气质说话，但别把词直接念出来。`, "");
    }

    const tasteBlock = tasteToPromptBlock(loadCharacterTaste(character.id));
    if (tasteBlock) lines.push("【你自己的音乐口味】", tasteBlock, "点评时可以带上自己的偏好，但别每句都提。", "");

    const moodBlock = buildMoodBlock(character.id, track.id);
    if (moodBlock) lines.push("【听歌记忆】", moodBlock, "");

    if (recentTexts.length > 0) {
        lines.push(
            "【刚才大家说的】",
            recentTexts.map(text => `- ${text}`).join("\n"),
            "可以顺着接一句，但别附和成复读。",
            "",
            "【绝对不能重复】下面这些说法已经出现过，换一个角度、换一种说法：",
            ...recentTexts.map(text => `- ${text}`),
            "",
        );
    }

    return lines;
}

const COMMENT_RULES = [
    "【输出要求】",
    "1. 只输出一句口语化的短评，10~40 字，最多不超过 80 字。",
    "2. 不写动作、神态、环境描写，不用括号，不用引号，不写角色名前缀，不加表情符号。",
    "3. 不解释自己在做什么，不提问，不邀请对方做事，不说场面话。",
    "4. 不重复上文出现过的话，也不要把歌词整句抄下来。",
    "5. 直接给出那句话本身，不要任何前后缀。",
].join("\n");

// ── 短评 ───────────────────────────────────────────────

export type GenerateCommentParams = ListenContextInput & {
    /** 最近几条弹幕（接话 + 防复读）；不传则内部读历史 */
    recentTexts?: string[];
};

/**
 * 生成一条陪听短评。
 * 失败一律返回 { text: null, error }，调用方负责决定是静默还是提示用户。
 */
export async function generateListenComment(params: GenerateCommentParams): Promise<ListenCommentResult> {
    const { character, track, userLabel } = params;

    if (!character.persona?.trim() && !character.personality?.trim()) {
        return { text: null, error: `角色「${character.name || "未命名"}」还没有人设，先去角色编辑器填人设或性格。` };
    }

    const apiConfig = resolveCharacterApiConfig(character.id);
    if (!apiConfig) {
        return { text: null, error: "这个角色还没有绑定可用的 API 配置，先到「设置 → 绑定」里给它指定一个。" };
    }

    const recentTexts = params.recentTexts ?? getRecentBubbleTexts(track.id);
    const systemPrompt = [
        `你正在和一个人一起听歌。你是「${character.name || "这个角色"}」，下面是你的人设和此刻的场景。`,
        "",
        ...buildSharedContext({ character, track, userLabel }, recentTexts),
        COMMENT_RULES,
    ].join("\n");

    const runOnce = async (nudge: string | null): Promise<string | null> => {
        const result = await simpleLLMCall(
            apiConfig,
            [
                { role: "system", content: systemPrompt },
                { role: "user", content: nudge ? `现在轮到你开口了。${nudge}只说一句话。` : "现在轮到你开口了。只说一句话。" },
            ],
            { temperature: 0.9, max_tokens: 2048 },
        );
        if (result.error || !result.content) return null;
        return result.content;
    };

    const first = await runOnce(null);
    if (first === null) return { text: null, error: "模型没有返回内容，检查 API 配置或稍后重试。" };

    let cleaned = sanitizeListenText(first);
    let duplicate = isListenDuplicate(cleaned, recentTexts);
    if (duplicate && RETRY_ON_DUPLICATE) {
        const retry = await runOnce("刚才那句话和之前说过的太像了，必须换一个完全不同的角度。");
        if (retry !== null) {
            const retryCleaned = sanitizeListenText(retry);
            if (retryCleaned && !isListenDuplicate(retryCleaned, recentTexts)) {
                cleaned = retryCleaned;
                duplicate = false;
            }
        }
    }
    if (!cleaned || duplicate) return { text: null, error: "模型这次没给出可用的话，跳过这条。" };

    return { text: cleaned };
}

// ── 切歌决策 ───────────────────────────────────────────

export type DecideSkipParams = ListenContextInput & {
    /** 已播放秒数 */
    playedSeconds: number;
    recentTexts?: string[];
};

/**
 * 让角色自己判断「要不要提议切歌」。
 * 只给出判断和一句理由，真正弹窗 / 投票在 layer 里按人数阈值决定。
 */
export async function decideListenSkip(params: DecideSkipParams): Promise<ListenSkipDecision> {
    const { character, track, userLabel, playedSeconds } = params;
    if (!character.persona?.trim() && !character.personality?.trim()) {
        return { skip: false, reason: "", error: "角色没有人设，跳过决策。" };
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    if (!apiConfig) return { skip: false, reason: "", error: "角色未绑定 API 配置。" };

    const recentTexts = params.recentTexts ?? getRecentBubbleTexts(track.id);
    const mood = getMood(character.id, track.id);
    const deniedNote = mood && mood.skipDenied > 0
        ? "这首歌你已经提过换歌被拒了，这次倾向继续听，除非有很明确的理由。"
        : "";

    const systemPrompt = [
        `你正在和一个人一起听歌。你是「${character.name || "这个角色"}」。`,
        "",
        ...buildSharedContext({ character, track, userLabel }, recentTexts),
        `【当前状态】这首歌已经播放了 ${Math.round(playedSeconds)} 秒。`,
        deniedNote,
        "",
        "【任务】判断你现在是否想提议换下一首。",
        "只有真的听不下去、或者觉得气氛该换时才提议；只是不太喜欢不算理由。",
        "只输出一行 JSON，不要代码块、不要解释：",
        `{"skip": true 或 false, "reason": "一句话理由，20 字以内，说不换就给空字符串"}`,
    ].filter(Boolean).join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: "你现在想换歌吗？只回那行 JSON。" },
        ],
        { temperature: 0.5, max_tokens: 2048 },
    );

    if (result.error || !result.content) {
        return { skip: false, reason: "", error: result.error || "模型没有返回内容。" };
    }

    const raw = result.content.replace(/```json|```/gi, "").trim();
    const skipMatch = raw.match(/"skip"\s*:\s*(true|false)/i);
    if (!skipMatch) return { skip: false, reason: "", error: "模型返回的不是可解析的 JSON。" };

    const skip = skipMatch[1].toLowerCase() === "true";
    const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]*)"/);
    const reason = skip ? sanitizeListenText(reasonMatch?.[1] || "") : "";
    return { skip, reason };
}

// ── 回复用户（1v1 对话）────────────────────────────────

export type ReplyToUserParams = ListenContextInput & {
    userText: string;
    recentTexts?: string[];
};

export async function generateListenReply(params: ReplyToUserParams): Promise<ListenCommentResult> {
    const { character, track, userLabel, userText } = params;
    const said = userText.trim();
    if (!said) return { text: null, error: "没有说话内容。" };
    if (!character.persona?.trim() && !character.personality?.trim()) {
        return { text: null, error: `角色「${character.name || "未命名"}」还没有人设。` };
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    if (!apiConfig) return { text: null, error: "这个角色还没有绑定 API 配置。" };
    const recentTexts = params.recentTexts ?? getRecentBubbleTexts(track.id);
    const systemPrompt = [
        `你正在和一个人一起听歌。你是「${character.name || "这个角色"}」。`,
        "对方会在听歌时随口跟你说话，请像平时一样接话，不要像客服答疑。",
        "",
        ...buildSharedContext({ character, track, userLabel }, recentTexts),
        "【输出要求】只回一句 10~50 字的话，最多 80 字；不写动作、神态、括号、角色名前缀或表情符号；直接输出回复本身。",
    ].join("\n");
    const result = await simpleLLMCall(apiConfig, [
        { role: "system", content: systemPrompt },
        { role: "user", content: `对方刚说：${said}` },
    ], { temperature: 0.9, max_tokens: 2048 });
    if (result.error || !result.content) return { text: null, error: result.error || "模型没有返回内容。" };
    const cleaned = sanitizeListenText(result.content);
    if (!cleaned) return { text: null, error: "模型没有给出可用回复。" };
    return { text: cleaned };
}

// ── 组装一条弹幕（新行为的样板）────────────────────────
// 加新的角色行为时照这个形状写：上下文组装 + simpleLLMCall + 出口清洗 + 写回历史。

export function createBubble(
    character: { id: string; name?: string },
    text: string,
    kind: ListenBubble["kind"] = "comment",
): ListenBubble {
    return {
        id: `lt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        characterId: character.id,
        characterName: character.name || "角色",
        text,
        at: Date.now(),
        kind,
    };
}
