// components/music/listen-together-panel.tsx
// 「一起听」启动面板：1v1 选择、聊天/最近一起听排序、关系距离与累计时长。
"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatMessages, loadChatSessions } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
    formatListenDuration,
    getListenRelation,
    loadListenSession,
    loadSelectedCharacterIds,
    markListenStarted,
    saveListenDistance,
    saveListenSession,
    saveSelectedCharacterIds,
} from "@/lib/music-listen-together";

type Props = {
    onStart: (characterIds: string[], intervalMin: number, intervalMax: number) => void;
    onClose: () => void;
};
type SortMode = "chat" | "recent";

function formatDistance(distanceKm: number | null): string {
    return distanceKm === null ? "就在你身边" : `${distanceKm} km`;
}

export default function ListenTogetherPanel({ onStart, onClose }: Props) {
    const characters = useMemo(() => loadCharacters(), []);
    const [selected, setSelected] = useState<string[]>(() => loadSelectedCharacterIds().slice(0, 1));
    const [sortMode, setSortMode] = useState<SortMode>("chat");
    const [distance, setDistance] = useState<number | null>(() => {
        const id = loadSelectedCharacterIds()[0];
        return id ? getListenRelation(id).distanceKm : null;
    });
    const [distanceDraft, setDistanceDraft] = useState("");
    const [intervalMin, setIntervalMin] = useState(() => loadListenSession().intervalMin);
    const [intervalMax, setIntervalMax] = useState(() => loadListenSession().intervalMax);
    const [userAvatar, setUserAvatar] = useState<string | undefined>();

    const ready = useMemo(
        () => characters.filter(character => character.persona?.trim() || character.personality?.trim()),
        [characters],
    );

    useEffect(() => {
        const identity = resolveUserIdentity();
        setUserAvatar(identity?.avatarUrl);
    }, []);

    const chatCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const session of loadChatSessions()) {
            if (session.isGroup) continue;
            const count = loadChatMessages(session.id).length;
            counts.set(session.contactId, count);
        }
        return counts;
    }, []);

    const sortedCharacters = useMemo(() => {
        return [...ready].sort((a, b) => {
            const ar = getListenRelation(a.id);
            const br = getListenRelation(b.id);
            const av = sortMode === "chat" ? (chatCounts.get(a.id) || 0) : ar.lastListenedAt;
            const bv = sortMode === "chat" ? (chatCounts.get(b.id) || 0) : br.lastListenedAt;
            if (bv !== av) return bv - av;
            return (a.name || "").localeCompare(b.name || "");
        });
    }, [chatCounts, ready, sortMode]);

    const activeId = selected[0] || "";
    const activeCharacter = characters.find(character => character.id === activeId);
    const activeRelation = activeId ? getListenRelation(activeId) : null;

    useEffect(() => {
        if (selected.length > 0 || sortedCharacters.length === 0) return;
        setSelected([sortedCharacters[0].id]);
    }, [selected.length, sortedCharacters]);

    const choose = (id: string) => {
        setSelected([id]);
        const nextDistance = getListenRelation(id).distanceKm;
        setDistance(nextDistance);
        setDistanceDraft(nextDistance === null ? "" : String(nextDistance));
    };

    const applyDistance = (next: number | null) => {
        if (!activeId) return;
        setDistance(next);
        saveListenDistance(activeId, next);
        setDistanceDraft(next === null ? "" : String(next));
    };

    const start = () => {
        if (!activeId) return;
        const min = Math.max(5, Math.min(300, intervalMin));
        const max = Math.max(min, Math.min(600, intervalMax));
        saveSelectedCharacterIds([activeId]);
        markListenStarted([activeId]);
        saveListenSession({ ...loadListenSession(), characterIds: [activeId], intervalMin: min, intervalMax: max });
        onStart([activeId], min, max);
    };

    return (
        <div className="lt-panel-mask" onClick={onClose}>
            <div className="lt-panel lt-panel-official" onClick={event => event.stopPropagation()}>
                <div className="lt-panel-head">
                    <div>
                        <span className="lt-panel-eyebrow">LISTEN TOGETHER</span>
                        <b>一起听</b>
                    </div>
                    <button className="lt-panel-close" onClick={onClose} aria-label="关闭">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                <div className="lt-pair-preview">
                    <div className="lt-pair-avatars">
                        <span className="lt-pair-avatar lt-pair-avatar-user">
                            {userAvatar ? <img src={userAvatar} alt="" /> : <span>我</span>}
                        </span>
                        <span className="lt-pair-avatar lt-pair-avatar-character">
                            {activeCharacter?.avatar ? <img src={activeCharacter.avatar} alt="" /> : <span>{(activeCharacter?.name || "?").slice(0, 1)}</span>}
                        </span>
                    </div>
                    <div className="lt-pair-copy">
                        <strong>和 {activeCharacter?.name || "TA"} 一起听</strong>
                        <span>已一起听 {formatListenDuration(activeRelation?.listenedSeconds || 0)}</span>
                    </div>
                </div>

                <div className="lt-panel-section">
                    <div className="lt-section-title"><b>选择陪听对象</b><span>{ready.length} 位可用角色</span></div>
                    <div className="lt-sort-tabs" role="tablist">
                        <button className="lt-sort-tab" {...(sortMode === "chat" ? { "data-on": "" } : {})} onClick={() => setSortMode("chat")}>聊天最多</button>
                        <button className="lt-sort-tab" {...(sortMode === "recent" ? { "data-on": "" } : {})} onClick={() => setSortMode("recent")}>最近一起听</button>
                    </div>
                    {ready.length === 0 ? (
                        <div className="lt-panel-empty">还没有写过人设的角色。先到角色编辑器填一段人设。</div>
                    ) : (
                        <div className="lt-panel-chars lt-panel-chars-official">
                            {sortedCharacters.map(character => {
                                const checked = character.id === activeId;
                                const relation = getListenRelation(character.id);
                                const count = chatCounts.get(character.id) || 0;
                                return (
                                    <button key={character.id} className="lt-panel-char" {...(checked ? { "data-checked": "" } : {})} onClick={() => choose(character.id)}>
                                        <span className="lt-panel-avatar">{character.avatar ? <img src={character.avatar} alt="" /> : <span className="lt-panel-avatar-text">{(character.name || "?").slice(0, 1)}</span>}</span>
                                        <span className="lt-panel-name-wrap"><span className="lt-panel-name">{character.name || "未命名"}</span><small>{sortMode === "chat" ? `${count} 条聊天` : relation.lastListenedAt ? "最近一起听过" : "还未一起听过"}</small></span>
                                        <span className="lt-panel-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="lt-panel-section lt-distance-section">
                    <div className="lt-section-title"><b>你们之间的距离</b><span>{formatDistance(distance)}</span></div>
                    <div className="lt-distance-options">
                        <button className="lt-distance-option" {...(distance === null ? { "data-on": "" } : {})} onClick={() => applyDistance(null)}>就在你身边</button>
                        <label className="lt-distance-custom" data-on={distance !== null ? "" : undefined}>
                            <span>距离</span>
                            <input type="number" min="0" step="0.1" value={distanceDraft} placeholder="输入" onChange={event => { setDistanceDraft(event.target.value); const value = Number(event.target.value); if (event.target.value !== "" && Number.isFinite(value)) applyDistance(value); }} />
                            <span>km</span>
                        </label>
                    </div>
                </div>

                <div className="lt-panel-section lt-interval-section">
                    <div className="lt-section-title"><b>自动发言间隔</b><span>{intervalMin}s – {intervalMax}s</span></div>
                    <div className="lt-range-row"><span>最短</span><input type="range" min={5} max={300} step={5} value={intervalMin} onChange={event => setIntervalMin(Number(event.target.value))} /></div>
                    <div className="lt-range-row"><span>最长</span><input type="range" min={10} max={600} step={5} value={intervalMax} onChange={event => setIntervalMax(Number(event.target.value))} /></div>
                </div>

                <button className="lt-start-button" disabled={!activeId} onClick={start}>开始一起听</button>
            </div>
        </div>
    );
}
