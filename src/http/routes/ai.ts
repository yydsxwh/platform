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
import type { AiService } from "../../modules/ai/service";
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

export function createAiRouter(deps: { ai: AiService }) {
  const router = new Hono<AppEnv>();

  router.post("/chat", async (c) => {
    const body = await parseJsonBody(chatSchema, c.req.raw);
    return c.json(await deps.ai.chatCompletion(body, c.get("caller")));
  });

  router.get("/providers", (c) => c.json({ providers: deps.ai.listProviders() }));

  router.get("/routes", (c) => c.json(deps.ai.listRoutes()));

  router.get("/usage", async (c) => {
    const query = c.req.query();
    return c.json(
      await deps.ai.getUsageSummary({ from: query.from, to: query.to }),
    );
  });

  return router;
}
