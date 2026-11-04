"use client";

// 外观 → 开屏动画：保存的多套开屏，每个搭配一个随机池。
// 勾选 = 放进当前搭配的随机池；全部没勾时放 float 原版。float 原版也算一套，可以删，删了能恢复。

import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/modal";
import { Switch } from "@/components/night/night-mode-card";
import { DAY_SET_ID, listLookSets, useNightRevision } from "@/lib/night-mode";
import { stillSplashStage } from "@/lib/splash-effects";
import {
    SPLASH_FLOAT_ID,
    copySplash,
    deleteSplash,
    ensureSplashFonts,
    followsDayPool,
    makeSplashConfig,
    renameSplash,
    restoreFloatSplash,
    setSplashAutoEnter,
    setSplashFollowDay,
    splashPool,
    toggleSplashInPool,
    useSplashLibrary,
    type SplashConfig,
} from "@/lib/splash-store";
import { getThemeAssetMap } from "@/lib/theme-storage";
import { SplashEditor } from "./splash-editor";

function SplashThumb({ config, imageUrl }: { config: SplashConfig; imageUrl: string | null }) {
    const ref = useRef<HTMLSpanElement | null>(null);
    useEffect(() => {
        if (ref.current) stillSplashStage(ref.current, config, imageUrl);
    }, [config, imageUrl]);
    return <span ref={ref} className="splash-thumb-stage" aria-hidden="true" />;
}

type Tile = { id: string; name: string; config: SplashConfig | null };
type Menu = { id: string; left: number; top: number; renaming: boolean };

export function SplashLibraryPage({ initialSet, onNotice }: { initialSet: string; onNotice: (text: string) => void }) {
    useNightRevision();
    const library = useSplashLibrary();
    const sets = listLookSets();
    const [setId, setSetId] = useState(sets.some((set) => set.id === initialSet) ? initialSet : DAY_SET_ID);
    const [images, setImages] = useState<Record<string, string>>({});
    const [editing, setEditing] = useState<{ config: SplashConfig; isNew: boolean } | null>(null);
    const [menu, setMenu] = useState<Menu | null>(null);
    const [renameText, setRenameText] = useState("");
    const [deleting, setDeleting] = useState<SplashConfig | null>(null);
    const pageRef = useRef<HTMLDivElement | null>(null);
    const [fontsReady, setFontsReady] = useState(0);

    const imageIds = useMemo(() => library.splashes.map((splash) => splash.imageAssetId).filter((id): id is string => Boolean(id)), [library.splashes]);
    const imageKey = imageIds.join(",");
    useEffect(() => {
        let cancelled = false;
        void getThemeAssetMap(imageIds).then((map) => { if (!cancelled) setImages(map); }).catch(() => undefined);
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imageKey]);

    const fontKey = library.fonts.map((font) => font.id).join(",");
    useEffect(() => {
        void ensureSplashFonts(library.fonts).then(() => setFontsReady((value) => value + 1));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fontKey]);

    useEffect(() => {
        if (!menu) return;
        const close = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target?.closest?.(".splash-menu, .splash-tile-more")) setMenu(null);
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [menu]);

    const following = followsDayPool(library, setId);
    const pool = splashPool(library, setId);
    const hint = following
        ? (pool.length ? `跟随日间 · ${pool.length} 套` : "跟随日间 · float 原版")
        : pool.length === 0 ? "全部没选时放 float 原版" : pool.length === 1 ? "固定用这一套" : `每次随机 ${pool.length} 套`;

    const tiles: Tile[] = [
        ...(library.floatRemoved ? [] : [{ id: SPLASH_FLOAT_ID, name: "float 默认", config: null }]),
        ...library.splashes.map((config) => ({ id: config.id, name: config.name, config })),
    ];

    const openMenu = (tile: Tile, button: HTMLElement) => {
        const host = pageRef.current?.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        if (!host) return;
        setRenameText(tile.name);
        setMenu({ id: tile.id, left: Math.min(rect.left - host.left, host.width - 136), top: rect.bottom - host.top + (pageRef.current?.scrollTop ?? 0) + 4, renaming: false });
    };
    const menuTile = menu ? tiles.find((tile) => tile.id === menu.id) : undefined;

    const removeTile = async (tile: Tile) => {
        setMenu(null);
        if (tile.config) {
            setDeleting(tile.config);
            return;
        }
        await deleteSplash(tile.id);
    };

    return (
        <div ref={pageRef} className="theme-section-page splash-lib" data-bottom-reserve>
            <h3 className="appearance-menu-section-title">搭配</h3>
            <div className="splash-chips" role="radiogroup" aria-label="给哪套搭配选开屏">
                {sets.map((set) => (
                    <button key={set.id} type="button" role="radio" aria-checked={set.id === setId} className="splash-chip" data-on={set.id === setId ? "true" : undefined} onClick={() => { setSetId(set.id); setMenu(null); }}>
                        {set.name}
                    </button>
                ))}
            </div>
            {setId !== DAY_SET_ID ? (
                <div className="splash-card">
                    <div className="splash-row">
                        <span className="menu-label">跟随日间</span>
                        <Switch on={following} label="跟随日间" onChange={(on) => setSplashFollowDay(setId, on)} />
                    </div>
                </div>
            ) : null}

            <div className="splash-lib-head">
                <h3 className="appearance-menu-section-title">随机池</h3>
                <span className="menu-desc">{hint}</span>
            </div>
            <div className="splash-card splash-grid" data-revision={fontsReady}>
                {tiles.map((tile) => {
                    const on = pool.includes(tile.id);
                    return (
                        <div key={tile.id} className="splash-tile">
                            <button
                                type="button"
                                className="splash-thumb"
                                aria-label={tile.config ? `编辑${tile.name}` : tile.name}
                                onClick={() => {
                                    setMenu(null);
                                    if (tile.config) setEditing({ config: tile.config, isNew: false });
                                    else onNotice("float 默认开屏不能改内容");
                                }}
                            >
                                {tile.config
                                    ? <SplashThumb config={tile.config} imageUrl={tile.config.imageAssetId ? images[tile.config.imageAssetId] ?? null : null} />
                                    : <span className="splash-thumb-float">float</span>}
                            </button>
                            <button type="button" className="splash-tile-more" aria-label={`${tile.name}的更多操作`} onClick={(event) => openMenu(tile, event.currentTarget)}>···</button>
                            <span className="splash-tile-name">{tile.name}</span>
                            <button
                                type="button"
                                className="splash-tile-check"
                                aria-pressed={on}
                                aria-label={`${tile.name}${on ? "移出随机池" : "放进随机池"}`}
                                disabled={following}
                                onClick={() => toggleSplashInPool(setId, tile.id)}
                            >
                                <span className="night-card-radio" data-on={on ? "true" : undefined} aria-hidden="true" />
                            </button>
                        </div>
                    );
                })}
                <div className="splash-tile">
                    <button type="button" className="splash-thumb splash-thumb-add" aria-label="新建开屏" onClick={() => setEditing({ config: makeSplashConfig(), isNew: true })}>+</button>
                    <span className="splash-tile-name">新建</span>
                </div>
            </div>
            {library.floatRemoved ? <button type="button" className="splash-link" onClick={restoreFloatSplash}>恢复 float 默认开屏</button> : null}

            <h3 className="appearance-menu-section-title">设置</h3>
            <div className="splash-card">
                <div className="splash-row">
                    <span className="splash-row-text">
                        <span className="menu-label">播完自动进入</span>
                        <span className="menu-desc">字停住后直接进桌面，不用点箭头</span>
                    </span>
                    <Switch on={library.autoEnter} label="播完自动进入" onChange={setSplashAutoEnter} />
                </div>
            </div>

            {menu && menuTile ? (
                <div className="splash-menu" style={{ left: menu.left, top: menu.top }}>
                    {menu.renaming && menuTile.config ? (
                        <>
                            <input aria-label="开屏名字" value={renameText} maxLength={12} autoFocus onChange={(event) => setRenameText(event.target.value)} />
                            <button type="button" onClick={() => { if (renameText.trim()) renameSplash(menu.id, renameText.trim()); setMenu(null); }}>确定</button>
                        </>
                    ) : (
                        <>
                            {menuTile.config ? (
                                <>
                                    <button type="button" onClick={() => { setMenu(null); setEditing({ config: menuTile.config as SplashConfig, isNew: false }); }}>编辑</button>
                                    <button type="button" onClick={() => { copySplash(menu.id); setMenu(null); }}>复制一份</button>
                                    <button type="button" onClick={() => setMenu({ ...menu, renaming: true })}>重命名</button>
                                </>
                            ) : null}
                            <button type="button" data-danger="true" onClick={() => { void removeTile(menuTile); }}>删除</button>
                        </>
                    )}
                </div>
            ) : null}

            {deleting ? (
                <ConfirmDialog
                    title={`删除「${deleting.name}」？`}
                    message="这一套开屏和它的图片都会删掉，不能恢复。"
                    confirmLabel="删除"
                    variant="danger"
                    onConfirm={() => { void deleteSplash(deleting.id); setDeleting(null); }}
                    onCancel={() => setDeleting(null)}
                />
            ) : null}

            {editing ? <SplashEditor config={editing.config} isNew={editing.isNew} poolSet={setId} onClose={() => setEditing(null)} onNotice={onNotice} /> : null}
        </div>
    );
}
