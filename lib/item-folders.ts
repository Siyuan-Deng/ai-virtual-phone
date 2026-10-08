"use client";

// 设置页列表的文件夹（世界书、API 配置共用）：只用来分组。一项最多在一个文件夹里（folderId），
// 文件夹本身只存名字。删文件夹时里面的东西回到「未分类」，不会跟着删。
// 最外层是「文件夹」和「没进文件夹的项」混排的，顺序单独存一份 id 列表（rootOrder）；
// 置顶的（文件夹和项都能置顶）另外放在最上面一组，这一组的顺序也存在 rootOrder 里。

import { kvGet, kvSet } from "./kv-db";
import { mergeOrder } from "./list-order";

export type ItemFolder = {
    id: string;
    name: string;
    createdAt: number;
    pinned?: boolean;
};

type FolderItem = { id: string; folderId?: string; pinned?: boolean };

export function loadItemFolders(key: string): ItemFolder[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(key) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
                id: String(item.id || ""),
                name: String(item.name || "").slice(0, 40) || "未命名文件夹",
                createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
                ...(item.pinned === true ? { pinned: true } : {}),
            }))
            .filter((item) => item.id);
    } catch {
        return [];
    }
}

export function saveItemFolders(key: string, folders: ItemFolder[]): void {
    if (typeof window === "undefined") return;
    kvSet(key, JSON.stringify(folders));
}

export function createItemFolder(idPrefix: string, name: string): ItemFolder {
    const now = Date.now();
    return {
        id: `${idPrefix}_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim().slice(0, 40) || "未命名文件夹",
        createdAt: now,
    };
}

export function loadRootOrder(key: string): string[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(key) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export function saveRootOrder(key: string, ids: string[]): void {
    if (typeof window === "undefined") return;
    kvSet(key, JSON.stringify(ids));
}

/** 按文件夹分组。置顶的单独一组（在文件夹里的也算，最外层要把它们放在最上面），
 *  未分类的不含置顶的；文件夹里面照常列出全部（置顶的在前）。指向不存在文件夹的算未分类。 */
export function groupItemsByFolder<T extends FolderItem>(
    items: T[],
    folders: ItemFolder[],
): { pinned: T[]; unfiled: T[]; inFolder: (folderId: string) => T[] } {
    const known = new Set(folders.map((folder) => folder.id));
    return {
        pinned: items.filter((item) => item.pinned === true),
        unfiled: items.filter((item) => item.pinned !== true && (!item.folderId || !known.has(item.folderId))),
        inFolder: (folderId: string) => items.filter((item) => item.folderId === folderId),
    };
}

export type RootEntry<T> = { id: string; folder?: ItemFolder; item?: T };

function orderEntries<T>(defaults: RootEntry<T>[], rootOrder: string[]): RootEntry<T>[] {
    const byId = new Map(defaults.map((entry) => [entry.id, entry]));
    return mergeOrder(rootOrder, defaults.map((entry) => entry.id))
        .map((id) => byId.get(id))
        .filter((entry): entry is RootEntry<T> => Boolean(entry));
}

/** 最外层最上面那组：置顶的文件夹和置顶的项（在文件夹里的也算）混排，按存过的顺序；没存过就是文件夹在前 */
export function buildPinnedEntries<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): RootEntry<T>[] {
    return orderEntries([
        ...folders.filter((folder) => folder.pinned).map((folder) => ({ id: folder.id, folder })),
        ...groupItemsByFolder(items, folders).pinned.map((item) => ({ id: item.id, item })),
    ], rootOrder);
}

/** 最外层（置顶的除外）：文件夹和没进文件夹的项，按存过的混排顺序；没存过就是文件夹在前、其余在后 */
export function buildRootEntries<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): RootEntry<T>[] {
    return orderEntries([
        ...folders.filter((folder) => !folder.pinned).map((folder) => ({ id: folder.id, folder })),
        ...groupItemsByFolder(items, folders).unfiled.map((item) => ({ id: item.id, item })),
    ], rootOrder);
}

/** 各处选择框的最外层：和设置页一样先置顶的一组，再其余混排；空文件夹不显示。
 *  一个非空文件夹都没有时返回 null，选择框照旧平铺。 */
export function buildPickerEntries<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): RootEntry<T>[] | null {
    const known = new Set(folders.map((folder) => folder.id));
    const used = new Set(items.map((item) => item.folderId).filter((id): id is string => Boolean(id && known.has(id))));
    if (used.size === 0) return null;
    return [...buildPinnedEntries(items, folders, rootOrder), ...buildRootEntries(items, folders, rootOrder)]
        .filter((entry) => entry.item || (entry.folder && used.has(entry.folder.id)));
}

/** 没有文件夹层级的平铺列表照设置页的样子排：先置顶的一组，再最外层，碰到文件夹就把它里面的依次展开（排过的不重复） */
export function orderLikeFolders<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): T[] {
    if (folders.length === 0 && rootOrder.length === 0) return items;
    const seen = new Set<string>();
    const result: T[] = [];
    const push = (item: T) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        result.push(item);
    };
    for (const entry of [...buildPinnedEntries(items, folders, rootOrder), ...buildRootEntries(items, folders, rootOrder)]) {
        if (entry.item) push(entry.item);
        else if (entry.folder) items.filter((item) => item.folderId === entry.folder!.id).forEach(push);
    }
    items.forEach(push);
    return result;
}

/** 设置页最外层拖完一组以后要存的东西：两组拼起来的总顺序（rootOrder），文件夹数组也按它排 */
export function commitRootGroupOrder<T extends FolderItem>(
    group: "pinned" | "root",
    orderedIds: string[],
    items: T[],
    folders: ItemFolder[],
    rootOrder: string[],
): { rootOrder: string[]; folders: ItemFolder[]; itemIds: string[] } {
    const pinnedIds = buildPinnedEntries(items, folders, rootOrder).map((entry) => entry.id);
    const restIds = buildRootEntries(items, folders, rootOrder).map((entry) => entry.id);
    const nextOrder = group === "pinned" ? [...orderedIds, ...restIds] : [...pinnedIds, ...orderedIds];
    const position = new Map(nextOrder.map((id, index) => [id, index]));
    const folderIds = new Set(folders.map((folder) => folder.id));
    return {
        rootOrder: nextOrder,
        folders: [...folders].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)),
        itemIds: orderedIds.filter((id) => !folderIds.has(id)),
    };
}
