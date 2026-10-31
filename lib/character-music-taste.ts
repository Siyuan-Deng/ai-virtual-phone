// 角色音乐偏好与私人歌单。
import { simpleLLMCall } from "./api-helpers";
import { kvGet, kvSet } from "./kv-db";
import type { Character } from "./character-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";

const KEY = "music-character-taste-v1";
export type TasteSong = { title: string; artist: string; why: string };
export type CharacterTaste = { characterId: string; genres: string[]; artists: string[]; habit: string; songs: TasteSong[]; generatedAt: number };

type Store = Record<string, CharacterTaste>;
function loadStore(): Store { try { const raw = kvGet(KEY); const value = raw ? JSON.parse(raw) : {}; return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function saveStore(value: Store): void { kvSet(KEY, JSON.stringify(value)); }
export function loadCharacterTaste(id: string): CharacterTaste | null { const value = loadStore()[id]; return value && Array.isArray(value.songs) ? value : null; }
export function clearCharacterTaste(id: string): void { const value = loadStore(); delete value[id]; saveStore(value); }
function apiFor(id: string) { const slot = resolveBinding(loadBindingConfig(), id, "music"); return slot.apiConfigId ? loadApiConfigs().find(config => config.id === slot.apiConfigId) ?? null : null; }
function array(value: unknown, max: number): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, max) : []; }
function json(raw: string): string | null { const clean = raw.replace(/```json|```/gi, ""); const a = clean.indexOf("{"); const b = clean.lastIndexOf("}"); return a >= 0 && b > a ? clean.slice(a, b + 1) : null; }

export async function generateCharacterTaste(character: Character): Promise<CharacterTaste> {
    if (!character.persona?.trim() && !character.personality?.trim()) throw new Error("这个角色还没有人设，先填一段人设再生成。");
    const config = apiFor(character.id); if (!config) throw new Error("还没给这个角色绑定 API 配置，请到设置 → 绑定里指定。");
    const prompt = [`你要为角色「${character.name || "这个角色"}」设计音乐偏好和私人歌单。`,`【人设】${(character.persona || "").slice(0, 1500)}`,`【性格】${character.personality || ""}`,"根据人设推断品味。歌单给 8 到 12 首真实存在的歌，每首写 20 字以内的喜欢理由。只输出 JSON，不要解释。","格式：{\"genres\":[\"风格\"],\"artists\":[\"歌手\"],\"habit\":\"习惯\",\"songs\":[{\"title\":\"歌名\",\"artist\":\"歌手\",\"why\":\"理由\"}]}"].join("\n");
    const result = await simpleLLMCall(config, [{ role: "system", content: prompt }, { role: "user", content: "生成这份音乐偏好。" }], { temperature: 0.8, max_tokens: 8192 });
    if (result.error || !result.content) throw new Error(result.error || "模型没有返回内容。");
    const raw = json(result.content); if (!raw) throw new Error("模型返回格式不正确，请重试。");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const songs = (Array.isArray(parsed.songs) ? parsed.songs : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map(item => ({ title: typeof item.title === "string" ? item.title.trim() : "", artist: typeof item.artist === "string" ? item.artist.trim() : "", why: typeof item.why === "string" ? item.why.trim() : "" })).filter(song => song.title).slice(0, 12);
    if (!songs.length) throw new Error("模型没有生成有效歌单，请重试。");
    const value: CharacterTaste = { characterId: character.id, genres: array(parsed.genres, 6), artists: array(parsed.artists, 8), habit: typeof parsed.habit === "string" ? parsed.habit.slice(0, 60) : "", songs, generatedAt: Date.now() };
    const store = loadStore(); store[character.id] = value; saveStore(store); return value;
}

export function tasteToPromptBlock(value: CharacterTaste | null): string { if (!value) return ""; return [`偏好：${value.genres.join("、")}`,`常听歌手：${value.artists.slice(0, 5).join("、")}`,value.habit].filter(Boolean).join("\n"); }
