"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from "react";

import {
  loadDiaryEntryFontAssetId,
  loadDiaryEntryFontScale,
  saveDiaryEntryFontAssetId,
  saveDiaryEntryFontScale,
} from "@/lib/diary-entry-storage";
import type { DiaryFontKind } from "@/lib/diary-entry-types";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";

// TA的日记、我的日记、片刻纪事各自独立一套字体，互不影响，跟以前双日记插件的行为一致。
const FONT_FAMILY: Record<DiaryFontKind, string> = {
  character: "AIPhoneDiaryEntryCharacterFont",
  user: "AIPhoneDiaryEntryUserWriterFont",
  moment: "AIPhoneMomentFont",
  "moment-user": "AIPhoneMomentUserFont",
  "moment-char": "AIPhoneMomentCharFont",
};
const FONT_STYLE_ID: Record<DiaryFontKind, string> = {
  character: "ai-phone-diary-entry-character-font-face",
  user: "ai-phone-diary-entry-user-writer-font-face",
  moment: "ai-phone-moment-font-face",
  "moment-user": "ai-phone-moment-user-font-face",
  "moment-char": "ai-phone-moment-char-font-face",
};
const FONT_LABEL: Record<DiaryFontKind, string> = {
  character: "日记字体",
  user: "日记字体",
  moment: "片刻纪事字体",
  "moment-user": "我的字体",
  "moment-char": "角色字体",
};
/** 写到哪个 CSS 变量上。片刻纪事聊天里「我」/角色的两份没传时不写，CSS 里退回片刻纪事那份 */
const FONT_VAR: Record<DiaryFontKind, string> = {
  character: "--diary-entry-font-family",
  user: "--diary-entry-font-family",
  moment: "--diary-entry-font-family",
  "moment-user": "--moment-user-font-family",
  "moment-char": "--moment-char-font-family",
};
/** 字号只跟着各本的主字体走（片刻纪事三份共用一个） */
const OWNS_SCALE: Record<DiaryFontKind, boolean> = {
  character: true,
  user: true,
  moment: true,
  "moment-user": false,
  "moment-char": false,
};
/** 没上传时手记默认的手写体 */
const DEFAULT_FAMILY = `"NoteWall Ximai"`;

export function useDiaryFont(kind: DiaryFontKind, notify: (message: string) => void) {
  const [assetId, setAssetId] = useState<string | null>(() => loadDiaryEntryFontAssetId(kind));
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(() => loadDiaryEntryFontScale(kind));
  const label = FONT_LABEL[kind];

  useEffect(() => {
    if (!assetId) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    void getThemeAssetDataUrl(assetId).then((url) => {
      if (cancelled) return;
      if (url) {
        setDataUrl(url);
        return;
      }
      saveDiaryEntryFontAssetId(null, kind);
      setAssetId(null);
      setDataUrl(null);
      notify(`${label}资源丢失，已恢复默认字体`);
    }).catch(() => {
      if (cancelled) return;
      setDataUrl(null);
      notify(`${label}加载失败，暂时使用默认字体`);
    });
    return () => { cancelled = true; };
  }, [assetId, kind, label, notify]);

  useEffect(() => {
    const styleId = FONT_STYLE_ID[kind];
    let node = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!node) {
      node = document.createElement("style");
      node.id = styleId;
      document.head.append(node);
    }
    node.textContent = dataUrl
      ? `@font-face{font-family:"${FONT_FAMILY[kind]}";src:url("${dataUrl}");font-display:swap;}`
      : "";
  }, [dataUrl, kind]);

  const upload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const nextId = await saveThemeAssetFromBlob(file, "font");
      const url = await getThemeAssetDataUrl(nextId);
      if (!url) {
        throw new Error("字体资源没有保存成功");
      }
      saveDiaryEntryFontAssetId(nextId, kind);
      setAssetId(nextId);
      setDataUrl(url);
      notify(`${label}已上传：${file.name}`);
    } catch (error) {
      notify(`${label}上传失败：` + String(error));
    }
  }, [kind, label, notify]);

  const changeScale = useCallback((next: number) => {
    const normalized = Math.min(1.25, Math.max(0.85, next));
    setScale(normalized);
    saveDiaryEntryFontScale(normalized, kind);
  }, [kind]);

  const reset = useCallback(() => {
    saveDiaryEntryFontAssetId(null, kind);
    setAssetId(null);
    setDataUrl(null);
    if (OWNS_SCALE[kind]) {
      saveDiaryEntryFontScale(1, kind);
      setScale(1);
    }
    notify(`已恢复默认${label}`);
  }, [kind, label, notify]);

  /** 画分享图用：canvas 只认真实的字体名，不认 CSS 变量 */
  const family = dataUrl ? `"${FONT_FAMILY[kind]}", ${DEFAULT_FAMILY}, serif` : `${DEFAULT_FAMILY}, serif`;

  const style = useMemo(() => {
    return {
      ...(dataUrl
        ? { [FONT_VAR[kind]]: `"${FONT_FAMILY[kind]}", ${DEFAULT_FAMILY}, var(--app-font-family)` }
        : {}),
      ...(OWNS_SCALE[kind] ? { "--diary-entry-font-scale": String(scale) } : {}),
    } as CSSProperties;
  }, [dataUrl, kind, scale]);

  return { hasCustomFont: Boolean(dataUrl), scale, family, style, label, upload, changeScale, reset };
}
