"use client";

import { useEffect, useState } from "react";
import { Check, Save, Trash2, X } from "lucide-react";
import {
    deleteReadingPreset,
    loadReadingPresets,
    saveReadingPreset,
    type ReadingPreset,
    type ReadingPresetKind,
} from "@/lib/reading-presets";

type Props<T> = {
    kind: ReadingPresetKind;
    /** 点保存时要存下来的东西 */
    current: () => T;
    onLoad: (payload: T) => void;
    /** 保存时预填的名字 */
    defaultName?: string;
};

/** 「保存配置 / 选一个配置」。左边一条下拉，右边一个方形保存键。
 *  摘抄图的模板配色、两段提示词都用它。 */
export function ReadingPresetBar<T>({ kind, current, onLoad, defaultName = "" }: Props<T>) {
    const [presets, setPresets] = useState<Array<ReadingPreset<T>>>([]);
    const [selectedId, setSelectedId] = useState("");
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState(defaultName);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    useEffect(() => { setPresets(loadReadingPresets<T>(kind)); }, [kind]);

    const refresh = () => setPresets(loadReadingPresets<T>(kind));

    return (
        <div className="reading-preset-bar">
            <div className="reading-preset-row">
                <select
                    className="ui-input reading-preset-select"
                    value={selectedId}
                    onChange={(event) => {
                        const id = event.target.value;
                        setSelectedId(id);
                        setConfirmingDelete(false);
                        const preset = presets.find(item => item.id === id);
                        if (preset) onLoad(preset.payload);
                    }}
                >
                    <option value="">{presets.length > 0 ? "选一个保存过的配置" : "还没有保存过配置"}</option>
                    {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                </select>

                {selectedId && (
                    <button
                        type="button"
                        className={`reading-preset-icon-btn${confirmingDelete ? " is-danger" : ""}`}
                        aria-label={confirmingDelete ? "确认删除这个配置" : "删除这个配置"}
                        onClick={() => {
                            if (!confirmingDelete) { setConfirmingDelete(true); return; }
                            deleteReadingPreset(selectedId);
                            setSelectedId("");
                            setConfirmingDelete(false);
                            refresh();
                        }}
                    >
                        <Trash2 size={15} />
                    </button>
                )}

                <button
                    type="button"
                    className="reading-preset-icon-btn"
                    aria-label="保存配置"
                    onClick={() => { setName(defaultName); setNaming(true); setConfirmingDelete(false); }}
                >
                    <Save size={15} />
                </button>
            </div>

            {naming && (
                <div className="reading-preset-naming">
                    <input
                        className="ui-input"
                        value={name}
                        maxLength={30}
                        placeholder="给这套配置起个名字"
                        onChange={(event) => setName(event.target.value)}
                        autoFocus
                    />
                    <button
                        type="button"
                        className="reading-preset-icon-btn"
                        aria-label="确认保存"
                        onClick={() => {
                            const saved = saveReadingPreset(kind, name || defaultName || "未命名", current());
                            refresh();
                            setSelectedId(saved.id);
                            setNaming(false);
                        }}
                    >
                        <Check size={15} />
                    </button>
                    <button
                        type="button"
                        className="reading-preset-icon-btn"
                        aria-label="取消"
                        onClick={() => setNaming(false)}
                    >
                        <X size={15} />
                    </button>
                </div>
            )}
        </div>
    );
}
