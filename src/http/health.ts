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
  service: "platform";
  status: "alive";
  version: typeof PLATFORM_API_VERSION;
  timestamp: string;
  storageProvider: string;
};

export type ModuleAvailability = "ok" | "degraded" | "unavailable" | "not_in_this_process";

export type ModuleStatusBody = {
  service: "platform";
  status: "ok";
  timestamp: string;
  /**
   * 模块状态只描述能力是否就绪，不参与进程探活。
   * AI 没配 Key 时这里是 unavailable，/health 仍然 200。
   */
  modules: {
    ai: ModuleAvailability;
    storage: ModuleAvailability;
    payments: ModuleAvailability;
    catalog: ModuleAvailability;
    releases: ModuleAvailability;
    notification: ModuleAvailability;
    maps: ModuleAvailability;
    media: ModuleAvailability;
  };
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

export function moduleStatus(config: PlatformConfig): ModuleStatusBody["modules"] {
  const aiReady = [...config.ai.providers.values()].some((provider) => provider.apiKey);
  const storageOk = checkStorageConfig(config) === "ok";
  return {
    ai: aiReady ? "ok" : "unavailable",
    storage: storageOk ? "ok" : "unavailable",
    payments: config.paymentWebhookSecret ? "ok" : "degraded",
    catalog: "ok",
    releases: "ok",
    // 通知、地图、媒体仍在主站进程里，这里不假装已经承接。
    notification: "not_in_this_process",
    maps: "not_in_this_process",
    media: "not_in_this_process",
  };
}

export function createHealthRouter(deps: {
  db: PrismaClient;
  config: PlatformConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const health = (c: { json: (body: HealthBody, status?: 200) => Response }) =>
    c.json({
      ok: true,
      service: "platform" as const,
      status: "alive" as const,
      version: PLATFORM_API_VERSION,
      timestamp: new Date().toISOString(),
      storageProvider: deps.config.env.STORAGE_DEFAULT_PROVIDER,
    });

  router.get("/health", (c) => health(c));
  router.get("/healthz", (c) => health(c));

  router.get("/health/modules", (c) => {
    const body: ModuleStatusBody = {
      service: "platform",
      status: "ok",
      timestamp: new Date().toISOString(),
      modules: moduleStatus(deps.config),
    };
    return c.json(body);
  });

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
