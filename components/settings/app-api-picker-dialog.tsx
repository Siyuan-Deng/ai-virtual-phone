"use client";

// 在用的地方（比如聊天设置）直接改「这个角色在这个应用里单独用哪个 API」。
// 弹窗和设置 → 绑定里选 API 的是同一个样子，改的也是同一份绑定。

import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { loadApiConfigs } from "@/lib/settings-storage";
import { loadApiConfigFolders, loadApiConfigRootOrder } from "@/lib/api-config-folders";
import { inheritedCharacterAppApiLabel, loadCharacterAppApiId, saveCharacterAppApiId } from "@/lib/app-api-binding";
import { BindingSheetFolderOptions } from "./folder-picker-options";

export function AppApiPickerDialog({
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
    const data = useMemo(() => ({
        items: loadApiConfigs().map(c => ({ id: c.id, name: c.name || c.provider, folderId: c.folderId, pinned: c.pinned })),
        folders: loadApiConfigFolders(),
        rootOrder: loadApiConfigRootOrder(),
        selected: loadCharacterAppApiId(characterId, appId),
        inheritLabel: inheritedCharacterAppApiLabel(characterId, appId),
    }), [characterId, appId]);

    const pick = (apiConfigId: string | undefined) => {
        saveCharacterAppApiId(characterId, appId, apiConfigId);
        onClose();
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
                    <span className="binding-picker-header-spacer" />
                </div>
                <div className="binding-picker-body">
                    <div className="binding-sheet-list">
                        <BindingSheetFolderOptions
                            items={data.items}
                            folders={data.folders}
                            rootOrder={data.rootOrder}
                            openFolderId={openFolderId}
                            onOpenFolder={setOpenFolderId}
                            isSelected={id => data.selected === id}
                            onPick={pick}
                            unsetRow={(
                                <button
                                    type="button"
                                    className="binding-sheet-option"
                                    data-selected={!data.selected}
                                    onClick={() => pick(undefined)}
                                >
                                    <span className="binding-sheet-check">{!data.selected && <Check size={15} />}</span>
                                    <span className="binding-sheet-option-text">{data.inheritLabel}</span>
                                </button>
                            )}
                            emptyRow={<div className="binding-sheet-empty">暂无可选 API 配置，请先在 API 设置页面创建。</div>}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
