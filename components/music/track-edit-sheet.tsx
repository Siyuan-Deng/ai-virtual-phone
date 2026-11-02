// 「编辑歌曲」：换封面、改歌名歌手、贴歌词或导入 .lrc。
// 本地音乐列表的 ✎ 和播放页右上角的 ✎、歌词页的「添加歌词」打开的都是这一个。
// 改动单独存（lib/music-track-overrides），歌曲本身不动；清空某一项就用回歌曲原来的。
"use client";

import { useRef, useState } from "react";
import type { MusicTrack } from "@/lib/music-storage";
import { coverFileToDataUrl, loadTrackOverride, readLyricsFile, saveTrackOverride } from "@/lib/music-track-overrides";

type Props = {
    /** 没叠改动的原样 */
    track: MusicTrack;
    /** 从「添加歌词」点进来：直接把光标放进歌词框 */
    focusLyrics?: boolean;
    onClose: () => void;
    onSaved?: (message: string) => void;
};

export default function TrackEditSheet({ track, focusLyrics, onClose, onSaved }: Props) {
    const existing = loadTrackOverride(track.id);
    // 空字符串 = 用歌曲原来的封面
    const [cover, setCover] = useState(existing?.coverUrl ?? "");
    const [title, setTitle] = useState(existing?.title ?? track.title);
    const [artist, setArtist] = useState(existing?.artist ?? track.artist);
    const [lyrics, setLyrics] = useState(existing?.lyrics ?? track.lyrics ?? "");
    const [error, setError] = useState("");
    const coverInputRef = useRef<HTMLInputElement>(null);
    const lyricsInputRef = useRef<HTMLInputElement>(null);
    const shownCover = cover || track.coverUrl;

    const pickCover = async (file: File | undefined) => {
        if (!file) return;
        try {
            setCover(await coverFileToDataUrl(file));
            setError("");
        } catch (err) {
            setError(err instanceof Error ? err.message : "图片处理失败");
        }
    };

    const pickLyrics = async (file: File | undefined) => {
        if (!file) return;
        try {
            setLyrics(await readLyricsFile(file));
            setError("");
        } catch {
            setError("歌词文件读不出来");
        }
    };

    const save = () => {
        // 和原来一样的不存，原来的变了（比如网易云更新了歌词）还能跟着变
        saveTrackOverride(track.id, {
            title: title.trim() && title.trim() !== track.title ? title : undefined,
            artist: artist.trim() && artist.trim() !== track.artist ? artist : undefined,
            coverUrl: cover || undefined,
            lyrics: lyrics.trim() && lyrics !== (track.lyrics ?? "") ? lyrics : undefined,
        });
        onSaved?.("已保存");
        onClose();
    };

    return (
        <div className="music-settings-modal-overlay" onClick={onClose}>
            <div className="music-settings-modal-dialog music-track-edit-dialog" onClick={(event) => event.stopPropagation()}>
                <div className="music-settings-header"><h2>编辑歌曲</h2></div>
                <div className="music-settings-body">
                    <div className="music-track-edit-cover-row">
                        <div className="music-track-edit-cover">
                            {shownCover ? <img src={shownCover} alt="" /> : (
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                            )}
                        </div>
                        <div className="music-track-edit-cover-side">
                            <span className="music-settings-label">专辑封面</span>
                            <div className="music-settings-actions">
                                <button type="button" className="music-settings-btn" onClick={() => coverInputRef.current?.click()}>上传图片</button>
                                <button type="button" className="music-settings-btn" disabled={!cover} onClick={() => setCover("")}>清除</button>
                            </div>
                        </div>
                        <input
                            ref={coverInputRef}
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(event) => { void pickCover(event.target.files?.[0]); event.target.value = ""; }}
                        />
                    </div>

                    <div className="music-settings-section">
                        <span className="music-settings-label">歌名</span>
                        <input className="music-settings-input" value={title} placeholder={track.title} onChange={(event) => setTitle(event.target.value)} />
                    </div>
                    <div className="music-settings-section">
                        <span className="music-settings-label">歌手</span>
                        <input className="music-settings-input" value={artist} placeholder={track.artist || "未知歌手"} onChange={(event) => setArtist(event.target.value)} />
                    </div>

                    <div className="music-settings-section">
                        <div className="music-settings-row">
                            <span className="music-settings-label">歌词</span>
                            <span className="music-settings-label music-track-edit-hint">带时间的 LRC 会跟着滚动，纯文字也能贴</span>
                        </div>
                        <textarea
                            className="music-settings-input music-track-edit-lyrics"
                            value={lyrics}
                            autoFocus={focusLyrics}
                            placeholder={"[00:12.50]第一句歌词\n[00:18.20]第二句歌词"}
                            onChange={(event) => setLyrics(event.target.value)}
                        />
                        <div className="music-settings-actions">
                            <button type="button" className="music-settings-btn" onClick={() => lyricsInputRef.current?.click()}>导入 .lrc 文件</button>
                            <button type="button" className="music-settings-btn" disabled={!lyrics} onClick={() => setLyrics("")}>清空歌词</button>
                        </div>
                        <input
                            ref={lyricsInputRef}
                            type="file"
                            accept=".lrc,.txt,text/plain"
                            hidden
                            onChange={(event) => { void pickLyrics(event.target.files?.[0]); event.target.value = ""; }}
                        />
                    </div>

                    {error ? <div className="music-settings-hint">{error}</div> : null}

                    <div className="music-settings-actions">
                        <button type="button" className="music-settings-btn" onClick={onClose}>取消</button>
                        <button type="button" className="music-settings-btn music-settings-btn-primary" onClick={save}>保存</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
