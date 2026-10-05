"use client";

// 设置页列表的文件夹（世界书、API 配置共用）：只用来分组。一项最多在一个文件夹里（folderId），
// 文件夹本身只存名字。删文件夹时里面的东西回到「未分类」，不会跟着删。
// 最外层是「文件夹」和「没进文件夹的项」混排的，顺序单独存一份 id 列表（rootOrder）；
// 置顶的另外放在最上面。

import { kvGet, kvSet } from "./kv-db";
import { mergeOrder } from "./list-order";

export type ItemFolder = {
    id: string;
    name: string;
    createdAt: number;
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

/** 最外层（置顶的除外）：文件夹和没进文件夹的项，按存过的混排顺序；没存过就是文件夹在前、其余在后 */
export function buildRootEntries<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): RootEntry<T>[] {
    const grouped = groupItemsByFolder(items, folders);
    const defaults: RootEntry<T>[] = [
        ...folders.map((folder) => ({ id: folder.id, folder })),
        ...grouped.unfiled.map((item) => ({ id: item.id, item })),
    ];
    const byId = new Map(defaults.map((entry) => [entry.id, entry]));
    return mergeOrder(rootOrder, defaults.map((entry) => entry.id))
        .map((id) => byId.get(id))
        .filter((entry): entry is RootEntry<T> => Boolean(entry));
}

/** 没有文件夹层级的平铺列表（各处的选择框）照设置页的样子排：置顶的在前，然后按最外层的顺序，
 *  碰到文件夹就把它里面的（置顶的已经在前面了）依次展开 */
export function orderLikeFolders<T extends FolderItem>(items: T[], folders: ItemFolder[], rootOrder: string[]): T[] {
    if (folders.length === 0 && rootOrder.length === 0) return items;
    const pinned = items.filter((item) => item.pinned === true);
    const rest = buildRootEntries(items, folders, rootOrder).flatMap((entry) => (
        entry.folder
            ? items.filter((item) => item.pinned !== true && item.folderId === entry.folder!.id)
            : entry.item ? [entry.item] : []
    ));
    return [...pinned, ...rest];
}
