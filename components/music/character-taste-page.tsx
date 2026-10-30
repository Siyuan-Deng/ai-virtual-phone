// components/music/character-taste-page.tsx
// 角色的音乐偏好 / 私人歌单：查看 + 重新生成 + 把歌加进播放队列。
"use client";

import { useCallback, useEffect, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    clearCharacterTaste,
    generateCharacterTaste,
    loadCharacterTaste,
    type CharacterTaste,
} from "@/lib/character-music-taste";
import { isNeteaseConfigured, searchNetease, type NeteaseSearchResult } from "@/lib/music-service";
// addToQueue 不在 useMusicControls 的返回值里（只有 control bridge 暴露它），
// 所以这里走 bridge 拿队列操作。
import { getMusicControlBridge } from "@/lib/music-control-bridge";
import type { MusicTrack } from "@/lib/music-storage";

type Props = { onClose: () => void };

export default function CharacterTastePage({ onClose }: Props) {
    const [characters] = useState<Character[]>(() => loadCharacters());
    const [activeId, setActiveId] = useState<string>(() => characters[0]?.id ?? "");
    const [taste, setTaste] = useState<CharacterTaste | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const [addingTitle, setAddingTitle] = useState<string | null>(null);

    const active = characters.find(character => character.id === activeId) ?? null;

    // 切角色时读已有偏好（没有就是空态，等用户点生成）
    useEffect(() => {
        if (!activeId) return;
        setTaste(loadCharacterTaste(activeId));
        setError(null);
    }, [activeId]);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 2200);
        return () => clearTimeout(timer);
    }, [toast]);

    const regenerate = useCallback(async () => {
        if (!active || busy) return;
        setBusy(true);
        setError(null);
        try {
            const next = await generateCharacterTaste(active);
            setTaste(next);
            setToast("已生成");
        } catch (err) {
            setError(err instanceof Error ? err.message : "生成失败，重试一次。");
        } finally {
            setBusy(false);
        }
    }, [active, busy]);

    const clear = useCallback(() => {
        if (!activeId) return;
        clearCharacterTaste(activeId);
        setTaste(null);
        setToast("已清除");
    }, [activeId]);

    // 把某首歌搜出来加进播放队列（需要配网易云；没配就明说）
    const addSong = useCallback(async (title: string, artist: string) => {
        if (!isNeteaseConfigured()) {
            setToast("没有配置网易云 API，只能看不能播");
            return;
        }
        const key = `${title}|${artist}`;
        setAddingTitle(key);
        try {
            const results: NeteaseSearchResult[] = await searchNetease(`${title} ${artist}`.trim(), 5);
            const hit = results.find(item => item.name && title && item.name.includes(title)) ?? results[0];
            if (!hit) {
                setToast("没搜到这首歌");
                return;
            }
            const track: MusicTrack = {
                id: `netease_${hit.id}`,
                title: hit.name || title,
                artist: hit.artists || artist,
                duration: Math.round((hit.duration || 0) / 1000),
                coverUrl: hit.coverUrl,
                liked: false,
                addedAt: new Date().toISOString(),
            };
            const bridge = getMusicControlBridge();
            if (!bridge) {
                setToast("播放器还没准备好，稍后再试");
                return;
            }
            const res = await bridge.addToQueue([track]);
            setToast(res.ok ? `已加入：${track.title}` : res.message);
        } catch {
            setToast("加入失败，检查网易云 API 配置");
        } finally {
            setAddingTitle(null);
        }
    }, []);

    const addAll = useCallback(async () => {
        if (!taste || taste.songs.length === 0) return;
        if (!isNeteaseConfigured()) {
            setToast("没有配置网易云 API，只能看不能播");
            return;
        }
        setBusy(true);
        try {
            const tracks: MusicTrack[] = [];
            for (const song of taste.songs) {
                const results = await searchNetease(`${song.title} ${song.artist}`.trim(), 3);
                const hit = results[0];
                if (!hit) continue;
                tracks.push({
                    id: `netease_${hit.id}`,
                    title: hit.name || song.title,
                    artist: hit.artists || song.artist,
                    duration: Math.round((hit.duration || 0) / 1000),
                    coverUrl: hit.coverUrl,
                    liked: false,
                    addedAt: new Date().toISOString(),
                });
            }
            if (tracks.length === 0) {
                setToast("一首都没搜到");
                return;
            }
            const bridge = getMusicControlBridge();
            if (!bridge) {
                setToast("播放器还没准备好，稍后再试");
                return;
            }
            const res = await bridge.addToQueue(tracks);
            setToast(res.ok ? `已加入 ${tracks.length} 首` : res.message);
        } finally {
            setBusy(false);
        }
    }, [taste]);

    return (
        <div className="ct-page">
            <div className="ct-nav">
                <button className="ct-back" onClick={onClose} aria-label="返回">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M15 19 8 12l7-7" />
                    </svg>
                </button>
                <b>TA 的歌单</b>
            </div>

            {characters.length === 0 ? (
                <div className="ct-empty">还没有角色。先去建一个角色，再来给 TA 生成歌单。</div>
            ) : (
                <>
                    <div className="ct-chars">
                        {characters.map(character => (
                            <button
                                key={character.id}
                                className="ct-char"
                                {...(character.id === activeId ? { "data-on": "" } : {})}
                                onClick={() => setActiveId(character.id)}
                            >
                                {character.avatar ? (
                                    <img src={character.avatar} alt="" />
                                ) : (
                                    <span>{(character.name || "?").slice(0, 1)}</span>
                                )}
                                <em>{character.name || "未命名"}</em>
                            </button>
                        ))}
                    </div>

                    {error && <div className="ct-error">{error}</div>}

                    {!taste ? (
                        <div className="ct-empty">
                            <p>还没给{active?.name || "这个角色"}生成过音乐偏好。</p>
                            <p className="ct-empty-sub">会按 TA 的人设推出一套口味和一份私人歌单。</p>
                            <button className="ct-primary" onClick={() => void regenerate()} disabled={busy}>
                                {busy ? "生成中…" : "生成 TA 的歌单"}
                            </button>
                        </div>
                    ) : (
                        <div className="ct-body">
                            <div className="ct-meta">
                                {taste.genres.length > 0 && (
                                    <div className="ct-tags">
                                        {taste.genres.map(genre => (
                                            <span key={genre} className="ct-tag">{genre}</span>
                                        ))}
                                    </div>
                                )}
                                {taste.artists.length > 0 && (
                                    <div className="ct-line">常听：{taste.artists.join("、")}</div>
                                )}
                                {taste.habit && <div className="ct-line">{taste.habit}</div>}
                            </div>

                            <div className="ct-actions">
                                <button className="ct-ghost" onClick={() => void regenerate()} disabled={busy}>
                                    {busy ? "生成中…" : "重新生成"}
                                </button>
                                <button className="ct-ghost" onClick={() => void addAll()} disabled={busy}>
                                    全部加入队列
                                </button>
                                <button className="ct-ghost ct-ghost-danger" onClick={clear}>清除</button>
                            </div>

                            <div className="ct-songs">
                                {taste.songs.map((song, index) => {
                                    const key = `${song.title}|${song.artist}`;
                                    return (
                                        <div key={`${key}_${index}`} className="ct-song">
                                            <div className="ct-song-idx">{index + 1}</div>
                                            <div className="ct-song-info">
                                                <div className="ct-song-title">{song.title}</div>
                                                <div className="ct-song-artist">{song.artist}</div>
                                                {song.why && <div className="ct-song-why">{song.why}</div>}
                                            </div>
                                            <button
                                                className="ct-song-add"
                                                onClick={() => void addSong(song.title, song.artist)}
                                                disabled={addingTitle === key}
                                                title="加入播放队列"
                                            >
                                                {addingTitle === key ? "…" : "+"}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </>
            )}

            {toast && <div className="ct-toast">{toast}</div>}
        </div>
    );
}
