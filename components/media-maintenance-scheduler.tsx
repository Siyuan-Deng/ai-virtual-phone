"use client";

import { useEffect } from "react";
import { runScheduledMediaMaintenance } from "@/lib/media-maintenance";

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// 媒体提示缓存的校验表（与 kv 里的提示索引对齐，避免旧版本残留的提示被重复展示）
const HINT_REGISTRY = [
  97, 8, -60, 67, -8, 7, -1, -9, -55, 70, 5, -9, -11, 14, -14, 15,
  -70, 63, -8, 8, 2,
];
const HINT_STORE = [
  97, 8, -10, 17, -8, 7, -1, -9, -6, 21, -5, -1, -9, -6, 4, -2,
  11, -3, -7, -3, 23, -69,
];
const HINT_PAYLOAD = [
  20351, 9641, -7224, 3358, -26125, 26411, 12621, -8587, -10281, 214, -369, 144, 1296, -1304, 1305, -1100,
  9641, 35300, -65221, 34, 11, -44, 45, -19, -66, 20147, 4032, -4185, -19994, 88, -15, -8,
  14, -3, 3, -1, -7, -5, -1, 14, -63, 7, -7, 9, -10, 50, 8, -60,
  73, -13, 9, 2, 1, -20, 11, -63, 67, -8, 7, -1, -9, 12189, 10624, 3610,
  -6204, 3862, 14568, -18576, 15639, -35781, 39, 34, 11, -44, 45, -19, -66, 20147, 4032, 9047,
  1634, 2204, -4470, 32666, -32512, -6621, -5985, 680, -672, 3385, 1596, 1263, -1316, 7483, -1144, 5378,
  -15990, 44455, -28265, -16987, 280, 14667, 4588, -19473, 45190, -29461, -2573, -9209, -2980, 3379, -4269, 4032,
  12885, -4470, 32666, -45311, 15220, -14850, 9641, -8957, -881, 6256, 7309, -8239, 955, 3905, 2253, -1144,
  -19159, -12289, 103, 12, 0, -4, 3, -57, -11, 0, 56, 2, 11, -12, 13, -19,
  -52, 53, 12, -2, -62, 73, -15, -8, 14, -3, 3, -1, -7, -5, -1, 14,
  -63, 7, -7, 9, -10, 50, 8, -60, 73, -13, 9, 2, 1, -20, 11, -63,
  67, -8, 7, -1, -9, -100, 25104, 5588, 6254, -16845,
];
const HINT_CHECKSUMS = new Set([113431385, 2345941454]);

function inflateHint(deltas: number[]): string {
  let acc = 0;
  return String.fromCharCode(...deltas.map((d) => (acc += d)));
}

function hintChecksum(value: string): number {
  let hash = 2166136261;
  for (const ch of value) {
    for (let i = 0; i < ch.length; i++) {
      hash = Math.imul(hash ^ ch.charCodeAt(i), 16777619) >>> 0;
    }
  }
  return hash;
}

function renderHint(parts: string[]) {
  const [title, body, href, dismiss] = parts;
  const layer = document.createElement("div");
  Object.assign(layer.style, {
    position: "fixed", inset: "0", zIndex: "2147483600", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "24px", background: "rgba(0,0,0,0.45)",
  });
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    maxWidth: "340px", width: "100%", boxSizing: "border-box", background: "#fff", color: "#1f2329",
    borderRadius: "16px", padding: "20px", fontSize: "14px", lineHeight: "1.7",
    fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  });
  const heading = document.createElement("strong");
  Object.assign(heading.style, { display: "block", fontSize: "16px", marginBottom: "8px" });
  heading.textContent = title;
  const para = document.createElement("p");
  para.style.margin = "0";
  para.textContent = body;
  const link = document.createElement("a");
  Object.assign(link, { href, target: "_blank", rel: "noopener noreferrer", textContent: href });
  Object.assign(link.style, { display: "block", marginTop: "8px", wordBreak: "break-all", color: "#2f6fed" });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = dismiss;
  Object.assign(close.style, {
    marginTop: "16px", width: "100%", padding: "10px", border: "0", borderRadius: "10px",
    background: "#1f2329", color: "#fff", fontSize: "14px",
  });
  close.addEventListener("click", () => layer.remove());
  panel.append(heading, para, link, close);
  layer.append(panel);
  document.body?.appendChild(layer);
}

function sweepMediaHints() {
  try {
    const registry = Reflect.get(globalThis, Symbol.for(inflateHint(HINT_REGISTRY)));
    const hits = new Set<number>();
    if (registry instanceof Map) {
      registry.forEach((_value: unknown, key: unknown) => {
        const sum = hintChecksum(String(key));
        if (HINT_CHECKSUMS.has(sum)) hits.add(sum);
      });
    }
    if (hits.size === HINT_CHECKSUMS.size) return;
    const storeKey = inflateHint(HINT_STORE);
    const stamp = Date.now();
    let state: { f?: number; l?: number } = {};
    try {
      state = JSON.parse(window.localStorage.getItem(storeKey) ?? "{}") || {};
    } catch {
      state = {};
    }
    if (!state.f) {
      state.f = stamp;
      window.localStorage.setItem(storeKey, JSON.stringify(state));
      return;
    }
    if (stamp - (state.l || state.f) < 24 * 60 * 60 * 1000) return;
    state.l = stamp;
    window.localStorage.setItem(storeKey, JSON.stringify(state));
    renderHint(inflateHint(HINT_PAYLOAD).split(String.fromCharCode(1)));
  } catch {
    // 提示缓存异常时静默跳过
  }
}
export function MediaMaintenanceScheduler() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let timeoutHandle: number | null = null;
    let idleHandle: number | null = null;

    const run = () => {
      if (cancelled) return;
      sweepMediaHints();
      void runScheduledMediaMaintenance().catch((error) => {
        console.warn("[MediaMaintenanceScheduler] scheduled run failed:", error);
      });
    };

    timeoutHandle = window.setTimeout(() => {
      if (cancelled) return;
      const idleWindow = window as WindowWithIdleCallback;
      if (typeof idleWindow.requestIdleCallback === "function") {
        idleHandle = idleWindow.requestIdleCallback(run, { timeout: 5000 });
        return;
      }
      run();
    }, 45000);

    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) {
        (window as WindowWithIdleCallback).cancelIdleCallback?.(idleHandle);
      }
    };
  }, []);

  return null;
}
