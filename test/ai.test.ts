import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type {
  AiChatResponse,
  AiUsageSummaryResponse,
  ListAiProvidersResponse,
  ListAiRoutesResponse,
} from "@yydsxwh/shared/contracts/ai";
import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";

import { loadAiConfig } from "../src/modules/ai/config";
import {
  AiProviderError,
  type ChatCompletionFn,
  type ChatCompletionInput,
} from "../src/modules/ai/provider";
import { AiService } from "../src/modules/ai/service";
import { createTestApp, json, type TestApp } from "./helpers/app";

const PROVIDERS = JSON.stringify([
  {
    id: "dashscope",
    label: "阿里云百炼",
    baseUrl: "https://dashscope.example.com/v1",
    apiKeyEnv: "AI_KEY_DASHSCOPE",
    models: [
      {
        id: "qwen-plus",
        costPerMillionInputMicros: 800_000,
        costPerMillionOutputMicros: 2_000_000,
      },
      { id: "qwen-vl-max", vision: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.example.com/v1",
    apiKeyEnv: "AI_KEY_OPENAI",
    models: [{ id: "gpt-4o-mini", vision: true }],
  },
  {
    id: "unconfigured",
    label: "没配 Key 的家",
    baseUrl: "https://nope.example.com/v1",
    apiKeyEnv: "AI_KEY_MISSING",
    models: [{ id: "m1" }],
  },
]);

const ROUTES = JSON.stringify({
  translate: ["dashscope/qwen-plus", "openai/gpt-4o-mini"],
  "vision-ocr": ["dashscope/qwen-vl-max"],
});

const AI_ENV = {
  AI_PROVIDERS: PROVIDERS,
  AI_ROUTES: ROUTES,
  AI_DEFAULT_MODEL: "dashscope/qwen-plus",
  AI_KEY_DASHSCOPE: "sk-dashscope-secret",
  AI_KEY_OPENAI: "sk-openai-secret",
  AI_TIMEOUT_MS: "5000",
  AI_RATE_LIMIT_PER_MINUTE: "5",
  AI_FAILURE_THRESHOLD: "2",
};

let ctx: TestApp;

/** 用可编排的假 provider 替换真实 HTTP 调用 */
function buildService(
  handler: ChatCompletionFn,
  envOverrides: Record<string, string> = {},
): { service: AiService; calls: ChatCompletionInput[] } {
  const calls: ChatCompletionInput[] = [];
  const wrapped: ChatCompletionFn = async (input) => {
    calls.push(input);
    return handler(input);
  };
  const config = loadAiConfig({ ...AI_ENV, ...envOverrides } as NodeJS.ProcessEnv);
  return { service: new AiService(ctx.db, config, wrapped), calls };
}

const okReply: ChatCompletionFn = async () => ({
  content: "译文",
  promptTokens: 100,
  completionTokens: 50,
});

const caller = { clientId: "andyyyds", actorId: "user_1" };
const messages = [{ role: "user" as const, content: "你好" }];

before(async () => {
  ctx = await createTestApp(AI_ENV);
});

after(async () => {
  await ctx.close();
});

test("provider 配置解析：Key 走环境变量间接引用，不写进配置 JSON", () => {
  const config = loadAiConfig(AI_ENV as NodeJS.ProcessEnv);
  assert.equal(config.providers.size, 3);
  assert.equal(config.providers.get("dashscope")!.apiKey, "sk-dashscope-secret");
  assert.equal(config.providers.get("unconfigured")!.apiKey, null);
  assert.deepEqual(config.routes.get("translate"), [
    "dashscope/qwen-plus",
    "openai/gpt-4o-mini",
  ]);
});

test("坏配置在启动时就报错，不留到第一个请求才 500", () => {
  assert.throws(() => loadAiConfig({ AI_PROVIDERS: "{坏" } as NodeJS.ProcessEnv), /合法 JSON/);
  assert.throws(
    () => loadAiConfig({ AI_PROVIDERS: '[{"id":"A","baseUrl":"x"}]' } as NodeJS.ProcessEnv),
    /不合法/,
  );
  assert.throws(
    () =>
      loadAiConfig({
        AI_PROVIDERS: PROVIDERS,
        AI_ROUTES: '{"not-a-purpose":"dashscope/qwen-plus"}',
      } as NodeJS.ProcessEnv),
    /未知用途/,
  );
  assert.throws(
    () =>
      loadAiConfig({
        AI_PROVIDERS: PROVIDERS,
        AI_ROUTES: '{"translate":"qwen-plus"}',
      } as NodeJS.ProcessEnv),
    /provider\/model/,
  );
});

test("按用途路由到对应模型，产品不用关心型号", async () => {
  const { service, calls } = buildService(okReply);
  const result = await service.chatCompletion({ purpose: "translate", messages }, caller);

  assert.equal(result.model, "dashscope/qwen-plus");
  assert.equal(result.provider, "dashscope");
  assert.equal(result.content, "译文");
  assert.equal(result.fallbackUsed, false);
  assert.equal(calls[0]!.model, "qwen-plus");
  assert.equal(calls[0]!.baseUrl, "https://dashscope.example.com/v1");
});

test("视觉用途路由到视觉模型", async () => {
  const { service, calls } = buildService(okReply);
  const result = await service.chatCompletion(
    {
      purpose: "vision-ocr",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "转写" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          ],
        },
      ],
    },
    caller,
  );
  assert.equal(result.model, "dashscope/qwen-vl-max");
  assert.equal(calls[0]!.model, "qwen-vl-max");
});

test("显式指定模型时优先于用途路由", async () => {
  const { service, calls } = buildService(okReply);
  const result = await service.chatCompletion(
    { purpose: "translate", model: "openai/gpt-4o-mini", messages },
    caller,
  );
  assert.equal(result.provider, "openai");
  assert.equal(calls[0]!.apiKey, "sk-openai-secret");
});

test("token 用量与成本按单价算出来", async () => {
  const { service } = buildService(okReply);
  const result = await service.chatCompletion({ purpose: "translate", messages }, caller);
  assert.equal(result.usage.promptTokens, 100);
  assert.equal(result.usage.completionTokens, 50);
  assert.equal(result.usage.totalTokens, 150);
  // 100/1e6*800000 + 50/1e6*2000000 = 80 + 100 = 180
  assert.equal(result.usage.costMicros, 180);
});

test("没配单价的模型不瞎算成本，返回 null", async () => {
  const { service } = buildService(okReply);
  const result = await service.chatCompletion(
    { model: "openai/gpt-4o-mini", messages },
    caller,
  );
  assert.equal(result.usage.costMicros, null);
});

test("缺 Key 的 provider 不会被路由命中", async () => {
  const { service } = buildService(okReply);
  const error = await service
    .chatCompletion({ model: "unconfigured/m1", messages }, caller)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.equal((error as { code: string }).code, "FAILED_PRECONDITION");
});

test("一个 provider 都没配时给出可操作的报错", async () => {
  const { service } = buildService(okReply, { AI_PROVIDERS: "" });
  const error = await service
    .chatCompletion({ purpose: "translate", messages }, caller)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.equal((error as { code: string }).code, "FAILED_PRECONDITION");
  assert.match((error as Error).message, /尚未配置任何 AI Provider/);
});

test("首选超时时自动 fallback 到备选，并标记 fallbackUsed", async () => {
  let call = 0;
  const { service, calls } = buildService(async (input) => {
    call += 1;
    if (input.baseUrl.includes("dashscope")) {
      throw new AiProviderError("TIMEOUT", "模型调用超时（5000ms）");
    }
    return { content: "备选译文", promptTokens: 10, completionTokens: 5 };
  });

  const result = await service.chatCompletion({ purpose: "translate", messages }, caller);
  assert.equal(call, 2);
  assert.equal(result.provider, "openai");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.content, "备选译文");
  assert.equal(calls.length, 2);
});

test("provider 报错同样触发 fallback；全部失败则 503", async () => {
  const { service } = buildService(async () => {
    throw new AiProviderError("HTTP", "模型返回 500：boom", 500);
  });
  const error = await service
    .chatCompletion({ purpose: "translate", messages }, caller)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.equal((error as { code: string }).code, "PROVIDER_UNAVAILABLE");
});

test("没有备选时不 fallback，失败即失败", async () => {
  const { service, calls } = buildService(async () => {
    throw new AiProviderError("NETWORK", "连不上");
  });
  await service
    .chatCompletion({ purpose: "vision-ocr", messages }, caller)
    .catch(() => null);
  assert.equal(calls.length, 1);
});

test("连续失败到阈值后该 provider 被标记降级，且在有备选时被跳过", async () => {
  let dashscopeCalls = 0;
  const { service } = buildService(async (input) => {
    if (input.baseUrl.includes("dashscope")) {
      dashscopeCalls += 1;
      throw new AiProviderError("HTTP", "500", 500);
    }
    return { content: "ok", promptTokens: 1, completionTokens: 1 };
  });

  await service.chatCompletion({ purpose: "translate", messages }, caller);
  await service.chatCompletion({ purpose: "translate", messages }, caller);
  const before = dashscopeCalls;
  // 阈值为 2，此时已降级：后续请求直接走备选，不再拿用户请求去试错
  const third = await service.chatCompletion({ purpose: "translate", messages }, caller);
  assert.equal(dashscopeCalls, before);
  assert.equal(third.provider, "openai");

  const status = service.listProviders().find((p) => p.providerId === "dashscope")!;
  assert.equal(status.health, "DEGRADED");
  assert.ok(status.consecutiveFailures >= 2);
});

test("限流按调用方计数，超出返回 RATE_LIMITED", async () => {
  const { service } = buildService(okReply, { AI_RATE_LIMIT_PER_MINUTE: "2" });
  await service.chatCompletion({ purpose: "translate", messages }, caller);
  await service.chatCompletion({ purpose: "translate", messages }, caller);
  const error = await service
    .chatCompletion({ purpose: "translate", messages }, caller)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.equal((error as { code: string }).code, "RATE_LIMITED");

  // 换一个调用方不受影响
  const other = await service.chatCompletion(
    { purpose: "translate", messages },
    { clientId: "softwarelist", actorId: null },
  );
  assert.equal(other.content, "译文");
});

test("请求侧 timeoutMs 不能超过平台上限", async () => {
  const { service, calls } = buildService(okReply);
  await service.chatCompletion(
    { purpose: "translate", messages, timeoutMs: 999_999 },
    caller,
  );
  assert.equal(calls[0]!.timeoutMs, 5000);
});

test("Provider 状态不暴露任何 Key，只报有没有配", () => {
  const { service } = buildService(okReply);
  const providers = service.listProviders();
  const serialized = JSON.stringify(providers);

  assert.ok(!serialized.includes("sk-dashscope-secret"), "响应里不得出现 Key");
  assert.ok(!serialized.includes("sk-openai-secret"), "响应里不得出现 Key");

  const dashscope = providers.find((p) => p.providerId === "dashscope")!;
  assert.equal(dashscope.hasApiKey, true);
  assert.equal(dashscope.apiKeyEnvName, "AI_KEY_DASHSCOPE");
  assert.equal(
    providers.find((p) => p.providerId === "unconfigured")!.health,
    "UNCONFIGURED",
  );
});

test("用量落库，可按调用方与模型汇总", async () => {
  const { service } = buildService(okReply);
  await service.chatCompletion(
    { purpose: "translate", messages, metadata: { entity: "course" } },
    { clientId: "usage-test", actorId: "u9" },
  );
  const summary = await service.getUsageSummary({});
  const bucket = summary.buckets.find((b) => b.clientId === "usage-test")!;
  assert.ok(bucket);
  assert.equal(bucket.provider, "dashscope");
  assert.equal(bucket.model, "qwen-plus");
  assert.equal(bucket.promptTokens, 100);
  assert.ok(summary.totals.calls >= 1);
});

test("失败调用也记账，便于看清是谁在烧钱又失败", async () => {
  const { service } = buildService(async () => {
    throw new AiProviderError("HTTP", "429", 429);
  });
  await service
    .chatCompletion({ purpose: "vision-ocr", messages }, { clientId: "fail-test", actorId: null })
    .catch(() => null);
  const summary = await service.getUsageSummary({});
  const bucket = summary.buckets.find((b) => b.clientId === "fail-test")!;
  assert.equal(bucket.failedCalls, 1);
});

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

test("AI 接口需要服务凭证", async () => {
  const res = await ctx.request("/v1/ai/providers", { token: "" });
  assert.equal(res.status, 401);
});

test("管理面接口返回的 JSON 里不含任何 Key", async () => {
  const res = await ctx.request("/v1/ai/providers");
  assert.equal(res.status, 200);
  const text = await res.clone().text();
  assert.ok(!text.includes("sk-dashscope-secret"));
  assert.ok(!text.includes("sk-openai-secret"));
  const body = await json<ListAiProvidersResponse>(res);
  assert.equal(body.providers.length, 3);
});

test("路由表可查，未配置的用途 resolved 为 null", async () => {
  const res = await ctx.request("/v1/ai/routes");
  const body = await json<ListAiRoutesResponse>(res);
  assert.equal(body.defaultModel, "dashscope/qwen-plus");
  assert.equal(body.routes.find((r) => r.purpose === "translate")!.resolved, "dashscope/qwen-plus");
  assert.equal(body.routes.find((r) => r.purpose === "general")!.resolved, null);
});

test("purpose 与 model 都不给要 400", async () => {
  const res = await ctx.request("/v1/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  assert.equal(res.status, 400);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "INVALID_REQUEST");
});

test("messages 为空要 400", async () => {
  const res = await ctx.request("/v1/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "translate", messages: [] }),
  });
  assert.equal(res.status, 400);
});

test("用量接口可查，时间参数非法要 400", async () => {
  assert.equal((await ctx.request("/v1/ai/usage")).status, 200);
  const summary = await json<AiUsageSummaryResponse>(await ctx.request("/v1/ai/usage"));
  assert.ok(Array.isArray(summary.buckets));
  assert.equal((await ctx.request("/v1/ai/usage?from=不是时间")).status, 400);
});

test("真实走一遍 HTTP：没配 Provider 的测试实例返回可操作的 412", async () => {
  const bare = await createTestApp({ AI_PROVIDERS: "", AI_ROUTES: "", AI_DEFAULT_MODEL: "" });
  const res = await bare.request("/v1/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "translate", messages }),
  });
  assert.equal(res.status, 412);
  const body = await json<PlatformErrorBody>(res);
  assert.equal(body.error.code, "FAILED_PRECONDITION");
  await bare.close();
});

test("响应里带 requestId，可与 platform 日志对账", async () => {
  const { service } = buildService(okReply);
  const result: AiChatResponse = await service.chatCompletion(
    { purpose: "translate", messages },
    caller,
  );
  assert.match(result.requestId, /^ai_[0-9a-f]+$/);
  assert.ok(result.latencyMs >= 0);
});
