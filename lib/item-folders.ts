"use client";

// 设置页列表的文件夹（世界书、API 配置共用）：只用来分组。一项最多在一个文件夹里（folderId），
// 文件夹本身只存名字和顺序。删文件夹时里面的东西回到「未分类」，不会跟着删。

import { kvGet, kvSet } from "./kv-db";

export type ItemFolder = {
    id: string;
    name: string;
    createdAt: number;
};

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

/** 按文件夹分组。置顶的单独一组（在文件夹里的也算，最外层要把它们放在最上面），
 *  未分类的不含置顶的；文件夹里面照常列出全部（置顶的在前）。指向不存在文件夹的算未分类。 */
export function groupItemsByFolder<T extends { id: string; folderId?: string; pinned?: boolean }>(
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
