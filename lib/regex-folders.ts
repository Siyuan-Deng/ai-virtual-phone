"use client";

// 正则文件夹：只用来给正则组分组。一个正则组最多在一个文件夹里（RegexConfig.folderId），
// 文件夹本身只存名字。删文件夹时里面的正则组回到「未分类」，不会跟着删。存取和世界书文件夹共用 lib/item-folders。

import { registerKvMigration } from "./kv-db";
import {
    buildRootEntries,
    createItemFolder,
    groupItemsByFolder,
    loadItemFolders,
    loadRootOrder,
    saveItemFolders,
    saveRootOrder,
    type ItemFolder,
} from "./item-folders";

const FOLDERS_KEY = "ai_phone_regex_folders_v1";
/** 最外层文件夹和正则组混排的顺序 */
const ROOT_ORDER_KEY = "ai_phone_regex_root_order_v1";
registerKvMigration(FOLDERS_KEY);
registerKvMigration(ROOT_ORDER_KEY);

export type RegexFolder = ItemFolder;

export function loadRegexFolders(): RegexFolder[] {
    return loadItemFolders(FOLDERS_KEY);
}

export function saveRegexFolders(folders: RegexFolder[]): void {
    saveItemFolders(FOLDERS_KEY, folders);
}

export function createRegexFolder(name: string): RegexFolder {
    return createItemFolder("rxf", name);
}

export function loadRegexRootOrder(): string[] {
    return loadRootOrder(ROOT_ORDER_KEY);
}

export function saveRegexRootOrder(ids: string[]): void {
    saveRootOrder(ROOT_ORDER_KEY, ids);
}

/** 按文件夹分组：pinned 是置顶的（最外层放最上面），unfiled 是没置顶也没进文件夹的 */
export const groupRegexesByFolder = groupItemsByFolder;

/** 最外层（置顶的除外）文件夹和正则组混排后的顺序 */
export const buildRegexRootEntries = buildRootEntries;
