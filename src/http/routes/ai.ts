/**
 * AI HTTP 层。
 *
 * 管理面（providers / routes / usage）返回的内容**不含任何 Key**，
 * 只报有没有配、来自哪个环境变量名，供 Studio 展示与排查。
 */

import { Hono } from "hono";
import { z } from "zod";

import { AI_PURPOSES } from "@yydsxwh/shared/contracts/ai";

import type { AppEnv } from "../context";
import { failedPrecondition, invalidRequest } from "../../errors";
import type { AiService } from "../../modules/ai/service";
import type { AiSettingsStore } from "../../modules/ai/settings-store";
import { parseJsonBody } from "./shared";

const contentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string().min(1) }),
  }),
]);

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(contentPartSchema).min(1)]),
});

const chatSchema = z
  .object({
    purpose: z.enum(AI_PURPOSES).optional(),
    model: z.string().max(200).optional(),
    messages: z.array(messageSchema).min(1).max(100),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => Boolean(v.purpose || v.model), {
    message: "purpose 与 model 至少给一个",
  });

const modelSchema = z.object({
  id: z.string().min(1).max(120),
  vision: z.boolean().default(false),
  costPerMillionInputMicros: z.number().int().nonnegative().nullable().default(null),
  costPerMillionOutputMicros: z.number().int().nonnegative().nullable().default(null),
});

const providerSchema = z.object({
  id: z.string().min(2).max(32),
  label: z.string().max(80).optional(),
  baseUrl: z.string().url(),
  /** 省略 = 保留原 Key；空串 = 清空。响应里永远不回显。 */
  apiKey: z.string().max(400).nullable().optional(),
  models: z.array(modelSchema).min(1).max(40),
  enabled: z.boolean().optional(),
});

const configSchema = z.object({
  providers: z.array(providerSchema).max(20).optional(),
  removeProviders: z.array(z.string().min(1)).max(20).optional(),
  // 只改传上来的用途，没传的保持原样，所以不能要求键齐全
  routes: z.record(z.string(), z.array(z.string().min(1)).max(8)).optional(),
});

function asPurpose(raw: string): (typeof AI_PURPOSES)[number] {
  if (!(AI_PURPOSES as readonly string[]).includes(raw)) {
    throw invalidRequest(`未知的 AI 用途：${raw}`);
  }
  return raw as (typeof AI_PURPOSES)[number];
}

const testSchema = z.object({
  purpose: z.enum(AI_PURPOSES).default("general"),
  mode: z.enum(["text", "image"]).default("text"),
});

export function createAiRouter(deps: { ai: AiService; settings: AiSettingsStore | null }) {
  const router = new Hono<AppEnv>();

  router.post("/chat", async (c) => {
    const body = await parseJsonBody(chatSchema, c.req.raw);
    return c.json(await deps.ai.chatCompletion(body, c.get("caller")));
  });

  router.get("/providers", async (c) => {
    await deps.ai.refresh(true);
    return c.json({ providers: deps.ai.listProviders() });
  });

  router.get("/routes", async (c) => {
    await deps.ai.refresh(true);
    return c.json(deps.ai.listRoutes());
  });

  /**
   * 统一配置控制面。主站后台「系统设置 → AI 接口」在服务端调这里，
   * 浏览器拿不到服务令牌，也拿不到任何 Key。
   */
  router.get("/config", async (c) => {
    await deps.ai.refresh(true);
    const routes = deps.ai.listRoutes();
    return c.json({
      persistence: deps.settings?.canPersistKeys ? "DATABASE" : "ENV_ONLY",
      providers: deps.ai.listProviders(),
      ...routes,
    });
  });

  router.put("/config", async (c) => {
    if (!deps.settings) {
      throw failedPrecondition("platform 未开启可写 AI 配置");
    }
    const body = await parseJsonBody(configSchema, c.req.raw);
    for (const provider of body.providers ?? []) {
      await deps.settings.upsertProvider(provider);
    }
    for (const id of body.removeProviders ?? []) {
      await deps.settings.deleteProvider(id);
    }
    // 先把 provider 落库再校验路由，否则刚加的视觉模型会被误判成未知
    await deps.ai.refresh(true);
    const pending = Object.entries(body.routes ?? {}).map(
      ([purpose, candidates]) => [asPurpose(purpose), candidates ?? []] as const,
    );
    // 全部校验通过才写，避免一半成功一半失败把好配置改坏
    for (const [purpose, candidates] of pending) deps.ai.assertRouteUsable(purpose, candidates);
    for (const [purpose, candidates] of pending) await deps.settings.setRoute(purpose, candidates);
    await deps.ai.refresh(true);
    const routes = deps.ai.listRoutes();
    return c.json({
      persistence: "DATABASE",
      providers: deps.ai.listProviders(),
      ...routes,
    });
  });

  router.post("/test", async (c) => {
    const body = await parseJsonBody(testSchema, c.req.raw);
    const result = await deps.ai.selfTest(body, c.get("caller"));
    return c.json({
      ok: true,
      mode: body.mode,
      purpose: body.purpose,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      // 只回显模型输出的前 200 字，够判断通没通，又不至于把长文塞进后台
      sample: result.content.slice(0, 200),
    });
  });

  router.get("/usage", async (c) => {
    const query = c.req.query();
    return c.json(
      await deps.ai.getUsageSummary({ from: query.from, to: query.to }),
    );
  });

  return router;
}
