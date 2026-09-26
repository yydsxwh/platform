/**
 * AI 服务层：路由、限流、超时、fallback、健康度与用量记录。
 *
 * 产品只说用途和消息；选哪个 provider、用哪个型号、Key 从哪来，全在这里决定。
 * **任何返回值与日志都不含 API Key。**
 *
 * 刻意保持简单：没有 embedding、没有流式、没有 prompt 模板管理、没有向量库。
 * 这些现在没有真实调用方，等有了再加，别先造一个 AI Gateway。
 */

import { randomUUID } from "node:crypto";

import type {
  AiChatRequest,
  AiChatResponse,
  AiProviderStatus,
  AiPurpose,
  AiRouteStatus,
  AiUsageSummaryResponse,
} from "@yydsxwh/shared/contracts/ai";
import { AI_PURPOSES } from "@yydsxwh/shared/contracts/ai";

import type { PrismaClient } from "@prisma/client";
import {
  failedPrecondition,
  invalidRequest,
  providerUnavailable,
  PlatformError,
} from "../../errors";
import { logger } from "../../observability/logger";
import { parseModelRef, type AiConfig, type AiProviderConfig } from "./config";
import {
  AiProviderError,
  callChatCompletion,
  type ChatCompletionFn,
} from "./provider";
import type { AiSettingsStore } from "./settings-store";

function messagesIncludeImage(messages: AiChatRequest["messages"]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
}

export type AiCaller = {
  clientId: string;
  actorId: string | null;
};

type ProviderHealthState = {
  consecutiveFailures: number;
  lastErrorAt: Date | null;
};

/**
 * 每分钟滑动窗口限流。
 *
 * 单进程模块化单体下用内存计数是最简实现；进程重启即清零。
 * 将来 platform 跑多副本时要换成共享存储，届时只改这个类。
 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limitPerMinute: number) {}

  check(key: string, now = Date.now()): boolean {
    const windowStart = now - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.limitPerMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** 库里的配置几秒内复用一次，避免每次调用都打一次 SQLite */
const CONFIG_CACHE_MS = 5_000;

/**
 * 「测试图片识别」用的探针图：84×54 灰度 PNG，画着两个字母 OK。
 * 纯文本模型收到它只会报参数错误或答非所问，正好把配错的路由暴露出来。
 */
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFQAAAA2CAAAAAB8POFMAAAASUlEQVR42u3XsQ0AMAgDQe+/dDJAguSG" +
  "AvyUCK5DgE5DCHQgqic+DUYedBbqE1YGNAAtu0BXo1U9aALKRIGyTXegXNKgfNFh6AUo13NEjeQSbAAAAABJRU5ErkJggg==";

export class AiService {
  private readonly health = new Map<string, ProviderHealthState>();
  private readonly limiter: RateLimiter;
  private config: AiConfig;
  private configLoadedAt = 0;

  constructor(
    private readonly db: PrismaClient,
    baseConfig: AiConfig,
    private readonly chat: ChatCompletionFn = callChatCompletion,
    private readonly settings: AiSettingsStore | null = null,
  ) {
    this.config = baseConfig;
    this.limiter = new RateLimiter(baseConfig.rateLimitPerMinute);
  }

  /** 后台改完配置立刻生效，不必重启 platform。 */
  async refresh(force = false): Promise<void> {
    if (!this.settings) return;
    if (!force && Date.now() - this.configLoadedAt < CONFIG_CACHE_MS) return;
    this.config = await this.settings.load();
    this.configLoadedAt = Date.now();
  }

  async chatCompletion(
    input: AiChatRequest,
    caller: AiCaller,
  ): Promise<AiChatResponse> {
    await this.refresh();
    if (!input.messages?.length) {
      throw invalidRequest("messages 不能为空");
    }
    if (this.config.providers.size === 0) {
      throw failedPrecondition("platform 尚未配置任何 AI Provider", {
        hint: "设置 AI_PROVIDERS 与对应的 Key 环境变量",
      });
    }
    if (!this.limiter.check(`${caller.clientId}:${input.purpose ?? "default"}`)) {
      throw new PlatformError(
        "RATE_LIMITED",
        `调用过于频繁，每分钟上限 ${this.config.rateLimitPerMinute} 次`,
        { limitPerMinute: this.config.rateLimitPerMinute },
      );
    }

    const candidates = this.resolveCandidates(input);
    if (candidates.length === 0) {
      throw failedPrecondition(
        input.purpose
          ? `用途 ${input.purpose} 没有可用的模型路由`
          : "未指定模型且没有默认模型",
        { purpose: input.purpose, model: input.model },
      );
    }

    const requestId = `ai_${randomUUID().replace(/-/g, "")}`;
    const timeoutMs = Math.min(
      input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : this.config.timeoutMs,
      this.config.timeoutMs,
    );

    // 一个候选都解析不出来 = 配置问题（没这个 provider / 没配 Key / 没这个型号），
    // 与「下游厂商挂了」是两回事，报错要分开，否则运维会去查错的方向
    if (!candidates.some((ref) => this.resolveProviderModel(ref) !== null)) {
      throw failedPrecondition(
        `候选模型都不可用：provider 未登记、未配 Key 或没有该型号`,
        { tried: candidates },
      );
    }

    const wantsImage = messagesIncludeImage(input.messages);
    let lastError: unknown = null;
    let blockedNonVision = false;
    let triedVision = false;
    for (const [index, ref] of candidates.entries()) {
      const resolved = this.resolveProviderModel(ref);
      if (!resolved) continue;
      const { provider, modelId } = resolved;
      const model = provider.models.find((item) => item.id === modelId);
      // 带图片的请求只能进 vision:true 的模型。纯文本模型不能“假装看过图”。
      if (wantsImage && model?.vision !== true) {
        blockedNonVision = true;
        continue;
      }
      if (wantsImage) triedVision = true;

      // 已经连续失败的 provider，在还有备选时直接跳过，不拿用户请求去试错
      if (this.isDegraded(provider.id) && index < candidates.length - 1) {
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await this.chat({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey!,
          model: modelId,
          messages: input.messages,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          timeoutMs,
        });
        const latencyMs = Date.now() - startedAt;
        this.markSuccess(provider.id);

        const costMicros = this.estimateCost(provider, modelId, result);
        await this.recordUsage({
          requestId,
          caller,
          purpose: input.purpose ?? null,
          provider: provider.id,
          model: modelId,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costMicros,
          latencyMs,
          status: "SUCCEEDED",
          errorKind: null,
          metadata: input.metadata,
        });

        return {
          requestId,
          model: `${provider.id}/${modelId}`,
          provider: provider.id,
          content: result.content,
          usage: {
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            totalTokens: result.promptTokens + result.completionTokens,
            costMicros,
          },
          latencyMs,
          fallbackUsed: index > 0,
        };
      } catch (error) {
        lastError = error;
        this.markFailure(provider.id);
        const latencyMs = Date.now() - startedAt;
        await this.recordUsage({
          requestId,
          caller,
          purpose: input.purpose ?? null,
          provider: provider.id,
          model: modelId,
          promptTokens: 0,
          completionTokens: 0,
          costMicros: 0,
          latencyMs,
          status: "FAILED",
          errorKind: error instanceof AiProviderError ? error.kind : "UNKNOWN",
          metadata: input.metadata,
        });
        logger.warn("ai", "模型调用失败，尝试下一个候选", {
          requestId,
          provider: provider.id,
          model: modelId,
          // 只记错误类型与摘要，绝不记 Key 或完整提示词
          errorKind: error instanceof AiProviderError ? error.kind : "UNKNOWN",
        });
      }
    }

    if (wantsImage && !triedVision && blockedNonVision) {
      throw failedPrecondition(
        "没有可用视觉模型：请求包含图片，但候选模型都不支持视觉输入",
        { requestId, purpose: input.purpose, tried: candidates },
      );
    }

    throw providerUnavailable(
      `所有候选模型均调用失败：${(lastError as Error)?.message || "未知错误"}`,
      { requestId, tried: candidates },
    );
  }

  listProviders(): AiProviderStatus[] {
    return [...this.config.providers.values()].map((provider) => {
      const state = this.health.get(provider.id);
      return {
        providerId: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        // 只报有没有配，不报值；Studio 也拿不到 Key
        hasApiKey: Boolean(provider.apiKey),
        apiKeyEnvName: provider.apiKeyEnv,
        models: provider.models.map((m) => ({
          id: m.id,
          vision: m.vision,
          costPerMillionInputMicros: m.costPerMillionInputMicros,
          costPerMillionOutputMicros: m.costPerMillionOutputMicros,
        })),
        health: !provider.apiKey
          ? "UNCONFIGURED"
          : this.isDegraded(provider.id)
            ? "DEGRADED"
            : "HEALTHY",
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastErrorAt: state?.lastErrorAt ? state.lastErrorAt.toISOString() : null,
      };
    });
  }

  listRoutes(): { routes: AiRouteStatus[]; defaultModel: string | null } {
    const routes = AI_PURPOSES.map((purpose) => {
      const candidates = this.config.routes.get(purpose) ?? [];
      const resolved =
        candidates.find((ref) => this.resolveProviderModel(ref) !== null) ?? null;
      return { purpose, candidates, resolved };
    });
    return { routes, defaultModel: this.config.defaultModel };
  }

  /**
   * vision-ocr 必须落在带视觉能力的模型上。
   * 配错了要在保存时就拦住——否则用户导入课表照片才发现，白跑一次上传。
   */
  assertRouteUsable(purpose: AiPurpose, candidates: string[]): void {
    if (!candidates.length) return;
    for (const ref of candidates) {
      if (!/^[a-z][a-z0-9-]*\/.+$/.test(ref)) {
        throw invalidRequest(`模型引用须为 provider/model 形式：${ref}`);
      }
    }
    if (purpose !== "vision-ocr") return;
    const bad: string[] = [];
    for (const ref of candidates) {
      const { providerId, modelId } = parseModelRef(ref);
      const model = this.config.providers.get(providerId)?.models.find((m) => m.id === modelId);
      // 认不出的型号交给调用时报错；这里只拦「明确登记为纯文本」的
      if (model && !model.vision) bad.push(ref);
    }
    if (bad.length) {
      throw invalidRequest(
        `${bad.join("、")} 登记为纯文本模型，不能用于图片识别（vision-ocr）。请改选带视觉能力的模型。`,
      );
    }
  }

  /** 后台「测试文字调用 / 测试图片识别」都走真实链路，不给假成功。 */
  async selfTest(
    input: { purpose: AiPurpose; mode: "text" | "image" },
    caller: AiCaller,
  ): Promise<AiChatResponse> {
    await this.refresh(true);
    const messages: AiChatRequest["messages"] =
      input.mode === "image"
        ? [
            {
              role: "user",
              content: [
                { type: "text", text: "这张图里写了什么字？只回答图里的文字本身。" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
              ],
            },
          ]
        : [{ role: "user", content: "只回复两个字：正常" }];
    return this.chatCompletion(
      {
        purpose: input.purpose,
        messages,
        temperature: 0,
        maxTokens: 64,
        metadata: { product: "platform", kind: `selftest-${input.mode}` },
      },
      caller,
    );
  }

  async getUsageSummary(query: {
    from?: string;
    to?: string;
  }): Promise<AiUsageSummaryResponse> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw invalidRequest("from / to 须为合法时间");
    }

    const rows = (await this.db.aiUsage.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        clientId: true,
        purpose: true,
        provider: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        costMicros: true,
        status: true,
      },
    })) as Array<{
      clientId: string;
      purpose: string | null;
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costMicros: number;
      status: string;
    }>;

    const buckets = new Map<string, AiUsageSummaryResponse["buckets"][number]>();
    for (const row of rows) {
      const purpose = row.purpose ?? "unspecified";
      const key = `${row.clientId}|${purpose}|${row.provider}|${row.model}`;
      const bucket = buckets.get(key) ?? {
        clientId: row.clientId,
        purpose,
        provider: row.provider,
        model: row.model,
        calls: 0,
        failedCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costMicros: 0,
      };
      bucket.calls += 1;
      if (row.status !== "SUCCEEDED") bucket.failedCalls += 1;
      bucket.promptTokens += row.promptTokens;
      bucket.completionTokens += row.completionTokens;
      bucket.costMicros += row.costMicros;
      buckets.set(key, bucket);
    }

    const list = [...buckets.values()].sort((a, b) => b.calls - a.calls);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      buckets: list,
      totals: {
        calls: list.reduce((sum, b) => sum + b.calls, 0),
        failedCalls: list.reduce((sum, b) => sum + b.failedCalls, 0),
        totalTokens: list.reduce(
          (sum, b) => sum + b.promptTokens + b.completionTokens,
          0,
        ),
        costMicros: list.reduce((sum, b) => sum + b.costMicros, 0),
      },
    };
  }

  /** 指定 model 优先；否则按用途路由；再否则用默认模型 */
  private resolveCandidates(input: AiChatRequest): string[] {
    if (input.model) return [input.model];
    if (input.purpose) {
      const byPurpose = this.config.routes.get(input.purpose as AiPurpose);
      if (byPurpose?.length) return byPurpose;
    }
    return this.config.defaultModel ? [this.config.defaultModel] : [];
  }

  /** 解析 `provider/model`；provider 不存在、没配 Key 或没这个型号都返回 null */
  private resolveProviderModel(
    ref: string,
  ): { provider: AiProviderConfig; modelId: string } | null {
    if (!ref.includes("/")) return null;
    const { providerId, modelId } = parseModelRef(ref);
    const provider = this.config.providers.get(providerId);
    if (!provider || !provider.apiKey) return null;
    if (!provider.models.some((m) => m.id === modelId)) return null;
    return { provider, modelId };
  }

  private isDegraded(providerId: string): boolean {
    const state = this.health.get(providerId);
    return (state?.consecutiveFailures ?? 0) >= this.config.failureThreshold;
  }

  private markSuccess(providerId: string): void {
    this.health.set(providerId, { consecutiveFailures: 0, lastErrorAt: null });
  }

  private markFailure(providerId: string): void {
    const state = this.health.get(providerId);
    this.health.set(providerId, {
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
      lastErrorAt: new Date(),
    });
  }

  private estimateCost(
    provider: AiProviderConfig,
    modelId: string,
    usage: { promptTokens: number; completionTokens: number },
  ): number | null {
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return null;
    const { costPerMillionInputMicros: input, costPerMillionOutputMicros: output } = model;
    if (input === null && output === null) return null;
    return Math.round(
      (usage.promptTokens * (input ?? 0)) / 1_000_000 +
        (usage.completionTokens * (output ?? 0)) / 1_000_000,
    );
  }

  /** 用量落库失败不能把业务请求带崩：AI 结果已经拿到了 */
  private async recordUsage(input: {
    requestId: string;
    caller: AiCaller;
    purpose: string | null;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costMicros: number | null;
    latencyMs: number;
    status: "SUCCEEDED" | "FAILED";
    errorKind: string | null;
    metadata?: Record<string, string>;
  }): Promise<void> {
    try {
      await this.db.aiUsage.create({
        data: {
          id: `aiu_${randomUUID().replace(/-/g, "")}`,
          requestId: input.requestId,
          clientId: input.caller.clientId,
          actorId: input.caller.actorId,
          purpose: input.purpose,
          provider: input.provider,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          costMicros: input.costMicros ?? 0,
          latencyMs: input.latencyMs,
          status: input.status,
          errorKind: input.errorKind,
          metadata: JSON.stringify(input.metadata ?? {}),
        },
      });
    } catch (error) {
      logger.error("ai", "用量落库失败", {
        requestId: input.requestId,
        message: (error as Error)?.message,
      });
    }
  }
}
