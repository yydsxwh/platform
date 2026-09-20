/**
 * platform 应用装配。
 *
 * 模块化单体：一个进程、一个库，模块之间只通过各自的 Service 交互，
 * HTTP 层薄到可以随时换掉。规模真的上来了再按模块拆进程，现在不提前微服务化。
 */

import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";

import { PLATFORM_API_VERSION } from "@yydsxwh/shared/contracts/version";

import type { PlatformConfig } from "./config";
import {
  errorResponse,
  requestIdMiddleware,
  serviceAuthMiddleware,
  type AppEnv,
} from "./http/context";
import { PlatformError } from "./errors";
import { createCatalogRouter } from "./http/routes/catalog";
import { createReleaseRouter } from "./http/routes/releases";
import {
  createLocalObjectRouter,
  createStorageRouter,
} from "./http/routes/storage";
import { CatalogService } from "./modules/catalog/service";
import { ReleaseService } from "./modules/releases/service";
import { AliyunOssAdapter } from "./modules/storage/providers/aliyun-oss";
import { LocalStorageAdapter } from "./modules/storage/providers/local";
import { deriveLocalSigningKey } from "./modules/storage/providers/signing";
import type { StorageAdapter } from "./modules/storage/providers/types";
import { StorageService } from "./modules/storage/service";

export type PlatformServices = {
  storage: StorageService;
  catalog: CatalogService;
  releases: ReleaseService;
};

export type BuiltApp = {
  app: Hono<AppEnv>;
  services: PlatformServices;
  db: PrismaClient;
};

export function buildStorageAdapter(config: PlatformConfig): {
  adapter: StorageAdapter;
  local: { adapter: LocalStorageAdapter; signingKey: string } | null;
} {
  if (config.env.STORAGE_DEFAULT_PROVIDER === "ALIYUN_OSS") {
    if (!config.oss) throw new Error("OSS 配置缺失");
    return { adapter: new AliyunOssAdapter(config.oss), local: null };
  }
  const signingKey = deriveLocalSigningKey(config.serviceTokens.values());
  const adapter = new LocalStorageAdapter({
    root: config.env.STORAGE_LOCAL_ROOT,
    publicBaseUrl: config.env.STORAGE_LOCAL_PUBLIC_BASE_URL,
    signingKey,
  });
  return { adapter, local: { adapter, signingKey } };
}

export function buildApp(input: {
  config: PlatformConfig;
  db: PrismaClient;
}): BuiltApp {
  const { config, db } = input;
  const { adapter, local } = buildStorageAdapter(config);
  const storage = new StorageService(db, adapter);
  const catalog = new CatalogService(db);
  const releases = new ReleaseService(db, storage);

  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware());

  app.onError((error, c) => errorResponse(c as never, error));
  app.notFound((c) => errorResponse(c as never, new PlatformError("NOT_FOUND", "接口不存在")));

  // 健康检查不鉴权：给反代和进程守护用
  app.get("/healthz", (c) =>
    c.json({ ok: true, version: PLATFORM_API_VERSION, provider: adapter.provider }),
  );

  // 本地对象端点靠 URL 签名自证，不能要求浏览器带服务凭证
  if (local) {
    app.route(
      `/${PLATFORM_API_VERSION}/storage/local-objects`,
      createLocalObjectRouter({ storage, adapter: local.adapter, signingKey: local.signingKey }),
    );
  }

  const api = new Hono<AppEnv>();
  api.use("*", serviceAuthMiddleware(config));
  api.route("/storage", createStorageRouter({ storage, local }));
  api.route("/catalog", createCatalogRouter({ catalog }));
  api.route("/", createReleaseRouter({ releases }));

  app.route(`/${PLATFORM_API_VERSION}`, api);

  return { app, services: { storage, catalog, releases }, db };
}
