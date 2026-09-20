/**
 * AI Provider 与路由配置。
 *
 * 密钥不写进配置 JSON，而是用 `apiKeyEnv` 指向另一个环境变量名。
 * 这样 provider 清单可以放进配置管理、日志与 Studio 展示，
 * **Key 本身只存在于它自己的环境变量里**，可以单独轮换、单独收紧读取权限。
 *
 * 配置形如：
 *   AI_PROVIDERS=[{"id":"dashscope","label":"阿里云百炼","baseUrl":"https://…/v1",
 *                  "apiKeyEnv":"AI_KEY_DASHSCOPE",
 *                  "models":[{"id":"qwen-vl-max","vision":true}]}]
 *   AI_KEY_DASHSCOPE=sk-…
 *   AI_ROUTES={"translate":["dashscope/qwen-plus","openai/gpt-4o-mini"]}
 */

import { z } from "zod";

import { AI_PURPOSES, type AiPurpose } from "@yydsxwh/shared/contracts/ai";

const modelSchema = z.object({
  id: z.string().min(1),
  vision: z.boolean().default(false),
  /** 百万 token 单价，单位百万分之一元；不填则不算成本 */
  costPerMillionInputMicros: z.number().int().nonnegative().nullable().default(null),
  costPerMillionOutputMicros: z.number().int().nonnegative().nullable().default(null),
});

const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "provider id 须为小写字母开头的短横线命名"),
  label: z.string().default(""),
  baseUrl: z.string().url(),
  /** 读取 API Key 的环境变量名；配置里不放 Key 本身 */
  apiKeyEnv: z.string().min(1),
  models: z.array(modelSchema).min(1),
});

export type AiModelConfig = z.infer<typeof modelSchema>;

export type AiProviderConfig = {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** 运行时从 apiKeyEnv 读出；不进日志、不进任何响应 */
  apiKey: string | null;
  models: AiModelConfig[];
};

export type AiConfig = {
  providers: Map<string, AiProviderConfig>;
  /** 用途 → 按顺序尝试的 `provider/model` 列表 */
  routes: Map<AiPurpose, string[]>;
  defaultModel: string | null;
  timeoutMs: number;
  /** 每分钟每调用方的调用上限 */
  rateLimitPerMinute: number;
  /** 连续失败多少次后标记为降级，在有备选时跳过 */
  failureThreshold: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_FAILURE_THRESHOLD = 3;

export function loadAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  const providers = new Map<string, AiProviderConfig>();
  for (const raw of parseProviders(env.AI_PROVIDERS)) {
    const apiKey = (env[raw.apiKeyEnv] || "").trim() || null;
    providers.set(raw.id, {
      id: raw.id,
      label: raw.label || raw.id,
      baseUrl: raw.baseUrl.replace(/\/+$/, ""),
      apiKeyEnv: raw.apiKeyEnv,
      apiKey,
      models: raw.models,
    });
  }

  const routes = parseRoutes(env.AI_ROUTES);
  const defaultModel = (env.AI_DEFAULT_MODEL || "").trim() || null;
  if (defaultModel) assertModelRefShape(defaultModel);

  return {
    providers,
    routes,
    defaultModel,
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    rateLimitPerMinute: positiveInt(
      env.AI_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE,
    ),
    failureThreshold: positiveInt(
      env.AI_FAILURE_THRESHOLD,
      DEFAULT_FAILURE_THRESHOLD,
    ),
  };
}

function parseProviders(raw: string | undefined): z.infer<typeof providerSchema>[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI_PROVIDERS 不是合法 JSON");
  }
  const result = z.array(providerSchema).safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`AI_PROVIDERS 配置不合法：${issues}`);
  }
  const seen = new Set<string>();
  for (const provider of result.data) {
    if (seen.has(provider.id)) {
      throw new Error(`AI_PROVIDERS 中 provider id 重复：${provider.id}`);
    }
    seen.add(provider.id);
  }
  return result.data;
}

function parseRoutes(raw: string | undefined): Map<AiPurpose, string[]> {
  const routes = new Map<AiPurpose, string[]>();
  if (!raw?.trim()) return routes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI_ROUTES 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_ROUTES 应为对象：用途 → 模型或模型数组");
  }
  for (const [purpose, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(AI_PURPOSES as readonly string[]).includes(purpose)) {
      throw new Error(`AI_ROUTES 含未知用途：${purpose}`);
    }
    const candidates = Array.isArray(value) ? value.map(String) : [String(value)];
    for (const candidate of candidates) assertModelRefShape(candidate);
    routes.set(purpose as AiPurpose, candidates);
  }
  return routes;
}

/** 模型引用必须是 `provider/model`，否则路由时分不清是哪家 */
function assertModelRefShape(ref: string): void {
  if (!/^[a-z][a-z0-9-]*\/.+$/.test(ref)) {
    throw new Error(`模型引用须为 provider/model 形式：${ref}`);
  }
}

export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/");
  return {
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
