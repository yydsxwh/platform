import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { createTestApp, json, type TestApp } from "./helpers/app";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp({
    PLATFORM_CONFIG_ENCRYPTION_KEY:
      "6f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  });
});

after(async () => {
  await ctx.close();
});

async function putConfig(body: unknown) {
  return ctx.request("/v1/ai/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("后台可以在线登记 provider，响应只给 hasApiKey 不回显 Key", async () => {
  const secret = "sk-test-vision-key-should-never-leak";
  const res = await putConfig({
    providers: [
      {
        id: "dashscope",
        label: "阿里云百炼",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: secret,
        models: [
          { id: "qwen-vl-max", vision: true },
          { id: "qwen-plus", vision: false },
        ],
      },
    ],
    routes: { "vision-ocr": ["dashscope/qwen-vl-max"], translate: ["dashscope/qwen-plus"] },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.clone().text();
  assert.ok(!text.includes(secret), "响应里出现了明文 API Key");

  const body = await json<{
    persistence: string;
    providers: Array<{ providerId: string; hasApiKey: boolean }>;
    routes: Array<{ purpose: string; resolved: string | null }>;
  }>(res);
  assert.equal(body.persistence, "DATABASE");
  const provider = body.providers.find((p) => p.providerId === "dashscope");
  assert.ok(provider);
  assert.equal(provider.hasApiKey, true);
  const vision = body.routes.find((r) => r.purpose === "vision-ocr");
  assert.equal(vision?.resolved, "dashscope/qwen-vl-max");
});

test("纯文本模型不允许被配成 vision-ocr 路由", async () => {
  const res = await putConfig({ routes: { "vision-ocr": ["dashscope/qwen-plus"] } });
  assert.equal(res.status, 400, await res.clone().text());
  const body = await json<{ error: { message: string } }>(res);
  assert.match(body.error.message, /纯文本模型/);

  // 被拒之后原来的视觉路由必须还在，不能把好配置改坏
  const after = await json<{ routes: Array<{ purpose: string; resolved: string | null }> }>(
    await ctx.request("/v1/ai/config"),
  );
  assert.equal(
    after.routes.find((r) => r.purpose === "vision-ocr")?.resolved,
    "dashscope/qwen-vl-max",
  );
});

test("再次保存可以省略 apiKey，不会把已有 Key 清掉", async () => {
  const res = await putConfig({
    providers: [
      {
        id: "dashscope",
        label: "阿里云百炼",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [{ id: "qwen-vl-max", vision: true }],
      },
    ],
  });
  assert.equal(res.status, 200);
  const body = await json<{ providers: Array<{ providerId: string; hasApiKey: boolean }> }>(res);
  assert.equal(body.providers.find((p) => p.providerId === "dashscope")?.hasApiKey, true);
});

test("GET /v1/ai/config 同样不泄露 Key", async () => {
  const res = await ctx.request("/v1/ai/config");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes("sk-test-vision-key"), "配置查询回显了 Key");
  assert.ok(text.includes('"hasApiKey":true'));
});
