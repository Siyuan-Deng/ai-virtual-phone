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
    resolveAuxiliaryApiConfig,
} from "./settings-storage";
import {
    applyOutputRegex,
    assemblePromptPayload,
    ensureTrailingUserTurn,
    type AssemblerInput,
    type LLMMessage,
} from "./llm-prompt-assembler";
import { MacroEngine } from "./macro-engine";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { DEFAULT_READING_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { simpleLLMCall } from "./api-helpers";

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
    options?: { skipOutputRegex?: boolean },
): Promise<string> {
    return sendLLMRequest(
        config,
        preset,
        messages,
        regexes ?? [],
        { characterName, userName },
        { appId: "reading", appTags, skipOutputRegex: options?.skipOutputRegex },
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

/** 区间总结一次最多送多少字的正文。请求里只有正文和一句指令，没有人设/世界书/记忆，
 *  所以上限可以给得比走预设时宽松；再多就该分几次总结了。 */
const SUMMARY_MAX_CHARS = 30000;

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

/** 手动触发的区间总结。
 *  走「辅助 API 绑定 → 记忆总结 API」，不走阅读绑定的预设：
 *  总结要的是客观清楚，代入角色语气反而会走形；不带人设/世界书/记忆也省掉大把 token。 */
export async function summarizeReadingRange(
    book: Book,
    chapters: BookChapter[],
): Promise<ReadingRangeSummaryResult> {
    if (chapters.length === 0) throw new Error("没有可总结的章节");

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) throw new Error("未配置记忆总结 API（设置 → 绑定管理 → 辅助 API 绑定）");

    const first = chapters[0];
    const last = chapters[chapters.length - 1];
    const nameOf = (chapter: BookChapter) => chapter.title?.trim() || `第${chapter.index + 1}章`;
    const rangeLabel = chapters.length === 1 ? nameOf(first) : `${nameOf(first)}—${nameOf(last)}`;

    const { text, truncated } = buildRangeText(chapters);
    const instruction = [
        `以下是《${book.title}》${rangeLabel}的正文。`,
        "请用中文把它概括成 50 字左右的一段话，说清楚发生了什么、谁做了什么。",
        "保持客观陈述，不要评论、不要代入任何人的口吻、不要分点、不要加标题或前后缀，只输出摘要本身。",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: `${instruction}\n\n${text}` }],
        { temperature: 0.3, label: `阅读区间总结·${book.title}` },
    );
    const summary = result.content?.trim();
    if (!summary) throw new Error(result.error || "API 返回空内容");
    return { summary, rangeLabel, truncated };
}

/** 模型回复里的一条批注标记。index 是「本批第几段」，已经换成 0 起。 */
export type ParsedAnnotationMarker = { index: number; quote?: string; content: string };

/** 拆 [批注:N|原文片段]批注内容[/批注]。片段可省略，老格式 [批注:N] 照样认。
 *  方括号、冒号、竖线都放宽到全角——有些模型会把整段标点全角化，内容其实是对的，
 *  为这个把整批批注丢掉太亏。 */
export function parseAnnotationMarkers(responseText: string): ParsedAnnotationMarker[] {
    const pattern = /[[［]批注[:：]\s*(\d+)\s*(?:[|｜]\s*([^\]］]*?)\s*)?[\]］]([\s\S]*?)[[［]\s*\/\s*批注\s*[\]］]/g;
    const markers: ParsedAnnotationMarker[] = [];
    let match;
    while ((match = pattern.exec(responseText)) !== null) {
        const index = parseInt(match[1], 10) - 1;
        if (!Number.isFinite(index) || index < 0) continue;
        const content = match[3].trim();
        if (!content) continue;
        markers.push({ index, ...(match[2] ? { quote: match[2] } : {}), content });
    }
    return markers;
}

/** 模型明确表示「这批没什么可写的」 */
export function hasNoAnnotationMarker(responseText: string): boolean {
    return /[[［]\s*无批注\s*[\]］]/.test(responseText);
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
    assertAnnotationPromptCarriesChapter(llmMessages);

    // 批注走的是「标记协议」而不是给人看的正文，所以先拿未经输出正则处理的原文来解析：
    // 用户的正则里常有清理方括号/行动描写的规则，套在这里会把 [批注:N] 标记本身吃掉，
    // 于是无论换什么模型、什么中转站都解析不出批注。正则改为只作用在每条批注的内容上。
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
        { skipOutputRegex: true },
    );
    if (!responseText) throw new Error("API 返回空内容");

    const macroEngine = new MacroEngine(character.name, input.userIdentity?.name ?? "用户");
    const cleanContent = (text: string) => applyOutputRegex(
        text,
        input.regexes ?? [],
        { macroEngine, activeTags: input.appTags ?? ["reading", "annotate"] },
    ).trim();

    const results: ReadingAnnotation[] = [];
    for (const parsed of parseAnnotationMarkers(responseText)) {
        const target = targets[parsed.index];
        const content = cleanContent(parsed.content);
        if (!content || !target) continue;
        const anchor = parsed.quote ? locateAnchor(target.text, parsed.quote) : null;
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

    // 一条都没解析出来才认 [无批注]：模型有时会一边写批注一边解释「否则我会输出[无批注]」，
    // 先判断会把写出来的批注全扔掉。
    if (results.length === 0) {
        if (hasNoAnnotationMarker(responseText)) return [];
        // 走到这里说明模型答了，但没按格式答。抛出去让重试接手，并把它到底说了什么带上，
        // 否则用户只能看到「没有返回批注」，无从判断是模型、预设还是正则的问题。
        throw new Error(
            `模型没有按 [批注:段落序号]…[/批注] 的格式回复，这一批解析不出批注。`
            + `它的开头是：「${responseText.trim().slice(0, 60)}」`,
        );
    }
    return results;
}

/** 批注提示词必须真的带上正文。带不上只有一个原因：绑定的预设里没有「▸ 阅读·批注」
 *  这一条（或被关掉了）——正文和格式要求都写在那条的 {{chapterContent}} 周围，
 *  条目不在，模型就只收到人设，然后回一段普通聊天，看起来像「批注生成不出来」。
 *  锚点要求是引擎侧拼在 chapterContent 末尾的，用它当探针最准。 */
function assertAnnotationPromptCarriesChapter(messages: LLMMessage[]): void {
    const hasChapter = messages.some((message) => (
        typeof message.content === "string" && message.content.includes("<annotation_anchor>")
    ));
    if (hasChapter) return;
    throw new Error(
        "当前「阅读」绑定的预设里没有启用「▸ 阅读·批注」条目，模型收不到正文和批注格式要求。"
        + "请到 设置 → 预设 里启用这一条（或把阅读改绑内置预设）后重试。",
    );
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
