"use client";

import { useEffect } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions, saveChatSessions, type ChatSession } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { THOUGHT_BUBBLE_DOTS, THOUGHT_BUBBLE_PATH } from "@/components/chat/thought-bubble-icon";
import { userThoughtLabel } from "@/lib/user-thought";

type ChatSessionWithReasoningVisibility = ChatSession & {
  hideReasoning?: boolean;
  hideUserThought?: boolean;
};

/** 聊天信息页的两个开关：{{char}}的思维链和{{user}}自己写的思维链各管各的 */
type ThoughtVisibility = {
  field: "hideReasoning" | "hideUserThought";
  controlAttr: string;
  hiddenAttr: string;
  /** 消息里的入口 */
  selector: string;
  /** 打开着的弹窗 */
  sheetSelector: string;
  desc: string;
  label: (session: ChatSessionWithReasoningVisibility) => string;
  createIcon: () => SVGSVGElement;
};

function getSessionId(wrapper: HTMLElement): string | null {
  for (const className of Array.from(wrapper.classList)) {
    if (className.startsWith("session-") && className.length > "session-".length) {
      return className.slice("session-".length);
    }
  }
  return null;
}

function readSession(sessionId: string): ChatSessionWithReasoningVisibility | undefined {
  return loadChatSessions().find((item) => item.id === sessionId);
}

function readHidden(sessionId: string, kind: ThoughtVisibility): boolean {
  return readSession(sessionId)?.[kind.field] === true;
}

function writeHidden(sessionId: string, kind: ThoughtVisibility, hidden: boolean): void {
  const sessions = loadChatSessions();
  const index = sessions.findIndex((item) => item.id === sessionId);
  if (index === -1) return;

  const updated = { ...sessions[index] } as ChatSessionWithReasoningVisibility;
  if (hidden) updated[kind.field] = true;
  else delete updated[kind.field];
  sessions[index] = updated;
  saveChatSessions(sessions);
}

function forceHide(element: HTMLElement, kind: ThoughtVisibility): void {
  if (element.hasAttribute(kind.hiddenAttr)) return;
  element.setAttribute(kind.hiddenAttr, "");
  element.style.setProperty("display", "none", "important");
}

function restoreHidden(element: HTMLElement, kind: ThoughtVisibility): void {
  if (!element.hasAttribute(kind.hiddenAttr)) return;
  element.style.removeProperty("display");
  element.removeAttribute(kind.hiddenAttr);
}

function applyThoughtVisibility(wrapper: HTMLElement, kind: ThoughtVisibility, hidden: boolean): void {
  if (!hidden) {
    wrapper.querySelectorAll<HTMLElement>(`[${kind.hiddenAttr}]`).forEach((element) => restoreHidden(element, kind));
    return;
  }

  wrapper.querySelectorAll<HTMLElement>(kind.selector).forEach((element) => forceHide(element, kind));

  // 若用户在弹窗打开时切换设置，也一并强制隐藏整个思维链弹层。
  wrapper.querySelectorAll<HTMLElement>(kind.sheetSelector).forEach((sheet) => {
    const overlay = sheet.closest<HTMLElement>(".modal-overlay");
    forceHide(overlay ?? sheet, kind);
  });
}

function setToggleVisual(toggle: HTMLButtonElement, checked: boolean): void {
  toggle.setAttribute("aria-checked", checked ? "true" : "false");
  if (checked) toggle.setAttribute("data-checked", "");
  else toggle.removeAttribute("data-checked");
}

function createClockIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "9");
  const hands = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hands.setAttribute("d", "M12 7v5l3 2");
  svg.append(circle, hands);
  return svg;
}

function createThoughtIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const cloud = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cloud.setAttribute("d", THOUGHT_BUBBLE_PATH);
  svg.appendChild(cloud);
  for (const [cx, cy, r] of THOUGHT_BUBBLE_DOTS) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", String(r));
    svg.appendChild(dot);
  }
  return svg;
}

const THOUGHT_VISIBILITIES: ThoughtVisibility[] = [
  {
    field: "hideReasoning",
    controlAttr: "data-chat-reasoning-visibility-control",
    hiddenAttr: "data-chat-reasoning-hidden-by-setting",
    // 普通消息：隐藏整条思维链入口；纯思维链轮次连外层一起隐藏，避免残留 gap。
    selector: ".chat-reasoning-trigger, [data-reasoning-row], [data-reasoning-only], [data-reasoning-empty]",
    sheetSelector: ".chat-reasoning-sheet",
    desc: "开启后完全隐藏思维链入口",
    label: (session) => {
      const character = session.isGroup ? undefined : loadCharacters().find((item) => String(item.id) === String(session.contactId));
      return `隐藏${character?.name || "角色"}思维链`;
    },
    createIcon: createClockIcon,
  },
  {
    field: "hideUserThought",
    controlAttr: "data-chat-user-thought-visibility-control",
    hiddenAttr: "data-chat-user-thought-hidden-by-setting",
    selector: "[data-user-thought-row], .chat-user-thought-mark",
    sheetSelector: ".chat-user-thought-sheet",
    desc: "只是不显示入口，角色决定看时照样能看到",
    label: (session) => `隐藏${userThoughtLabel(resolveUserIdentity(session.contactId, "chat")?.name)}`,
    createIcon: createThoughtIcon,
  },
];

function ensureSettingsControl(menu: HTMLElement, wrapper: HTMLElement, sessionId: string, kind: ThoughtVisibility): void {
  const session = readSession(sessionId);
  // 群聊没有{{user}}思维链
  if (!session || (session.isGroup && kind.field === "hideUserThought")) return;

  const existing = menu.querySelector<HTMLElement>(`[${kind.controlAttr}]`);
  if (existing) {
    const toggle = existing.querySelector<HTMLButtonElement>(".ui-toggle");
    if (toggle) setToggleVisual(toggle, readHidden(sessionId, kind));
    return;
  }

  const cssLabel = Array.from(menu.querySelectorAll<HTMLElement>(".menu-label")).find(
    (el) => el.textContent?.trim() === "自定义 CSS 样式",
  );
  const cssItem = cssLabel?.closest<HTMLElement>(".menu-item");
  const advancedGroup = cssItem?.closest<HTMLElement>(".menu-group");
  if (!cssItem || !advancedGroup) return;

  const row = document.createElement("div");
  row.className = "menu-item";
  row.setAttribute(kind.controlAttr, "");

  const icon = document.createElement("span");
  icon.className = "chat-info-icon";
  icon.style.setProperty("--icon-color", "var(--c-icon-active)");
  icon.appendChild(kind.createIcon());

  const labels = document.createElement("div");
  labels.className = "menu-label-group";
  const label = document.createElement("span");
  label.className = "menu-label";
  label.textContent = kind.label(session);
  const desc = document.createElement("span");
  desc.className = "menu-desc";
  desc.textContent = kind.desc;
  labels.append(label, desc);

  const right = document.createElement("div");
  right.className = "menu-right";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ui-toggle";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("data-ui", "toggle");
  const knob = document.createElement("span");
  knob.className = "ui-toggle-knob";
  toggle.appendChild(knob);
  setToggleVisual(toggle, readHidden(sessionId, kind));
  right.appendChild(toggle);

  const setHidden = (next: boolean) => {
    writeHidden(sessionId, kind, next);
    setToggleVisual(toggle, next);
    applyThoughtVisibility(wrapper, kind, next);
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setHidden(!readHidden(sessionId, kind));
  });
  row.addEventListener("click", () => setHidden(!readHidden(sessionId, kind)));

  row.append(icon, labels, right);
  advancedGroup.insertBefore(row, cssItem);
}

function syncAll(): void {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>(".chat-room-wrapper"));
  wrappers.forEach((wrapper) => {
    const sessionId = getSessionId(wrapper);
    if (!sessionId) return;
    THOUGHT_VISIBILITIES.forEach((kind) => applyThoughtVisibility(wrapper, kind, readHidden(sessionId, kind)));
  });

  // 聊天信息页通过 portal 挂在 session wrapper 外面；用 data-settings-open 找到它对应的会话。
  const activeWrapper = wrappers.find((wrapper) => wrapper.hasAttribute("data-settings-open"));
  if (!activeWrapper) return;
  const sessionId = getSessionId(activeWrapper);
  if (!sessionId) return;

  document.querySelectorAll<HTMLElement>(".chat-settings-layer .chat-info-menu").forEach((menu) => {
    THOUGHT_VISIBILITIES.forEach((kind) => ensureSettingsControl(menu, activeWrapper, sessionId, kind));
  });
}

/**
 * 给聊天信息页补“隐藏{{char}}思维链”“隐藏{{user}}思维链”两个开关。
 *
 * 这里故意在 DOM 层用 inline `display:none !important` 执行隐藏：
 * 会话自定义 CSS 来自 author stylesheet，优先级低于 inline !important，
 * 因此用户即使在自定义 CSS 里强制显示思维链，也无法覆盖这个隐私开关。
 * 关闭后移除 inline 样式，完整恢复项目原有 UI 与用户自己的 CSS 行为。
 */
export function ChatReasoningVisibilityController() {
  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncAll();
      });
    };

    syncAll();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      THOUGHT_VISIBILITIES.forEach((kind) => {
        document.querySelectorAll<HTMLElement>(`[${kind.hiddenAttr}]`).forEach((element) => restoreHidden(element, kind));
      });
    };
  }, []);

  return null;
}
