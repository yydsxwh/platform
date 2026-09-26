import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { createTestApp, json, type TestApp } from "./helpers/app";
import type { HealthBody, ReadyBody } from "../src/http/health";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

test("GET /health 不鉴权，进程活着即 200", async () => {
  const res = await ctx.request("/health", { token: "" });
  assert.equal(res.status, 200);
  const body = await json<HealthBody>(res);
  assert.equal(body.ok, true);
  assert.equal(body.status, "alive");
  assert.equal(body.version, "v1");
});

test("GET /healthz 仍是探活别名", async () => {
  const res = await ctx.request("/healthz", { token: "" });
  assert.equal(res.status, 200);
  const body = await json<HealthBody>(res);
  assert.equal(body.status, "alive");
});

test("AI 未配置时 /health 仍 200，模块状态单独标 unavailable", async () => {
  const res = await ctx.request("/health", { token: "" });
  assert.equal(res.status, 200);
  const modules = await ctx.request("/health/modules", { token: "" });
  assert.equal(modules.status, 200);
  const body = await json<import("../src/http/health").ModuleStatusBody>(modules);
  assert.equal(body.service, "platform");
  assert.equal(body.modules.ai, "unavailable");
  assert.equal(body.modules.storage, "ok");
  assert.equal(body.modules.payments, "ok");
  assert.equal(body.modules.notification, "not_in_this_process");
});

test("GET /ready 在数据库可用时 200，且不含 AI Provider 检查", async () => {
  const res = await ctx.request("/ready", { token: "" });
  assert.equal(res.status, 200);
  const body = await json<ReadyBody>(res);
  assert.equal(body.ok, true);
  assert.equal(body.status, "ready");
  assert.equal(body.checks.database, "ok");
  assert.equal(body.checks.storageConfig, "ok");
  assert.equal("ai" in body.checks, false);
});
