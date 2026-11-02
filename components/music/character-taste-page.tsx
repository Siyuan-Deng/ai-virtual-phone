// 角色音乐偏好与私人歌单页面。
"use client";
import { useEffect, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { clearCharacterTaste, generateCharacterTaste, loadCharacterTaste, type CharacterTaste } from "@/lib/character-music-taste";
import { getMusicControlBridge } from "@/lib/music-control-bridge";
import { isNeteaseConfigured, searchNetease } from "@/lib/music-service";

type Props = { onClose: () => void };
export default function CharacterTastePage({ onClose }: Props) {
    const [characters] = useState<Character[]>(() => loadCharacters());
    const [id, setId] = useState(() => characters[0]?.id || "");
    const [taste, setTaste] = useState<CharacterTaste | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const active = characters.find(character => character.id === id);
    useEffect(() => { setTaste(loadCharacterTaste(id)); }, [id]);
    const generate = async () => { if (!active) return; setBusy(true); try { setTaste(await generateCharacterTaste(active)); setMessage("已生成"); } catch (error) { setMessage(error instanceof Error ? error.message : "生成失败"); } finally { setBusy(false); } };
    const add = async (title: string, artist: string) => { if (!isNeteaseConfigured()) { setMessage("请先配置网易云 API"); return; } const result = await searchNetease(`${title} ${artist}`, 3); const hit = result[0]; const bridge = getMusicControlBridge(); if (!hit || !bridge) { setMessage("没有找到可播放的歌曲"); return; } const added = await bridge.addToQueue([{ id: `netease_${hit.id}`, title: hit.name || title, artist: hit.artists || artist, duration: Math.round(hit.duration / 1000), coverUrl: hit.coverUrl, liked: false, addedAt: new Date().toISOString() }]); setMessage(added.message); };
    return <div className="ct-page"><div className="ct-nav"><button className="ct-back" onClick={onClose}>←</button><b>TA 的歌单</b></div><div className="ct-chars">{characters.map(character => <button key={character.id} className="ct-char" data-on={character.id === id ? "" : undefined} onClick={() => setId(character.id)}>{character.avatar ? <img src={character.avatar} alt="" /> : <span>{(character.name || "?").slice(0, 1)}</span>}<em>{character.name}</em></button>)}</div>{!taste ? <div className="ct-empty"><p>还没生成音乐偏好</p><button className="ct-primary" disabled={busy} onClick={() => void generate()}>{busy ? "生成中…" : "生成 TA 的歌单"}</button></div> : <div className="ct-body"><div className="ct-meta"><div className="ct-tags">{taste.genres.map(item => <span className="ct-tag" key={item}>{item}</span>)}</div><div className="ct-line">常听：{taste.artists.join("、")}</div><div className="ct-line">{taste.habit}</div></div><div className="ct-actions"><button className="ct-ghost" onClick={() => void generate()} disabled={busy}>重新生成</button><button className="ct-ghost" onClick={() => { clearCharacterTaste(id); setTaste(null); }}>清除</button></div><div className="ct-songs">{taste.songs.map((song, index) => <div className="ct-song" key={`${song.title}_${index}`}><div className="ct-song-idx">{index + 1}</div><div className="ct-song-info"><div className="ct-song-title">{song.title}</div><div className="ct-song-artist">{song.artist}</div><div className="ct-song-why">{song.why}</div></div><button className="ct-song-add" onClick={() => void add(song.title, song.artist)}>+</button></div>)}</div></div>}{message && <div className="ct-toast">{message}</div>}</div>;
}
