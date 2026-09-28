"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadReadingAsset, saveReadingAsset } from "./reading-appearance";

/** 阅读 app 自己的「账号」：和手机主人的身份无关，只是分享摘抄图片时
 *  署名用的昵称和头像。 */
export type ReadingProfile = {
    /** 显示的 ID / 昵称；空字符串表示没设置 */
    name: string;
};

const PROFILE_KEY = "ai_phone_reading_profile_v1";
registerKvMigration(PROFILE_KEY);
const AVATAR_ASSET_KEY = "profile-avatar";

export const DEFAULT_READING_PROFILE: ReadingProfile = { name: "" };

export function loadReadingProfile(): ReadingProfile {
    if (typeof window === "undefined") return DEFAULT_READING_PROFILE;
    try {
        const raw = kvGet(PROFILE_KEY);
        if (!raw) return DEFAULT_READING_PROFILE;
        const parsed = JSON.parse(raw) as Partial<ReadingProfile>;
        return { name: typeof parsed?.name === "string" ? parsed.name.trim().slice(0, 40) : "" };
    } catch {
        return DEFAULT_READING_PROFILE;
    }
}

export function saveReadingProfile(profile: ReadingProfile): ReadingProfile {
    const normalized: ReadingProfile = { name: profile.name.trim().slice(0, 40) };
    if (typeof window === "undefined") return normalized;
    try {
        kvSet(PROFILE_KEY, JSON.stringify(normalized));
    } catch {
        // 写不进去就只保留本次会话的内存值，不打断用户
    }
    return normalized;
}

export async function saveReadingProfileAvatar(blob: Blob | null): Promise<void> {
    await saveReadingAsset(AVATAR_ASSET_KEY, blob);
}

export async function loadReadingProfileAvatar(): Promise<Blob | null> {
    return loadReadingAsset(AVATAR_ASSET_KEY);
}
