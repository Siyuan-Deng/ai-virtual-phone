// components/music/listen-together-layer.tsx
// 「一起听」实时互动层：弹幕气泡 + 随机发言调度器 + 切歌投票 / 弹窗 / 冷却。
//
// 三条硬约束（改动时别破）：
// 1. 层整体 pointer-events: none，只有控制条 / 按钮 / 弹窗局部恢复 auto，
//    否则会把播放器整片区域的点击全吃掉。
// 2. 弹幕最多同时 5 条，右下角堆叠；每条 TTL 7 秒。
// 3. 切歌的打扰程度由「阈值 + 冷却 + 概率」三者共同控制，别只把概率调高就完事。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    appendListenHistory,
    createBubble,
    decideListenSkip,
    generateListenComment,
    getRecentBubbleTexts,
    loadListenSession,
    markCommentLine,
    markSkipDenied,
    markSkipWanted,
    markTrackListened,
    resolveUserLabel,
    type ListenBubble,
    type ListenSession,
} from "@/lib/music-listen-together";

// ── 节奏常量 ───────────────────────────────────────────
const BUBBLE_TTL = 7000;              // 单条弹幕停留
const MAX_BUBBLES = 5;                // 同时最多几条
const SKIP_PROBABILITY = 0.22;        // 每次调度 tick 转去评估切歌的概率
const MIN_EVAL_PLAYED = 60;           // 至少播放 60 秒才评估（秒）
const AUTO_EVAL_GAP_MS = 45_000;      // 两次评估最小间隔
const DENY_COOLDOWN_MS = 3 * 60_000;  // 用户拒绝后的冷却
const AUTO_SKIP_DENY_LIMIT = 3;       // 同会话被拒满 3 次 → 停用自动提议（手动不受影响）
const SOFT_CONFIRM_TTL = 15_000;      // 单人「软确认」按钮存活时间

type Props = {
    track: MusicTrack;
    currentTime: number;
    isPlaying: boolean;
    onNext: () => void;
    onExit: () => void;
};

type SkipVote = { characterId: string; characterName: string; reason: string };

export default function ListenTogetherLayer({ track, currentTime, isPlaying, onNext, onExit }: Props) {
    const [session, setSession] = useState<ListenSession>(() => loadListenSession());
    const [characters] = useState<Character[]>(() => loadCharacters());
    const [bubbles, setBubbles] = useState<ListenBubble[]>([]);
    const [pendingSkip, setPendingSkip] = useState<SkipVote | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [softSkipId, setSoftSkipId] = useState<string | null>(null);

    // ── refs：调度器一律读 ref，避免闭包拿到旧值 ──
    const bubbleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const softSkipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const speakingRef = useRef(false);
    const mountedRef = useRef(true);
    const lastEvalAtRef = useRef(0);
    const denyCountRef = useRef(0);
    const denyCooldownUntilRef = useRef(0);

    const trackRef = useRef(track);
    const currentTimeRef = useRef(currentTime);
    const pendingSkipRef = useRef<SkipVote | null>(null);
    trackRef.current = track;
    currentTimeRef.current = currentTime;
    pendingSkipRef.current = pendingSkip;

    const roster = useMemo(
        () => characters.filter(character => session.characterIds.includes(character.id)),
        [characters, session.characterIds],
    );
    const rosterRef = useRef<Character[]>(roster);
    const sessionRef = useRef(session);
    rosterRef.current = roster;
    sessionRef.current = session;

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // ── 弹幕淡出 ──
    const pushBubble = useCallback((bubble: ListenBubble) => {
        setBubbles(prev => {
            const next = [...prev, bubble];
            const overflow = next.length - MAX_BUBBLES;
            if (overflow > 0) {
                next.splice(0, overflow).forEach(dropped => {
                    const timer = bubbleTimersRef.current.get(dropped.id);
                    if (timer) clearTimeout(timer);
                    bubbleTimersRef.current.delete(dropped.id);
                });
            }
            return next;
        });
        const timer = setTimeout(() => {
            setBubbles(prev => prev.filter(item => item.id !== bubble.id));
            bubbleTimersRef.current.delete(bubble.id);
        }, BUBBLE_TTL);
        bubbleTimersRef.current.set(bubble.id, timer);
    }, []);

    useEffect(() => {
        const timers = bubbleTimersRef.current;
        return () => {
            timers.forEach(timer => clearTimeout(timer));
            timers.clear();
            if (softSkipTimerRef.current) clearTimeout(softSkipTimerRef.current);
        };
    }, []);

    // ── 换歌：清空弹幕、重置冷却、记「陪听过一次」──
    useEffect(() => {
        setBubbles([]);
        bubbleTimersRef.current.forEach(timer => clearTimeout(timer));
        bubbleTimersRef.current.clear();
        setPendingSkip(null);
        setSoftSkipId(null);
        lastEvalAtRef.current = 0;
        denyCountRef.current = 0;
        denyCooldownUntilRef.current = 0;
        if (!track.id) return;
        for (const character of rosterRef.current) markTrackListened(character.id, track.id);
        // 只跟歌走：换角色不该重置会话状态
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track.id]);

    // ── 让某个角色说一句（写历史 + 记情绪）──
    const speak = useCallback(async (character: Character): Promise<ListenBubble | null> => {
        const current = trackRef.current;
        const result = await generateListenComment({
            character,
            track: current,
            userLabel: resolveUserLabel(character.id),
            recentTexts: getRecentBubbleTexts(current.id),
        });
        if (!result.text) {
            if (result.error && mountedRef.current) setError(result.error);
            return null;
        }
        if (mountedRef.current) setError(null);
        const bubble = createBubble(character, result.text, "comment");
        appendListenHistory(current.id, bubble);
        markCommentLine(character.id, current.id, result.text);
        if (mountedRef.current) pushBubble(bubble);
        return bubble;
    }, [pushBubble]);

    // ── 手动「一起评」：串行触发全部角色，后面的能看到前面的（顺带验证接话）──
    const runAll = useCallback(async () => {
        if (speakingRef.current || roster.length === 0) return;
        speakingRef.current = true;
        setBusy(true);
        try {
            for (const character of roster) {
                if (!mountedRef.current) break;
                await speak(character);
            }
        } finally {
            speakingRef.current = false;
            if (mountedRef.current) setBusy(false);
        }
    }, [roster, speak]);

    // ── 切歌阈值：按人数动态 ──
    // 1 人=不弹窗，走弹幕内嵌「切歌」软确认；2 人=1 票即弹窗；3 人+=≥2 票或 ≥60%。
    const reachesConsensus = useCallback((votes: number, people: number): boolean => {
        if (people <= 1) return false;
        if (people === 2) return votes >= 1;
        return votes >= 2 || votes / people >= 0.6;
    }, []);

    const acceptSkip = useCallback(() => {
        setPendingSkip(null);
        setSoftSkipId(null);
        if (softSkipTimerRef.current) clearTimeout(softSkipTimerRef.current);
        onNext();
    }, [onNext]);

    const denySkip = useCallback((vote: SkipVote | null) => {
        setPendingSkip(null);
        setSoftSkipId(null);
        if (softSkipTimerRef.current) clearTimeout(softSkipTimerRef.current);
        denyCooldownUntilRef.current = Date.now() + DENY_COOLDOWN_MS;
        denyCountRef.current += 1;
        if (vote) markSkipDenied(vote.characterId, trackRef.current.id);
    }, []);

    const requestSkip = useCallback((vote: SkipVote) => {
        const current = trackRef.current;
        markSkipWanted(vote.characterId, current.id);
        const people = rosterRef.current.length;

        // 单人：不弹窗，弹幕里嵌一个「切歌」小按钮，15 秒没点就消失
        if (!reachesConsensus(1, people)) {
            const bubble = createBubble(
                { id: vote.characterId, name: vote.characterName },
                vote.reason || "这首听得有点腻了，换一首？",
                "skip",
            );
            appendListenHistory(current.id, bubble);
            pushBubble(bubble);
            setSoftSkipId(bubble.id);
            if (softSkipTimerRef.current) clearTimeout(softSkipTimerRef.current);
            softSkipTimerRef.current = setTimeout(() => {
                if (mountedRef.current) setSoftSkipId(null);
            }, SOFT_CONFIRM_TTL);
            return;
        }
        // 多人：凑够票就弹窗
        setPendingSkip(vote);
    }, [pushBubble, reachesConsensus]);

    // ── 一次调度 tick ──
    const tickRef = useRef<() => Promise<void>>(async () => {});
    tickRef.current = async () => {
        if (!mountedRef.current || speakingRef.current) return;
        const people = rosterRef.current;
        if (people.length === 0) return;

        const now = Date.now();
        const canAutoSkip = denyCountRef.current < AUTO_SKIP_DENY_LIMIT
            && now >= denyCooldownUntilRef.current
            && currentTimeRef.current >= MIN_EVAL_PLAYED
            && now - lastEvalAtRef.current >= AUTO_EVAL_GAP_MS
            && !pendingSkipRef.current;

        speakingRef.current = true;
        try {
            if (canAutoSkip && Math.random() < SKIP_PROBABILITY) {
                lastEvalAtRef.current = now;
                const character = people[Math.floor(Math.random() * people.length)];
                const decision = await decideListenSkip({
                    character,
                    track: trackRef.current,
                    userLabel: resolveUserLabel(character.id),
                    playedSeconds: currentTimeRef.current,
                    recentTexts: getRecentBubbleTexts(trackRef.current.id),
                });
                if (decision.error && mountedRef.current) setError(decision.error);
                if (decision.skip && mountedRef.current && !pendingSkipRef.current) {
                    requestSkip({
                        characterId: character.id,
                        characterName: character.name || "角色",
                        reason: decision.reason,
                    });
                }
                return;
            }
            const character = people[Math.floor(Math.random() * people.length)];
            await speak(character);
        } finally {
            speakingRef.current = false;
        }
    };

    // ── 调度循环：暂停就停，恢复就接着跑 ──
    useEffect(() => {
        if (!session.active || roster.length === 0 || !isPlaying) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const nextDelay = () => {
            const { intervalMin, intervalMax } = sessionRef.current;
            const span = Math.max(1, intervalMax - intervalMin);
            return (intervalMin + Math.random() * span) * 1000;
        };

        const loop = () => {
            timer = setTimeout(async () => {
                if (cancelled) return;
                try {
                    await tickRef.current();
                } finally {
                    if (!cancelled) loop();
                }
            }, nextDelay());
        };

        loop();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [session.active, session.intervalMin, session.intervalMax, roster.length, isPlaying]);

    const exit = useCallback(() => {
        setSession(prev => ({ ...prev, active: false }));
        onExit();
    }, [onExit]);

    if (!session.active || roster.length === 0) return null;

    const people = roster.length;

    return (
        <div className="lt-layer">
            {/* 顶部状态条 */}
            <div className="lt-live-bar">
                <span className="lt-live-dot" />
                <b>一起听</b>
                <span className="lt-live-people">
                    {roster.map(character => character.name || "角色").join("、")}
                </span>
                <div className="lt-live-actions">
                    <button className="lt-live-btn" onClick={() => void runAll()} disabled={busy}>
                        {busy ? "说话中" : "一起评"}
                    </button>
                    <button className="lt-live-btn" onClick={exit}>结束</button>
                </div>
            </div>

            {error && <div className="lt-layer-error">{error}</div>}

            {/* 弹幕堆叠 */}
            <div className="lt-bubbles">
                {bubbles.map(bubble => {
                    const character = roster.find(item => item.id === bubble.characterId);
                    const isSoft = bubble.id === softSkipId && bubble.kind === "skip";
                    return (
                        <div key={bubble.id} className="lt-bubble">
                            <span className="lt-bubble-avatar">
                                {character?.avatar ? (
                                    <img src={character.avatar} alt="" />
                                ) : (
                                    <span className="lt-bubble-avatar-text">{(bubble.characterName || "?").slice(0, 1)}</span>
                                )}
                            </span>
                            <div className="lt-bubble-body">
                                <div className="lt-bubble-name">{bubble.characterName}</div>
                                <div className="lt-bubble-text">{bubble.text}</div>
                                {isSoft && (
                                    <button className="lt-bubble-skip" onClick={acceptSkip}>切歌</button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* 多人切歌弹窗 */}
            {pendingSkip && (
                <div className="lt-skip-modal" onClick={() => denySkip(pendingSkip)}>
                    <div className="lt-skip-card" onClick={event => event.stopPropagation()}>
                        <div className="lt-skip-title">{pendingSkip.characterName} 想换一首</div>
                        {pendingSkip.reason && <div className="lt-skip-reason">{pendingSkip.reason}</div>}
                        <div className="lt-skip-tip">{people} 人一起听，够票了才能换</div>
                        <div className="lt-skip-actions">
                            <button className="lt-panel-btn" onClick={() => denySkip(pendingSkip)}>继续听</button>
                            <button className="lt-panel-btn lt-panel-btn-primary" onClick={acceptSkip}>切歌</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
