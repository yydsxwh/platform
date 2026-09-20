/**
 * 环境配置。
 *
 * 密钥只从环境变量读，绝不写进代码或提交进 Git。
 * 启动时一次性校验：配置缺失要在启动就炸，而不是等第一个请求才 500。
 */

import { z } from "zod";

import {
  parseServiceScopes,
  type PlatformServiceScope,
  type ServiceCredential,
} from "@yydsxwh/shared/contracts/service";

import { loadAiConfig, type AiConfig } from "./modules/ai/config";

const serviceTokenEntry = /^([a-z0-9][a-z0-9_-]*):(.+)$/i;
const scopeTail = /^(\*|all|[a-z]+(?:\+[a-z]+)*)$/i;

export type { ServiceCredential };

/**
 * 服务凭证：`clientId:token` 或以 `clientId:token:ai+storage` 收紧权限。
 * 同一 clientId 可登记多把 token，用于轮换：先加新的，再撤旧的。
 * 吊销：从本变量去掉该 token 并重启。
 */
export function parseServiceTokens(raw: string): ServiceCredential[] {
  const list: ServiceCredential[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const matched = serviceTokenEntry.exec(trimmed);
    if (!matched) {
      throw new Error(
        "PLATFORM_SERVICE_TOKENS 格式应为 clientId:token 或 clientId:token:scopes，多个用逗号分隔",
      );
    }
    const clientId = matched[1]!.toLowerCase();
    const rest = matched[2]!;
    const lastColon = rest.lastIndexOf(":");
    let token = rest;
    let scopeRaw: string | undefined;
    if (lastColon >= 0) {
      const maybeScopes = rest.slice(lastColon + 1);
      if (scopeTail.test(maybeScopes)) {
        token = rest.slice(0, lastColon);
        scopeRaw = maybeScopes;
      }
    }
    if (token.length < 24) {
      throw new Error(`调用方 ${clientId} 的服务凭证过短，至少 24 位`);
    }
    list.push({
      clientId,
      token,
      scopes: parseServiceScopes(scopeRaw),
    });
  }
  return list;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  PLATFORM_SERVICE_TOKENS: z.string().min(1),

  /** 默认存储后端；namespace 可单独覆盖 */
  STORAGE_DEFAULT_PROVIDER: z.enum(["LOCAL", "ALIYUN_OSS"]).default("LOCAL"),
  /** LOCAL provider 的落盘根目录 */
  STORAGE_LOCAL_ROOT: z.string().default("./data/files"),
  /** LOCAL provider 对外可访问的基地址，用于拼下载链接 */
  STORAGE_LOCAL_PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:4000"),
  /**
   * 本地签名专用密钥。推荐与 service token 分开，避免轮换 token 时已发出的
   * 短时 URL 全部失效。未设置时仍从全部 service token 派生（兼容旧行为）。
   */
  STORAGE_LOCAL_SIGNING_KEY: z.string().optional(),

  OSS_ACCESS_KEY_ID: z.string().optional(),
  OSS_ACCESS_KEY_SECRET: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_REGION: z.string().default("cn-hongkong"),
  /** 留空则用 `{bucket}.oss-{region}.aliyuncs.com` */
  OSS_ENDPOINT: z.string().optional(),
  /** 自定义域名 / CDN；留空用 Bucket 虚拟主机域名 */
  OSS_PUBLIC_BASE_URL: z.string().optional(),
  /** 大文件下载走传输加速域名 */
  OSS_ACCELERATE_ENABLED: z.coerce.boolean().default(false),

  /** 签发给产品的履约事件签名密钥 */
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  /** 生产必须为 false，否则任何人都能把订单标成已付 */
  PAYMENT_ALLOW_MOCK: z.coerce.boolean().default(false),

  /**
   * 预留：account issuer。本轮不实现 assertion 验签。
   * NEEDS_ACCOUNT_INTEGRATION
   */
  ACCOUNT_ISSUER: z.string().optional(),
  ACCOUNT_JWKS_URI: z.string().optional(),
  ACCOUNT_AUDIENCE: z.string().optional(),
});

export type PlatformEnv = z.infer<typeof envSchema>;

export type OssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint: string;
  publicBaseUrl: string;
  accelerateEnabled: boolean;
};

export type PlatformConfig = {
  env: PlatformEnv;
  /** AI Provider、路由与限流；同样在启动时校验，坏配置不留到第一个请求 */
  ai: AiConfig;
  isProduction: boolean;
  serviceCredentials: ServiceCredential[];
  oss: OssConfig | null;
  paymentWebhookSecret: string | null;
  allowMockPayments: boolean;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`platform 环境变量不合法：${issues}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";
  const serviceCredentials = parseServiceTokens(env.PLATFORM_SERVICE_TOKENS);
  if (serviceCredentials.length === 0) {
    throw new Error("PLATFORM_SERVICE_TOKENS 至少要配置一个调用方");
  }

  const oss = buildOssConfig(env);
  if (env.STORAGE_DEFAULT_PROVIDER === "ALIYUN_OSS" && !oss) {
    throw new Error("默认存储为 ALIYUN_OSS，但 OSS 的 AccessKey / Bucket 未配置完整");
  }
  // mock 支付会让「付款成功」变成一句话的事，生产开着等于白送
  if (isProduction && env.PAYMENT_ALLOW_MOCK) {
    throw new Error("生产环境禁止开启 PAYMENT_ALLOW_MOCK");
  }

  return {
    env,
    ai: loadAiConfig(source),
    isProduction,
    serviceCredentials,
    oss,
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET || null,
    allowMockPayments: env.PAYMENT_ALLOW_MOCK,
  };
}

export function listServiceClientIds(config: PlatformConfig): string[] {
  return [...new Set(config.serviceCredentials.map((c) => c.clientId))];
}

export function credentialTokens(config: PlatformConfig): string[] {
  return config.serviceCredentials.map((c) => c.token);
}

export function hasScope(
  scopes: readonly PlatformServiceScope[],
  needed: PlatformServiceScope,
): boolean {
  return scopes.includes(needed);
}

function buildOssConfig(env: PlatformEnv): OssConfig | null {
  const accessKeyId = env.OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET?.trim();
  const bucket = env.OSS_BUCKET?.trim();
  if (!accessKeyId || !accessKeySecret || !bucket) return null;
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region: env.OSS_REGION.trim().replace(/^oss-/, "") || "cn-hongkong",
    endpoint: (env.OSS_ENDPOINT || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, ""),
    publicBaseUrl: (env.OSS_PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),
    accelerateEnabled: env.OSS_ACCELERATE_ENABLED,
  };
}
