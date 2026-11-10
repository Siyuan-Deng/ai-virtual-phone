// lib/settings-db.ts
// IndexedDB persistence for presets, world books, and regex configs.
// Same pattern as chat-db.ts: in-memory cache + async fire-and-forget writes.

import Dexie from "dexie";
import type { PresetConfig, WorldBookConfig, RegexConfig } from "./settings-types";

// ── Database Schema ──────────────────────────────

class SettingsDatabase extends Dexie {
    presets!: Dexie.Table<PresetConfig, string>;
    worldBooks!: Dexie.Table<WorldBookConfig, string>;
    regexes!: Dexie.Table<RegexConfig, string>;

    constructor() {
        super("AiPhoneSettingsDB");
        this.version(1).stores({
            presets: "id",
            worldBooks: "id",
            regexes: "id",
        });
    }
}

const settingsDb = new SettingsDatabase();

// ── localStorage keys (for migration) ──

const LS_PRESETS_KEY = "ai_phone_presets_v1";
const LS_WORLDBOOKS_KEY = "ai_phone_worldbooks_v1";
const LS_REGEXES_KEY = "ai_phone_regexes_v1";
const LS_MIGRATED_FLAG = "ai_phone_settings_idb_migrated_v1";

// ── In-memory caches ──

let _presets: PresetConfig[] | null = null;
let _worldBooks: WorldBookConfig[] | null = null;
let _regexes: RegexConfig[] | null = null;
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;
let _presetsWriteQueue: Promise<void> = Promise.resolve();

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Hydration (must be called once at startup) ──
// 读不出来不能当成「没有」：以前读失败就把三样都当空的、还标成读完了，界面上世界书正则全是 0，
// 这时候存任何一条，写入会先清空整张表再写——真数据就没了。现在读失败保持「没读完」：
// 没读完时的写入只追加不清空，下次再调用会重读；iOS 后台久了连接会断，当场重开数据库再试一次。

export function hydrateSettingsDb(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = loadSettingsFromDb()
        .catch(async (err) => {
            console.warn("[SettingsDB] Load failed, reopening the database and retrying once:", err);
            settingsDb.close();
            await settingsDb.open();
            await loadSettingsFromDb();
        })
        .then(() => {
            // 读完之前就打开了的页面（世界书、正则、预设）按读到的刷新一遍
            for (const name of ["settings-presets-updated", "settings-worldbooks-updated", "settings-regexes-updated"]) {
                window.dispatchEvent(new CustomEvent(name));
            }
        })
        .catch((err) => {
            console.error("[SettingsDB] Load failed again; leaving storage unhydrated so nothing gets overwritten:", err);
        })
        .finally(() => {
            _hydratePromise = null;
        });
    return _hydratePromise;
}

async function loadSettingsFromDb(): Promise<void> {
    if (_hydrated) return;
    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // Guard against a lost migration flag while IndexedDB still holds data.
        // The flag lives in volatile localStorage; the data lives in durable IDB and
        // can outlive the flag (e.g. clearing the "cache" data module). Re-migrating
        // from now-empty localStorage would shadow real data with empty caches and
        // the next write would wipe IDB — so reuse IDB data when it already exists.
        try {
            const existingCount =
                (await settingsDb.presets.count()) +
                (await settingsDb.worldBooks.count()) +
                (await settingsDb.regexes.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [presets, worldBooks, regexes] = await Promise.all([
                    settingsDb.presets.toArray(),
                    settingsDb.worldBooks.toArray(),
                    settingsDb.regexes.toArray(),
                ]);
                _presets = presets;
                _worldBooks = worldBooks;
                _regexes = regexes;
                _hydrated = true;
                console.log(`[SettingsDB] Migration flag missing but IndexedDB has data; reusing it: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
                return;
            }
        } catch (err) {
            // 查不了库里有没有东西，就不能拿 localStorage（多半是空的）去迁移盖掉它
            console.warn("[SettingsDB] Pre-migration IndexedDB check failed:", err);
            throw err;
        }

        // Migrate from localStorage → IndexedDB
        try {
            const lsPresets: PresetConfig[] = safeParse(window.localStorage.getItem(LS_PRESETS_KEY));
            const lsWorldBooks: WorldBookConfig[] = safeParse(window.localStorage.getItem(LS_WORLDBOOKS_KEY));
            const lsRegexes: RegexConfig[] = safeParse(window.localStorage.getItem(LS_REGEXES_KEY));

            if (lsPresets.length > 0) await settingsDb.presets.bulkPut(lsPresets);
            if (lsWorldBooks.length > 0) await settingsDb.worldBooks.bulkPut(lsWorldBooks);
            if (lsRegexes.length > 0) await settingsDb.regexes.bulkPut(lsRegexes);

            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_PRESETS_KEY);
            window.localStorage.removeItem(LS_WORLDBOOKS_KEY);
            window.localStorage.removeItem(LS_REGEXES_KEY);

            console.log(`[SettingsDB] Migrated: ${lsPresets.length} presets, ${lsWorldBooks.length} worldBooks, ${lsRegexes.length} regexes`);

            _presets = lsPresets;
            _worldBooks = lsWorldBooks;
            _regexes = lsRegexes;
        } catch (err) {
            console.error("[SettingsDB] Migration failed, falling back to localStorage:", err);
            _presets = safeParse(window.localStorage.getItem(LS_PRESETS_KEY));
            _worldBooks = safeParse(window.localStorage.getItem(LS_WORLDBOOKS_KEY));
            _regexes = safeParse(window.localStorage.getItem(LS_REGEXES_KEY));
        }
    } else {
        // Already migrated: load from IndexedDB
        try {
            const [presets, worldBooks, regexes] = await Promise.all([
                settingsDb.presets.toArray(),
                settingsDb.worldBooks.toArray(),
                settingsDb.regexes.toArray(),
            ]);
            _presets = presets;
            _worldBooks = worldBooks;
            _regexes = regexes;
            console.log(`[SettingsDB] Loaded: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
        } catch (err) {
            console.error("[SettingsDB] Failed to load from IndexedDB:", err);
            throw err;
        }
    }
    _hydrated = true;
}

export function isSettingsHydrated(): boolean {
    return _hydrated;
}

// ── Sync reads from cache ──

export function readPresetsCache(): PresetConfig[] {
    return _presets ?? [];
}

export function readWorldBooksCache(): WorldBookConfig[] {
    return _worldBooks ?? [];
}

export function readRegexesCache(): RegexConfig[] {
    return _regexes ?? [];
}

// ── Writes: update cache + async persist ──

// clear + bulkPut are wrapped in a single transaction so a crash/close between
// them can never leave the store emptied. (Matches dbReplaceContacts in chat-db.)
function persistPresetsSnapshot(presets: PresetConfig[]): Promise<void> {
    return settingsDb.transaction("rw", settingsDb.presets, async () => {
        await settingsDb.presets.clear();
        await settingsDb.presets.bulkPut(presets);
    });
}

function enqueuePresetsPersist(presets: PresetConfig[], warnInQueue: boolean): Promise<void> {
    const task = _presetsWriteQueue.then(() => persistPresetsSnapshot(presets));
    _presetsWriteQueue = task.catch(err => {
        if (warnInQueue) console.warn("[SettingsDB] save presets failed:", err);
    });
    return task;
}

export function writePresetsCache(presets: PresetConfig[]): void {
    _presets = presets;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCache before hydration; using additive write to avoid replacing existing presets.");
        settingsDb.presets.bulkPut(presets).catch(err => console.warn("[SettingsDB] additive save presets failed:", err));
        return;
    }
    void enqueuePresetsPersist(presets, true);
}

export async function writePresetsCacheAsync(presets: PresetConfig[]): Promise<void> {
    _presets = presets;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCacheAsync before hydration; using additive write to avoid replacing existing presets.");
        await settingsDb.presets.bulkPut(presets);
        return;
    }
    try {
        await enqueuePresetsPersist(presets, false);
    } catch (err) {
        console.warn("[SettingsDB] save presets failed:", err);
        throw err;
    }
}

export function writeWorldBooksCache(books: WorldBookConfig[]): void {
    _worldBooks = books;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeWorldBooksCache before hydration; using additive write to avoid replacing existing worldBooks.");
        settingsDb.worldBooks.bulkPut(books).catch(err => console.warn("[SettingsDB] additive save worldBooks failed:", err));
        return;
    }
    settingsDb.transaction("rw", settingsDb.worldBooks, async () => {
        await settingsDb.worldBooks.clear();
        await settingsDb.worldBooks.bulkPut(books);
    }).catch(err => console.warn("[SettingsDB] save worldBooks failed:", err));
}

export function writeRegexesCache(regexes: RegexConfig[]): void {
    _regexes = regexes;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeRegexesCache before hydration; using additive write to avoid replacing existing regexes.");
        settingsDb.regexes.bulkPut(regexes).catch(err => console.warn("[SettingsDB] additive save regexes failed:", err));
        return;
    }
    settingsDb.transaction("rw", settingsDb.regexes, async () => {
        await settingsDb.regexes.clear();
        await settingsDb.regexes.bulkPut(regexes);
    }).catch(err => console.warn("[SettingsDB] save regexes failed:", err));
}
