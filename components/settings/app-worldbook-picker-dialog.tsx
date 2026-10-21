"use client";

// 在用的地方（比如聊天设置）直接改「这个角色在这个应用里勾哪几本世界书」。
// 弹窗和设置 → 绑定里选世界书的是同一个样子，改的也是同一份绑定：勾了就只用这几本，一本都不勾就继承上一级。

import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { loadWorldBooks } from "@/lib/settings-storage";
import { loadWorldBookFolders, loadWorldBookRootOrder } from "@/lib/worldbook-folders";
import {
    inheritedCharacterAppWorldBookLabel,
    loadCharacterAppWorldBookIds,
    saveCharacterAppSlotField,
} from "@/lib/app-api-binding";
import { BindingSheetFolderOptions } from "./folder-picker-options";

export function AppWorldBookPickerDialog({
    characterId,
    appId,
    title,
    onClose,
}: {
    characterId: string;
    appId: string;
    title: string;
    onClose: () => void;
}) {
    const [openFolderId, setOpenFolderId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>(() => loadCharacterAppWorldBookIds(characterId, appId));
    const data = useMemo(() => ({
        items: loadWorldBooks().map(book => ({ id: book.id, name: book.name, folderId: book.folderId, pinned: book.pinned })),
        folders: loadWorldBookFolders(),
        rootOrder: loadWorldBookRootOrder(),
        inheritLabel: inheritedCharacterAppWorldBookLabel(characterId, appId),
    }), [characterId, appId]);

    const save = (next: string[]) => {
        setSelectedIds(next);
        saveCharacterAppSlotField(characterId, appId, "worldBookIds", next);
    };
    const toggle = (id: string) => {
        save(selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id]);
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div
                className="binding-picker-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="binding-picker-header">
                    <button type="button" className="binding-picker-icon-btn" onClick={onClose} aria-label="关闭">
                        <X size={17} />
                    </button>
                    <h3 className="binding-picker-title">{title}</h3>
                    <button type="button" className="binding-picker-done-btn" onClick={onClose}>完成</button>
                </div>
                <div className="binding-picker-body">
                    <div className="binding-sheet-list">
                        <BindingSheetFolderOptions
                            items={data.items}
                            folders={data.folders}
                            rootOrder={data.rootOrder}
                            openFolderId={openFolderId}
                            onOpenFolder={setOpenFolderId}
                            isSelected={id => selectedIds.includes(id)}
                            onPick={toggle}
                            unsetRow={(
                                <button
                                    type="button"
                                    className="binding-sheet-option"
                                    data-selected={selectedIds.length === 0}
                                    onClick={() => save([])}
                                >
                                    <span className="binding-sheet-check">{selectedIds.length === 0 && <Check size={15} />}</span>
                                    <span className="binding-sheet-option-text">{data.inheritLabel}</span>
                                </button>
                            )}
                            emptyRow={<div className="binding-sheet-empty">暂无可选世界书，请先在世界书设置页面创建。</div>}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
