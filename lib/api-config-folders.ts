"use client";

// API 配置文件夹：和世界书文件夹一样，只用来分组（ApiConfig.folderId）。删文件夹时里面的配置回到「未分类」。

import { registerKvMigration } from "./kv-db";
import { createItemFolder, loadItemFolders, saveItemFolders, type ItemFolder } from "./item-folders";

const FOLDERS_KEY = "ai_phone_api_config_folders_v1";
registerKvMigration(FOLDERS_KEY);

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
