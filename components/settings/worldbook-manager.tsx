"use client";

import { useState, useEffect, useRef, useContext, useCallback } from "react";
import { Plus, BookOpen, Trash2, Upload, Download, ChevronLeft, AlertCircle, Maximize2, Replace, Copy, Folder, FolderPlus, FolderInput, Pencil, Check, Pin } from "lucide-react";
import {
    loadWorldBooks,
    saveWorldBooks,
    createWorldBook,
    parseWorldBookFromJson,
    loadBindingConfig,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { WorldBookConfig, WorldBookEntry } from "@/lib/settings-types";
import {
    createWorldBookFolder,
    groupWorldBooksByFolder,
    loadWorldBookFolders,
    saveWorldBookFolders,
    type WorldBookFolder,
} from "@/lib/worldbook-folders";
import { applyGroupOrder } from "@/lib/list-order";
import { Toggle } from "@/components/ui/form";
import { SettingsContext } from "../phone-settings-app";
import { useLongPressReorder } from "./use-long-press-reorder";
import { BottomSheet, ConfirmDialog, ContentDialog, TextExpandModal } from "@/components/ui/modal";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { notifyMascotPageContext } from "@/lib/mascot-events";

export function WorldBookManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [books, setBooks] = useState<WorldBookConfig[]>([]);
    const [activeBookId, setActiveBookId] = useState<string>("");
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingUid, setEditingUid] = useState<string | null>(null);
    const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ type: 'book' | 'entry', id: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [expandUid, setExpandUid] = useState<string | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    // 文件夹：currentFolderId 是正在看的文件夹（null = 最外层）
    const [folders, setFolders] = useState<WorldBookFolder[]>([]);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [folderNameDialog, setFolderNameDialog] = useState<{ mode: "create" } | { mode: "rename"; id: string } | null>(null);
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
    const [moveSelection, setMoveSelection] = useState<Set<string> | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadWorldBooks();
        if (loaded.length > 0) {
            setBooks(loaded);
            setActiveBookId(loaded[0]?.id || "");
        }
        setFolders(loadWorldBookFolders());
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newBooks: WorldBookConfig[]) => {
        setBooks(newBooks);
        saveWorldBooks(newBooks);
    }, []);

    const persistFolders = useCallback((next: WorldBookFolder[]) => {
        setFolders(next);
        saveWorldBookFolders(next);
    }, []);

    const currentFolder = currentFolderId ? folders.find(f => f.id === currentFolderId) ?? null : null;

    // 长按卡片拖动排序：文件夹之间、置顶的之间、普通的之间各自换位置
    const reorder = useLongPressReorder((group, orderedIds) => {
        if (group === "folders") {
            const byId = new Map(folders.map(f => [f.id, f]));
            persistFolders(orderedIds.map(id => byId.get(id)).filter((f): f is WorldBookFolder => Boolean(f)));
            return;
        }
        persist(applyGroupOrder(books, orderedIds));
    });

    const wbContainerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && activeBookId) {
            // 从文件夹里点进来的，返回回到那个文件夹
            setOverrideBack(() => () => setViewMode("list"));
            const target = books.find(b => b.id === activeBookId);
            setSubpageTitle(target?.name || "世界书详情");
        } else if (currentFolder) {
            setOverrideBack(() => () => setCurrentFolderId(null));
            setSubpageTitle(currentFolder.name);
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, activeBookId, books, currentFolder, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        const scrollParent = wbContainerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, activeBookId, currentFolderId]);

    // Refresh trigger — incremented when returning from binding page
    const [ctxRefreshKey, setCtxRefreshKey] = useState(0);
    useEffect(() => {
        const onRefresh = () => setCtxRefreshKey(k => k + 1);
        window.addEventListener("worldbook-refresh-context", onRefresh);
        return () => window.removeEventListener("worldbook-refresh-context", onRefresh);
    }, []);

    // Send mascot context when editing a worldbook (only when this tab is active)
    useEffect(() => {
        if (!isActive) return;
        if (viewMode === "detail" && activeBookId) {
            const book = books.find(b => b.id === activeBookId);
            if (!book) return;
            // Reverse-lookup: which characters have this worldbook bound?
            const bindingConfig = loadBindingConfig();
            const characters = loadCharacters();
            const boundNames: string[] = [];
            const boundCharProfiles: string[] = [];
            // Check global defaults
            if (bindingConfig.globalDefaults.worldBookIds?.includes(activeBookId)) {
                boundNames.push("全局默认");
            }
            // Check character bindings
            for (const cb of bindingConfig.characterBindings) {
                const hasIt = cb.defaults.worldBookIds?.includes(activeBookId)
                    || Object.values(cb.appOverrides).some(slot => slot?.worldBookIds?.includes(activeBookId));
                if (hasIt) {
                    const char = characters.find(c => c.id === cb.characterId);
                    if (char) {
                        boundNames.push(char.name);
                        const parts = [`【${char.name}】`];
                        if (char.persona) parts.push(char.persona);
                        if (char.personality) parts.push(`性格: ${char.personality}`);
                        boundCharProfiles.push(parts.join("\n"));
                    }
                }
            }
            // Build entry summaries and full content for context
            const fields: Record<string, string> = {
                worldbookName: book.name,
                worldbookDescription: book.description || "",
                boundCharacters: boundNames.length > 0 ? boundNames.join("、") : "未绑定",
            };
            if (boundCharProfiles.length > 0) {
                fields.characterProfiles = boundCharProfiles.join("\n\n");
            }
            for (const entry of book.entries) {
                const prefix = `entry_${entry.uid}`;
                fields[`${prefix}_comment`] = entry.comment || "";
                fields[`${prefix}_key`] = entry.key;
                fields[`${prefix}_content`] = entry.content;
                fields[`${prefix}_constant`] = entry.constant ? "true" : "false";
                fields[`${prefix}_position`] = String(entry.position);
                fields[`${prefix}_disable`] = entry.disable ? "true" : "false";
            }
            notifyMascotPageContext({
                page: "worldbook",
                mode: "editing",
                label: `世界书 · ${book.name}`,
                fields,
            });
        } else if (viewMode === "list") {
            notifyMascotPageContext({
                page: "worldbook",
                mode: "viewing",
                label: "世界书列表",
                fields: {},
            });
        }
    }, [viewMode, activeBookId, books, ctxRefreshKey, isActive]);

    // Reset mascot context on unmount
    useEffect(() => {
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, []);

    // Debounced save for mascot batch actions — avoids flooding IndexedDB
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = useRef<WorldBookConfig[] | null>(null);
    const debouncedSave = (next: WorldBookConfig[]) => {
        pendingSaveRef.current = next;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            if (pendingSaveRef.current) saveWorldBooks(pendingSaveRef.current);
            pendingSaveRef.current = null;
            saveTimerRef.current = null;
        }, 300);
    };

    // Listen for mascot fill events — uses functional state update to handle rapid batched actions
    const activeBookIdRef = useRef(activeBookId);
    activeBookIdRef.current = activeBookId;

    useEffect(() => {
        const onFill = (e: Event) => {
            const { field, value, _batchId } = (e as CustomEvent).detail;
            const batchId = _batchId || "0";
            const bookId = activeBookIdRef.current;
            if (!bookId) return;

            setBooks(prev => {
                const bookIndex = prev.findIndex(b => b.id === bookId);
                if (bookIndex < 0) return prev;
                const book = prev[bookIndex];
                let updatedBook: WorldBookConfig | null = null;

                if (field === "worldbookName") {
                    updatedBook = { ...book, name: value, updatedAt: Date.now() };
                } else if (field === "worldbookDescription") {
                    updatedBook = { ...book, description: value, updatedAt: Date.now() };
                } else if (field.startsWith("entry_new_")) {
                    const match = field.match(/^entry_new_(\d+)_(\w+)$/);
                    if (match) {
                        const idx = parseInt(match[1], 10);
                        const subfield = match[2];
                        // Use a stable uid per batch+index — different batches never collide
                        const stableUid = `mascot_batch_${batchId}_${idx}`;
                        const entries = [...book.entries];
                        let entryIdx = entries.findIndex(e => e.uid === stableUid);
                        if (entryIdx < 0) {
                            entries.push({
                                uid: stableUid,
                                key: "", content: "", comment: "",
                                use_regex: false, disable: false, constant: false,
                                position: 0, insertion_order: 100, role: 0,
                            });
                            entryIdx = entries.length - 1;
                        }
                        const entry = { ...entries[entryIdx] };
                        if (subfield === "key") entry.key = value;
                        else if (subfield === "content") entry.content = value;
                        else if (subfield === "comment") entry.comment = value;
                        else if (subfield === "constant") entry.constant = value === "true";
                        else if (subfield === "position") entry.position = parseInt(value, 10) || 0;
                        entries[entryIdx] = entry;
                        updatedBook = { ...book, entries, updatedAt: Date.now() };
                    }
                } else if (field.startsWith("entry_") && field.includes("_")) {
                    // Modify existing entry: entry_{uid}_{subfield}
                    // Only changes the specified subfield, all other fields stay intact
                    const lastUnderscore = field.lastIndexOf("_");
                    const subfield = field.slice(lastUnderscore + 1);
                    const uid = field.slice("entry_".length, lastUnderscore);
                    const entryIdx = book.entries.findIndex(e => e.uid === uid);
                    if (entryIdx >= 0) {
                        const entries = [...book.entries];
                        const entry = { ...entries[entryIdx] };
                        if (subfield === "content") entry.content = value;
                        else if (subfield === "key") entry.key = value;
                        else if (subfield === "comment") entry.comment = value;
                        else if (subfield === "constant") entry.constant = value === "true";
                        else if (subfield === "position") entry.position = parseInt(value, 10) || 0;
                        else if (subfield === "disable") entry.disable = value === "true";
                        entries[entryIdx] = entry;
                        updatedBook = { ...book, entries, updatedAt: Date.now() };
                    }
                }

                if (!updatedBook) return prev;
                const next = [...prev];
                next[bookIndex] = updatedBook;
                debouncedSave(next);
                return next;
            });
        };
        window.addEventListener("mascot-fill-field", onFill);
        return () => window.removeEventListener("mascot-fill-field", onFill);
    }, []);

    // --- Book Level Operations ---
    const addBook = useCallback(() => {
        // 在文件夹里新建就直接放进这个文件夹
        const newBook = { ...createWorldBook("新世界书"), ...(currentFolderId ? { folderId: currentFolderId } : {}) };
        persist([newBook, ...books]);
        setActiveBookId(newBook.id);
        setViewMode("detail");
    }, [books, currentFolderId, persist]);

    /** 复制一份：条目全部带上（换新 uid），放在同一个文件夹，打开副本 */
    const duplicateBook = (book: WorldBookConfig) => {
        const source = JSON.parse(JSON.stringify(book)) as WorldBookConfig;
        const base = createWorldBook(`${source.name || "世界书"} 副本`);
        const copy: WorldBookConfig = {
            ...source,
            id: base.id,
            name: base.name,
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
            entries: (source.entries || []).map((entry, index) => ({ ...entry, uid: `wb-entry-${base.createdAt}-${index}` })),
            pinned: undefined,
        };
        persist([copy, ...books]);
        setActiveBookId(copy.id);
        setEditingUid(null);
        setViewMode("detail");
    };

    // --- Folder Operations ---
    const openFolderNameDialog = (dialog: { mode: "create" } | { mode: "rename"; id: string }) => {
        setFolderNameDraft(dialog.mode === "rename" ? folders.find(f => f.id === dialog.id)?.name ?? "" : "");
        setFolderNameDialog(dialog);
    };

    const submitFolderName = () => {
        const dialog = folderNameDialog;
        if (!dialog) return;
        setFolderNameDialog(null);
        if (dialog.mode === "create") {
            const folder = createWorldBookFolder(folderNameDraft);
            persistFolders([folder, ...folders]);
            // 建好直接进去，方便马上把世界书移进来
            setCurrentFolderId(folder.id);
            return;
        }
        const name = folderNameDraft.trim().slice(0, 40);
        if (!name) return;
        persistFolders(folders.map(f => f.id === dialog.id ? { ...f, name } : f));
    };

    const removeFolder = (folderId: string) => {
        persistFolders(folders.filter(f => f.id !== folderId));
        // 里面的世界书回到未分类
        if (books.some(b => b.folderId === folderId)) {
            persist(books.map(b => b.folderId === folderId ? { ...b, folderId: undefined, updatedAt: Date.now() } : b));
        }
        if (currentFolderId === folderId) setCurrentFolderId(null);
    };

    const moveBooksToFolder = (bookIds: Set<string>, folderId: string | undefined) => {
        if (bookIds.size === 0) return;
        persist(books.map(b => bookIds.has(b.id) ? { ...b, folderId, updatedAt: Date.now() } : b));
    };

    useEffect(() => {
        if (viewMode !== "list") {
            setSubpageRightAction("worldbook", null);
            return;
        }
        setSubpageRightAction("worldbook",
            <div className="flex items-center gap-2">
                {/* 三个都只放图标、不带阴影；文件夹只有一层，在文件夹里面不再显示「新建文件夹」 */}
                {currentFolderId ? null : (
                    <button
                        type="button"
                        onClick={() => openFolderNameDialog({ mode: "create" })}
                        aria-label="新建文件夹"
                        title="新建文件夹"
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-gray-800 transition-all hover:bg-gray-50 active:scale-95 focus:outline-none"
                    >
                        <FolderPlus size={16} strokeWidth={1.8} />
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="导入世界书"
                    title="导入世界书"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-gray-800 transition-all hover:bg-gray-50 active:scale-95 focus:outline-none"
                >
                    <Upload size={16} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    onClick={addBook}
                    aria-label="新建世界书"
                    title="新建世界书"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-all hover:bg-gray-800 active:scale-95 focus:outline-none"
                >
                    <Plus size={16} strokeWidth={1.8} />
                </button>
            </div>
        );
        return () => setSubpageRightAction("worldbook", null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addBook, setSubpageRightAction, viewMode, currentFolderId, folders]);

    const updateBook = (id: string, updates: Partial<WorldBookConfig>) => {
        persist(books.map(b => b.id === id ? { ...b, ...updates, updatedAt: Date.now() } : b));
    };

    const removeBook = (id: string) => {
        const remaining = books.filter(b => b.id !== id);
        persist(remaining);
        setViewMode("list");
        if (remaining.length > 0) {
            setActiveBookId(remaining[0].id);
        } else {
            setActiveBookId("");
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const parsed = parseWorldBookFromJson(text);
                if (parsed) {
                    // 在文件夹里导入就放进这个文件夹
                    if (currentFolderId) parsed.folderId = currentFolderId;
                    persist([parsed, ...books]);
                    setActiveBookId(parsed.id);
                } else {
                    setImportError("无法解析世界书文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该世界书格式");
                } else {
                    setImportError("无法解析世界书文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleExport = async (book: WorldBookConfig) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(book, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${book.name || "worldbook"}.json`);
    };

    // --- Entry Level Operations ---
    const activeBook = books.find(b => b.id === activeBookId);

    const visibleEntries = activeBook?.entries || [];

    // ── 条目左滑操作（微信式：左滑露出「新增/删除」） ──
    const swipe = useSwipeActions();

    const makeNewEntry = (): WorldBookEntry => ({
        uid: `wb-entry-${Date.now()}`,
        key: "",
        content: "",
        comment: "",
        use_regex: false,
        disable: false,
        constant: false,
        position: 4,
        depth: 4,
        probability: 100,
        useProbability: false,
        role: 0,
        insertion_order: 50,
    });

    const addEntry = () => {
        if (!activeBook) return;
        const newEntry = makeNewEntry();
        updateBook(activeBook.id, { entries: [newEntry, ...(activeBook.entries || [])] });
        setEditingUid(newEntry.uid);
    };

    const insertEntryAfter = (afterUid: string) => {
        if (!activeBook) return;
        const newEntry = makeNewEntry();
        const entries = [...(activeBook.entries || [])];
        const idx = entries.findIndex(e => e.uid === afterUid);
        if (idx >= 0) entries.splice(idx + 1, 0, newEntry);
        else entries.push(newEntry);
        updateBook(activeBook.id, { entries });
        swipe.close();
        setEditingUid(newEntry.uid);
        window.setTimeout(() => {
            wbContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(newEntry.uid)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    // ── 条目级导入/导出（左滑「替换/导出」+ 底部「添加条目」菜单） ──
    const [addEntryMenuOpen, setAddEntryMenuOpen] = useState(false);
    const entryFileInputRef = useRef<HTMLInputElement>(null);
    const entryImportModeRef = useRef<{ mode: "append" } | { mode: "replace"; uid: string } | null>(null);

    const sanitizeEntryImport = (raw: unknown, fallbackUid: string): WorldBookEntry | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.content !== "string" && typeof obj.comment !== "string" && typeof obj.key !== "string" && !Array.isArray(obj.key)) return null;
        // 兼容酒馆世界书条目：key 可能是字符串数组
        const key = Array.isArray(obj.key)
            ? obj.key.filter((k): k is string => typeof k === "string").join(", ")
            : (typeof obj.key === "string" ? obj.key : "");
        return {
            uid: fallbackUid,
            key,
            content: typeof obj.content === "string" ? obj.content : "",
            comment: typeof obj.comment === "string" ? obj.comment : "",
            use_regex: !!obj.use_regex,
            disable: !!obj.disable,
            constant: !!obj.constant,
            position: typeof obj.position === "number" || typeof obj.position === "string"
                ? obj.position as WorldBookEntry["position"]
                : 4,
            depth: typeof obj.depth === "number" ? obj.depth : 4,
            probability: typeof obj.probability === "number" ? obj.probability : 100,
            useProbability: !!obj.useProbability,
            role: typeof obj.role === "number" ? obj.role : 0,
            insertion_order: typeof obj.insertion_order === "number" ? obj.insertion_order : 50,
        };
    };

    const appendImportedEntries = (book: WorldBookConfig, raws: unknown[]) => {
        const base = Date.now();
        const appended = raws
            .map((raw, i) => sanitizeEntryImport(raw, `wb-entry-${base + i}`))
            .filter((entry): entry is WorldBookEntry => !!entry);
        if (appended.length === 0) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        updateBook(book.id, { entries: [...(book.entries || []), ...appended] });
        if (appended.length === 1) setEditingUid(appended[0].uid);
        window.setTimeout(() => {
            wbContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(appended[0].uid)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    const replaceImportedEntry = (book: WorldBookConfig, targetUid: string, raw: unknown) => {
        const sanitized = sanitizeEntryImport(raw, targetUid);
        if (!sanitized) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        // 保留原 uid，只替换内容
        const finalEntry = { ...sanitized, uid: targetUid };
        updateBook(book.id, { entries: (book.entries || []).map(e => e.uid === targetUid ? finalEntry : e) });
    };

    const exportEntry = async (entry: WorldBookEntry) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${entry.comment || entry.key || "worldbook-entry"}.json`);
    };

    const handleEntryImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const mode = entryImportModeRef.current;
        entryImportModeRef.current = null;
        if (entryFileInputRef.current) entryFileInputRef.current.value = "";
        if (!file || !mode) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const book = books.find(b => b.id === activeBookId);
            if (!book) return;
            try {
                const parsed = JSON.parse(event.target?.result as string);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                if (mode.mode === "replace") replaceImportedEntry(book, mode.uid, items[0]);
                else appendImportedEntries(book, items);
            } catch {
                setImportError("无法解析条目文件，格式不正确。");
            }
        };
        reader.readAsText(file);
    };

    const updateEntry = (uid: string, updates: Partial<WorldBookEntry>) => {
        if (!activeBook) return;
        const newEntries = activeBook.entries.map(e => e.uid === uid ? { ...e, ...updates } : e);
        updateBook(activeBook.id, { entries: newEntries });
    };

    const removeEntry = (uid: string) => {
        if (!activeBook) return;
        updateBook(activeBook.id, { entries: activeBook.entries.filter(e => e.uid !== uid) });
        if (editingUid === uid) setEditingUid(null);
    };

    if (!isLoaded) return null;

    const openBook = (bookId: string) => {
        setActiveBookId(bookId);
        setViewMode("detail");
    };

    const renderBookCard = (book: WorldBookConfig, group: string, groupIds: string[]) => (
        <div
            key={book.id}
            {...reorder.itemProps(group, book.id, groupIds)}
            className="ui-config-card min-w-0 cursor-pointer"
            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
            role="button"
            tabIndex={0}
            aria-label={`编辑 ${book.name || "世界书"}`}
            onClick={() => openBook(book.id)}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openBook(book.id);
                }
            }}
        >
            <div className="min-w-0 flex flex-col gap-1.5">
                <div className="min-w-0 flex items-center gap-[6px]">
                    <BookOpen size={16} className="shrink-0" />
                    <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{book.name}</span>
                    {book.pinned ? <Pin size={13} className="ml-auto shrink-0 opacity-45" aria-label="已置顶" /> : null}
                </div>
                <span className="menu-desc truncate">{book.description || `${book.entries?.length || 0} 个条目`}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
                <span className="menu-desc ts-12">条目 {book.entries?.length || 0}</span>
                <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
            </div>
        </div>
    );

    return (
        <div ref={wbContainerRef} className="flex flex-col gap-5 h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            <input type="file" accept=".json" className="hidden" ref={entryFileInputRef} onChange={handleEntryImportFile} />
            {viewMode === "list" ? (
                currentFolder ? (
                    <>
                        {/* 文件夹名已经在顶上标题栏里了，这里不再写一遍大字 */}
                        <div className="flex justify-center gap-2">
                            <button
                                type="button"
                                onClick={() => setMoveSelection(new Set())}
                                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white transition-all hover:bg-gray-800 active:scale-95"
                            >
                                <FolderInput size={15} strokeWidth={1.8} />
                                <span>移入世界书</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => openFolderNameDialog({ mode: "rename", id: currentFolder.id })}
                                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 transition-all hover:bg-gray-50 active:scale-95"
                            >
                                <Pencil size={15} strokeWidth={1.8} />
                                <span>重命名</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmDeleteFolderId(currentFolder.id)}
                                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] transition-all hover:bg-gray-50 active:scale-95"
                            >
                                <Trash2 size={15} strokeWidth={1.8} />
                                <span>删除文件夹</span>
                            </button>
                        </div>
                        {(() => {
                            const inside = groupWorldBooksByFolder(books, folders).inFolder(currentFolder.id);
                            const insidePinned = inside.filter(b => b.pinned);
                            const insideRest = inside.filter(b => !b.pinned);
                            return inside.length === 0 ? (
                                <div className="ui-empty mt-2">
                                    <div className="ui-icon-circle">
                                        <Folder size={24} />
                                    </div>
                                    <span className="menu-label font-semibold">文件夹是空的</span>
                                    <span className="menu-desc text-center max-w-[240px] !mt-0">
                                        点「移入世界书」把已有的世界书放进来，或者在这里直接新建、导入。
                                    </span>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-3">
                                    {reorder.order("inside-pinned", insidePinned).map(book => renderBookCard(book, "inside-pinned", insidePinned.map(b => b.id)))}
                                    {reorder.order("inside", insideRest).map(book => renderBookCard(book, "inside", insideRest.map(b => b.id)))}
                                </div>
                            );
                        })()}
                    </>
                ) : (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Worldbooks</h2>
                    </div>

                    {books.length === 0 && folders.length === 0 ? (
                        <div className="ui-empty mt-2">
                            <div className="ui-icon-circle">
                                <BookOpen size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有世界书</span>
                            <span className="menu-desc text-center max-w-[240px] !mt-0">
                                世界书用于为 AI 提供长期记忆和背景知识，当触发特定词汇时自动插入设定。
                            </span>
                            <button onClick={addBook} className="ui-btn ui-btn-primary mt-2">
                                <Plus size={16} /> 新建世界书
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            {(() => {
                                const grouped = groupWorldBooksByFolder(books, folders);
                                const pinnedIds = grouped.pinned.map(b => b.id);
                                const folderIds = folders.map(f => f.id);
                                const unfiledIds = grouped.unfiled.map(b => b.id);
                                return (
                                    <>
                                        {/* 置顶的放最上面，在文件夹里的也会出现在这里 */}
                                        {reorder.order("pinned", grouped.pinned).map(book => renderBookCard(book, "pinned", pinnedIds))}
                                        {reorder.order("folders", folders).map(folder => {
                                            const inside = grouped.inFolder(folder.id);
                                            return (
                                                <div
                                                    key={folder.id}
                                                    {...reorder.itemProps("folders", folder.id, folderIds)}
                                                    className="ui-config-card min-w-0 cursor-pointer"
                                                    style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-label={`打开文件夹 ${folder.name}`}
                                                    onClick={() => setCurrentFolderId(folder.id)}
                                                    onKeyDown={(event) => {
                                                        if (event.target !== event.currentTarget) return;
                                                        if (event.key === "Enter" || event.key === " ") {
                                                            event.preventDefault();
                                                            setCurrentFolderId(folder.id);
                                                        }
                                                    }}
                                                >
                                                    <div className="min-w-0 flex flex-col gap-1.5">
                                                        <div className="min-w-0 flex items-center gap-[6px]">
                                                            <Folder size={16} className="shrink-0" />
                                                            <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{folder.name}</span>
                                                        </div>
                                                        <span className="menu-desc truncate">
                                                            {inside.length > 0 ? inside.map(b => b.name).join("、") : "空文件夹"}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="menu-desc ts-12">世界书 {inside.length}</span>
                                                        <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {reorder.order("unfiled", grouped.unfiled).map(book => renderBookCard(book, "unfiled", unfiledIds))}
                                    </>
                                );
                            })()}
                        </div>
                    )}
                </>
                )
            ) : (
                <>
                    {/* Detail View — matches preset-manager layout */}
                    {activeBook && (
                        <div className="flex flex-col gap-4 pb-6">
                            <div className="flex justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => duplicateBook(activeBook)}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-3 text-xs font-bold text-gray-800 transition-all hover:bg-gray-50 active:scale-95"
                                >
                                    <Copy size={15} strokeWidth={1.8} />
                                    <span>复制世界书</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleExport(activeBook)}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-3 text-xs font-bold text-white transition-all hover:bg-gray-800 active:scale-95"
                                >
                                    <Download size={15} strokeWidth={1.8} />
                                    <span>导出世界书</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteTarget({ type: 'book', id: activeBook.id })}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-3 text-xs font-bold text-[var(--c-danger)] transition-all hover:bg-gray-50 active:scale-95"
                                >
                                    <Trash2 size={15} strokeWidth={1.8} />
                                    <span>删除世界书</span>
                                </button>
                            </div>

                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Worldbook Info</h2>
                            <div className="ui-entry-card" style={{ cursor: "default" }}>
                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">世界书名称</label>
                                    <input
                                        type="text"
                                        value={activeBook.name}
                                        onChange={(e) => updateBook(activeBook.id, { name: e.target.value })}
                                        placeholder="世界书名称..."
                                        className="ui-input font-medium"
                                    />
                                </div>

                                {folders.length > 0 && (
                                    <div className="flex flex-col gap-2">
                                        <label className="menu-label ts-13 font-semibold ml-1">所在文件夹</label>
                                        <select
                                            value={activeBook.folderId && folders.some(f => f.id === activeBook.folderId) ? activeBook.folderId : ""}
                                            onChange={(e) => updateBook(activeBook.id, { folderId: e.target.value || undefined })}
                                            className="ui-select"
                                        >
                                            <option value="">未分类</option>
                                            {folders.map(folder => (
                                                <option key={folder.id} value={folder.id}>{folder.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                <div className="flex items-center justify-between gap-3">
                                    <label className="menu-label ts-13 font-semibold ml-1">置顶</label>
                                    <Toggle
                                        checked={activeBook.pinned === true}
                                        onChange={(value) => updateBook(activeBook.id, { pinned: value || undefined })}
                                    />
                                </div>

                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">简介描述</label>
                                    <textarea
                                        value={activeBook.description || ""}
                                        onChange={(e) => updateBook(activeBook.id, { description: e.target.value })}
                                        placeholder="简介描述..."
                                        rows={2}
                                        className="ui-textarea resize-none"
                                    />
                                </div>
                            </div>

                            {/* Entries Section */}
                            <div className="flex flex-col gap-4 mt-2">
                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Worldbook Entries ({activeBook.entries?.length || 0})</h2>

                            {/* Entry Cards */}
                            <div className="flex flex-col gap-2">
                                {visibleEntries.length === 0 ? (
                                    <div className="menu-desc text-center mt-10 ts-14">
                                        没找到相关的世界书条目
                                    </div>
                                ) : (
                                    visibleEntries.map(entry => {
                                        const isEditing = editingUid === entry.uid;

                                        return (
                                            <SwipeActionRow
                                                key={entry.uid}
                                                controller={swipe}
                                                id={entry.uid}
                                                disabled={isEditing}
                                                actions={
                                                    <>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="insert"
                                                            onClick={() => insertEntryAfter(entry.uid)}
                                                        >
                                                            <Plus size={18} strokeWidth={2} />
                                                            <span>新增</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="replace"
                                                            onClick={() => {
                                                                entryImportModeRef.current = { mode: "replace", uid: entry.uid };
                                                                entryFileInputRef.current?.click();
                                                                swipe.close();
                                                            }}
                                                        >
                                                            <Replace size={18} strokeWidth={2} />
                                                            <span>替换</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="export"
                                                            onClick={() => {
                                                                exportEntry(entry);
                                                                swipe.close();
                                                            }}
                                                        >
                                                            <Download size={18} strokeWidth={2} />
                                                            <span>导出</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="delete"
                                                            onClick={() => {
                                                                setConfirmDeleteTarget({ type: 'entry', id: entry.uid });
                                                                swipe.close();
                                                            }}
                                                        >
                                                            <Trash2 size={18} strokeWidth={2} />
                                                            <span>删除</span>
                                                        </button>
                                                    </>
                                                }
                                            >
                                            <div
                                                className="ui-entry-card"
                                                data-active={isEditing ? "true" : undefined}
                                                data-disabled={entry.disable && !isEditing ? "true" : undefined}
                                                style={{ gap: isEditing ? 12 : 0 }}
                                            >
                                                {/* Summary Row */}
                                                <div className="flex justify-between items-start">
                                                    <button
                                                        onClick={() => {
                                                            if (swipe.consumeClickSuppression()) return;
                                                            if (swipe.openId || swipe.swipingId) {
                                                                swipe.close();
                                                                return;
                                                            }
                                                            setEditingUid(isEditing ? null : entry.uid);
                                                        }}
                                                        className="flex gap-3 flex-1 bg-none border-none text-left cursor-pointer p-0"
                                                    >
                                                        <div className="mt-0.5 ui-entry-icon">
                                                            <BookOpen size={20} />
                                                        </div>
                                                        <div className="flex flex-col gap-1 flex-1">
                                                            <span className="menu-label font-semibold break-all ts-15">
                                                                {entry.comment || "(未设置名称)"}
                                                            </span>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="ui-tag" data-variant="muted">
                                                                    {entry.key || "(无触发词)"}
                                                                </span>
                                                                {entry.constant && <span className="ui-status-tag" data-variant="warning">常驻激活</span>}
                                                                {entry.use_regex && !entry.constant && <span className="ui-status-tag" data-variant="action">正则触发</span>}
                                                                {!entry.constant && !entry.use_regex && <span className="ui-status-tag" data-variant="success">关键词触发</span>}
                                                                {entry.disable && <span className="ui-status-tag">已禁用</span>}
                                                            </div>
                                                        </div>
                                                    </button>

                                                    <div className="flex gap-3 ml-3 shrink-0 items-center">
                                                        <label
                                                            className="ui-mini-toggle"
                                                            onClick={(e) => e.stopPropagation()}
                                                            title={entry.disable ? "已禁用 (点击启用)" : "已启用 (点击禁用)"}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={!entry.disable}
                                                                onChange={(e) => updateEntry(entry.uid, { disable: !e.target.checked })}
                                                                className="ui-mini-toggle-track"
                                                            />
                                                            <div className="ui-mini-toggle-thumb" />
                                                        </label>
                                                    </div>
                                                </div>

                                                {/* Expanded Edit */}
                                                {isEditing && (
                                                    <div className="ui-entry-separator flex flex-col gap-3">

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between items-end">
                                                                <label className="menu-desc">触发关键字 (Key)</label>
                                                                <div className="flex items-center gap-3">
                                                                    <label className="ui-checkbox-label">
                                                                        <input type="checkbox" checked={entry.constant} onChange={(e) => updateEntry(entry.uid, { constant: e.target.checked })} />
                                                                        常驻激活
                                                                    </label>
                                                                    <label className="ui-checkbox-label" style={{ opacity: entry.constant ? 0.5 : 1 }}>
                                                                        <input type="checkbox" checked={entry.use_regex} onChange={(e) => updateEntry(entry.uid, { use_regex: e.target.checked })} disabled={entry.constant} />
                                                                        使用正则
                                                                    </label>
                                                                </div>
                                                            </div>
                                                            <input
                                                                type="text"
                                                                value={entry.key}
                                                                onChange={(e) => updateEntry(entry.uid, { key: e.target.value })}
                                                                placeholder={entry.constant ? "已全局常驻，此字段无效" : (entry.use_regex ? "/正则表达式/i" : "例如: 魔法, 设定, 人物")}
                                                                disabled={entry.constant}
                                                                className="ui-input ts-14"
                                                                style={{ fontFamily: entry.use_regex && !entry.constant ? "monospace" : "inherit", opacity: entry.constant ? 0.5 : 1 }}
                                                            />
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">注入位置 (Position)</label>
                                                                <select
                                                                    value={String(
                                                                        typeof entry.position === "string"
                                                                            ? ({ before_char: 0, after_char: 1, before_an: 2, after_an: 3, before_em: 5, after_em: 6 }[entry.position] ?? 0)
                                                                            : (entry.position ?? 0)
                                                                    )}
                                                                    onChange={(e) => {
                                                                        const num = parseInt(e.target.value);
                                                                        updateEntry(entry.uid, { position: isNaN(num) ? 0 : num });
                                                                    }}
                                                                    className="ui-select ts-13"
                                                                >
                                                                    <option value="0">角色设定前</option>
                                                                    <option value="1">角色设定后</option>
                                                                    <option value="4">按深度插入</option>
                                                                </select>
                                                            </div>
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">注入深度 (Depth)</label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.depth ?? 0}
                                                                    onChange={(e) => updateEntry(entry.uid, { depth: parseInt(e.target.value) || 0 })}
                                                                    min="0"
                                                                    disabled={entry.position !== 4}
                                                                    className="ui-input ts-13"
                                                                    style={{ opacity: entry.position !== 4 ? 0.5 : 1 }}
                                                                />
                                                            </div>

                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">权重优先级 (Order)</label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.insertion_order ?? 50}
                                                                    onChange={(e) => updateEntry(entry.uid, { insertion_order: parseInt(e.target.value) || 0 })}
                                                                    className="ui-input ts-13"
                                                                />
                                                            </div>
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">消息角色 (Role)</label>
                                                                <select
                                                                    value={entry.role ?? 0}
                                                                    onChange={(e) => updateEntry(entry.uid, { role: parseInt(e.target.value) || 0 })}
                                                                    className="ui-select ts-13"
                                                                >
                                                                    <option value={0}>System</option>
                                                                    <option value={1}>User</option>
                                                                    <option value={2}>Assistant</option>
                                                                </select>
                                                            </div>
                                                            <div className="col-span-full flex items-center gap-3">
                                                                <span className="menu-desc !mt-0 shrink-0">触发概率 (Probability)</span>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={!!entry.useProbability} onChange={e => updateEntry(entry.uid, { useProbability: e.target.checked })} />
                                                                    启用
                                                                </label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.probability ?? 100}
                                                                    onChange={(e) => updateEntry(entry.uid, { probability: parseInt(e.target.value) || 0 })}
                                                                    min="0" max="100"
                                                                    disabled={!entry.useProbability}
                                                                    className="ui-input ts-13 ml-auto w-[88px]"
                                                                    style={{ opacity: !entry.useProbability ? 0.5 : 1 }}
                                                                />
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">备注 (Comment)</label>
                                                            <input
                                                                type="text"
                                                                value={entry.comment}
                                                                onChange={(e) => updateEntry(entry.uid, { comment: e.target.value })}
                                                                placeholder="描述设定的作用..."
                                                                className="ui-input ts-13"
                                                            />
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">设定内容 (Content)</label>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={entry.content}
                                                                    onChange={(e) => updateEntry(entry.uid, { content: e.target.value })}
                                                                    placeholder="当触发关键字时，会被作为背景信息输入给AI的内容..."
                                                                    rows={6}
                                                                    className="ui-textarea ts-13"
                                                                />
                                                                <button onClick={() => setExpandUid(entry.uid)} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                    </div>
                                                )}
                                            </div>
                                            </SwipeActionRow>
                                        )
                                    })
                                )}
                            </div>

                            <button
                                type="button"
                                onClick={() => setAddEntryMenuOpen(true)}
                                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                            >
                                <Plus size={15} strokeWidth={1.8} />
                                添加条目
                            </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Delete Confirmation Dialog */}
            {confirmDeleteTarget && (
                <ConfirmDialog
                    title="确认删除？"
                    message={confirmDeleteTarget.type === 'book' ? "删除世界书后无法恢复。是否继续？" : "删除条目后无法恢复。是否继续？"}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        if (confirmDeleteTarget.type === 'book') {
                            removeBook(confirmDeleteTarget.id);
                        } else {
                            removeEntry(confirmDeleteTarget.id);
                        }
                        setConfirmDeleteTarget(null);
                    }}
                    onCancel={() => setConfirmDeleteTarget(null)}
                />
            )}

            {folderNameDialog && (
                <ContentDialog
                    title={folderNameDialog.mode === "create" ? "新建文件夹" : "重命名文件夹"}
                    confirmLabel={folderNameDialog.mode === "create" ? "新建" : "保存"}
                    cancelLabel="取消"
                    onConfirm={submitFolderName}
                    onCancel={() => setFolderNameDialog(null)}
                >
                    <input
                        type="text"
                        value={folderNameDraft}
                        maxLength={40}
                        autoFocus
                        placeholder="文件夹名称"
                        onChange={(e) => setFolderNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                submitFolderName();
                            }
                        }}
                        className="ui-input w-full"
                    />
                </ContentDialog>
            )}

            {confirmDeleteFolderId && (
                <ConfirmDialog
                    title="删除文件夹？"
                    message="只删文件夹，里面的世界书不会删除，会回到未分类。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除文件夹"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeFolder(confirmDeleteFolderId);
                        setConfirmDeleteFolderId(null);
                    }}
                    onCancel={() => setConfirmDeleteFolderId(null)}
                />
            )}

            {moveSelection && currentFolder && (() => {
                const candidates = books.filter(b => b.folderId !== currentFolder.id);
                const folderName = (book: WorldBookConfig) =>
                    folders.find(f => f.id === book.folderId)?.name ?? "未分类";
                return (
                    <BottomSheet title={`移入「${currentFolder.name}」`} onClose={() => setMoveSelection(null)}>
                        <div className="flex flex-col gap-2">
                            {candidates.length === 0 ? (
                                <div className="menu-desc text-center py-6">没有别的世界书可以移进来了</div>
                            ) : (
                                <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                                    {candidates.map(book => {
                                        const checked = moveSelection.has(book.id);
                                        return (
                                            <button
                                                key={book.id}
                                                type="button"
                                                className="binding-sheet-option"
                                                data-selected={checked}
                                                aria-pressed={checked}
                                                onClick={() => setMoveSelection(prev => {
                                                    const next = new Set(prev ?? []);
                                                    if (next.has(book.id)) next.delete(book.id); else next.add(book.id);
                                                    return next;
                                                })}
                                            >
                                                <span className="binding-sheet-check">{checked && <Check size={15} />}</span>
                                                <span className="binding-sheet-option-text">{book.name}</span>
                                                <span className="binding-sheet-option-meta">{folderName(book)}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary w-full"
                                disabled={moveSelection.size === 0}
                                onClick={() => {
                                    moveBooksToFolder(moveSelection, currentFolder.id);
                                    setMoveSelection(null);
                                }}
                            >
                                <FolderInput size={16} /> 移入{moveSelection.size > 0 ? `（${moveSelection.size}）` : ""}
                            </button>
                        </div>
                    </BottomSheet>
                );
            })()}

            {importError && (
                <ConfirmDialog
                    title="导入失败"
                    message={importError}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="知道了"
                    cancelLabel=""
                    onConfirm={() => setImportError(null)}
                    onCancel={() => setImportError(null)}
                />
            )}

            {addEntryMenuOpen && activeBook && (
                <BottomSheet title="添加条目" onClose={() => setAddEntryMenuOpen(false)}>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full"
                            onClick={() => {
                                setAddEntryMenuOpen(false);
                                addEntry();
                            }}
                        >
                            <Plus size={16} /> 直接创建
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline w-full"
                            onClick={() => {
                                setAddEntryMenuOpen(false);
                                entryImportModeRef.current = { mode: "append" };
                                entryFileInputRef.current?.click();
                            }}
                        >
                            <Upload size={16} /> 从 JSON 文件导入
                        </button>
                    </div>
                </BottomSheet>
            )}

            {expandUid && (() => {
                const entry = activeBook?.entries?.find(e => e.uid === expandUid);
                if (!entry) return null;
                return (
                    <TextExpandModal
                        title={entry.comment || "编辑设定内容"}
                        value={entry.content}
                        onChange={(v) => updateEntry(entry.uid, { content: v })}
                        placeholder="当触发关键字时，会被作为背景信息输入给AI的内容..."
                        className="ts-13"
                        onClose={() => setExpandUid(null)}
                    />
                );
            })()}
        </div>
    );
}
