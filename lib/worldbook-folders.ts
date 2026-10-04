"use client";

// 世界书文件夹：只用来给世界书分组。一本世界书最多在一个文件夹里（WorldBookConfig.folderId），
// 文件夹本身只存名字。删文件夹时里面的世界书回到「未分类」，不会跟着删。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { WorldBookConfig } from "./settings-types";

const FOLDERS_KEY = "ai_phone_worldbook_folders_v1";
registerKvMigration(FOLDERS_KEY);

export type WorldBookFolder = {
    id: string;
    name: string;
    createdAt: number;
};

export function loadWorldBookFolders(): WorldBookFolder[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(FOLDERS_KEY) || "[]") as unknown;
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

export function saveWorldBookFolders(folders: WorldBookFolder[]): void {
    if (typeof window === "undefined") return;
    kvSet(FOLDERS_KEY, JSON.stringify(folders));
}

export function createWorldBookFolder(name: string): WorldBookFolder {
    const now = Date.now();
    return {
        id: `wbf_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim().slice(0, 40) || "未命名文件夹",
        createdAt: now,
    };
}

/** 按文件夹分组；指向不存在文件夹的世界书算未分类 */
export function groupWorldBooksByFolder<T extends Pick<WorldBookConfig, "id" | "folderId">>(
    books: T[],
    folders: WorldBookFolder[],
): { unfiled: T[]; inFolder: (folderId: string) => T[] } {
    const known = new Set(folders.map((folder) => folder.id));
    return {
        unfiled: books.filter((book) => !book.folderId || !known.has(book.folderId)),
        inFolder: (folderId: string) => books.filter((book) => book.folderId === folderId),
    };
}
