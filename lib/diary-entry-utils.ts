import { jsonrepair } from "jsonrepair";
import type { DiaryEntryBlock, DiaryEntryTodoItem } from "./diary-entry-types";

export type ParsedDiaryEntry = {
  title: string;
  dateLabel: string;
  mood: string;
  weather: string;
  tags: string[];
  body: string;
  blocks: DiaryEntryBlock[];
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMultilineText(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return Array.from(new Set(raw.map(item => cleanText(item, 16)).filter(Boolean))).slice(0, 5);
}

function parseJsonLike(content: string): unknown | null {
  const jsonCandidate = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(jsonCandidate);
  } catch {
    try {
      return JSON.parse(jsonrepair(jsonCandidate));
    } catch {
      return null;
    }
  }
}

function normalizeTodoItems(value: unknown): DiaryEntryTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DiaryEntryTodoItem | null => {
      if (typeof item === "string") {
        const text = cleanText(item, 120);
        return text ? { text, done: false } : null;
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = cleanText(record.text ?? record.content ?? record.title, 120);
      if (!text) return null;
      return { text, done: Boolean(record.done ?? record.completed ?? record.checked) };
    })
    .filter((item): item is DiaryEntryTodoItem => Boolean(item))
    .slice(0, 10);
}

/** 要点：字符串或 { text } 都认 */
function normalizeBulletItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === "string") return cleanText(item, 120);
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return cleanText(record.text ?? record.content ?? record.title, 120);
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeBlocks(value: unknown, fallbackBody: string): DiaryEntryBlock[] {
  const raw = Array.isArray(value) ? value : [];
  const blocks = raw
    .map((block): DiaryEntryBlock | null => {
      if (typeof block === "string") {
        const text = cleanMultilineText(block, 900);
        return text ? { type: "paragraph", text } : null;
      }
      if (!block || typeof block !== "object") return null;
      const record = block as Record<string, unknown>;
      const type = cleanText(record.type, 32).toLowerCase();

      if (type === "bullet" || type === "bullets" || type === "points") {
        const items = normalizeBulletItems(record.items ?? record.points ?? record.list);
        if (items.length === 0) return null;
        return {
          type: "bullet",
          title: cleanText(record.title ?? record.heading, 40),
          items,
        };
      }

      if (type === "todo" || type === "todos" || type === "list") {
        const items = normalizeTodoItems(record.items ?? record.todos ?? record.list);
        if (items.length === 0) return null;
        return {
          type: "todo",
          title: cleanText(record.title ?? record.heading, 40),
          items,
        };
      }

      if (type === "correction" || type === "strike" || type === "redaction") {
        const text = cleanText(record.text ?? record.from ?? record.old, 220);
        const replacement = cleanText(record.replacement ?? record.to ?? record.new, 220);
        if (!text && !replacement) return null;
        return { type: "correction", text: text || replacement, replacement: replacement || undefined };
      }

      if (type === "image" || type === "picture" || type === "photo") {
        const description = cleanMultilineText(record.description ?? record.prompt ?? record.text ?? record.alt, 420);
        if (!description) return null;
        return {
          type: "image",
          caption: cleanText(record.caption ?? record.title, 80),
          description,
        };
      }

      if (type === "quote") {
        const text = cleanMultilineText(record.text ?? record.content ?? record.body, 500);
        return text ? { type: "quote", text } : null;
      }

      const text = cleanMultilineText(record.text ?? record.content ?? record.body, 900);
      return text ? { type: "paragraph", text } : null;
    })
    .filter((block): block is DiaryEntryBlock => Boolean(block))
    .slice(0, 18);

  if (blocks.length > 0) return blocks;

  const paragraphs = cleanMultilineText(fallbackBody, 3000)
    .split(/\n{2,}|\n/)
    .map(text => text.trim())
    .filter(Boolean)
    .slice(0, 10);

  return paragraphs.length > 0
    ? paragraphs.map(text => ({ type: "paragraph", text }))
    : [{ type: "paragraph", text: "今天也留下了一点痕迹。" }];
}

export function parseDiaryEntryContent(content: string): ParsedDiaryEntry {
  const trimmed = content.trim();
  const parsed = parseJsonLike(trimmed);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const body = cleanMultilineText(trimmed, 3000) || "今天也留下了一点痕迹。";
    return {
      title: body.slice(0, 20) || "未命名日记",
      dateLabel: "",
      mood: "",
      weather: "",
      tags: [],
      body,
      blocks: normalizeBlocks([], body),
    };
  }

  const record = parsed as Record<string, unknown>;
  const body = cleanMultilineText(record.body ?? record.content ?? record.text, 6000);
  const blocks = normalizeBlocks(record.blocks ?? record.sections ?? record.items, body);
  const combinedBody = body || blocks.map(block => {
    if (block.type === "paragraph" || block.type === "quote") return block.text;
    if (block.type === "correction") return block.replacement || block.text;
    if (block.type === "image") return block.description;
    if (block.type === "todo") return block.items.map(item => `${item.done ? "完成" : "待办"}：${item.text}`).join("\n");
    if (block.type === "bullet") return block.items.map(item => `• ${item}`).join("\n");
    return "";
  }).filter(Boolean).join("\n\n");

  return {
    title: cleanText(record.title ?? record.heading, 80) || combinedBody.slice(0, 20) || "未命名日记",
    dateLabel: cleanText(record.dateLabel ?? record.date ?? record.date_label, 40),
    mood: cleanText(record.mood, 60),
    weather: cleanText(record.weather, 60),
    tags: normalizeTags(record.tags ?? record.labels),
    body: combinedBody || "今天也留下了一点痕迹。",
    blocks,
  };
}

export function formatDiaryEntryContext(entries: Array<{
  characterName: string;
  title: string;
  dateLabel: string;
  mood: string;
  weather: string;
  tags?: string[];
  body: string;
  createdAt: string;
}>): string {
  const active = [...entries]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12);
  if (active.length === 0) return "暂无日记";

  return active.map((entry, index) => [
    `#${index + 1}`,
    `author: ${entry.characterName}`,
    `date: ${entry.dateLabel || entry.createdAt}`,
    `title: ${entry.title}`,
    entry.mood ? `mood: ${entry.mood}` : "",
    entry.weather ? `weather: ${entry.weather}` : "",
    entry.tags?.length ? `tags: ${entry.tags.join("、")}` : "",
    `body: ${cleanMultilineText(entry.body, 520)}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}
