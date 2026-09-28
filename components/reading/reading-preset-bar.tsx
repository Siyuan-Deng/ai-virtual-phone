"use client";

import { useEffect, useState } from "react";
import { Check, FolderOpen, Save, Trash2, X } from "lucide-react";
import {
    deleteReadingPreset,
    loadReadingPresets,
    saveReadingPreset,
    type ReadingPreset,
    type ReadingPresetKind,
} from "@/lib/reading-presets";

type Props<T> = {
    kind: ReadingPresetKind;
    /** 点「存一档」时要存的东西 */
    current: () => T;
    onLoad: (payload: T) => void;
    /** 存档时预填的名字 */
    defaultName?: string;
};

/** 「存一档 / 调出来」的小条。摘抄图的模板配色、两段提示词都用它。 */
export function ReadingPresetBar<T>({ kind, current, onLoad, defaultName = "" }: Props<T>) {
    const [presets, setPresets] = useState<Array<ReadingPreset<T>>>([]);
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState(defaultName);
    const [confirmingId, setConfirmingId] = useState<string | null>(null);

    useEffect(() => { setPresets(loadReadingPresets<T>(kind)); }, [kind]);

    const refresh = () => setPresets(loadReadingPresets<T>(kind));

    return (
        <div className="reading-preset-bar">
            <div className="reading-preset-actions">
                <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    onClick={() => { setName(defaultName); setNaming(true); }}
                >
                    <Save size={13} />
                    <span>存一档</span>
                </button>
                <span className="reading-preset-count">
                    <FolderOpen size={12} />
                    {presets.length > 0 ? `${presets.length} 档` : "还没存过"}
                </span>
            </div>

            {naming && (
                <div className="reading-preset-naming">
                    <input
                        className="ui-input"
                        value={name}
                        maxLength={30}
                        placeholder="给这一档起个名字"
                        onChange={(event) => setName(event.target.value)}
                        autoFocus
                    />
                    <button
                        type="button"
                        className="ui-btn ui-btn-soft-action"
                        onClick={() => {
                            saveReadingPreset(kind, name || defaultName || "未命名", current());
                            refresh();
                            setNaming(false);
                        }}
                    >
                        <Check size={13} />
                        <span>保存</span>
                    </button>
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setNaming(false)}>
                        <X size={13} />
                    </button>
                </div>
            )}

            {presets.length > 0 && (
                <div className="reading-preset-list">
                    {presets.map((preset) => (
                        <div key={preset.id} className="reading-preset-item">
                            <button
                                type="button"
                                className="reading-preset-name"
                                onClick={() => onLoad(preset.payload)}
                            >
                                {preset.name}
                            </button>
                            <button
                                type="button"
                                className="reading-preset-delete"
                                aria-label={`删除 ${preset.name}`}
                                onClick={() => {
                                    if (confirmingId === preset.id) {
                                        deleteReadingPreset(preset.id);
                                        refresh();
                                        setConfirmingId(null);
                                    } else {
                                        setConfirmingId(preset.id);
                                    }
                                }}
                            >
                                {confirmingId === preset.id ? <span>确认删</span> : <Trash2 size={12} />}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
