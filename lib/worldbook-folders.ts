"use client";

// 世界书文件夹：只用来给世界书分组。一本世界书最多在一个文件夹里（WorldBookConfig.folderId），
// 文件夹本身只存名字。删文件夹时里面的世界书回到「未分类」，不会跟着删。存取和 API 配置文件夹共用 lib/item-folders。

import { registerKvMigration } from "./kv-db";
import { createItemFolder, groupItemsByFolder, loadItemFolders, saveItemFolders, type ItemFolder } from "./item-folders";

const FOLDERS_KEY = "ai_phone_worldbook_folders_v1";
registerKvMigration(FOLDERS_KEY);

export type WorldBookFolder = ItemFolder;

export function loadWorldBookFolders(): WorldBookFolder[] {
    return loadItemFolders(FOLDERS_KEY);
}

export function saveWorldBookFolders(folders: WorldBookFolder[]): void {
    saveItemFolders(FOLDERS_KEY, folders);
}

export function createWorldBookFolder(name: string): WorldBookFolder {
    return createItemFolder("wbf", name);
}

/** 按文件夹分组：pinned 是置顶的（最外层放最上面），unfiled 是没置顶也没进文件夹的 */
export const groupWorldBooksByFolder = groupItemsByFolder;
