import { test } from "node:test";
import assert from "node:assert/strict";

import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";

import { loadConfig, parseServiceTokens } from "../src/config";
import {
  TEST_TOKEN_ANDYYYDS,
  createTestApp,
  json,
} from "./helpers/app";

test("同一 client 可登记两把 token，便于轮换", () => {
  const creds = parseServiceTokens(
    "andyyyds:old-token-0123456789abcdef0123,andyyyds:new-token-0123456789abcdef0123",
  );
  assert.equal(creds.length, 2);
  assert.equal(creds[0]!.clientId, "andyyyds");
  assert.equal(creds[1]!.clientId, "andyyyds");
  assert.notEqual(creds[0]!.token, creds[1]!.token);
});

test("可选 scope 收紧模块权限，未写则五个模块全开", () => {
  const open = parseServiceTokens("andyyyds:aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(open[0]!.scopes, ["ai", "storage", "catalog", "releases", "payments"]);

  const tight = parseServiceTokens("rishi:bbbbbbbbbbbbbbbbbbbbbbbb:ai+storage");
  assert.equal(tight[0]!.clientId, "rishi");
  assert.deepEqual(tight[0]!.scopes, ["ai", "storage"]);
});

test("缺少服务凭证时 Actor 头不能让请求通过", async () => {
  const ctx = await createTestApp();
  try {
    const res = await ctx.request("/v1/catalog/products", {
      token: "",
      actor: "usr_someone_else",
    });
    assert.equal(res.status, 401);
    const body = await json<PlatformErrorBody>(res);
    assert.equal(body.error.code, "UNAUTHENTICATED");
  } finally {
    await ctx.close();
  }
});

test("伪造 token 加上别人的 Actor 仍是 401", async () => {
  const ctx = await createTestApp();
  try {
    const res = await ctx.request("/v1/catalog/products", {
      token: "not-a-real-service-token-xxxx",
      actor: "usr_someone_else",
    });
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test("scope 不足时 403，而不是默默当成全公司权限", async () => {
  const ctx = await createTestApp({
    PLATFORM_SERVICE_TOKENS: `andyyyds:${TEST_TOKEN_ANDYYYDS}:catalog`,
  });
  try {
    const denied = await ctx.request("/v1/ai/providers");
    assert.equal(denied.status, 403);
    const body = await json<PlatformErrorBody>(denied);
    assert.equal(body.error.code, "PERMISSION_DENIED");

    const allowed = await ctx.request("/v1/catalog/products");
    assert.equal(allowed.status, 200);
  } finally {
    await ctx.close();
  }
});

test("合法服务凭证通过后才接受 Actor", async () => {
  const ctx = await createTestApp();
  try {
    const res = await ctx.request("/v1/catalog/products", { actor: "usr_demo" });
    assert.equal(res.status, 200);
  } finally {
    await ctx.close();
  }
});

test("默认两把互不相同的 token 分别对应 andyyyds 与 softwarelist", async () => {
  const ctx = await createTestApp();
  try {
    const ids = new Set(ctx.config.serviceCredentials.map((c) => c.clientId));
    assert.deepEqual([...ids].sort(), ["andyyyds", "softwarelist"]);
  } finally {
    await ctx.close();
  }
});

test("生产禁止 mock 支付的规则仍然有效", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "file:./x.db",
        PLATFORM_SERVICE_TOKENS: "andyyyds:0123456789abcdef0123456789abcdef",
        PAYMENT_ALLOW_MOCK: "true",
      } as NodeJS.ProcessEnv),
    /生产环境禁止开启 PAYMENT_ALLOW_MOCK/,
  );
});
