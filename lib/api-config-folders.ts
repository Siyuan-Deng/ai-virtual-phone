"use client";

// API 配置文件夹：和世界书文件夹一样，只用来分组（ApiConfig.folderId）。删文件夹时里面的配置回到「未分类」。

import { registerKvMigration } from "./kv-db";
import { createItemFolder, loadItemFolders, loadRootOrder, saveItemFolders, saveRootOrder, type ItemFolder } from "./item-folders";

const FOLDERS_KEY = "ai_phone_api_config_folders_v1";
/** 最外层文件夹和配置混排的顺序 */
const ROOT_ORDER_KEY = "ai_phone_api_config_root_order_v1";
registerKvMigration(FOLDERS_KEY);
registerKvMigration(ROOT_ORDER_KEY);

export type ApiConfigFolder = ItemFolder;

export function loadApiConfigFolders(): ApiConfigFolder[] {
    return loadItemFolders(FOLDERS_KEY);
}

export function saveApiConfigFolders(folders: ApiConfigFolder[]): void {
    saveItemFolders(FOLDERS_KEY, folders);
}

export function createApiConfigFolder(name: string): ApiConfigFolder {
    return createItemFolder("apif", name);
}

export function loadApiConfigRootOrder(): string[] {
    return loadRootOrder(ROOT_ORDER_KEY);
}

export function saveApiConfigRootOrder(ids: string[]): void {
    saveRootOrder(ROOT_ORDER_KEY, ids);
}
