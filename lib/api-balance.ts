"use client";

// 查 API 配置的余额。各家接口不一样：
//   DeepSeek / OpenRouter / Kimi / 硅基流动：各有自己的余额接口
//   中转站（大多是 one-api、new-api 搭的）：认 OpenAI 早年的 /dashboard/billing 那两个接口，余额 = 额度上限 − 已用
//   OpenAI 官方、Anthropic、Gemini、Groq、智谱、Together：没有给 API key 用的余额接口，查不了
//   中转站填了系统访问令牌：查整个账户的余额（/api/user/self），不限额度的 key 也能看到真余额
// 和聊天请求一样从浏览器直连，令牌不经过别的服务器。结果在内存里留一分钟，来回进出设置页不重复查。

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

/** 站点后台怎么显示额度就怎么显示：new-api 的 /api/status 里有换算比例和币种（人民币、美元、自定义、纯额度） */
function formatQuota(quota: number, status: Record<string, unknown>): string {
    const perUnit = num(status.quota_per_unit);
    const usd = quota / (perUnit && perUnit > 0 ? perUnit : 500_000);
    const type = typeof status.quota_display_type === "string" ? status.quota_display_type : status.display_in_currency === false ? "TOKENS" : "USD";
    if (type === "TOKENS") return `${Math.round(quota).toLocaleString()} 额度`;
    if (type === "CNY") {
        const rate = num(status.usd_exchange_rate) ?? num(status.price);
        if (rate) return money(usd * rate, "CNY");
    }
    if (type === "CUSTOM") {
        const symbol = typeof status.custom_currency_symbol === "string" ? status.custom_currency_symbol : "";
        return `${symbol}${(usd * (num(status.custom_currency_exchange_rate) ?? 1)).toFixed(2)}`;
    }
    return money(usd, "USD");
}

/** 系统访问令牌查整个账户：new-api 还要带上用户 ID */
async function queryAccount(origin: string, token: string, userId: string): Promise<string | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (userId) headers["New-Api-User"] = userId;
    const response = await fetch(`${origin}/api/user/self`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { success?: boolean; data?: { quota?: unknown } };
    const quota = body.success === false ? null : num(body.data?.quota);
    if (quota === null) return null;
    // 站点信息是公开的，不带令牌；拿不到就按 one-api 默认的美元算
    const status = await fetch(`${origin}/api/status`)
        .then(async (res) => (res.ok ? (await res.json() as { data?: Record<string, unknown> }).data : undefined))
        .catch(() => undefined);
    return formatQuota(quota, status ?? {});
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
    if (!url) return { kind: "unsupported" };
    // 填了令牌就只认它：令牌填错了要显示查不到，不悄悄退回去用 API Key 查
    const accessToken = config.balanceAccessToken?.trim();
    if (accessToken) {
        try {
            const account = await queryAccount(url.origin, accessToken, config.balanceUserId?.trim() ?? "");
            return account ? { kind: "ok", text: account } : { kind: "failed" };
        } catch {
            return { kind: "failed" };
        }
    }
    if (!config.apiKey || config.provider === "Google" || NO_BALANCE_HOSTS.has(url.host)) return { kind: "unsupported" };
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
    return `${config.provider}|${config.baseUrl ?? ""}|${config.apiKey}|${config.balanceAccessToken ?? ""}|${config.balanceUserId ?? ""}`;
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
