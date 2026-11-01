"use client";

// 查 API 配置的余额。各家接口不一样：
//   DeepSeek / OpenRouter / Kimi / 硅基流动：各有自己的余额接口
//   中转站（大多是 one-api、new-api 搭的）：认 OpenAI 早年的 /dashboard/billing 那两个接口，余额 = 额度上限 − 已用
//   OpenAI 官方、Anthropic、Gemini、Groq、智谱、Together：没有给 API key 用的余额接口，查不了
// 和聊天请求一样从浏览器直连。结果在内存里留一分钟，来回进出设置页不重复查。

import { determineBaseUrl } from "./api-helpers";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { ApiConfig } from "./settings-types";

const VISIBLE_KEY = "ai_phone_api_balance_visible_v1";
registerKvMigration(VISIBLE_KEY);

export type ApiBalance =
    /** text：「¥23.41」「$0.62」「不限额度」 */
    | { kind: "ok"; text: string }
    /** 能查的服务商，这次没查到（key 不对、网络断了……） */
    | { kind: "failed" }
    /** 这家查不了，什么都不显示 */
    | { kind: "unsupported" };

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; signature: string; result: ApiBalance }>();

/** API 设置卡片上要不要显示余额（有人看着余额会焦虑，可以关掉） */
export function loadBalanceVisible(): boolean {
    if (typeof window === "undefined") return true;
    return kvGet(VISIBLE_KEY) !== "0";
}

export function saveBalanceVisible(visible: boolean): void {
    kvSet(VISIBLE_KEY, visible ? "1" : "0");
}

const NO_BALANCE_HOSTS = new Set([
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.groq.com",
    "open.bigmodel.cn",
    "api.together.xyz",
]);

function parseUrl(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

function money(amount: number, currency: "CNY" | "USD"): string {
    return `${currency === "CNY" ? "¥" : "$"}${amount.toFixed(2)}`;
}

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
}

function num(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

/** 各家自己的余额接口；不是这几家就是 null */
async function queryOfficial(url: URL, apiKey: string): Promise<string | null | undefined> {
    const host = url.host;
    if (host === "api.deepseek.com") {
        const data = await getJson(`${url.origin}/user/balance`, apiKey) as { balance_infos?: Array<{ currency?: string; total_balance?: string }> };
        const info = data.balance_infos?.[0];
        const amount = num(info?.total_balance);
        return amount === null ? null : money(amount, info?.currency === "USD" ? "USD" : "CNY");
    }
    if (host === "openrouter.ai") {
        const data = await getJson(`${url.origin}/api/v1/credits`, apiKey) as { data?: { total_credits?: number; total_usage?: number } };
        const total = num(data.data?.total_credits);
        const used = num(data.data?.total_usage);
        return total === null || used === null ? null : money(total - used, "USD");
    }
    if (host === "api.moonshot.cn" || host === "api.moonshot.ai") {
        const data = await getJson(`${url.origin}/v1/users/me/balance`, apiKey) as { data?: { available_balance?: number } };
        const amount = num(data.data?.available_balance);
        return amount === null ? null : money(amount, host.endsWith(".cn") ? "CNY" : "USD");
    }
    if (host === "api.siliconflow.cn" || host === "api.siliconflow.com") {
        const data = await getJson(`${url.origin}/v1/user/info`, apiKey) as { data?: { totalBalance?: string } };
        const amount = num(data.data?.totalBalance);
        return amount === null ? null : money(amount, host.endsWith(".cn") ? "CNY" : "USD");
    }
    return undefined;
}

/** 中转站：额度上限 − 已用（已用是美分） */
async function queryRelay(baseUrl: string, apiKey: string): Promise<string | null> {
    const base = baseUrl.replace(/\/$/, "").replace(/\/(chat\/completions|completions|embeddings|messages|models)$/i, "");
    const subscription = await getJson(`${base}/dashboard/billing/subscription`, apiKey) as { hard_limit_usd?: number };
    const limit = num(subscription.hard_limit_usd);
    if (limit === null) return null;
    // one-api / new-api 不限额度的 key 会报一个一亿美元的上限
    if (limit >= 1e7) return "不限额度";
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const usage = await getJson(`${base}/dashboard/billing/usage?start_date=2023-01-01&end_date=${tomorrow}`, apiKey) as { total_usage?: number };
    const used = num(usage.total_usage);
    return used === null ? null : money(limit - used / 100, "USD");
}

async function query(config: ApiConfig): Promise<ApiBalance> {
    const baseUrl = determineBaseUrl(config);
    const url = parseUrl(baseUrl);
    if (!url || !config.apiKey || config.provider === "Google" || NO_BALANCE_HOSTS.has(url.host)) return { kind: "unsupported" };
    try {
        const official = await queryOfficial(url, config.apiKey);
        if (official !== undefined) return official ? { kind: "ok", text: official } : { kind: "failed" };
    } catch {
        return { kind: "failed" };
    }
    // 中转站不一定认这两个接口，查不到就当查不了，不显示
    try {
        const relay = await queryRelay(baseUrl, config.apiKey);
        return relay ? { kind: "ok", text: relay } : { kind: "unsupported" };
    } catch {
        return { kind: "unsupported" };
    }
}

function signatureOf(config: ApiConfig): string {
    return `${config.provider}|${config.baseUrl ?? ""}|${config.apiKey}`;
}

/** 查一个配置的余额；一分钟内查过、地址和 key 都没变就直接用上次的 */
export async function getApiBalance(config: ApiConfig, force = false): Promise<ApiBalance> {
    const signature = signatureOf(config);
    const cached = cache.get(config.id);
    if (!force && cached && cached.signature === signature && Date.now() - cached.at < CACHE_MS) return cached.result;
    const result = await query(config);
    cache.set(config.id, { at: Date.now(), signature, result });
    return result;
}
