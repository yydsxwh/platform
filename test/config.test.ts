import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_ISSUER,
  ACCOUNT_JWKS_URI,
  PLATFORM_RESOURCE_AUDIENCE,
} from "@yydsxwh/shared/contracts/identity";

import { loadConfig } from "../src/config";

function minimalEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "file:./tmp-config-test.db",
    PLATFORM_SERVICE_TOKENS: "andyyyds:test-token-andyyyds-0123456789abcdef",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

test("Owner 拍板的公开标识是配置默认值，不是 Secret", () => {
  const config = loadConfig(minimalEnv());
  assert.equal(config.env.HOST, "127.0.0.1");
  assert.equal(config.env.PORT, 4000);
  assert.equal(config.env.ACCOUNT_ISSUER, ACCOUNT_ISSUER);
  assert.equal(config.env.ACCOUNT_JWKS_URI, ACCOUNT_JWKS_URI);
  assert.equal(config.env.ACCOUNT_AUDIENCE, PLATFORM_RESOURCE_AUDIENCE);
  assert.equal(ACCOUNT_ISSUER, "https://account.yydsxwh.com");
  assert.equal(PLATFORM_RESOURCE_AUDIENCE, "https://api.yydsxwh.com");
});

test("预发域名与 audience 不是产品 client_id", () => {
  const config = loadConfig(minimalEnv());
  assert.notEqual(config.env.ACCOUNT_AUDIENCE, "andyyyds");
  assert.notEqual(config.env.ACCOUNT_AUDIENCE, "softwarelist");
  assert.notEqual(config.env.ACCOUNT_AUDIENCE, "rishi");
  assert.equal(config.env.ACCOUNT_AUDIENCE, "https://api.yydsxwh.com");
});
