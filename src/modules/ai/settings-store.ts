/**
 * 可在线修改的 AI 配置。
 *
 * 之前 Provider / Key / 路由只来自环境变量，改一次要重启，主站后台也就无法
 * 成为统一控制面。这里把同一份结构落库：环境变量继续作为初始值与兜底，
 * 库里有同名 provider 时以库为准。
 *
 * Key 用 AES-256-GCM 加密存放，明文只在拼 Authorization 头时出现在内存里。
 * 任何响应、任何日志都只给 `hasApiKey`。
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

import { AI_PURPOSES, type AiPurpose } from "@yydsxwh/shared/contracts/ai";
import type { PrismaClient } from "@prisma/client";

import { invalidRequest } from "../../errors";
import { logger } from "../../observability/logger";
import type { AiConfig, AiModelConfig, AiProviderConfig } from "./config";

export type ProviderUpsert = {
  id: string;
  label?: string;
  baseUrl: string;
  /** 明文 Key；缺省表示保留库里已有的那把，空字符串表示清空 */
  apiKey?: string | null;
  models: AiModelConfig[];
  enabled?: boolean;
};

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,31}$/;

function encryptionKey(raw: string | undefined): Buffer {
  const value = (raw || "").trim();
  if (!value) return Buffer.alloc(0);
  // 允许直接给 64 位 hex，也允许给任意口令；都归一成 32 字节
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  return createHash("sha256").update(value).digest();
}

export class AiSettingsStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: PrismaClient,
    private readonly base: AiConfig,
    secret: string | undefined,
  ) {
    this.key = encryptionKey(secret);
  }

  get canPersistKeys(): boolean {
    return this.key.length === 32;
  }

  /** 环境变量配置叠加数据库配置，数据库优先。每次读配置都走这里。 */
  async load(): Promise<AiConfig> {
    const providers = new Map<string, AiProviderConfig>(this.base.providers);
    const routes = new Map<AiPurpose, string[]>(this.base.routes);

    let rows: Array<{
      id: string;
      label: string;
      baseUrl: string;
      apiKeyCipher: string | null;
      models: string;
      enabled: boolean;
    }> = [];
    let routeRows: Array<{ purpose: string; candidates: string }> = [];
    try {
      rows = await this.db.aiProviderSetting.findMany();
      routeRows = await this.db.aiRouteSetting.findMany();
    } catch (error) {
      // 表还没迁移时退回纯环境变量配置，而不是让所有 AI 调用 500
      logger.warn("ai", "读取 AI 配置表失败，暂时只用环境变量", {
        message: (error as Error)?.message,
      });
      return this.base;
    }

    for (const row of rows) {
      if (!row.enabled) {
        providers.delete(row.id);
        continue;
      }
      const fromEnv = this.base.providers.get(row.id);
      providers.set(row.id, {
        id: row.id,
        label: row.label || row.id,
        baseUrl: row.baseUrl.replace(/\/+$/, ""),
        apiKeyEnv: fromEnv?.apiKeyEnv ?? "(数据库)",
        apiKey: this.decrypt(row.apiKeyCipher) ?? fromEnv?.apiKey ?? null,
        models: safeModels(row.models),
      });
    }

    for (const row of routeRows) {
      if (!(AI_PURPOSES as readonly string[]).includes(row.purpose)) continue;
      const candidates = safeStringArray(row.candidates);
      if (candidates.length) routes.set(row.purpose as AiPurpose, candidates);
      else routes.delete(row.purpose as AiPurpose);
    }

    return { ...this.base, providers, routes };
  }

  async upsertProvider(input: ProviderUpsert): Promise<void> {
    if (!PROVIDER_ID.test(input.id)) {
      throw invalidRequest("provider id 须为小写字母开头的短横线命名");
    }
    if (!/^https?:\/\//.test(input.baseUrl)) {
      throw invalidRequest("baseUrl 必须是 http(s) 地址");
    }
    if (!input.models.length) {
      throw invalidRequest("至少登记一个模型");
    }
    let cipher: string | null | undefined
    if (input.apiKey === undefined) cipher = undefined
    else if (input.apiKey === null || input.apiKey === "") cipher = null
    else cipher = this.encrypt(input.apiKey)

    const models = JSON.stringify(input.models);
    await this.db.aiProviderSetting.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        label: input.label ?? input.id,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        apiKeyCipher: cipher ?? null,
        models,
        enabled: input.enabled ?? true,
      },
      update: {
        label: input.label ?? input.id,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        ...(cipher === undefined ? {} : { apiKeyCipher: cipher }),
        models,
        enabled: input.enabled ?? true,
      },
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.db.aiProviderSetting.deleteMany({ where: { id } });
  }

  async setRoute(purpose: AiPurpose, candidates: string[]): Promise<void> {
    await this.db.aiRouteSetting.upsert({
      where: { purpose },
      create: { purpose, candidates: JSON.stringify(candidates) },
      update: { candidates: JSON.stringify(candidates) },
    });
  }

  /** 已经登记过就不要覆盖，迁移脚本可以反复跑。 */
  async hasProvider(id: string): Promise<boolean> {
    const row = await this.db.aiProviderSetting.findUnique({ where: { id } });
    return Boolean(row);
  }

  private encrypt(plain: string): string {
    if (!this.canPersistKeys) {
      throw invalidRequest(
        "platform 未配置 PLATFORM_CONFIG_ENCRYPTION_KEY，拒绝明文保存 API Key",
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
  }

  private decrypt(value: string | null): string | null {
    if (!value || !this.canPersistKeys) return null;
    const [iv, tag, body] = value.split(".");
    if (!iv || !tag || !body) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(body, "base64")),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      // 换过加密密钥就解不开；报「没配 Key」比拿脏数据去调模型安全
      logger.warn("ai", "AI Key 解密失败，可能换过 PLATFORM_CONFIG_ENCRYPTION_KEY");
      return null;
    }
  }
}

function safeModels(raw: string): AiModelConfig[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: String(item.id ?? ""),
        vision: Boolean(item.vision),
        costPerMillionInputMicros:
          typeof item.costPerMillionInputMicros === "number" ? item.costPerMillionInputMicros : null,
        costPerMillionOutputMicros:
          typeof item.costPerMillionOutputMicros === "number" ? item.costPerMillionOutputMicros : null,
      }))
      .filter((item) => item.id);
  } catch {
    return [];
  }
}

function safeStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
