import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { applyLlmRequestHooksForPreview, previewMessagesForApi, sendLLMRequestPreferStream, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, type StoryExtraBindings, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking";

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
    // 剧情里的 system 消息就是「指令」发的系统指令：和聊天的系统指令一样单独成一条 system，不和前后合并
    ...(message.role === "system" ? { mediaType: "system_instruction" as const } : {}),
  };
}

/** 剧情里 system 的只有「指令」发的才进提示词；报错提示（「重试失败…」）也是 system，不能当指令发给模型 */
function isPromptStoryMessage(message: StoryMessage): boolean {
  return message.role !== "system" || message.instruction === true;
}

/** 上次回复之后发的系统指令，挪到这次输入的紧前面：【前面所有】【系统指令】【新输入】。
 *  剧情历史和私聊、日记这些按时间混排，指令发出去到你输入之间要是有别处的记录，
 *  就会插在两者中间，指令看着像一条旧记录，模型不当回事（聊天里两者总挨着）。
 *  发完指令点重试时，指令在输入后面，也一样挪到前面 */
function pinPendingInstructions(history: ChatMessage[]): ChatMessage[] {
  let lastUser = -1;
  let lastAssistant = -1;
  history.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
    if (message.role === "assistant") lastAssistant = index;
  });
  if (lastUser < 0 || lastUser < lastAssistant) return history;
  const anchor = Date.parse(history[lastUser].createdAt);
  if (!Number.isFinite(anchor)) return history;
  const pending = history.filter((message, index) => index > lastAssistant && message.mediaType === "system_instruction");
  if (pending.length === 0) return history;
  // 时间线按时间排，所以时间改到输入前一点点；数组里也挪过去
  const pinned = pending.map((message, order) => ({
    ...message,
    createdAt: new Date(anchor - (pending.length - order)).toISOString(),
  }));
  const pendingIds = new Set(pending.map(message => message.id));
  const rest = history.filter(message => !pendingIds.has(message.id));
  const inputAt = rest.indexOf(history[lastUser]);
  return [...rest.slice(0, inputAt), ...pinned, ...rest.slice(inputAt)];
}

/** 番外多一个 story_extra 标签：日历、经期这些只进正篇，不进番外 */
function storyAppTags(extra?: boolean): string[] {
  return extra ? ["story", "story_extra"] : ["story"];
}

/** overrides：番外单独的绑定。哪项没填（或绑的东西已经删了）就跟随剧情 */
function resolveStoryConfigs(characterId: string, overrides?: StoryExtraBindings): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = (overrides?.apiConfigId ? apiConfigs.find((config) => config.id === overrides.apiConfigId) : undefined)
    ?? apiConfigs.find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  const overridePreset = overrides?.presetId ? presets.find((item) => item.id === overrides.presetId) || null : null;
  let preset = overridePreset ?? (activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null);
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = overrides?.regexIds
    ?? (storyOverrideRegexIds && storyOverrideRegexIds.length > 0
      ? storyOverrideRegexIds
      : activeSlot.regexIds || []);
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (overrides?.worldBookIds ?? activeSlot.worldBookIds ?? [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

export function getStoryRenderSignature(characterId: string, overrides?: StoryExtraBindings): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId, overrides);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionFoldTags?: string; sessionContextExcludedTags?: string; signal?: AbortSignal; bindings?: StoryExtraBindings; extra?: boolean },
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId, options?.bindings);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  // 剧情一次生成很长：优先流式，避免 iOS Safari 约 60 秒无数据就断开（见 sendLLMRequestPreferStream）
  const rawOutput = await sendLLMRequestPreferStream(apiConfig, preset, llmMessages, regexes, {
    characterName: character.name,
  }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: storyAppTags(options?.extra), characterId, signal: options?.signal });

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const historyMessages = pinPendingInstructions(
    history.filter(isPromptStoryMessage).map((message) => toHistoryMessage(message, contextExcludedTags)),
  );
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "story", {
    userName: userIdentity?.name ?? "用户",
    history: historyMessages,
  });

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);

  const now = new Date();

  return assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(now)),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
  });
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionContextExcludedTags?: string; bindings?: StoryExtraBindings; extra?: boolean },
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset, regexes, worldBooks } = resolveStoryConfigs(characterId, options?.bindings);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const built = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);
  // 日历、备忘录、经期是真正发请求时由 llm.request 加进去的，预览也跑一遍才和实际一致
  const hooked = await applyLlmRequestHooksForPreview(preset, built, "story", { characterId, appTags: storyAppTags(options?.extra) });
  return {
    messages: previewMessagesForApi(apiConfig, hooked.preset, hooked.messages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(
  characterId: string,
  sessionId: string,
  options?: { sessionFoldTags?: string; bindings?: StoryExtraBindings },
): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId, options?.bindings);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId, options?.bindings);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
