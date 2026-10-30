// lib/character-music-taste.ts
// 角色的音乐偏好与「TA 自己的歌单」。
//
// 与一起听同一条铁律：走 simpleLLMCall + 角色聊天的 API 绑定，不走预设系统组装
// （角色扮演预设会把这个结构化任务带成散文，JSON 直接解析不出来）。
//
// 注意：这里刻意不 import music-listen-together 的 trimPersona，
// 否则两个模块互相 import 形成循环依赖。人设预算自己截一刀就够了。
//
// 产物只存「歌名 + 歌手 + 理由」，不存音频：音频要靠网易云搜索现找，
// 用户没配网易云时这部分自然为空，歌单仍然可以看。

import { simpleLLMCall } from "./api-helpers";
import { kvGet, kvSet } from "./kv-db";
import type { Character } from "./character-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { renderUserNameMacro } from "./user-macro";

const TASTE_KEY = "music-character-taste-v1";
const TASTE_MAX_CHARACTERS = 60;
const TASTE_PERSONA_BUDGET = 1500;

export type TasteSong = {
    title: string;
    artist: string;
    /** TA 为什么喜欢这首（一句话，给用户看） */
    why: string;
};

export type CharacterTaste = {
    characterId: string;
    /** 偏好标签，如「city pop」「老摇滚」「雨天民谣」 */
    genres: string[];
    /** 常听的歌手 */
    artists: string[];
    /** 听歌习惯：什么时候听、怎么听 */
    habit: string;
    songs: TasteSong[];
    generatedAt: number;
};

type TasteStore = Record<string, CharacterTaste>;

// ── 存储 ───────────────────────────────────────────────

function loadTasteStore(): TasteStore {
    try {
        const raw = kvGet(TASTE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as TasteStore;
    } catch {
        return {};
    }
}

function saveTasteStore(store: TasteStore): void {
    const entries = Object.entries(store)
        .sort((a, b) => (b[1].generatedAt || 0) - (a[1].generatedAt || 0))
        .slice(0, TASTE_MAX_CHARACTERS);
    kvSet(TASTE_KEY, JSON.stringify(Object.fromEntries(entries)));
}

export function loadCharacterTaste(characterId: string): CharacterTaste | null {
    if (!characterId) return null;
    const taste = loadTasteStore()[characterId];
    return taste && Array.isArray(taste.songs) ? taste : null;
}

export function clearCharacterTaste(characterId: string): void {
    const store = loadTasteStore();
    if (!(characterId in store)) return;
    delete store[characterId];
    saveTasteStore(store);
}

// ── 生成 ───────────────────────────────────────────────

function resolveApiConfig(characterId: string) {
    const slot = resolveBinding(loadBindingConfig(), characterId, "music");
    if (!slot.apiConfigId) return null;
    return loadApiConfigs().find(config => config.id === slot.apiConfigId) ?? null;
}

/** 从模型输出里抠出 JSON（模型经常会包代码块或加解释） */
function extractJson(raw: string): string | null {
    const cleaned = raw.replace(/```json|```/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return cleaned.slice(start, end + 1);
}

function toStringArray(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, limit);
}

/**
 * 按角色人设生成 TA 的音乐偏好 + 歌单。
 * 失败抛错（带用户可读信息），调用方负责展示。
 */
export async function generateCharacterTaste(
    character: Character,
    userName?: string,
): Promise<CharacterTaste> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("这个角色还没有人设，先填一段人设再生成。");
    }
    const apiConfig = resolveApiConfig(character.id);
    if (!apiConfig) throw new Error("还没给这个角色绑定 API 配置，去「设置 → 绑定」里指定一个。");

    const name = character.name?.trim() || "这个角色";
    const rawPersona = (character.persona || "").trim();
    const persona = renderUserNameMacro(
        rawPersona.length > TASTE_PERSONA_BUDGET ? `${rawPersona.slice(0, TASTE_PERSONA_BUDGET)}…` : rawPersona,
        userName,
    );
    const personality = renderUserNameMacro((character.personality || "").trim(), userName);

    const systemPrompt = [
        `你要为角色「${name}」设计 TA 自己的音乐偏好和私人歌单。`,
        "依据只有下面的人设，不要凭空发明与设定冲突的品味。",
        "",
        persona ? `【人设】\n${persona}` : "",
        personality ? `【性格】\n${personality}` : "",
        "",
        "要求：",
        "- 品味必须能从人设里推出来：年龄、职业、成长背景、性格、情绪底色都会影响听什么。",
        "- 歌单 8~12 首，尽量是真实存在的歌（华语、欧美、日语都行），不要编造歌名和歌手。",
        "- 允许有反差：一个冷静的人也可能偷偷循环很吵的歌，但要在理由里说清为什么。",
        "- 每首歌的 why 一句话，20 字以内，写 TA 自己的理由，不要写乐评。",
        "- 不要出现「主人」这类称呼，也不要写第二人称对话。",
        "",
        "只输出一行 JSON，不要代码块、不要任何解释：",
        '{"genres":["风格标签"],"artists":["常听歌手"],"habit":"一句听歌习惯，30字以内","songs":[{"title":"歌名","artist":"歌手","why":"理由"}]}',
    ].filter(Boolean).join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请为「${name}」生成音乐偏好和歌单，只回那行 JSON。` },
        ],
        // 思考模型会先烧隐藏 token，上限给小了正文会是空的
        { temperature: 0.85, max_tokens: 8192 },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "模型没有返回内容，检查 API 配置或稍后重试。");
    }

    const jsonText = extractJson(result.content);
    if (!jsonText) throw new Error("模型返回的格式不对（没找到 JSON），重试一次试试。");

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error("模型返回的 JSON 解析失败，重试一次试试。");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("模型返回的内容不是对象。");

    const obj = parsed as Record<string, unknown>;
    const songsRaw = Array.isArray(obj.songs) ? obj.songs : [];
    const songs: TasteSong[] = songsRaw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map(item => ({
            title: typeof item.title === "string" ? item.title.trim() : "",
            artist: typeof item.artist === "string" ? item.artist.trim() : "",
            why: typeof item.why === "string" ? item.why.trim() : "",
        }))
        .filter(song => song.title.length > 0)
        .slice(0, 12);

    if (songs.length === 0) throw new Error("模型没给出可用的歌单，重试一次试试。");

    const taste: CharacterTaste = {
        characterId: character.id,
        genres: toStringArray(obj.genres, 6),
        artists: toStringArray(obj.artists, 8),
        habit: typeof obj.habit === "string" ? obj.habit.trim().slice(0, 60) : "",
        songs,
        generatedAt: Date.now(),
    };

    const store = loadTasteStore();
    store[character.id] = taste;
    saveTasteStore(store);
    return taste;
}

/** 偏好摘要：给一起听的 prompt 用，让 TA 的点评带点自己的品味。 */
export function tasteToPromptBlock(taste: CharacterTaste | null): string {
    if (!taste) return "";
    const lines: string[] = [];
    if (taste.genres.length > 0) lines.push(`你平时爱听：${taste.genres.join("、")}。`);
    if (taste.artists.length > 0) lines.push(`常循环的歌手：${taste.artists.slice(0, 5).join("、")}。`);
    if (taste.habit) lines.push(`你的听歌习惯：${taste.habit}`);
    return lines.join("\n");
}
