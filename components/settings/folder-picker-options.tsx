"use client";

// 绑定弹窗里选 API / 世界书（设置页的绑定、聊天设置里的聊天 API 共用）：
// 有文件夹时分层，最外层和设置页一样——置顶的一组在最上面，然后文件夹和没进文件夹的按拖出来的顺序混排，
// 点文件夹进去选里面的；一个非空文件夹都没有就平铺。单选多选都行，选中与否由外面判断。

import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Folder } from "lucide-react";
import { buildPickerEntries, type ItemFolder } from "@/lib/item-folders";

export type FolderPickerItem = { id: string; name: string; folderId?: string; pinned?: boolean };

export function BindingSheetFolderOptions({
    items,
    folders,
    rootOrder,
    openFolderId,
    onOpenFolder,
    isSelected,
    onPick,
    unsetRow,
    emptyRow,
}: {
    items: FolderPickerItem[];
    folders: ItemFolder[];
    rootOrder: string[];
    /** 正在看的文件夹，null = 最外层 */
    openFolderId: string | null;
    onOpenFolder: (folderId: string | null) => void;
    isSelected: (id: string) => boolean;
    onPick: (id: string) => void;
    /** 「未设置 / 继承」那一行，只在最外层显示 */
    unsetRow?: ReactNode;
    /** 一项都没有时显示的 */
    emptyRow?: ReactNode;
}) {
    const entries = buildPickerEntries(items, folders, rootOrder);

    const itemRow = (item: FolderPickerItem) => {
        const selected = isSelected(item.id);
        return (
            <button
                key={item.id}
                type="button"
                className="binding-sheet-option"
                data-selected={selected}
                aria-pressed={selected}
                onClick={() => onPick(item.id)}
            >
                <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                <span className="binding-sheet-option-text">{item.name}</span>
            </button>
        );
    };

    if (!entries) {
        return (
            <>
                {unsetRow}
                {items.length === 0 ? emptyRow : items.map(itemRow)}
            </>
        );
    }

    const openFolder = openFolderId ? folders.find(folder => folder.id === openFolderId) : undefined;
    if (openFolder) {
        return (
            <>
                <button type="button" className="binding-sheet-option binding-sheet-folder-back" onClick={() => onOpenFolder(null)}>
                    <span className="binding-sheet-check"><ChevronLeft size={15} /></span>
                    <span className="binding-sheet-option-text">{openFolder.name}</span>
                </button>
                {items.filter(item => item.folderId === openFolder.id).map(itemRow)}
            </>
        );
    }

    return (
        <>
            {unsetRow}
            {entries.map(entry => {
                if (entry.item) return itemRow(entry.item);
                const folder = entry.folder!;
                const count = items.filter(item => item.folderId === folder.id && isSelected(item.id)).length;
                return (
                    <button
                        key={folder.id}
                        type="button"
                        className="binding-sheet-option"
                        aria-label={`打开文件夹 ${folder.name}`}
                        onClick={() => onOpenFolder(folder.id)}
                    >
                        <span className="binding-sheet-check"><Folder size={15} /></span>
                        <span className="binding-sheet-option-text">{folder.name}</span>
                        <span className="binding-sheet-option-meta">
                            {count > 0 ? `已选 ${count}` : null}
                            <ChevronRight size={15} />
                        </span>
                    </button>
                );
            })}
        </>
    );
}
