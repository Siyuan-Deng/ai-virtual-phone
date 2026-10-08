"use client";

// 把会话里存的「这个聊天单独用的头像」（图片库 id）换成能直接显示的地址。读过的记住，切回来不闪。

import { useEffect, useState } from "react";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";

const resolved = new Map<string, string>();

async function resolveRef(ref: string): Promise<string | null> {
    if (ref.startsWith("data:") || ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("blob:")) return ref;
    const cached = resolved.get(ref);
    if (cached) return cached;
    const url = await getChatImageFromIndexedDB(ref);
    if (url) resolved.set(ref, url);
    return url;
}

function syncResolve(overrides: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, ref] of Object.entries(overrides || {})) {
        if (/^(data:|https?:|blob:)/.test(ref)) out[key] = ref;
        else if (resolved.has(ref)) out[key] = resolved.get(ref)!;
    }
    return out;
}

/** key（"self" / 角色 id）→ 头像地址；没换过的 key 不在里面 */
export function useChatAvatarOverrides(overrides: Record<string, string> | undefined): Record<string, string> {
    const signature = JSON.stringify(overrides || {});
    const [urls, setUrls] = useState<Record<string, string>>(() => syncResolve(overrides));
    useEffect(() => {
        let cancelled = false;
        const entries = Object.entries(overrides || {});
        setUrls(syncResolve(overrides));
        void Promise.all(entries.map(async ([key, ref]) => [key, await resolveRef(ref)] as const)).then((pairs) => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [key, url] of pairs) if (url) next[key] = url;
            setUrls(next);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
    return urls;
}
