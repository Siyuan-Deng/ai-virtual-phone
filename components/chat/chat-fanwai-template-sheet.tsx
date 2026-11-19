"use client";

// 聊天番外的「番外模板」：照剧情 App 的番外模板来（梗概 / if线设定、文风、其它要求、带上之前的番外），
// 聊天记录用不上的人称和场景数去掉，字数（以上）换成至少多少条消息，多一个「带上正篇最近的聊天」。
// 用的是全局的底部面板、输入框、开关类名，美化主题照常生效。

import { useEffect, useRef, useState } from "react";
import { Eraser, X } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import { buildChatFanwaiInstruction, type ChatFanwaiTemplate } from "@/lib/chat-fanwai";

export function ChatFanwaiTemplateSheet({
    initial,
    sending,
    onSave,
    onSend,
    onClose,
}: {
    initial: ChatFanwaiTemplate;
    sending: boolean;
    /** 面板关掉（包括发送）时，把填的内容存起来，下次打开还在 */
    onSave: (template: ChatFanwaiTemplate) => void;
    onSend: (instruction: string, template: ChatFanwaiTemplate) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<ChatFanwaiTemplate>(initial);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    useEffect(() => () => onSaveRef.current(draftRef.current), []);

    const set = (patch: Partial<ChatFanwaiTemplate>) => setDraft(prev => ({ ...prev, ...patch }));
    // 梗概和 if线设定共用一个框，上面切换；清空只清当前这一页
    const [textTab, setTextTab] = useState<"content" | "ifLine">("content");
    const canSend = !sending && (!!draft.content.trim() || !!draft.ifLine.trim());

    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" role="dialog" aria-modal="true" aria-label="番外模板" onClick={onClose}>
            <div className="modal-sheet chat-fanwai-template" onClick={e => e.stopPropagation()}>
                <div className="chat-fanwai-template-head">
                    <span className="chat-fanwai-template-title">番外模板</span>
                    <button type="button" className="chat-fanwai-template-close" aria-label="关闭" onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>
                <div className="chat-fanwai-template-body">
                    <div className="chat-fanwai-template-field">
                        <div className="chat-fanwai-template-tabs" role="tablist" aria-label="梗概和 if线设定">
                            <button type="button" role="tab" aria-selected={textTab === "content"} data-active={textTab === "content" ? "" : undefined} onClick={() => setTextTab("content")}>梗概</button>
                            <button type="button" role="tab" aria-selected={textTab === "ifLine"} data-active={textTab === "ifLine" ? "" : undefined} onClick={() => setTextTab("ifLine")}>if线设定</button>
                            <button
                                type="button"
                                className="chat-fanwai-template-clear"
                                disabled={!draft[textTab]}
                                onClick={() => set({ [textTab]: "" })}
                                aria-label={textTab === "content" ? "清空梗概" : "清空 if线设定"}
                            >
                                <Eraser size={13} />清空
                            </button>
                        </div>
                        {textTab === "content" ? (
                            <textarea className="ui-input" rows={5} value={draft.content} placeholder="这段番外大概写什么" aria-label="梗概" onChange={e => set({ content: e.target.value })} />
                        ) : (
                            <textarea className="ui-input" rows={5} value={draft.ifLine} placeholder="可选：如果……会怎样（比如：如果我们是大学室友）" aria-label="if线设定" onChange={e => set({ ifLine: e.target.value })} />
                        )}
                    </div>
                    <div className="chat-fanwai-template-pair">
                        <label className="chat-fanwai-template-field">
                            <span className="menu-label">文风</span>
                            <input className="ui-input" value={draft.style} placeholder="比如轻松日常" onChange={e => set({ style: e.target.value })} />
                        </label>
                        <label className="chat-fanwai-template-field">
                            <span className="menu-label">至少多少条</span>
                            <input className="ui-input" value={draft.count} inputMode="numeric" placeholder="比如 20" onChange={e => set({ count: e.target.value })} />
                        </label>
                    </div>
                    <div className="chat-fanwai-template-field">
                        <div className="chat-fanwai-template-label-row">
                            <span className="menu-label">其它要求</span>
                            <button
                                type="button"
                                className="chat-fanwai-template-clear"
                                disabled={!draft.extra}
                                onClick={() => set({ extra: "" })}
                                aria-label="清空其它要求"
                            >
                                <Eraser size={13} />清空
                            </button>
                        </div>
                        <textarea className="ui-input" rows={2} value={draft.extra} placeholder="可选：结局、要出现的细节、禁止事项……" aria-label="其它要求" onChange={e => set({ extra: e.target.value })} />
                    </div>
                    <div className="chat-fanwai-template-switches">
                        <div className="chat-fanwai-template-switch">
                            <span className="chat-fanwai-template-switch-text">
                                <span>带上正篇最近的聊天</span>
                                <small>让语气和人物关系接得上</small>
                            </span>
                            <Toggle checked={draft.includeMain} ariaLabel="带上正篇最近的聊天" onChange={next => set({ includeMain: next })} />
                        </div>
                        <div className="chat-fanwai-template-switch">
                            <span className="chat-fanwai-template-switch-text">
                                <span>带上之前的番外内容</span>
                                <small>同一个平行世界接着写时用</small>
                            </span>
                            <Toggle checked={draft.includePrevious} ariaLabel="带上之前的番外内容" onChange={next => set({ includePrevious: next })} />
                        </div>
                    </div>
                </div>
                <div className="chat-fanwai-template-foot">
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary chat-fanwai-template-send"
                        disabled={!canSend}
                        onClick={() => onSend(buildChatFanwaiInstruction(draft), draft)}
                    >
                        发送番外指令
                    </button>
                </div>
            </div>
        </div>
    );
}
