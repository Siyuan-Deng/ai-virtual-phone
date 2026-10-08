"use client";

import { useState, useEffect, useCallback, useContext } from "react";
import { Plus, RefreshCw, Rss, AlertCircle, FileEdit, Trash2, X, Check, Copy, Folder, FolderPlus, FolderInput, Pencil, ChevronRight, Pin } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { useLongPressReorder } from "./use-long-press-reorder";
import { applyGroupOrder } from "@/lib/list-order";
import { buildPinnedEntries, buildRootEntries, commitRootGroupOrder, groupItemsByFolder } from "@/lib/item-folders";
import {
    createApiConfigFolder,
    loadApiConfigFolders,
    loadApiConfigRootOrder,
    saveApiConfigFolders,
    saveApiConfigRootOrder,
    type ApiConfigFolder,
} from "@/lib/api-config-folders";
import type { ApiConfig } from "@/lib/settings-types";
import { loadApiConfigs, removeApiConfigReferences, saveApiConfigs } from "@/lib/settings-storage";
import { generateEmbedding, isEmbeddingModelName } from "@/lib/memory-embedding";
import { BottomSheet, ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { determineBaseUrl, simpleLLMCall } from "@/lib/api-helpers";

const DEFAULT_CONFIGS: ApiConfig[] = [
    {
        id: "default-openai",
        name: "OpenAI 官方",
        provider: "OpenAI",
        apiKey: "",
        defaultModel: "gpt-4o",
        enableNativeTools: true,
        enableImageRecognition: true,
        enableImageGeneration: true,
        preventEmptyGenerateRambling: true,
    }
];

function getNativeToolProtocolLabel(config: ApiConfig): string {
    if (config.provider === "Anthropic" && !config.baseUrl) return "Anthropic";
    if (config.provider === "Google") return "Gemini";
    return "OpenAI-compatible";
}

export function ApiSettings() {
    const { setSubpageRightAction, setSubpageTitle, setOverrideBack } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    // 文件夹（和世界书一样）：currentFolderId 是正在看的文件夹，null = 最外层
    const [folders, setFolders] = useState<ApiConfigFolder[]>([]);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [folderNameDialog, setFolderNameDialog] = useState<{ mode: "create" } | { mode: "rename"; id: string } | null>(null);
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
    const [moveSelection, setMoveSelection] = useState<Set<string> | null>(null);
    /** 最外层文件夹和配置混排的顺序（长按拖出来的） */
    const [rootOrder, setRootOrder] = useState<string[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Testing and Fetching states
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    const [isTesting, setIsTesting] = useState<Record<string, boolean>>({});
    const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const loaded = loadApiConfigs();
        if (loaded.length > 0) {
            setConfigs(loaded);
        } else {
            setConfigs(DEFAULT_CONFIGS);
            saveApiConfigs(DEFAULT_CONFIGS);
        }
        setFolders(loadApiConfigFolders());
        setRootOrder(loadApiConfigRootOrder());
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: ApiConfig[]) => {
        setConfigs(newConfigs);
        saveApiConfigs(newConfigs);
    }, []);

    const persistFolders = useCallback((next: ApiConfigFolder[]) => {
        setFolders(next);
        saveApiConfigFolders(next);
    }, []);

    const currentFolder = currentFolderId ? folders.find(f => f.id === currentFolderId) ?? null : null;

    // 进了文件夹：标题栏显示文件夹名，返回先回到最外层
    useEffect(() => {
        if (currentFolder) {
            setOverrideBack(() => () => setCurrentFolderId(null));
            setSubpageTitle(currentFolder.name);
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [currentFolder, setOverrideBack, setSubpageTitle]);

    // 长按卡片拖动排序：最外层的文件夹和配置混在一起排；置顶的（文件夹和配置）之间、文件夹里面各自排
    const reorder = useLongPressReorder((group, orderedIds) => {
        if (group === "root" || group === "pinned") {
            const next = commitRootGroupOrder(group, orderedIds, configs, folders, rootOrder);
            persistFolders(next.folders);
            persist(applyGroupOrder(configs, next.itemIds));
            setRootOrder(next.rootOrder);
            saveApiConfigRootOrder(next.rootOrder);
            return;
        }
        persist(applyGroupOrder(configs, orderedIds));
    });

    const addConfig = useCallback(() => {
        const newConfig: ApiConfig = {
            id: `config-${Date.now()}`,
            name: "新配置",
            provider: "Custom",
            apiKey: "",
            defaultModel: "",
            enableNativeTools: true,
            enableImageRecognition: false,
            enableImageGeneration: false,
            preventEmptyGenerateRambling: true,
            // 在文件夹里新建就直接放进这个文件夹
            ...(currentFolderId ? { folderId: currentFolderId } : {}),
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, currentFolderId, persist]);

    /** 复制一份放在原来那份后面（同一个文件夹，不置顶），打开副本 */
    const duplicateConfig = (config: ApiConfig) => {
        const copy: ApiConfig = {
            ...config,
            id: `config-${Date.now()}`,
            name: `${config.name || config.provider} 副本`,
            pinned: undefined,
        };
        const index = configs.findIndex(c => c.id === config.id);
        const next = [...configs];
        next.splice(index < 0 ? next.length : index + 1, 0, copy);
        persist(next);
        // 从新建的编辑页里复制：副本不算「新建」，点 × 不会把它删掉
        setIsNewConfig(false);
        setEditingId(copy.id);
    };

    // --- 文件夹 ---
    const openFolderNameDialog = (dialog: { mode: "create" } | { mode: "rename"; id: string }) => {
        setFolderNameDraft(dialog.mode === "rename" ? folders.find(f => f.id === dialog.id)?.name ?? "" : "");
        setFolderNameDialog(dialog);
    };

    const submitFolderName = () => {
        const dialog = folderNameDialog;
        if (!dialog) return;
        setFolderNameDialog(null);
        if (dialog.mode === "create") {
            const folder = createApiConfigFolder(folderNameDraft);
            persistFolders([folder, ...folders]);
            setCurrentFolderId(folder.id);
            return;
        }
        const name = folderNameDraft.trim().slice(0, 40);
        if (!name) return;
        persistFolders(folders.map(f => f.id === dialog.id ? { ...f, name } : f));
    };

    const toggleFolderPinned = (folderId: string) => {
        persistFolders(folders.map(f => f.id === folderId ? { ...f, pinned: f.pinned ? undefined : true } : f));
    };

    const removeFolder = (folderId: string) => {
        persistFolders(folders.filter(f => f.id !== folderId));
        // 里面的配置回到未分类，不跟着删
        if (configs.some(c => c.folderId === folderId)) {
            persist(configs.map(c => c.folderId === folderId ? { ...c, folderId: undefined } : c));
        }
        if (currentFolderId === folderId) setCurrentFolderId(null);
    };

    const moveConfigsToFolder = (configIds: Set<string>, folderId: string) => {
        if (configIds.size === 0) return;
        persist(configs.map(c => configIds.has(c.id) ? { ...c, folderId } : c));
    };

    useEffect(() => {
        // 和世界书一样只放图标、不带阴影；文件夹只有一层，在文件夹里面不再显示「新建文件夹」
        setSubpageRightAction("api",
            <div className="flex items-center gap-2">
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
                    onClick={addConfig}
                    aria-label="新增API方案"
                    title="新增API方案"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-all hover:bg-gray-800 active:scale-95 focus:outline-none"
                >
                    <Plus size={16} strokeWidth={1.8} />
                </button>
            </div>
        );
        return () => setSubpageRightAction("api", null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addConfig, setSubpageRightAction, currentFolderId, folders]);

    const updateConfig = (id: string, updates: Partial<ApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));
        removeApiConfigReferences(id);
        const newFetchedModels = { ...fetchedModels };
        delete newFetchedModels[id];
        setFetchedModels(newFetchedModels);

        const newTestResults = { ...testResult };
        delete newTestResults[id];
        setTestResult(newTestResults);
    };

    // Use unified determineBaseUrl from api-helpers

    const fetchModels = async (config: ApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            const baseUrl = determineBaseUrl(config);
            if (!baseUrl) throw new Error("缺少 Base URL");
            if (!config.apiKey) throw new Error("缺少 API Key");

            // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
            // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
            const isGoogleNative = config.provider === "Google";
            // 用户常把完整端点填进 Base URL（如 .../v1/embeddings、.../v1/chat/completions），
            // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
            const modelsBase = baseUrl
                .replace(/\/$/, "")
                .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
            const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
            const url = isGoogleNative
                ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
                : modelsUrl;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

            const response = await fetch(url, { method: "GET", headers });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            let modelNames: string[] = [];
            if (isGoogleNative && Array.isArray(data?.models)) {
                // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
                modelNames = data.models.map((m: { name: string }) => (m.name || "").replace(/^models\//, ""));
            } else if (Array.isArray(data?.data)) {
                modelNames = data.data.map((m: { id: string }) => m.id);
            } else {
                throw new Error("返回数据格式不符合预期");
            }
            setFetchedModels(prev => ({ ...prev, [config.id]: modelNames }));
            setTestResult(prev => ({ ...prev, [config.id]: { success: true, message: `成功获取 ${modelNames.length} 个模型` } }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `拉取失败: ${msg}` } }));
            setFetchedModels(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const testConnection = async (config: ApiConfig) => {
        if (!config.defaultModel) {
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "请先输入或选择默认模型" } }));
            return;
        }

        setIsTesting(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            // 向量模型配置：测 /embeddings 端点。原来一律测 /chat/completions，
            // 导致 embedding 配置永远 404「测试失败」。
            if (isEmbeddingModelName(config.defaultModel)) {
                const embedding = await generateEmbedding("你好", config, { throwOnError: true });
                if (!embedding) throw new Error("接口未返回向量数据");
                setTestResult(prev => ({
                    ...prev,
                    [config.id]: { success: true, message: `测试成功! 向量模型可用，维度 ${embedding.length}` },
                }));
                return;
            }
            const result = await simpleLLMCall(
                config,
                [{ role: "user", content: "你好" }],
                // Cap (not spend): reasoning models (deepseek-reasoner / gemini-pro 等) burn
                // tokens on hidden reasoning first, so a tiny cap leaves the visible
                // content empty and the test falsely fails (finishReason=length).
                // 4096 covers heavy thinkers; a "你好" reply still stops well before it.
                { temperature: 0.2, max_tokens: 4096 },
            );
            if (result.error || !result.content) {
                throw new Error(result.error || "模型返回了空内容");
            }
            const reply = result.content.replace(/\s+/g, " ").trim();
            const preview = reply.length > 80 ? `${reply.slice(0, 80)}...` : reply;
            setTestResult(prev => ({
                ...prev,
                [config.id]: { success: true, message: `测试成功! 模型回复: ${preview}` },
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `测试失败: ${msg}` } }));
        } finally {
            setIsTesting(prev => ({ ...prev, [config.id]: false }));
        }
    };

    if (!isLoaded) return null;

    const renderConfigCard = (config: ApiConfig, group: string, groupIds: string[]) => (
        <div
            key={config.id}
            {...reorder.itemProps(group, config.id, groupIds)}
            className="ui-config-card min-w-0 cursor-pointer"
            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
            role="button"
            tabIndex={0}
            aria-label={`编辑 ${config.name || config.provider}`}
            onClick={() => setEditingId(config.id)}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setEditingId(config.id);
                }
            }}
        >
            <div className="min-w-0 flex flex-col gap-1">
                <div className="min-w-0 flex items-center gap-[6px]">
                    <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{config.name || config.provider}</span>
                    {config.pinned ? <Pin size={13} className="ml-auto shrink-0 opacity-45" aria-label="已置顶" /> : null}
                </div>
                <span className="menu-desc truncate">{config.defaultModel || config.provider || "未设置模型"}</span>
            </div>
            <div className="flex gap-2 shrink-0 items-center justify-end">
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        duplicateConfig(config);
                    }}
                    className="ui-link-btn"
                    aria-label="复制配置"
                    title="复制配置"
                >
                    <Copy size={17} />
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        setEditingId(config.id);
                    }}
                    className="ui-link-btn"
                >
                    <FileEdit size={18} />
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        setConfirmDeleteId(config.id);
                    }}
                    className="ui-link-btn"
                    data-variant="danger"
                >
                    <Trash2 size={18} />
                </button>
            </div>
        </div>
    );

    const grouped = groupItemsByFolder(configs, folders);
    const pinnedEntries = buildPinnedEntries(configs, folders, rootOrder);
    const pinnedIds = pinnedEntries.map(entry => entry.id);
    const rootEntries = buildRootEntries(configs, folders, rootOrder);
    const rootIds = rootEntries.map(entry => entry.id);

    const renderFolderCard = (folder: ApiConfigFolder, group: string, groupIds: string[]) => {
        const inside = grouped.inFolder(folder.id);
        return (
            <div
                key={folder.id}
                {...reorder.itemProps(group, folder.id, groupIds)}
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
                        {folder.pinned ? <Pin size={13} className="ml-auto shrink-0 opacity-45" aria-label="已置顶" /> : null}
                    </div>
                    <span className="menu-desc truncate">
                        {inside.length > 0 ? inside.map(c => c.name || c.provider).join("、") : "空文件夹"}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="menu-desc ts-12">配置 {inside.length}</span>
                    <ChevronRight size={16} className="opacity-40" />
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col gap-6">
            {currentFolder ? (
                <>
                    {/* 文件夹名已经在顶上标题栏里了，这里不再写一遍大字；最前面的图钉是置顶这个文件夹，变黑就是已置顶 */}
                    <div className="flex justify-center gap-2 max-[420px]:gap-1.5">
                        <button
                            type="button"
                            onClick={() => toggleFolderPinned(currentFolder.id)}
                            aria-label={currentFolder.pinned ? "取消置顶文件夹" : "置顶文件夹"}
                            aria-pressed={currentFolder.pinned === true}
                            title={currentFolder.pinned ? "取消置顶" : "置顶"}
                            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 transition-all active:scale-95 ${currentFolder.pinned ? "bg-black text-white hover:bg-gray-800" : "bg-white text-gray-800 hover:bg-gray-50"}`}
                        >
                            <Pin size={15} strokeWidth={1.8} />
                        </button>
                        <button
                            type="button"
                            onClick={() => setMoveSelection(new Set())}
                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black whitespace-nowrap px-4 text-xs max-[420px]:px-3 font-bold text-white transition-all hover:bg-gray-800 active:scale-95"
                        >
                            <FolderInput size={15} strokeWidth={1.8} />
                            <span>移入配置</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => openFolderNameDialog({ mode: "rename", id: currentFolder.id })}
                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white whitespace-nowrap px-4 text-xs max-[420px]:px-3 font-bold text-gray-800 transition-all hover:bg-gray-50 active:scale-95"
                        >
                            <Pencil size={15} strokeWidth={1.8} />
                            <span>重命名</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmDeleteFolderId(currentFolder.id)}
                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white whitespace-nowrap px-4 text-xs max-[420px]:px-3 font-bold text-[var(--c-danger)] transition-all hover:bg-gray-50 active:scale-95"
                        >
                            <Trash2 size={15} strokeWidth={1.8} />
                            <span>删除文件夹</span>
                        </button>
                    </div>
                    {(() => {
                        const inside = grouped.inFolder(currentFolder.id);
                        const insidePinned = inside.filter(c => c.pinned);
                        const insideRest = inside.filter(c => !c.pinned);
                        return inside.length === 0 ? (
                            <div className="ui-empty mt-2">
                                <div className="ui-icon-circle">
                                    <Folder size={24} />
                                </div>
                                <span className="menu-label font-semibold">文件夹是空的</span>
                                <span className="menu-desc text-center max-w-[240px] !mt-0">
                                    点「移入配置」把已有的 API 配置放进来，或者在这里直接新建。
                                </span>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {reorder.order("inside-pinned", insidePinned).map(c => renderConfigCard(c, "inside-pinned", insidePinned.map(x => x.id)))}
                                {reorder.order("inside", insideRest).map(c => renderConfigCard(c, "inside", insideRest.map(x => x.id)))}
                            </div>
                        );
                    })()}
                </>
            ) : (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">API Settings</h2>
                    </div>

                    {configs.length === 0 && folders.length === 0 ? (
                        <div className="ui-empty">
                            <div className="ui-icon-circle">
                                <AlertCircle size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有 API 配置</span>
                            <span className="menu-desc max-w-[240px]">
                                配置 API 密钥和模型以连接到 AI 服务。
                            </span>
                            <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                                <Plus size={16} /> 添加配置
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            {/* 置顶的文件夹和配置放最上面（在文件夹里的置顶配置也会出现在这里） */}
                            {reorder.order("pinned", pinnedEntries).map(entry => (
                                entry.folder ? renderFolderCard(entry.folder, "pinned", pinnedIds) : entry.item ? renderConfigCard(entry.item, "pinned", pinnedIds) : null
                            ))}
                            {/* 文件夹和配置混在一起，按拖出来的顺序 */}
                            {reorder.order("root", rootEntries).map(entry => (
                                entry.folder ? renderFolderCard(entry.folder, "root", rootIds) : entry.item ? renderConfigCard(entry.item, "root", rootIds) : null
                            ))}
                        </div>
                    )}
                </>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加配置" : "编辑配置"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的 OpenAI"
                                            />
                                        </div>
                                        {folders.length > 0 && (
                                            <div className="flex flex-col gap-1">
                                                <label className="menu-desc ml-1">所在文件夹</label>
                                                <select
                                                    value={config.folderId && folders.some(f => f.id === config.folderId) ? config.folderId : ""}
                                                    onChange={(e) => updateConfig(config.id, { folderId: e.target.value || undefined })}
                                                    className="ui-select"
                                                >
                                                    <option value="">未分类</option>
                                                    {folders.map(folder => (
                                                        <option key={folder.id} value={folder.id}>{folder.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        )}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={config.provider}
                                                onChange={(e) => updateConfig(config.id, { provider: e.target.value })}
                                                className="ui-select"
                                            >
                                                <option value="OpenAI">OpenAI</option>
                                                <option value="Anthropic">Anthropic</option>
                                                <option value="Google">Google Gemini</option>
                                                <option value="DeepSeek">DeepSeek</option>
                                                <option value="Groq">Groq</option>
                                                <option value="OpenRouter">OpenRouter</option>
                                                <option value="Moonshot">Kimi (Moonshot)</option>
                                                <option value="Zhipu">Zhipu (GLM)</option>
                                                <option value="SiliconFlow">SiliconFlow</option>
                                                <option value="TogetherAI">Together AI</option>
                                                <option value="Custom">自定义 (Custom)</option>
                                            </select>
                                        </div>

                                        {/* Custom 必填 Base URL；其他 provider 可选填中转站地址 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">
                                                Base URL {config.provider === "Custom" ? "（必填）" : "（可选，留空用官方端点）"}
                                                {config.provider === "Google" && (
                                                    <span style={{ color: "#888", marginLeft: 6, fontSize: "0.85em" }}>
                                                        中转站填 https://xxx/v1beta 走原生协议
                                                    </span>
                                                )}
                                            </label>
                                            <Input
                                                type="url"
                                                value={config.baseUrl || ""}
                                                onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                placeholder={
                                                    config.provider === "Custom"
                                                        ? "https://api.example.com/v1"
                                                        : config.provider === "Google"
                                                            ? "https://your-proxy.example.com/v1beta"
                                                            : "默认用官方端点，留空即可"
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="sk-..."
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">默认模型 (Default Model)</label>
                                            <div className="flex gap-2">
                                                {fetchedModels[config.id] && fetchedModels[config.id].length > 0 ? (
                                                    <select
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        className="ui-select flex-1"
                                                    >
                                                        <option value="">请选择模型...</option>
                                                        {fetchedModels[config.id].map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input
                                                        type="text"
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        placeholder="gpt-4o, claude-3-opus..."
                                                        className="ui-input flex-1"
                                                    />
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex gap-3 mt-1">
                                            <button
                                                onClick={() => fetchModels(config)}
                                                disabled={isFetching[config.id]}
                                                className="ui-btn ui-btn ui-btn-soft-action flex-1"
                                            >
                                                <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                {isFetching[config.id] ? "拉取中..." : "拉取模型列表"}
                                            </button>

                                            <button
                                                onClick={() => testConnection(config)}
                                                disabled={isTesting[config.id]}
                                                className="ui-btn ui-btn ui-btn-success flex-1"
                                            >
                                                <Rss size={16} className={isTesting[config.id] ? "animate-spin" : ""} />
                                                {isTesting[config.id] ? "测试中..." : "测试连接"}
                                            </button>
                                        </div>

                                        {testResult[config.id] && testResult[config.id].message && (
                                            <Alert variant={testResult[config.id].success ? "success" : "danger"}>
                                                <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                                <span className="break-all leading-[1.5]">{testResult[config.id].message}</span>
                                            </Alert>
                                        )}

                                        <div className="ui-toggle-row mt-2">
                                            <span className="menu-label font-medium">置顶</span>
                                            <Toggle checked={config.pinned === true} onChange={(v) => updateConfig(config.id, { pinned: v || undefined })} />
                                        </div>

                                        <div
                                            className="ui-toggle-row mt-2 overflow-visible"
                                            style={{ display: "block", position: "relative", height: "auto", flexShrink: 0, padding: "14px 76px 14px 16px" }}
                                        >
                                            <span className="menu-label font-medium">启用原生工具调用</span>
                                            <span className="menu-desc whitespace-normal break-words leading-[1.45]">
                                                开启后自动选择该服务商可用的原生工具格式（当前：{getNativeToolProtocolLabel(config)}）；关闭后使用文本动作协议。
                                            </span>
                                            <span style={{ position: "absolute", top: 0, bottom: 0, right: 16, display: "flex", alignItems: "center" }}>
                                                <Toggle
                                                    checked={config.enableNativeTools !== false}
                                                    onChange={(v) => updateConfig(config.id, { enableNativeTools: v })}
                                                />
                                            </span>
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="menu-label font-medium">启用图像识别</span>
                                            <Toggle checked={config.enableImageRecognition} onChange={(v) => updateConfig(config.id, { enableImageRecognition: v })} />
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="flex min-w-0 flex-col">
                                                <span className="menu-label font-medium">防胡言乱语</span>
                                                <span className="menu-desc">防止没有用户输入时胡言乱语</span>
                                            </span>
                                            <Toggle
                                                checked={config.preventEmptyGenerateRambling === true}
                                                onChange={(v) => updateConfig(config.id, { preventEmptyGenerateRambling: v })}
                                            />
                                        </div>
                                        <button type="button" onClick={() => duplicateConfig(config)} className="ui-btn ui-btn-soft-action mt-2 w-full">
                                            <Copy size={16} /> 复制这个配置
                                        </button>

                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
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
                    message="只删文件夹，里面的 API 配置不会删除，会回到未分类。"
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
                const candidates = configs.filter(c => c.folderId !== currentFolder.id);
                const folderName = (config: ApiConfig) => folders.find(f => f.id === config.folderId)?.name ?? "未分类";
                return (
                    <BottomSheet title={`移入「${currentFolder.name}」`} onClose={() => setMoveSelection(null)}>
                        <div className="flex flex-col gap-2">
                            {candidates.length === 0 ? (
                                <div className="menu-desc text-center py-6">没有别的配置可以移进来了</div>
                            ) : (
                                <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                                    {candidates.map(config => {
                                        const checked = moveSelection.has(config.id);
                                        return (
                                            <button
                                                key={config.id}
                                                type="button"
                                                className="binding-sheet-option"
                                                data-selected={checked}
                                                aria-pressed={checked}
                                                onClick={() => setMoveSelection(prev => {
                                                    const next = new Set(prev ?? []);
                                                    if (next.has(config.id)) next.delete(config.id); else next.add(config.id);
                                                    return next;
                                                })}
                                            >
                                                <span className="binding-sheet-check">{checked && <Check size={15} />}</span>
                                                <span className="binding-sheet-option-text">{config.name || config.provider}</span>
                                                <span className="binding-sheet-option-meta">{folderName(config)}</span>
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
                                    moveConfigsToFolder(moveSelection, currentFolder.id);
                                    setMoveSelection(null);
                                }}
                            >
                                <FolderInput size={16} /> 移入{moveSelection.size > 0 ? `（${moveSelection.size}）` : ""}
                            </button>
                        </div>
                    </BottomSheet>
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
