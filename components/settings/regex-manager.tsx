"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, Trash2, Download, Database, Play, Upload, ChevronLeft, AlertCircle, Maximize2, X, Replace, Copy, Check, Folder, FolderPlus, FolderInput, Pencil, Pin } from "lucide-react";
import {
    loadRegexes,
    saveRegexes,
    createRegexGroup,
    parseRegexFromJson,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import type { RegexConfig, RegexRule } from "@/lib/settings-types";
import {
    buildRegexRootEntries,
    createRegexFolder,
    groupRegexesByFolder,
    loadRegexFolders,
    loadRegexRootOrder,
    saveRegexFolders,
    saveRegexRootOrder,
    type RegexFolder,
} from "@/lib/regex-folders";
import { applyGroupOrder } from "@/lib/list-order";
import { buildPinnedEntries, commitRootGroupOrder } from "@/lib/item-folders";
import { Toggle } from "@/components/ui/form";
import { useLongPressReorder } from "./use-long-press-reorder";
import { testRegexRule } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { areTagsEqual, getTagProfileId, getTagsLabel, type TagProfile } from "@/lib/content-tag-utils";
import { buildCustomAppTagGroups, flattenTagGroups } from "@/lib/custom-app-tag-profiles";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import type { InstalledCustomApp } from "@/lib/custom-app-types";
import { SettingsContext } from "../phone-settings-app";
import { BottomSheet, ConfirmDialog, ContentDialog, TextExpandModal } from "@/components/ui/modal";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { notifyMascotPageContext } from "@/lib/mascot-events";

function copyTextToClipboard(text: string): void {
    const fallbackCopy = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

/** 复制「起效后的代码」（正则替换结果）的小按钮：点击后短暂显示「已复制」。 */
function CopyCodeButton({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className={className}
            disabled={!text}
            title={text ? "复制起效后的代码" : "无内容可复制"}
            onClick={(e) => {
                e.stopPropagation();
                copyTextToClipboard(text);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            }}
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                border: "1px solid var(--c-panel-border)",
                background: "var(--c-card)",
                borderRadius: 8,
                padding: "2px 8px",
                cursor: text ? "pointer" : "not-allowed",
                color: "var(--c-icon)",
                opacity: text ? 1 : 0.4,
                flexShrink: 0,
            }}
        >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span className="ts-11">{copied ? "已复制" : "复制"}</span>
        </button>
    );
}

/** 从 ```html 围栏里提取真正的 HTML 文档（渲染预览用）。 */
function extractHtmlForPreview(text: string): string {
    const m = text.match(/```html\s*\n([\s\S]*?)```/);
    return m ? m[1].trim() : text.trim();
}

/**
 * 渲染预览 iframe：与聊天里真正的 HTML 卡片同机制（iframe + 脚本可执行 + 高度自适应）。
 * 之前的预览用 dangerouslySetInnerHTML 直接把 HTML 塞进当前文档：
 * <style> 会生效、<script> 永不执行，导致带脚本的卡片只显示空壳、文字全丢。
 */
function HtmlPreviewFrame({ html }: { html: string }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(360);
    const srcDoc = useMemo(() => {
        const action = `document.addEventListener("click",function(e){var t=e.target.closest("[data-action]");if(t){e.preventDefault();window.parent.postMessage({type:"_chat_action",text:t.getAttribute("data-action")},"*")}},true);`;
        const resize = `
            var n=0;
            var send=function(){
                if(n>=12)return;
                n++;
                var b=document.body;
                if(!b)return;
                var h=Math.max(Math.ceil(b.getBoundingClientRect().height),b.scrollHeight||0,80);
                window.parent.postMessage({type:"_chat_inline_html_resize",h:h},"*");
            };
            window.addEventListener("load",send);
            if(window.ResizeObserver&&document.body){new ResizeObserver(function(){n=0;send();}).observe(document.body);}
            document.addEventListener("toggle",function(){n=0;setTimeout(send,50);},true);
            setTimeout(send,300);
            setTimeout(send,1200);
            setTimeout(send,2500);`;
        const inject = `<script>(function(){${action}${resize}})();<\/script>`;
        let h = html;
        if (h.includes("</body>")) h = h.replace("</body>", inject + "</body>");
        else h = h + inject;
        return h;
    }, [html]);

    useEffect(() => {
        setHeight(360);
    }, [srcDoc]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            if (e.data.type === "_chat_inline_html_resize" && typeof e.data.h === "number") {
                setHeight(Math.max(80, Math.ceil(e.data.h)));
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, []);

    return (
        <iframe
            ref={iframeRef}
            srcDoc={srcDoc}
            title="正则渲染预览"
            // 与聊天卡片同规格的沙箱：脚本可跑但跨源隔离——正则组可从别人处导入，
            // 预览内容不可信，不加 sandbox 会让脚本摸到主应用的 localStorage/IndexedDB
            sandbox="allow-scripts"
            style={{ width: "100%", height, border: "none", borderRadius: 12, background: "transparent" }}
        />
    );
}

function getRuleTags(rule: Pick<RegexRule, "tags">): string[] {
    return rule.tags && rule.tags.length > 0 ? [...rule.tags] : [];
}

const BASE_REGEX_SCOPE_TAG_PROFILES = [
    { id: "chat", label: "聊天", tags: ["chat", "text"] },
    { id: "group_chat", label: "群聊", tags: ["group_chat", "text"] },
    { id: "story", label: "剧情", tags: ["story"] },
    { id: "offline", label: "线下", tags: ["offline"] },
];

const DEFAULT_REGEX_TAGS = BASE_REGEX_SCOPE_TAG_PROFILES[0].tags;

function migrateLegacyRuleTags(tags: string[]): string[] {
    if (areTagsEqual(tags, ["chat"])) return ["chat", "text"];
    if (areTagsEqual(tags, ["group_chat"])) return ["group_chat", "text"];
    return tags;
}

function normalizeRuleScope(rule: RegexRule): RegexRule {
    const tags = migrateLegacyRuleTags(getRuleTags(rule));
    if (tags.length === 0) return rule.tags === undefined ? rule : { ...rule, tags: undefined };
    return areTagsEqual(tags, getRuleTags(rule)) ? rule : { ...rule, tags };
}

function normalizeGroupScope(group: RegexConfig): RegexConfig {
    return {
        ...group,
        rules: (group.rules || []).map(normalizeRuleScope),
    };
}

function getRuleTagProfileId(rule: Pick<RegexRule, "tags">, profiles: TagProfile[]): string {
    return getTagProfileId(getRuleTags(rule), profiles);
}

function getRuleTagsLabel(rule: Pick<RegexRule, "tags">, profiles: TagProfile[]): string {
    return getTagsLabel(getRuleTags(rule), profiles);
}

function getRuleRawTagsLabel(rule: Pick<RegexRule, "tags">): string {
    const tags = getRuleTags(rule);
    return tags.length > 0 ? tags.join(" · ") : "通用";
}

function setRuleTags(tags: string[]): Partial<RegexRule> {
    return {
        tags: tags.length > 0 ? tags : undefined,
    };
}

export function RegexManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [groups, setGroups] = useState<RegexConfig[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string>("");
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
    const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ type: 'group' | 'rule', id: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [testingRuleId, setTestingRuleId] = useState<string | null>(null);
    const [testInput, setTestInput] = useState("在这里输入测试文本...");
    const [expandTarget, setExpandTarget] = useState<{ ruleId: string; field: "findRegex" | "replaceString" } | null>(null);
    const [previewHtml, setPreviewHtml] = useState<string | null>(null);
    const [groupTestOpen, setGroupTestOpen] = useState(false);
    const [groupTestInput, setGroupTestInput] = useState("");
    const [groupTestExpandStep, setGroupTestExpandStep] = useState<number | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);
    // 文件夹：currentFolderId 是正在看的文件夹（null = 最外层）。和世界书同一套
    const [folders, setFolders] = useState<RegexFolder[]>([]);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [folderNameDialog, setFolderNameDialog] = useState<{ mode: "create" } | { mode: "rename"; id: string } | null>(null);
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
    const [moveSelection, setMoveSelection] = useState<Set<string> | null>(null);
    /** 最外层文件夹和正则组混排的顺序（长按拖出来的） */
    const [rootOrder, setRootOrder] = useState<string[]>([]);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadRegexes().map(normalizeGroupScope);
        if (loaded.length > 0) {
            setGroups(loaded);
            setActiveGroupId(loaded[0]?.id || "");
            saveRegexes(loaded);
        }
        setCustomApps(loadInstalledCustomApps());
        setFolders(loadRegexFolders());
        setRootOrder(loadRegexRootOrder());
        setIsLoaded(true);
    }, []);

    useEffect(() => {
        const refreshCustomApps = () => setCustomApps(loadInstalledCustomApps());
        const refreshRegexes = () => {
            const loaded = loadRegexes().map(normalizeGroupScope);
            setGroups(loaded);
            setActiveGroupId(current => current && loaded.some(group => group.id === current) ? current : loaded[0]?.id || "");
        };
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
        window.addEventListener("settings-regexes-updated", refreshRegexes);
        return () => {
            window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
            window.removeEventListener("settings-regexes-updated", refreshRegexes);
        };
    }, []);

    const regexScopeTagProfiles = useMemo(() => [
        ...BASE_REGEX_SCOPE_TAG_PROFILES,
        ...flattenTagGroups(buildCustomAppTagGroups(customApps, { regexes: groups })),
    ], [customApps, groups]);

    // Push mascot context only when this tab is active
    useEffect(() => {
        if (!isLoaded || !isActive) return;
        const activeGroup = groups.find(g => g.id === activeGroupId);
        const rulesSummary = activeGroup
            ? (activeGroup.rules || []).map(r => `${r.disabled ? "❌" : "✅"} ${r.scriptName}`).join(", ")
            : "";
        notifyMascotPageContext({
            page: "regex",
            mode: "editing",
            label: activeGroup ? `正则编辑 · ${activeGroup.name}` : "正则编辑",
            fields: activeGroup ? {
                groupId: activeGroup.id,
                groupName: activeGroup.name,
                ruleCount: String(activeGroup.rules?.length || 0),
                rules: rulesSummary,
            } : {},
        });
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, [isLoaded, isActive, activeGroupId, groups]);

    const persist = useCallback((newGroups: RegexConfig[]) => {
        setGroups(newGroups);
        saveRegexes(newGroups);
    }, []);

    const persistFolders = useCallback((next: RegexFolder[]) => {
        setFolders(next);
        saveRegexFolders(next);
    }, []);

    const currentFolder = currentFolderId ? folders.find(f => f.id === currentFolderId) ?? null : null;

    // 长按卡片拖动排序：最外层的文件夹和正则组混在一起排；置顶的（文件夹和正则组）之间、文件夹里面各自排
    const reorder = useLongPressReorder((group, orderedIds) => {
        if (group === "root" || group === "pinned") {
            const next = commitRootGroupOrder(group, orderedIds, groups, folders, rootOrder);
            persistFolders(next.folders);
            persist(applyGroupOrder(groups, next.itemIds));
            setRootOrder(next.rootOrder);
            saveRegexRootOrder(next.rootOrder);
            return;
        }
        persist(applyGroupOrder(groups, orderedIds));
    });

    const rxContainerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && activeGroupId) {
            // 从文件夹里点进来的，返回回到那个文件夹
            setOverrideBack(() => () => setViewMode("list"));
            const target = groups.find(g => g.id === activeGroupId);
            setSubpageTitle(target?.name || "正则组详情");
        } else if (currentFolder) {
            setOverrideBack(() => () => setCurrentFolderId(null));
            setSubpageTitle(currentFolder.name);
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, activeGroupId, groups, currentFolder, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        const scrollParent = rxContainerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, activeGroupId, currentFolderId]);

    // --- Group Level Operations ---
    const addGroup = useCallback(() => {
        // 在文件夹里新建就直接放进这个文件夹
        const newGroup = { ...createRegexGroup("新正则组"), ...(currentFolderId ? { folderId: currentFolderId } : {}) };
        persist([newGroup, ...groups]);
        setActiveGroupId(newGroup.id);
        setViewMode("detail");
    }, [groups, currentFolderId, persist]);

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
            const folder = createRegexFolder(folderNameDraft);
            persistFolders([folder, ...folders]);
            // 建好直接进去，方便马上把正则组移进来
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
        // 里面的正则组回到未分类
        if (groups.some(g => g.folderId === folderId)) {
            persist(groups.map(g => g.folderId === folderId ? { ...g, folderId: undefined, updatedAt: Date.now() } : g));
        }
        if (currentFolderId === folderId) setCurrentFolderId(null);
    };

    const moveGroupsToFolder = (groupIds: Set<string>, folderId: string | undefined) => {
        if (groupIds.size === 0) return;
        persist(groups.map(g => groupIds.has(g.id) ? { ...g, folderId, updatedAt: Date.now() } : g));
    };

    useEffect(() => {
        if (viewMode !== "list") {
            setSubpageRightAction("regex", null);
            return;
        }
        setSubpageRightAction("regex",
            <div className="flex items-center gap-2">
                {/* 和世界书一样三个都只放图标；文件夹只有一层，在文件夹里面不再显示「新建文件夹」 */}
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
                    aria-label="导入正则"
                    title="导入正则"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-gray-800 transition-all hover:bg-gray-50 active:scale-95 focus:outline-none"
                >
                    <Upload size={16} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    onClick={addGroup}
                    aria-label="新建正则"
                    title="新建正则"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-all hover:bg-gray-800 active:scale-95 focus:outline-none"
                >
                    <Plus size={16} strokeWidth={1.8} />
                </button>
            </div>
        );
        return () => setSubpageRightAction("regex", null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addGroup, setSubpageRightAction, viewMode, currentFolderId, folders]);

    const updateGroup = (id: string, updates: Partial<RegexConfig>) => {
        persist(groups.map(g => g.id === id ? { ...g, ...updates, updatedAt: Date.now() } : g));
    };

    const removeGroup = (id: string) => {
        const remaining = groups.filter(g => g.id !== id);
        persist(remaining);
        setViewMode("list");
        if (remaining.length > 0) {
            setActiveGroupId(remaining[0].id);
        } else {
            setActiveGroupId("");
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const fallbackName = file.name.replace(/\.json$/i, "") || "导入的正则组";
                const parsed = parseRegexFromJson(text, fallbackName);
                if (parsed) {
                    // 在文件夹里导入就放进这个文件夹
                    const scoped = { ...normalizeGroupScope(parsed), ...(currentFolderId ? { folderId: currentFolderId } : {}) };
                    persist([scoped, ...groups]);
                    setActiveGroupId(scoped.id);
                } else {
                    setImportError("无法解析正则文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该正则格式");
                } else {
                    setImportError("无法解析正则文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleExport = async (group: RegexConfig) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const exportData = { name: group.name, description: group.description, rules: group.rules };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${group.name || "regex_group"}.json`);
    };

    // --- Rule Level Operations ---
    const activeGroup = groups.find(g => g.id === activeGroupId);

    const visibleRules = activeGroup?.rules || [];

    // ── 规则左滑操作（微信式：左滑露出「新增/删除」） ──
    const swipe = useSwipeActions();

    const makeNewRule = (): RegexRule => ({
        id: `regex-rule-${Date.now()}`,
        scriptName: "新正则规则",
        findRegex: "",
        replaceString: "",
        disabled: false,
        placement: [1],
        tags: [...DEFAULT_REGEX_TAGS],
    });

    const addRule = () => {
        if (!activeGroup) return;
        const newRule = makeNewRule();
        updateGroup(activeGroup.id, { rules: [newRule, ...(activeGroup.rules || [])] });
        setEditingRuleId(newRule.id);
    };

    const insertRuleAfter = (afterId: string) => {
        if (!activeGroup) return;
        const newRule = makeNewRule();
        const rules = [...(activeGroup.rules || [])];
        const idx = rules.findIndex(r => r.id === afterId);
        if (idx >= 0) rules.splice(idx + 1, 0, newRule);
        else rules.push(newRule);
        updateGroup(activeGroup.id, { rules });
        swipe.close();
        setEditingRuleId(newRule.id);
        window.setTimeout(() => {
            rxContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(newRule.id)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    // ── 规则级导入/导出（左滑「替换/导出」+ 底部「添加条目」菜单） ──
    const [addRuleMenuOpen, setAddRuleMenuOpen] = useState(false);
    const ruleFileInputRef = useRef<HTMLInputElement>(null);
    const ruleImportModeRef = useRef<{ mode: "append" } | { mode: "replace"; id: string } | null>(null);

    const sanitizeRuleImport = (raw: unknown, fallbackId: string): RegexRule | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.findRegex !== "string" && typeof obj.scriptName !== "string") return null;
        const placement = Array.isArray(obj.placement)
            ? obj.placement.filter((v): v is number => typeof v === "number")
            : [];
        const rule: RegexRule = {
            id: fallbackId,
            scriptName: typeof obj.scriptName === "string" ? obj.scriptName : "导入的规则",
            findRegex: typeof obj.findRegex === "string" ? obj.findRegex : "",
            replaceString: typeof obj.replaceString === "string" ? obj.replaceString : "",
            disabled: !!obj.disabled,
            placement: placement.length > 0 ? placement : [1],
        };
        if (Array.isArray(obj.tags)) rule.tags = obj.tags.filter((t): t is string => typeof t === "string");
        if (Array.isArray(obj.trimStrings)) rule.trimStrings = obj.trimStrings.filter((t): t is string => typeof t === "string");
        if (typeof obj.markdownOnly === "boolean") rule.markdownOnly = obj.markdownOnly;
        if (typeof obj.promptOnly === "boolean") rule.promptOnly = obj.promptOnly;
        if (typeof obj.runOnEdit === "boolean") rule.runOnEdit = obj.runOnEdit;
        if (typeof obj.historyOnly === "boolean") rule.historyOnly = obj.historyOnly;
        if (typeof obj.substituteRegex === "number") rule.substituteRegex = obj.substituteRegex;
        if (typeof obj.minDepth === "number") rule.minDepth = obj.minDepth;
        if (typeof obj.maxDepth === "number") rule.maxDepth = obj.maxDepth;
        return normalizeRuleScope(rule);
    };

    const appendImportedRules = (group: RegexConfig, raws: unknown[]) => {
        const base = Date.now();
        const appended = raws
            .map((raw, i) => sanitizeRuleImport(raw, `regex-rule-${base + i}`))
            .filter((rule): rule is RegexRule => !!rule);
        if (appended.length === 0) {
            setImportError("JSON 里没有可识别的规则内容。");
            return;
        }
        updateGroup(group.id, { rules: [...(group.rules || []), ...appended] });
        if (appended.length === 1) setEditingRuleId(appended[0].id);
        window.setTimeout(() => {
            rxContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(appended[0].id)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    const replaceImportedRule = (group: RegexConfig, targetId: string, raw: unknown) => {
        const sanitized = sanitizeRuleImport(raw, targetId);
        if (!sanitized) {
            setImportError("JSON 里没有可识别的规则内容。");
            return;
        }
        // 保留原 id，只替换内容
        const finalRule = { ...sanitized, id: targetId };
        updateGroup(group.id, { rules: (group.rules || []).map(r => r.id === targetId ? finalRule : r) });
    };

    const exportRule = async (rule: RegexRule) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(rule, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${rule.scriptName || "regex-rule"}.json`);
    };

    const handleRuleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const mode = ruleImportModeRef.current;
        ruleImportModeRef.current = null;
        if (ruleFileInputRef.current) ruleFileInputRef.current.value = "";
        if (!file || !mode) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const group = groups.find(g => g.id === activeGroupId);
            if (!group) return;
            try {
                const parsed = JSON.parse(event.target?.result as string);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                if (mode.mode === "replace") replaceImportedRule(group, mode.id, items[0]);
                else appendImportedRules(group, items);
            } catch {
                setImportError("无法解析规则文件，格式不正确。");
            }
        };
        reader.readAsText(file);
    };

    const updateRule = (id: string, updates: Partial<RegexRule>) => {
        if (!activeGroup) return;
        const newRules = activeGroup.rules.map(r => r.id === id ? { ...r, ...updates } : r);
        updateGroup(activeGroup.id, { rules: newRules });
    };

    const removeRule = (id: string) => {
        if (!activeGroup) return;
        updateGroup(activeGroup.id, { rules: activeGroup.rules.filter(r => r.id !== id) });
        if (editingRuleId === id) setEditingRuleId(null);
        if (testingRuleId === id) setTestingRuleId(null);
    };

    // Run a single regex rule against test input (delegates to the production engine)
    function runTestRegex(rule: RegexRule, input: string): { output: string; matchCount: number; error?: string } {
        return testRegexRule(rule, input);
    }

    const openGroup = (groupId: string) => {
        setActiveGroupId(groupId);
        setViewMode("detail");
    };

    const renderGroupCard = (group: RegexConfig, orderGroup: string, groupIds: string[]) => (
        <div
            key={group.id}
            {...reorder.itemProps(orderGroup, group.id, groupIds)}
            className="ui-config-card min-w-0 cursor-pointer"
            style={{ minHeight: "84px", padding: "16px", justifyContent: "space-between" }}
            role="button"
            tabIndex={0}
            aria-label={`编辑 ${group.name || "正则组"}`}
            onClick={() => openGroup(group.id)}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openGroup(group.id);
                }
            }}
        >
            <div className="min-w-0 flex flex-col gap-1.5">
                <div className="min-w-0 flex items-center gap-[6px]">
                    <Database size={16} className="shrink-0" />
                    <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{group.name}</span>
                    {group.pinned ? <Pin size={13} className="ml-auto shrink-0 opacity-45" aria-label="已置顶" /> : null}
                </div>
                <span className="menu-desc truncate">{group.description || `${group.rules?.length || 0} 个规则`}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
                <span className="menu-desc ts-12">规则 {group.rules?.length || 0}</span>
                <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
            </div>
        </div>
    );

    if (!isLoaded) return null;

    return (
        <div ref={rxContainerRef} className="flex flex-col gap-5 h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            <input type="file" accept=".json" className="hidden" ref={ruleFileInputRef} onChange={handleRuleImportFile} />
            {viewMode === "list" ? (
                currentFolder ? (
                    <>
                        {/* 文件夹名已经在顶上标题栏里了；最前面的图钉是置顶这个文件夹，变黑就是已置顶（和世界书一样） */}
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
                                <span>移入正则</span>
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
                            const inside = groupRegexesByFolder(groups, folders).inFolder(currentFolder.id);
                            const insidePinned = inside.filter(g => g.pinned);
                            const insideRest = inside.filter(g => !g.pinned);
                            return inside.length === 0 ? (
                                <div className="ui-empty mt-2">
                                    <div className="ui-icon-circle">
                                        <Folder size={24} />
                                    </div>
                                    <span className="menu-label font-semibold">文件夹是空的</span>
                                    <span className="menu-desc text-center max-w-[240px] !mt-0">
                                        点「移入正则」把已有的正则组放进来，或者在这里直接新建、导入。
                                    </span>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-3">
                                    {reorder.order("inside-pinned", insidePinned).map(group => renderGroupCard(group, "inside-pinned", insidePinned.map(g => g.id)))}
                                    {reorder.order("inside", insideRest).map(group => renderGroupCard(group, "inside", insideRest.map(g => g.id)))}
                                </div>
                            );
                        })()}
                    </>
                ) : (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Regex</h2>
                    </div>

                    {groups.length === 0 && folders.length === 0 ? (
                        <div className="ui-empty mt-2">
                            <div className="ui-icon-circle">
                                <Database size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有正则组</span>
                            <span className="menu-desc max-w-[240px]">
                                正则用于在发送给 AI 或收到 AI 回复时进行高阶的文本替换与格式处理。
                            </span>
                            <button onClick={addGroup} className="ui-btn ui-btn-primary mt-2">
                                <Plus size={16} /> 新建正则组
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {(() => {
                                const grouped = groupRegexesByFolder(groups, folders);
                                const pinnedEntries = buildPinnedEntries(groups, folders, rootOrder);
                                const pinnedIds = pinnedEntries.map(entry => entry.id);
                                const rootEntries = buildRegexRootEntries(groups, folders, rootOrder);
                                const rootIds = rootEntries.map(entry => entry.id);
                                const renderFolderCard = (folder: RegexFolder, group: string, groupIds: string[]) => {
                                    const inside = grouped.inFolder(folder.id);
                                    return (
                                        <div
                                            key={folder.id}
                                            {...reorder.itemProps(group, folder.id, groupIds)}
                                            className="ui-config-card min-w-0 cursor-pointer"
                                            style={{ minHeight: "84px", padding: "16px", justifyContent: "space-between" }}
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
                                                    {inside.length > 0 ? inside.map(g => g.name).join("、") : "空文件夹"}
                                                </span>
                                            </div>
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="menu-desc ts-12">正则组 {inside.length}</span>
                                                <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
                                            </div>
                                        </div>
                                    );
                                };
                                return (
                                    <>
                                        {/* 置顶的文件夹和正则组放最上面（在文件夹里的置顶正则组也会出现在这里） */}
                                        {reorder.order("pinned", pinnedEntries).map(entry => (
                                            entry.folder ? renderFolderCard(entry.folder, "pinned", pinnedIds) : entry.item ? renderGroupCard(entry.item, "pinned", pinnedIds) : null
                                        ))}
                                        {/* 文件夹和正则组混在一起，按拖出来的顺序 */}
                                        {reorder.order("root", rootEntries).map(entry => (
                                            entry.folder ? renderFolderCard(entry.folder, "root", rootIds) : entry.item ? renderGroupCard(entry.item, "root", rootIds) : null
                                        ))}
                                    </>
                                );
                            })()}
                        </div>
                    )}
                </>
                )
            ) : (
                <>
                    {activeGroup && (
                        <div className="flex flex-col gap-4 pb-6">
                            <div className="flex justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleExport(activeGroup)}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95"
                                >
                                    <Download size={15} strokeWidth={1.8} />
                                    <span>导出正则</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteTarget({ type: 'group', id: activeGroup.id })}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                >
                                    <Trash2 size={15} strokeWidth={1.8} />
                                    <span>删除正则</span>
                                </button>
                            </div>

                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Regex Info</h2>
                            <div className="ui-entry-card" style={{ cursor: "default" }}>
                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">正则组名称</label>
                                    <input
                                        type="text"
                                        value={activeGroup.name}
                                        onChange={(e) => updateGroup(activeGroup.id, { name: e.target.value })}
                                        placeholder="正则组名称..."
                                        className="ui-input font-medium"
                                    />
                                </div>

                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">简介描述</label>
                                    <textarea
                                        value={activeGroup.description || ""}
                                        onChange={(e) => updateGroup(activeGroup.id, { description: e.target.value })}
                                        placeholder="简介描述..."
                                        rows={2}
                                        className="ui-textarea resize-none"
                                    />
                                </div>

                                <div className="flex items-center justify-between gap-3">
                                    <label className="menu-label ts-13 font-semibold ml-1">置顶</label>
                                    <Toggle
                                        checked={activeGroup.pinned === true}
                                        onChange={(value) => updateGroup(activeGroup.id, { pinned: value || undefined })}
                                    />
                                </div>
                            </div>

                            <div className="flex flex-col gap-4 mt-2">
                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Regex Rules ({activeGroup.rules?.length || 0})</h2>

                            <button
                                className="ui-btn ui-btn-outline w-full ts-13"
                                onClick={() => setGroupTestOpen(!groupTestOpen)}
                            >
                                <Play size={14} fill="currentColor" /> {groupTestOpen ? "收起整组测试" : "整组测试"}
                            </button>

                            {groupTestOpen && activeGroup && (() => {
                                let groupOutput = groupTestInput;
                                const steps: { name: string; output: string; changed: boolean; skipped?: string }[] = [];
                                for (const rule of activeGroup.rules) {
                                    if (rule.disabled) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: "已禁用" }); continue; }
                                    if (!rule.placement?.includes(2)) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: `位置=${JSON.stringify(rule.placement)}` }); continue; }
                                    if (rule.promptOnly) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: "仅Prompt" }); continue; }
                                    const before = groupOutput;
                                    try {
                                        const { output } = testRegexRule(rule, groupOutput);
                                        groupOutput = output;
                                    } catch { /* skip */ }
                                    steps.push({ name: rule.scriptName, output: groupOutput, changed: groupOutput !== before });
                                }
                                return (
                                    <div className="ui-entry-card flex flex-col gap-3" data-active="true" style={{ gap: 12 }}>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc">测试输入（粘贴一段完整的 AI 回复）</label>
                                            <textarea
                                                value={groupTestInput}
                                                onChange={(e) => { setGroupTestInput(e.target.value); setGroupTestExpandStep(null); }}
                                                placeholder="在这里粘入 AI 原始回复文本..."
                                                rows={5}
                                                className="ui-textarea ts-13"
                                            />
                                        </div>
                                        {groupTestInput.trim() && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc">执行步骤 ({steps.filter(s => !s.skipped).length} 条规则执行，{steps.filter(s => s.skipped).length} 条跳过)</label>
                                                    <div className="flex flex-col gap-1">
                                                        {steps.map((step, i) => (
                                                            <div key={i}>
                                                                <button
                                                                    onClick={() => setGroupTestExpandStep(groupTestExpandStep === i ? null : i)}
                                                                    className="flex items-center gap-2 ts-12 w-full bg-transparent border-none text-left cursor-pointer p-0"
                                                                    style={{ padding: "4px 0", borderBottom: "1px solid var(--c-panel-border)" }}
                                                                >
                                                                    <span className="ui-tag" data-variant={step.skipped ? "muted" : step.changed ? "success" : "muted"} style={{ minWidth: 24, textAlign: "center", fontSize: "calc(11px*var(--app-text-scale,1))" }}>
                                                                        {step.skipped ? "跳" : step.changed ? "改" : "—"}
                                                                    </span>
                                                                    <span className="menu-label ts-12 truncate flex-1">{step.name}</span>
                                                                    {step.skipped && <span className="ts-11" style={{ color: "var(--c-icon)", opacity: 0.6 }}>{step.skipped}</span>}
                                                                </button>
                                                                {groupTestExpandStep === i && !step.skipped && (
                                                                    <div className="flex flex-col gap-1" style={{ margin: "4px 0 8px" }}>
                                                                        <div className="flex items-center justify-end">
                                                                            <CopyCodeButton text={step.output} />
                                                                        </div>
                                                                        <div className="ui-code-block" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "calc(12px*var(--app-text-scale,1))" }}>
                                                                            {step.output || <span className="menu-desc !mt-0">(空)</span>}
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                                        <label className="menu-desc !mt-0">最终输出</label>
                                                        <CopyCodeButton text={groupOutput} />
                                                    </div>
                                                    <div className="ui-code-block" style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "calc(13px*var(--app-text-scale,1))" }}>
                                                        {groupOutput || <span className="menu-desc !mt-0">(空)</span>}
                                                    </div>
                                                </div>
                                                {/<[a-z][\s\S]*?>/i.test(groupOutput) && (
                                                    <button
                                                        className="ui-btn ui-btn-outline self-end ts-13"
                                                        onClick={() => setPreviewHtml(groupOutput)}
                                                    >
                                                        <Maximize2 size={14} /> 渲染预览
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                );
                            })()}

                            <div className="flex flex-col gap-2">
                                {visibleRules.length === 0 ? (
                                    <div className="menu-desc text-center mt-10 ts-14">
                                        没找到相关的正则规则
                                    </div>
                                ) : (
                                    visibleRules.map(rule => {
                                        const isEditing = editingRuleId === rule.id;

                                        return (
                                            <SwipeActionRow
                                                key={rule.id}
                                                controller={swipe}
                                                id={rule.id}
                                                disabled={isEditing}
                                                actions={
                                                    <>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="insert"
                                                            onClick={() => insertRuleAfter(rule.id)}
                                                        >
                                                            <Plus size={18} strokeWidth={2} />
                                                            <span>新增</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="replace"
                                                            onClick={() => {
                                                                ruleImportModeRef.current = { mode: "replace", id: rule.id };
                                                                ruleFileInputRef.current?.click();
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
                                                                exportRule(rule);
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
                                                                setConfirmDeleteTarget({ type: 'rule', id: rule.id });
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
                                                data-disabled={rule.disabled && !isEditing ? "true" : undefined}
                                                style={{ gap: isEditing ? 12 : 0 }}
                                            >
                                                <div className="flex justify-between items-start">
                                                    <button
                                                        onClick={() => {
                                                            if (swipe.consumeClickSuppression()) return;
                                                            if (swipe.openId || swipe.swipingId) {
                                                                swipe.close();
                                                                return;
                                                            }
                                                            setEditingRuleId(isEditing ? null : rule.id);
                                                        }}
                                                        className="flex gap-3 flex-1 bg-none border-none text-left cursor-pointer p-0"
                                                    >
                                                        <div className="mt-0.5 ui-entry-icon">
                                                            <Database size={20} />
                                                        </div>
                                                        <div className="flex flex-col gap-1 flex-1">
                                                            <span className="menu-label font-semibold break-all ts-15">
                                                                {rule.scriptName || "(未命名规则)"}
                                                            </span>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="ui-tag" data-variant="muted">
                                                                    <span className="font-mono overflow-hidden text-ellipsis whitespace-nowrap max-w-[160px] inline-block align-bottom">{rule.findRegex || "无匹配正则"}</span>
                                                                </span>
                                                                <span className="ui-status-tag" data-variant={getRuleTags(rule).length > 0 ? "success" : undefined}>
                                                                    {getRuleTagsLabel(rule, regexScopeTagProfiles)}
                                                                </span>
                                                                {rule.disabled && <span className="ui-status-tag">已禁用</span>}
                                                            </div>
                                                        </div>
                                                    </button>

                                                    <div className="flex gap-3 ml-3 shrink-0 items-center">
                                                        <label
                                                            className="ui-mini-toggle"
                                                            onClick={(e) => e.stopPropagation()}
                                                            title={rule.disabled ? "已禁用 (点击启用)" : "已启用 (点击禁用)"}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={!rule.disabled}
                                                                onChange={(e) => updateRule(rule.id, { disabled: !e.target.checked })}
                                                                className="ui-mini-toggle-track"
                                                            />
                                                            <span className="ui-mini-toggle-thumb" />
                                                        </label>
                                                    </div>
                                                </div>

                                                {isEditing && (
                                                    <div className="ui-entry-separator flex flex-col gap-3">
                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">规则名称 (Script Name)</label>
                                                            <input
                                                                type="text"
                                                                value={rule.scriptName}
                                                                onChange={(e) => updateRule(rule.id, { scriptName: e.target.value })}
                                                                placeholder="例如: 屏蔽广告词"
                                                                className="ui-input ts-14 font-medium"
                                                            />
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">匹配内容 (Find Regex)</label>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={rule.findRegex}
                                                                    onChange={(e) => updateRule(rule.id, { findRegex: e.target.value })}
                                                                    placeholder="/正则表达式/flags&#10;例: /\[.*?\]/gs&#10;flags 由用户指定，不会自动添加"
                                                                    rows={3}
                                                                    className="ui-textarea ts-13 font-mono"
                                                                />
                                                                <button onClick={() => setExpandTarget({ ruleId: rule.id, field: "findRegex" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">替换为 (Replace String)</label>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={rule.replaceString}
                                                                    onChange={(e) => updateRule(rule.id, { replaceString: e.target.value })}
                                                                    placeholder="留空即为删除，支持 $1 $<name> {{match}} {{char}}"
                                                                    rows={2}
                                                                    className="ui-textarea ts-13 font-mono"
                                                                />
                                                                <button onClick={() => setExpandTarget({ ruleId: rule.id, field: "replaceString" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">作用位置 (Placement)</label>
                                                            <div className="flex items-center justify-between gap-4 mt-2">
                                                                {([
                                                                    [1, "用户输入"],
                                                                    [2, "AI 输出"],
                                                                    [5, "世界书"],
                                                                    [6, "思维链"],
                                                                ] as const).map(([val, label]) => {
                                                                    // 「仅历史消息」只有在组装提示词（用户输入）这一环才拿得到历史标记，
                                                                    // 勾在别的环节上规则会彻底不触发——所以开着它时锁死为「用户输入」
                                                                    const lockedToInput = rule.historyOnly === true;
                                                                    return (
                                                                        <label
                                                                            key={val}
                                                                            className="ui-checkbox-label whitespace-nowrap"
                                                                            style={lockedToInput && val !== 1 ? { opacity: 0.35 } : undefined}
                                                                        >
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={lockedToInput ? val === 1 : (rule.placement?.includes(val) ?? false)}
                                                                                disabled={lockedToInput}
                                                                                onChange={(e) => {
                                                                                    const p = new Set(rule.placement || []);
                                                                                    e.target.checked ? p.add(val) : p.delete(val);
                                                                                    updateRule(rule.id, { placement: [...p] });
                                                                                }}
                                                                            />
                                                                            {label}
                                                                        </label>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">应用模式</label>
                                                            <div className="flex items-center justify-between gap-6 mt-2">
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.markdownOnly ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { markdownOnly: e.target.checked || undefined, promptOnly: e.target.checked ? undefined : rule.promptOnly })} />
                                                                    仅显示时
                                                                </label>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.promptOnly ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { promptOnly: e.target.checked || undefined, markdownOnly: e.target.checked ? undefined : rule.markdownOnly })} />
                                                                    仅Prompt
                                                                </label>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.runOnEdit ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { runOnEdit: e.target.checked || undefined })} />
                                                                    编辑时执行
                                                                </label>
                                                            </div>
                                                            <div className="flex items-center justify-between gap-6 mt-2">
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.historyOnly ?? false}
                                                                        onChange={(e) => updateRule(rule.id, e.target.checked
                                                                            // 勾上即锁定为「用户输入」：这是它唯一能生效的环节
                                                                            ? { historyOnly: true, placement: [1] }
                                                                            : { historyOnly: undefined })} />
                                                                    仅历史消息
                                                                </label>
                                                                <span className="menu-desc !mt-0">只作用于聊天历史消息，不碰系统提示词/预设/世界书</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">适用范围</label>
                                                            <select
                                                                value={getRuleTagProfileId(rule, regexScopeTagProfiles)}
                                                                onChange={(e) => {
                                                                    const selectedProfile = regexScopeTagProfiles.find(profile => profile.id === e.target.value);
                                                                    if (!selectedProfile) return;
                                                                    updateRule(rule.id, setRuleTags(selectedProfile.tags));
                                                                }}
                                                                className="ui-input ts-13"
                                                            >
                                                                {getRuleTagProfileId(rule, regexScopeTagProfiles) === "__custom__" ? (
                                                                    <option value="__custom__">{getRuleRawTagsLabel(rule)}</option>
                                                                ) : null}
                                                                {regexScopeTagProfiles.map((profile) => (
                                                                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                                                                ))}
                                                            </select>
                                                            <div className="menu-desc !mt-0">
                                                                实际标签：{getRuleRawTagsLabel(rule)}
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">Trim Strings（从捕获组中移除的文本，每行一条）</label>
                                                            <textarea
                                                                value={(rule.trimStrings || []).join("\n")}
                                                                onChange={(e) => {
                                                                    const lines = e.target.value.split("\n").filter(s => s.length > 0);
                                                                    updateRule(rule.id, { trimStrings: lines.length > 0 ? lines : undefined });
                                                                }}
                                                                placeholder="每行一条要移除的文本..."
                                                                rows={2}
                                                                className="ui-textarea ts-13 font-mono"
                                                            />
                                                        </div>

                                                        <div className="flex gap-4 items-end flex-wrap">
                                                            <div className="flex flex-col gap-1 flex-1 min-w-[100px]">
                                                                <label className="menu-desc">宏替换 (Find Regex)</label>
                                                                <select value={rule.substituteRegex ?? 0}
                                                                    onChange={(e) => updateRule(rule.id, { substituteRegex: Number(e.target.value) || undefined })}
                                                                    className="ui-input ts-13">
                                                                    <option value={0}>不替换</option>
                                                                    <option value={1}>RAW（直接展开）</option>
                                                                    <option value={2}>ESCAPED（转义特殊字符）</option>
                                                                </select>
                                                            </div>
                                                            <div className="flex flex-col gap-1 w-[72px]">
                                                                <label className="menu-desc">最小深度</label>
                                                                <input type="number" value={rule.minDepth ?? ""} placeholder="-1"
                                                                    onChange={(e) => updateRule(rule.id, { minDepth: e.target.value ? Number(e.target.value) : undefined })}
                                                                    className="ui-input ts-13" />
                                                            </div>
                                                            <div className="flex flex-col gap-1 w-[72px]">
                                                                <label className="menu-desc">最大深度</label>
                                                                <input type="number" value={rule.maxDepth ?? ""} placeholder="∞"
                                                                    onChange={(e) => updateRule(rule.id, { maxDepth: e.target.value ? Number(e.target.value) : undefined })}
                                                                    className="ui-input ts-13" />
                                                            </div>
                                                        </div>

                                                        <button
                                                            className="ui-btn ui-btn-outline w-full mt-1 ts-13"
                                                            onClick={() => {
                                                                const opening = testingRuleId !== rule.id;
                                                                setTestingRuleId(opening ? rule.id : null);
                                                            }}
                                                        >
                                                            <Play size={14} fill="currentColor" /> {testingRuleId === rule.id ? "收起测试" : "测试正则"}
                                                        </button>

                                                        {testingRuleId === rule.id && (() => {
                                                            const { output, matchCount, error } = runTestRegex(rule, testInput);
                                                            return (
                                                                <div className="ui-entry-separator flex flex-col gap-3">
                                                                    <div className="flex flex-col gap-1">
                                                                        <label className="menu-desc">测试输入</label>
                                                                        <textarea
                                                                            value={testInput}
                                                                            onChange={(e) => setTestInput(e.target.value)}
                                                                            placeholder="输入要测试的文本..."
                                                                            rows={3}
                                                                            className="ui-textarea ts-13"
                                                                        />
                                                                    </div>
                                                                    {error ? (
                                                                        <div className="flex items-start gap-2 p-2.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--c-danger) 12%, transparent)", border: "1px solid var(--c-danger)" }}>
                                                                            <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: "var(--c-danger)" }} />
                                                                            <span className="ts-12" style={{ color: "var(--c-danger)" }}>{error}</span>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="flex flex-col gap-1">
                                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                                <label className="menu-desc !mt-0">替换结果</label>
                                                                                <span className="ui-tag" data-variant={matchCount > 0 ? "success" : "muted"}>
                                                                                    {matchCount > 0 ? `${matchCount} 处匹配` : "无匹配"}
                                                                                </span>
                                                                                <span className="flex-1" />
                                                                                <CopyCodeButton text={output} />
                                                                            </div>
                                                                            <div className="ui-code-block">{output || <span className="menu-desc !mt-0">(空)</span>}</div>
                                                                        </div>
                                                                    )}
                                                                    {!error && matchCount > 0 && /<[a-z][\s\S]*?>/i.test(output) && (
                                                                        <button
                                                                            className="ui-btn ui-btn-outline self-end ts-13"
                                                                            onClick={() => setPreviewHtml(output)}
                                                                        >
                                                                            <Maximize2 size={14} /> 渲染预览
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
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
                                onClick={() => setAddRuleMenuOpen(true)}
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

            {confirmDeleteTarget && (
                <ConfirmDialog
                    title="确认删除？"
                    message={confirmDeleteTarget.type === 'group' ? "删除正则组后无法恢复。是否继续？" : "删除规则后无法恢复。是否继续？"}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        if (confirmDeleteTarget.type === 'group') {
                            removeGroup(confirmDeleteTarget.id);
                        } else {
                            removeRule(confirmDeleteTarget.id);
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
                    message="只删文件夹，里面的正则组不会删除，会回到未分类。"
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
                const candidates = groups.filter(g => g.folderId !== currentFolder.id);
                const folderName = (group: RegexConfig) =>
                    folders.find(f => f.id === group.folderId)?.name ?? "未分类";
                return (
                    <BottomSheet title={`移入「${currentFolder.name}」`} onClose={() => setMoveSelection(null)}>
                        <div className="flex flex-col gap-2">
                            {candidates.length === 0 ? (
                                <div className="menu-desc text-center py-6">没有别的正则组可以移进来了</div>
                            ) : (
                                <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                                    {candidates.map(group => {
                                        const checked = moveSelection.has(group.id);
                                        return (
                                            <button
                                                key={group.id}
                                                type="button"
                                                className="binding-sheet-option"
                                                data-selected={checked}
                                                aria-pressed={checked}
                                                onClick={() => setMoveSelection(prev => {
                                                    const next = new Set(prev ?? []);
                                                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                                                    return next;
                                                })}
                                            >
                                                <span className="binding-sheet-check">{checked && <Check size={15} />}</span>
                                                <span className="binding-sheet-option-text">{group.name}</span>
                                                <span className="binding-sheet-option-meta">{folderName(group)}</span>
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
                                    moveGroupsToFolder(moveSelection, currentFolder.id);
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

            {addRuleMenuOpen && activeGroup && (
                <BottomSheet title="添加条目" onClose={() => setAddRuleMenuOpen(false)}>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full"
                            onClick={() => {
                                setAddRuleMenuOpen(false);
                                addRule();
                            }}
                        >
                            <Plus size={16} /> 直接创建
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline w-full"
                            onClick={() => {
                                setAddRuleMenuOpen(false);
                                ruleImportModeRef.current = { mode: "append" };
                                ruleFileInputRef.current?.click();
                            }}
                        >
                            <Upload size={16} /> 从 JSON 文件导入
                        </button>
                    </div>
                </BottomSheet>
            )}

            {expandTarget && (() => {
                const rule = activeGroup?.rules?.find(r => r.id === expandTarget.ruleId);
                if (!rule) return null;
                const isFind = expandTarget.field === "findRegex";
                return (
                    <TextExpandModal
                        title={isFind ? "匹配内容 (Find Regex)" : "替换为 (Replace String)"}
                        value={rule[expandTarget.field]}
                        onChange={(v) => updateRule(rule.id, { [expandTarget.field]: v })}
                        placeholder={isFind ? "/正则表达式/flags  例: /\\[.*?\\]/gs\nflags 由用户指定，不会自动添加" : "留空即为删除，支持 $1 $<name> {{match}} {{char}}"}
                        className="ts-13 font-mono"
                        onClose={() => setExpandTarget(null)}
                    />
                );
            })()}

            {previewHtml && (
                <div className="absolute inset-0 z-[999] flex flex-col" style={{ background: "var(--c-page-body-bg)" }}>
                    <header className="flex items-center justify-between px-4 shrink-0" style={{ height: 48, marginTop: 48 }}>
                        <span className="menu-label font-semibold ts-15">渲染预览</span>
                        <button onClick={() => setPreviewHtml(null)} className="w-[32px] h-[32px] rounded-full flex items-center justify-center" style={{ background: "var(--c-card)", color: "var(--c-text)" }}>
                            <X size={18} />
                        </button>
                    </header>
                    <div className="flex-1 overflow-auto p-4">
                        <HtmlPreviewFrame html={extractHtmlForPreview(previewHtml)} />
                    </div>
                </div>
            )}
        </div>
    );
}
