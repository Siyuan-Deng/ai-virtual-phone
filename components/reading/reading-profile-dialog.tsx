"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { Input } from "@/components/ui/form";
import { READING_AVATAR_MAX_SIZE, compressReadingImage } from "@/lib/reading-image";
import {
    loadReadingProfile,
    loadReadingProfileAvatar,
    saveReadingProfile,
    saveReadingProfileAvatar,
    type ReadingProfile,
} from "@/lib/reading-profile";

type Props = {
    onClose: () => void;
    onSaved?: (profile: ReadingProfile) => void;
};

/** 阅读 app 的「账号」设置：分享摘抄图片时署名用的 ID 和头像。
 *  和手机主人的身份无关，是这个阅读软件自己的一套。 */
export function ReadingProfileDialog({ onClose, onSaved }: Props) {
    const [name, setName] = useState("");
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
    const [avatarFile, setAvatarFile] = useState<File | null>(null);
    const [clearAvatar, setClearAvatar] = useState(false);
    const [saving, setSaving] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    /** 本地预览用的 objectURL，换图/关闭时要回收 */
    const previewUrlRef = useRef<string | null>(null);

    useEffect(() => {
        setName(loadReadingProfile().name);
        let cancelled = false;
        void loadReadingProfileAvatar().then((blob) => {
            if (cancelled || !blob) return;
            const url = URL.createObjectURL(blob);
            previewUrlRef.current = url;
            setAvatarUrl(url);
        });
        return () => {
            cancelled = true;
            if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
            previewUrlRef.current = null;
        };
    }, []);

    const showAvatar = avatarUrl && !clearAvatar;

    const handleSave = async () => {
        try {
            setSaving(true);
            const saved = saveReadingProfile({ name });
            if (clearAvatar) await saveReadingProfileAvatar(null);
            else if (avatarFile) {
                await saveReadingProfileAvatar(await compressReadingImage(avatarFile, READING_AVATAR_MAX_SIZE));
            }
            onSaved?.(saved);
            onClose();
        } catch (err) {
            alert(err instanceof Error ? err.message : "阅读账号保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <ContentDialog
            title="阅读账号"
            confirmLabel={saving ? "保存中..." : "保存"}
            cancelLabel="取消"
            onConfirm={() => { if (!saving) void handleSave(); }}
            onCancel={() => { if (!saving) onClose(); }}
        >
            <div className="reading-settings-grid">
                <div className="reading-profile-row">
                    <button
                        type="button"
                        className="reading-profile-avatar"
                        onClick={() => fileRef.current?.click()}
                        disabled={saving}
                        aria-label="更换头像"
                    >
                        {showAvatar
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={avatarUrl as string} alt="" />
                            : <ImagePlus size={20} />}
                    </button>
                    <div className="reading-profile-fields">
                        <span className="reading-settings-label-inline">ID</span>
                        <Input
                            value={name}
                            maxLength={40}
                            placeholder="分享摘抄时显示的名字"
                            onChange={(e) => setName(e.target.value)}
                            disabled={saving}
                        />
                    </div>
                </div>
                {showAvatar && (
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            disabled={saving}
                            onClick={() => { setAvatarFile(null); setClearAvatar(true); }}
                        >
                            <Trash2 size={14} />
                            <span>清除头像</span>
                        </button>
                    </div>
                )}
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0] || null;
                        e.target.value = "";
                        if (!file) return;
                        setAvatarFile(file);
                        setClearAvatar(false);
                        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                        const url = URL.createObjectURL(file);
                        previewUrlRef.current = url;
                        setAvatarUrl(url);
                    }}
                />
            </div>
        </ContentDialog>
    );
}
