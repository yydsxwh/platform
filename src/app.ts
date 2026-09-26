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
import { credentialTokens } from "./config";
import {
  errorResponse,
  requestIdMiddleware,
  scopeGuardMiddleware,
  serviceAuthMiddleware,
  type AppEnv,
} from "./http/context";
import { createHealthRouter } from "./http/health";
import { requestLogMiddleware } from "./http/request-log";
import { PlatformError } from "./errors";
import { createAiRouter } from "./http/routes/ai";
import { createCatalogRouter } from "./http/routes/catalog";
import {
  createPaymentRouter,
  createPaymentWebhookRouter,
} from "./http/routes/payments";
import { createReleaseRouter } from "./http/routes/releases";
import {
  createLocalObjectRouter,
  createStorageRouter,
} from "./http/routes/storage";
import { AiService } from "./modules/ai/service";
import { AiSettingsStore } from "./modules/ai/settings-store";
import { CatalogService } from "./modules/catalog/service";
import { MockPaymentAdapter } from "./modules/payments/providers/mock";
import {
  PaymentService,
  type PaymentProviderAdapter,
} from "./modules/payments/service";
import { ReleaseService } from "./modules/releases/service";
import { AliyunOssAdapter } from "./modules/storage/providers/aliyun-oss";
import { LocalStorageAdapter } from "./modules/storage/providers/local";
import { deriveLocalSigningKey } from "./modules/storage/providers/signing";
import type { StorageAdapter } from "./modules/storage/providers/types";
import { StorageService } from "./modules/storage/service";

export type PlatformServices = {
  ai: AiService;
  storage: StorageService;
  catalog: CatalogService;
  releases: ReleaseService;
  payments: PaymentService;
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
  const signingKey =
    config.env.STORAGE_LOCAL_SIGNING_KEY?.trim() ||
    deriveLocalSigningKey(credentialTokens(config));
  const adapter = new LocalStorageAdapter({
    root: config.env.STORAGE_LOCAL_ROOT,
    publicBaseUrl: config.env.STORAGE_LOCAL_PUBLIC_BASE_URL,
    signingKey,
  });
  return { adapter, local: { adapter, signingKey } };
}

/**
 * 目前只有 mock 渠道在本仓库实现：微信与支付宝的服务端实现仍在主站，
 * 迁移要连同商户证书与回调域名一起切，属于独立一步。
 * 这里先把核心流程（幂等、验签、金额核对、履约事件）做实，渠道按需接。
 */
function buildPaymentAdapters(
  config: PlatformConfig,
): Map<"WECHAT" | "ALIPAY" | "MOCK", PaymentProviderAdapter> {
  const adapters = new Map<"WECHAT" | "ALIPAY" | "MOCK", PaymentProviderAdapter>();
  if (config.allowMockPayments && config.paymentWebhookSecret) {
    adapters.set("MOCK", new MockPaymentAdapter(config.paymentWebhookSecret));
  }
  return adapters;
}

export function buildApp(input: {
  config: PlatformConfig;
  db: PrismaClient;
}): BuiltApp {
  const { config, db } = input;
  const { adapter, local } = buildStorageAdapter(config);
  const storage = new StorageService(db, adapter);
  const aiSettings = new AiSettingsStore(db, config.ai, config.configEncryptionKey);
  const ai = new AiService(db, config.ai, undefined, aiSettings);
  const catalog = new CatalogService(db);
  const releases = new ReleaseService(db, storage);
  const payments = new PaymentService(
    db,
    buildPaymentAdapters(config),
    config.paymentWebhookSecret,
  );

  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", requestLogMiddleware());

  app.onError((error, c) => errorResponse(c as never, error));
  app.notFound((c) => errorResponse(c as never, new PlatformError("NOT_FOUND", "接口不存在")));

  // 探活 / 就绪不鉴权：给反代和进程守护用。AI Provider 异常不影响 /health。
  app.route("/", createHealthRouter({ db, config }));

  // 渠道回调带的是渠道自己的签名，不可能带我们的服务凭证
  app.route(
    `/${PLATFORM_API_VERSION}/payment-webhooks`,
    createPaymentWebhookRouter({ payments }),
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
  api.use("*", scopeGuardMiddleware());
  api.route("/ai", createAiRouter({ ai, settings: aiSettings }));
  api.route("/storage", createStorageRouter({ storage, local }));
  api.route("/catalog", createCatalogRouter({ catalog }));
  api.route("/payments", createPaymentRouter({ payments }));
  api.route("/", createReleaseRouter({ releases }));

  app.route(`/${PLATFORM_API_VERSION}`, api);

  return { app, services: { ai, storage, catalog, releases, payments }, db };
}
