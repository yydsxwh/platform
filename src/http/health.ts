/**
 * 进程探活与就绪。
 *
 * /health  —— 进程活着即可 200。外部 AI Provider 异常不得拖死探活。
 * /ready   —— 本进程依赖的本地设施已就绪（当前是数据库）。
 * /healthz —— 兼容别名，语义同 /health。
 */

import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";

import { PLATFORM_API_VERSION } from "@yydsxwh/shared/contracts/version";

import type { PlatformConfig } from "../config";
import type { AppEnv } from "./context";

export type HealthBody = {
  ok: true;
  status: "alive";
  version: typeof PLATFORM_API_VERSION;
  storageProvider: string;
};

export type ReadyCheck = "ok" | "error";

export type ReadyBody = {
  ok: boolean;
  status: "ready" | "not_ready";
  version: typeof PLATFORM_API_VERSION;
  checks: {
    database: ReadyCheck;
    storageConfig: ReadyCheck;
  };
};

export async function checkDatabase(db: PrismaClient): Promise<ReadyCheck> {
  try {
    await db.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

export function checkStorageConfig(config: PlatformConfig): ReadyCheck {
  if (config.env.STORAGE_DEFAULT_PROVIDER === "ALIYUN_OSS") {
    return config.oss ? "ok" : "error";
  }
  return config.env.STORAGE_LOCAL_ROOT ? "ok" : "error";
}

export function createHealthRouter(deps: {
  db: PrismaClient;
  config: PlatformConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const health = (c: { json: (body: HealthBody, status?: 200) => Response }) =>
    c.json({
      ok: true,
      status: "alive",
      version: PLATFORM_API_VERSION,
      storageProvider: deps.config.env.STORAGE_DEFAULT_PROVIDER,
    });

  router.get("/health", (c) => health(c));
  router.get("/healthz", (c) => health(c));

  router.get("/ready", async (c) => {
    const database = await checkDatabase(deps.db);
    const storageConfig = checkStorageConfig(deps.config);
    const ok = database === "ok" && storageConfig === "ok";
    const body: ReadyBody = {
      ok,
      status: ok ? "ready" : "not_ready",
      version: PLATFORM_API_VERSION,
      checks: { database, storageConfig },
    };
    return c.json(body, ok ? 200 : 503);
  });

  return router;
}
