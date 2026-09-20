/**
 * 集成测试脚手架：每个用例一套独立的 SQLite 文件与本地存储目录，
 * 用例之间互不串数据，也不碰任何真实环境。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";

import { buildApp, type PlatformServices } from "../../src/app";
import { loadConfig, type PlatformConfig } from "../../src/config";
import type { AppEnv } from "../../src/http/context";

export const TEST_TOKEN_ANDYYYDS = "test-token-andyyyds-0123456789abcdef";
export const TEST_TOKEN_SOFTWARELIST = "test-token-softwarelist-0123456789ab";

export type TestApp = {
  app: Hono<AppEnv>;
  services: PlatformServices;
  db: PrismaClient;
  config: PlatformConfig;
  dir: string;
  /** 带上默认服务凭证与 actor 的请求助手 */
  request(
    path: string,
    init?: RequestInit & { token?: string; actor?: string | null },
  ): Promise<Response>;
  close(): Promise<void>;
};

let schemaTemplate: string | null = null;

/** 第一次运行时用 prisma db push 生成一份库模板，后续用例直接拷贝，避免每次都跑 push */
function ensureSchemaTemplate(): string {
  if (schemaTemplate) return schemaTemplate;
  const dir = mkdtempSync(path.join(tmpdir(), "platform-schema-"));
  const dbPath = path.join(dir, "template.db");
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "pipe",
    },
  );
  schemaTemplate = dbPath;
  return dbPath;
}

export async function createTestApp(
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  const template = ensureSchemaTemplate();
  const dir = mkdtempSync(path.join(tmpdir(), "platform-test-"));
  const dbPath = path.join(dir, "test.db");
  const { copyFileSync } = await import("node:fs");
  copyFileSync(template, dbPath);

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: `file:${dbPath}`,
    PLATFORM_SERVICE_TOKENS: `andyyyds:${TEST_TOKEN_ANDYYYDS},softwarelist:${TEST_TOKEN_SOFTWARELIST}`,
    STORAGE_DEFAULT_PROVIDER: "LOCAL",
    STORAGE_LOCAL_ROOT: path.join(dir, "files"),
    STORAGE_LOCAL_PUBLIC_BASE_URL: "http://platform.test",
    PAYMENT_ALLOW_MOCK: "true",
    PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
    ...overrides,
  } as NodeJS.ProcessEnv);

  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  const { app, services } = buildApp({ config, db });

  return {
    app,
    services,
    db,
    config,
    dir,
    async request(reqPath, init = {}) {
      const { token, actor, headers, ...rest } = init;
      const merged = new Headers(headers);
      if (token !== undefined) {
        if (token) merged.set("authorization", `Bearer ${token}`);
      } else {
        merged.set("authorization", `Bearer ${TEST_TOKEN_ANDYYYDS}`);
      }
      if (actor) merged.set("x-platform-actor", actor);
      const url = reqPath.startsWith("http") ? reqPath : `http://platform.test${reqPath}`;
      return app.fetch(new Request(url, { ...rest, headers: merged }));
    },
    async close() {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
