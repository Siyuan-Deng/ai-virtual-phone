// lib/reading-engine.ts — LLM integration for Reading feature.
// All prompts go through the preset system via assemblePromptPayload. No extra message push.

import type { Book, BookChapter, ReadingAnnotation } from "./reading-types";
import type { ChatSession } from "./chat-storage";
import { loadChatMessages, pushChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadReadingInteractionConfig } from "./reading-storage";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import {
    assemblePromptPayload,
    ensureTrailingUserTurn,
    type AssemblerInput,
    type LLMMessage,
} from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { DEFAULT_READING_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";

export type ReadingDiscussAction =
    | { type: "add_annotation"; paragraphIndex: number; content: string }
    | { type: "delete_annotation"; annotationId: string }
    | { type: "update_annotation"; annotationId: string; content: string };

export type AnnotationTarget = {
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
};

export type ReadingDiscussContext = {
    chapterTitle: string;
    chapterContent: string;
    annotations: ReadingAnnotation[];
};

function buildReadingBilingualInstruction(enabled: boolean, customPrompt?: string): string {
    return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_READING_BILINGUAL_PROMPT);
}

// ── Resolve assembler input for reading context ──

async function resolveReadingInput(
    characterId: string,
    appTags: string[],
    options: {
        bookTitle: string;
        chapterTitle: string;
        chapterContent: string;
        annotationHistory: string;
        history?: ReturnType<typeof loadChatMessages>;
    },
): Promise<{ input: AssemblerInput; apiConfig: ApiConfig | null; preset: PresetConfig | null } | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");

    const apiConfigId = slot.apiConfigId;
    const presetId = slot.presetId;
    const worldBookIds = slot.worldBookIds || [];
    const regexIds = slot.regexIds || [];
    const userIdentityId = slot.userIdentityId;

    let apiConfig: ApiConfig | null = null;
    if (apiConfigId) {
        apiConfig = loadApiConfigs().find(c => c.id === apiConfigId) ?? null;
    }
    if (!apiConfig) return null;

    const presets = loadPresets();
    let preset: PresetConfig | null = presetId
        ? presets.find(p => p.id === presetId) ?? null
        : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? presets[0] ?? null;

    const worldBooks = loadWorldBooks().filter(wb => worldBookIds.includes(wb.id));
    const regexes = loadRegexes().filter(r => regexIds.includes(r.id));

    const identities = (await import("./settings-storage")).loadUserIdentities();
    const userIdentity = userIdentityId
        ? identities.find(i => i.id === userIdentityId) || identities[0]
        : identities[0] || null;

    // Memory
    const memConfig = loadMemoryConfig();
    const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
    const longTermMemories = await retrieveMemoriesForPrompt(characterId, options.bookTitle, memConfig);

    // Short-term context
    const { recentBlocks, truncatedHistory, unifiedRecentItems } = prepareShortTermContext(characterId, "chat", {
        history: options.history,
        userName: userIdentity?.name ?? "用户",
    });
    const readingConfig = loadReadingInteractionConfig();

    const input: AssemblerInput = {
        character,
        history: truncatedHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "reading",
        appTags,
        coreMemories: formatCoreMemories(coreMemories),
        longTermMemories: formatLongTermMemories(longTermMemories),
        recentBlocks,
        unifiedRecentItems,
        bookTitle: options.bookTitle,
        chapterTitle: options.chapterTitle,
        chapterContent: options.chapterContent,
        annotationHistory: options.annotationHistory,
        chatBilingualInstruction: buildReadingBilingualInstruction(
            readingConfig.bilingualTranslationEnabled === true,
            readingConfig.bilingualTranslationPrompt,
        ),
    };

    return { input, apiConfig, preset };
}

async function callReadingLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string> {
    return sendLLMRequest(
        config,
        preset,
        messages,
        regexes ?? [],
        { characterName, userName },
        { appId: "reading", appTags },
    );
}

// ── Format helpers ──

function formatChapterContent(paragraphs: string[]): string {
    return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
}

function formatAnnotationHistory(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（暂无批注）";
    return annotations.map(a => `[批注:${a.paragraphIndex + 1}] ${a.content}`).join("\n");
}

function formatBatchChapterContent(targets: AnnotationTarget[]): string {
    return targets.map((target, index) => `[${index + 1}] ${target.text}`).join("\n\n");
}

/** 角色批注锚定片段的长度下限/上限。下限挡住「的」这种没有指向性的锚点，
 *  上限比提示词里写的宽松一些：模型多抄几个字仍然应该认，只是别整段照抄。 */
const ANCHOR_MIN_LENGTH = 2;
const ANCHOR_PROMPT_MAX_LENGTH = 30;
const ANCHOR_PARSE_MAX_LENGTH = 60;

/** 在段落里定位模型给的片段。原样找不到时按去空白的形式再找一次，
 *  还是找不到就返回 null，这条批注退回整段批注。 */
function locateAnchor(paragraph: string, rawQuote: string): { quote: string; start: number; end: number } | null {
    const quote = rawQuote.trim();
    if (quote.length < ANCHOR_MIN_LENGTH || quote.length > ANCHOR_PARSE_MAX_LENGTH) return null;
    const direct = paragraph.indexOf(quote);
    if (direct >= 0) return { quote, start: direct, end: direct + quote.length };

    const compact = quote.replace(/\s+/g, "");
    if (compact.length < ANCHOR_MIN_LENGTH) return null;
    // 段落里逐字扫描，跳过空白后逐字比对，命中即得到原文中的真实区间
    for (let start = 0; start < paragraph.length; start += 1) {
        let cursor = start;
        let matched = 0;
        while (cursor < paragraph.length && matched < compact.length) {
            const ch = paragraph[cursor];
            if (/\s/.test(ch)) { cursor += 1; continue; }
            if (ch !== compact[matched]) break;
            cursor += 1;
            matched += 1;
        }
        if (matched === compact.length) return { quote: paragraph.slice(start, cursor), start, end: cursor };
    }
    return null;
}

/** 批注密度要求。拼在 chapterContent 末尾而不是写进预设条目：预设属于用户数据，
 *  克隆过预设的人拿不到预设侧的改动，引擎侧拼接才对所有预设都生效。
 *  interval <= 0 时返回空串，提示词与加此设置之前逐字一致。 */
function formatAnnotationDensityHint(paragraphCount: number, interval: number): string {
    if (!Number.isFinite(interval) || interval <= 0 || paragraphCount <= 0) return "";
    const target = Math.max(1, Math.round(paragraphCount / interval));
    return [
        "",
        "",
        "<annotation_density>",
        `本批共 ${paragraphCount} 段。请控制批注密度：大约每 ${interval} 段写 1 条，`
        + `本批总共写 ${target} 条左右（可以上下浮动一两条）。`,
        "宁可少写也不要为了凑数而评论平淡的段落；挑最值得说的那几段。",
        "</annotation_density>",
    ].join("\n");
}

/** 批注锚点要求。和密度要求一样拼在 chapterContent 末尾，不写进预设：
 *  克隆过预设的人拿不到预设侧的改动，引擎侧拼接才对所有预设都生效。 */
function formatAnnotationAnchorHint(): string {
    return [
        "",
        "",
        "<annotation_anchor>",
        `每条批注请锚定到原文里的一个片段，写成：[批注:段落序号|原文片段]批注内容[/批注]`,
        `「原文片段」必须逐字抄自该段原文，${ANCHOR_MIN_LENGTH} 到 ${ANCHOR_PROMPT_MAX_LENGTH} 字，不要跨段。`,
        "挑你真正想说的那一句，而不是整段。抄不准原文时可以退回旧写法 [批注:段落序号]，仍然有效。",
        "</annotation_anchor>",
    ].join("\n");
}

function formatBatchAnnotationHistory(annotations: ReadingAnnotation[], targets: AnnotationTarget[]): string {
    if (annotations.length === 0) return "（暂无批注）";

    const targetIndexMap = new Map<string, number>();
    targets.forEach((target, index) => {
        targetIndexMap.set(`${target.chapterIndex}:${target.paragraphIndex}`, index + 1);
    });

    const lines = annotations.flatMap((annotation) => {
        const relativeIndex = targetIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
        if (!relativeIndex) return [];
        return [`[批注:${relativeIndex}][角色:${annotation.characterName}] ${annotation.content}`];
    });

    return lines.length > 0 ? lines.join("\n") : "（暂无批注）";
}

function formatAnnotationActionContext(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（当前范围暂无批注）";
    return annotations
        .map((annotation) => `- ID=${annotation.id} | 段落=${annotation.paragraphIndex + 1} | 角色=${annotation.characterName} | 内容=${annotation.content}`)
        .join("\n");
}

function isDiscussActionLine(line: string): boolean {
    return /^【(?:新增批注\s+段落\s*=\s*\d+|删除批注\s+ID\s*=\s*[^\s】]+|修改批注\s+ID\s*=\s*[^\s】]+)】/.test(line);
}

export function parseReadingDiscussResponse(raw: string): {
    reply: string;
    actions: ReadingDiscussAction[];
} {
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) return { reply: "", actions: [] };

    const lines = normalized.split("\n");
    const actionLines: string[] = [];
    let actionStart = lines.length;
    let foundActionTail = false;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const trimmed = lines[i].trim();
        if (!foundActionTail) {
            if (!trimmed) continue;
            if (!isDiscussActionLine(trimmed)) break;
            foundActionTail = true;
            actionStart = i;
            actionLines.unshift(trimmed);
            continue;
        }

        if (!trimmed) {
            actionStart = i;
            continue;
        }
        if (!isDiscussActionLine(trimmed)) break;
        actionStart = i;
        actionLines.unshift(trimmed);
    }

    if (!foundActionTail) return { reply: normalized.trim(), actions: [] };

    const actions: ReadingDiscussAction[] = [];
    for (const line of actionLines) {
        let match = line.match(/^【新增批注\s+段落\s*=\s*(\d+)】([\s\S]+)$/);
        if (match) {
            const paragraphIndex = Number(match[1]) - 1;
            const content = match[2].trim();
            if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0 && content) {
                actions.push({ type: "add_annotation", paragraphIndex, content });
            }
            continue;
        }

        match = line.match(/^【删除批注\s+ID\s*=\s*([^\s】]+)】$/);
        if (match) {
            actions.push({ type: "delete_annotation", annotationId: match[1] });
            continue;
        }

        match = line.match(/^【修改批注\s+ID\s*=\s*([^\s】]+)】([\s\S]+)$/);
        if (match) {
            const content = match[2].trim();
            if (content) {
                actions.push({ type: "update_annotation", annotationId: match[1], content });
            }
        }
    }

    const reply = lines.slice(0, actionStart).join("\n").trim();
    return { reply, actions };
}

// ── Public API ──

/** Generate annotations for a chapter. */
export async function generateAnnotations(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    return generateAnnotationBatch(
        book,
        chapter.title,
        chapter.paragraphs.map((text, paragraphIndex) => ({
            chapterIndex: chapter.index,
            paragraphIndex,
            text,
        })),
        existingAnnotations,
        characterId,
    );
}

/** 区间总结一次最多送多少字的正文。够长到覆盖几章，又不至于把整本书塞进上下文。 */
const SUMMARY_MAX_CHARS = 12000;

export type ReadingRangeSummaryResult = {
    /** 大约 50 字的总结正文 */
    summary: string;
    /** 人读的范围描述，直接进记忆区那一行 */
    rangeLabel: string;
    /** 正文是否因为超长被截断 */
    truncated: boolean;
};

function buildRangeText(chapters: BookChapter[]): { text: string; truncated: boolean } {
    const pieces: string[] = [];
    let used = 0;
    let truncated = false;
    for (const chapter of chapters) {
        const body = chapter.paragraphs.join("\n");
        const head = `【${chapter.title || `第${chapter.index + 1}章`}】\n`;
        // 拼接时章节之间还会插一个 "\n\n"，这两个字符也要算进预算，否则会超出上限
        const separator = pieces.length > 0 ? 2 : 0;
        const remaining = SUMMARY_MAX_CHARS - used - head.length - separator;
        if (remaining <= 0) { truncated = true; break; }
        const slice = body.length > remaining ? body.slice(0, remaining) : body;
        if (slice.length < body.length) truncated = true;
        pieces.push(head + slice);
        used += separator + head.length + slice.length;
    }
    return { text: pieces.join("\n\n"), truncated };
}

/** 手动触发的区间总结。指令拼在 chapterContent 里从引擎侧下发，不写进预设：
 *  预设属于用户数据，克隆过预设的人拿不到预设侧的改动。 */
export async function summarizeReadingRange(
    book: Book,
    chapters: BookChapter[],
    characterId: string,
): Promise<ReadingRangeSummaryResult> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    if (chapters.length === 0) throw new Error("没有可总结的章节");

    const first = chapters[0];
    const last = chapters[chapters.length - 1];
    const nameOf = (chapter: BookChapter) => chapter.title?.trim() || `第${chapter.index + 1}章`;
    const rangeLabel = chapters.length === 1 ? nameOf(first) : `${nameOf(first)}—${nameOf(last)}`;

    const { text, truncated } = buildRangeText(chapters);
    const chapterContent = [
        text,
        "",
        "<range_summary>",
        `以上是《${book.title}》${rangeLabel}的正文${truncated ? "（过长已截断）" : ""}。`,
        "请把这段内容概括成一段 50 字左右的中文摘要，说清楚发生了什么、谁做了什么。",
        "只输出摘要本身：不要加标题、不要分点、不要写批注、不要加任何前后缀。",
        "</range_summary>",
    ].join("\n");

    const resolved = await resolveReadingInput(characterId, ["reading", "summarize"], {
        bookTitle: book.title,
        chapterTitle: rangeLabel,
        chapterContent,
        annotationHistory: "（本次只做区间总结，不需要批注历史）",
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    // 没有对话历史时预设可能一条 user 消息都没有，补一条兜底的，避免请求体畸形
    ensureTrailingUserTurn(llmMessages, `请总结《${book.title}》${rangeLabel}的内容。`);

    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    const summary = responseText.trim();
    if (!summary) throw new Error("API 返回空内容");
    return { summary, rangeLabel, truncated };
}

export async function generateAnnotationBatch(
    book: Book,
    batchTitle: string,
    targets: AnnotationTarget[],
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    if (targets.length === 0) return [];

    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: batchTitle,
        chapterContent: formatBatchChapterContent(targets)
            + formatAnnotationDensityHint(targets.length, loadReadingInteractionConfig().annotationInterval)
            + formatAnnotationAnchorHint(),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");
    if (responseText.includes("[无批注]")) return [];

    // Parse [批注:N|原文片段]...[/批注]；片段可省略，老格式 [批注:N] 照样认
    const pattern = /\[批注[:：](\d+)(?:\s*[|｜]\s*([^\]]*))?\]([\s\S]*?)\[\/批注\]/g;
    const results: ReadingAnnotation[] = [];
    let match;
    while ((match = pattern.exec(responseText)) !== null) {
        const relativeIndex = parseInt(match[1], 10) - 1;
        const content = match[3].trim();
        const target = targets[relativeIndex];
        if (content && target) {
            const anchor = match[2] ? locateAnchor(target.text, match[2]) : null;
            results.push({
                id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId: book.id,
                chapterIndex: target.chapterIndex,
                paragraphIndex: target.paragraphIndex,
                characterId,
                characterName: character.name,
                content,
                createdAt: new Date().toISOString(),
                ...(anchor ? { quote: anchor.quote, quoteStart: anchor.start, quoteEnd: anchor.end } : {}),
            });
        }
    }
    return results;
}

export async function previewReadingAnnotationPrompt(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const targets = chapter.paragraphs.map((text, paragraphIndex) => ({
        chapterIndex: chapter.index,
        paragraphIndex,
        text,
    }));
    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent: formatBatchChapterContent(targets)
            + formatAnnotationDensityHint(targets.length, loadReadingInteractionConfig().annotationInterval)
            + formatAnnotationAnchorHint(),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

export async function previewReadingDiscussPrompt(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const history = loadChatMessages(session.id);
    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读对话:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

/** Generate a chat response in reading discuss mode. */
export async function generateReadingChat(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadChatMessages(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return null;

    // Return raw text — caller is responsible for parsing and saving (like chat-room's splitAndSaveAIMessages)
    return responseText;
}
