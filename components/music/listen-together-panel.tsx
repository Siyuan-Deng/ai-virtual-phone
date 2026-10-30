// components/music/listen-together-panel.tsx
// 「一起听」启动前设置面板：选陪听角色、调自动发言间隔。
"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import {
    loadListenSession,
    loadSelectedCharacterIds,
    saveListenSession,
    saveSelectedCharacterIds,
} from "@/lib/music-listen-together";

type Props = {
    onStart: (characterIds: string[], intervalMin: number, intervalMax: number) => void;
    onClose: () => void;
};

export default function ListenTogetherPanel({ onStart, onClose }: Props) {
    const characters = useMemo(() => loadCharacters(), []);
    const [selected, setSelected] = useState<string[]>(() => {
        const saved = loadSelectedCharacterIds();
        const valid = new Set(characters.map(character => character.id));
        return saved.filter(id => valid.has(id));
    });
    const [intervalMin, setIntervalMin] = useState(() => loadListenSession().intervalMin);
    const [intervalMax, setIntervalMax] = useState(() => loadListenSession().intervalMax);

    // 只有人设或性格写过的角色才有话可说；双空的角色直接不列出来
    const ready = useMemo(
        () => characters.filter(character => character.persona?.trim() || character.personality?.trim()),
        [characters],
    );

    // 首次进入且没选过：默认勾上第一个可用角色，省一步
    useEffect(() => {
        if (selected.length > 0 || ready.length === 0) return;
        setSelected([ready[0].id]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggle = (id: string) => {
        setSelected(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
    };

    const start = () => {
        if (selected.length === 0) return;
        const min = Math.max(5, Math.min(300, intervalMin));
        const max = Math.max(min, Math.min(600, intervalMax));
        saveSelectedCharacterIds(selected);
        saveListenSession({
            ...loadListenSession(),
            characterIds: selected,
            intervalMin: min,
            intervalMax: max,
        });
        onStart(selected, min, max);
    };

    return (
        <div className="lt-panel-mask" onClick={onClose}>
            <div className="lt-panel" onClick={event => event.stopPropagation()}>
                <div className="lt-panel-head">
                    <b>一起听</b>
                    <button className="lt-panel-close" onClick={onClose} aria-label="关闭">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="lt-panel-tip">
                    {ready.length === 0
                        ? "还没有写过人设的角色。先到角色编辑器填一段人设，角色才有话可说。"
                        : "选谁来陪你听。TA 会按自己的人设对正在放的歌发弹幕，可能还会主动提议换歌。"}
                </div>

                {ready.length > 0 && (
                    <div className="lt-panel-chars">
                        {ready.map(character => {
                            const checked = selected.includes(character.id);
                            return (
                                <button
                                    key={character.id}
                                    className="lt-panel-char"
                                    {...(checked ? { "data-checked": "" } : {})}
                                    onClick={() => toggle(character.id)}
                                >
                                    <span className="lt-panel-avatar">
                                        {character.avatar ? (
                                            <img src={character.avatar} alt="" />
                                        ) : (
                                            <span className="lt-panel-avatar-text">{(character.name || "?").slice(0, 1)}</span>
                                        )}
                                    </span>
                                    <span className="lt-panel-name">{character.name || "未命名"}</span>
                                    <span className="lt-panel-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                <div className="lt-panel-interval">
                    <div className="lt-panel-interval-row">
                        <span>自动发言间隔</span>
                        <span className="lt-panel-interval-val">{intervalMin}s ~ {intervalMax}s</span>
                    </div>
                    <label className="lt-panel-range">
                        <span>最短</span>
                        <input
                            type="range"
                            min={5}
                            max={300}
                            step={5}
                            value={intervalMin}
                            onChange={event => setIntervalMin(Number(event.target.value))}
                        />
                    </label>
                    <label className="lt-panel-range">
                        <span>最长</span>
                        <input
                            type="range"
                            min={10}
                            max={600}
                            step={5}
                            value={intervalMax}
                            onChange={event => setIntervalMax(Number(event.target.value))}
                        />
                    </label>
                </div>

                <div className="lt-panel-actions">
                    <button className="lt-panel-btn" onClick={onClose}>取消</button>
                    <button
                        className="lt-panel-btn lt-panel-btn-primary"
                        disabled={selected.length === 0}
                        onClick={start}
                    >
                        开始（{selected.length}）
                    </button>
                </div>
            </div>
        </div>
    );
}
