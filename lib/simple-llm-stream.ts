// lib/simple-llm-stream.ts
// simpleLLMCall 的「优先流式」版本：请求内容与 simpleLLMCall 完全一致（共用 buildSimpleLLMRequest），
// 只是打开各家的流式开关，在本地把增量收齐后按原样返回。
//
// 为什么要流式：iOS Safari 对迟迟收不到任何响应数据的请求，大约 60 秒就判定超时断开。
// 非流式要等模型整段写完才返回，长生成在 iPhone 上会必挂；流式一开始就陆续有数据。
//
// 退回规则：什么都没收到就失败（接口或中转不支持 SSE、HTTP 报错、流里没有任何增量等），
// 退回 simpleLLMCall 再请求一次，报错信息和以前完全一样；
// 已经收到正文或思考内容后连接断开，或调用方主动中止，按失败返回，不再重试（避免同一次长生成计费两次）。

import type { ApiConfig } from "./settings-types";
import { pushApiLog } from "./api-log-store";
import {
    buildSimpleLLMRequest,
    describeEmptyLLMResponse,
    extractFinishReason,
    extractUsage,
    isTruncationFinishReason,
    simpleLLMCall,
    stripHallucinatedTimestamps,
    stripReasoningMarkup,
    type SimpleLLMCallOptions,
    type SimpleLLMCallResult,
    type SimpleLLMMessage,
} from "./api-helpers";
import { parseProviderStreamDelta } from "./llm-provider-adapter";
import { createSseJsonParser } from "./sse-json";

function splitSseEvents(buffer: string): { events: string[]; rest: string } {
    const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
    return { events: parts.slice(0, -1), rest: parts[parts.length - 1] || "" };
}

/** Anthropic 的结束原因在 message_delta 事件的 delta 里，extractFinishReason 只认顶层字段 */
function anthropicStopReason(chunk: Record<string, unknown>): string | undefined {
    if (chunk.type !== "message_delta") return undefined;
    const delta = chunk.delta as { stop_reason?: unknown } | undefined;
    return typeof delta?.stop_reason === "string" ? delta.stop_reason : undefined;
}

/** null 表示「什么都没收到」，由调用方退回非流式 */
async function simpleLLMStreamCall(
    config: ApiConfig,
    messages: SimpleLLMMessage[],
    options?: SimpleLLMCallOptions,
): Promise<SimpleLLMCallResult | null> {
    const request = buildSimpleLLMRequest(config, messages, options, true);
    if (!request) return null;

    let content = "";
    let reasoning = "";
    let started = false;
    let finishReason: string | undefined;
    let usage: ReturnType<typeof extractUsage>;

    const handleChunk = (parsed: unknown) => {
        const delta = parseProviderStreamDelta(request.providerKind, parsed);
        if (delta.content) {
            content += delta.content;
            started = true;
        }
        if (delta.reasoning) {
            reasoning += delta.reasoning;
            started = true;
        }
        if (parsed && typeof parsed === "object") {
            const chunk = parsed as Record<string, unknown>;
            finishReason = extractFinishReason(chunk) ?? anthropicStopReason(chunk) ?? finishReason;
            usage = extractUsage(chunk) ?? usage;
        }
    };

    try {
        const res = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
            signal: options?.signal,
        });
        if (!res.ok || !res.body) return null;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const sseParser = createSseJsonParser();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const split = splitSseEvents(buffer);
            buffer = split.rest;
            for (const eventText of split.events) {
                for (const parsed of sseParser.pushEvent(eventText)) handleChunk(parsed);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            for (const parsed of sseParser.pushEvent(buffer)) handleChunk(parsed);
        }
        for (const parsed of sseParser.flush()) handleChunk(parsed);
    } catch (err) {
        if (!started && !options?.signal?.aborted) return null;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[simpleLLMStreamCall] stream error:", err);
        pushApiLog({
            characterName: options?.label,
            source: "background",
            model: config.defaultModel,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            rawResponse: `[请求失败] ${message}`,
        });
        return { content: null, error: `请求失败: ${message}` };
    }

    if (!started) return null;

    // 与 extractLLMContent 的收尾处理一致：正文为空时，OpenAI 兼容接口退而用思考内容
    let raw = content.trim();
    if (!raw && request.providerKind === "openai-compatible") raw = reasoning.trim();
    const finalContent = raw ? stripHallucinatedTimestamps(stripReasoningMarkup(raw)) : "";
    const wasTruncated = isTruncationFinishReason(finishReason);
    if (!finalContent) {
        const error = describeEmptyLLMResponse({}, finishReason, wasTruncated, config);
        pushApiLog({
            characterName: options?.label,
            source: "background",
            model: config.defaultModel,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            rawResponse: error,
            usage,
        });
        return { content: null, error, finishReason, wasTruncated };
    }

    pushApiLog({
        characterName: options?.label,
        source: "background",
        model: config.defaultModel,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        rawResponse: finalContent,
        usage,
    });
    return { content: finalContent, finishReason, wasTruncated };
}

/** 和 simpleLLMCall 同签名、同返回；优先流式，没收到任何内容时退回 simpleLLMCall。 */
export async function simpleLLMCallPreferStream(
    config: ApiConfig,
    messages: SimpleLLMMessage[],
    options?: SimpleLLMCallOptions,
): Promise<SimpleLLMCallResult> {
    const streamed = await simpleLLMStreamCall(config, messages, options);
    if (streamed) return streamed;
    if (options?.signal?.aborted) return { content: null, error: "请求失败: 已中止" };
    return simpleLLMCall(config, messages, options);
}
