/**
 * 请求上下文：认证、请求 id、错误归一。
 *
 * 认证一律在这里做，业务模块只拿到已验证的 caller，不再各自解析头。
 *
 * 身份分两层，禁止混为一谈：
 * 1. Service Identity：Bearer 服务凭证。浏览器不得持有。
 * 2. End User Identity：仅在服务凭证通过后，才接受产品后端传来的 Actor。
 */

import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

import {
  PLATFORM_ERROR_STATUS,
  type PlatformErrorBody,
} from "@yydsxwh/shared/contracts/error";
import type { PlatformServiceScope } from "@yydsxwh/shared/contracts/service";
import {
  PLATFORM_ACTOR_HEADER,
  PLATFORM_REQUEST_ID_HEADER,
} from "@yydsxwh/shared/contracts/version";
import type { PlatformConfig } from "../config";
import { hasScope } from "../config";
import { PlatformError } from "../errors";
import { constantTimeEquals } from "../modules/storage/providers/signing";

export type Caller = {
  clientId: string;
  actorId: string | null;
  scopes: readonly PlatformServiceScope[];
};

export type AppEnv = {
  Variables: {
    caller: Caller;
    requestId: string;
  };
};

export function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header(PLATFORM_REQUEST_ID_HEADER);
    const requestId = incoming?.trim() || `req_${randomUUID().replace(/-/g, "")}`;
    c.set("requestId", requestId);
    c.header(PLATFORM_REQUEST_ID_HEADER, requestId);
    await next();
  };
}

/**
 * 服务间认证：`Authorization: Bearer <token>`。
 * 逐个调用方比对，用定长比较避免按字节计时爆破。
 *
 * 同一 client 可配置多把 token（轮换）。匹配后才读取 Actor：
 * 没有有效服务凭证时，Actor 头被忽略，请求直接 401。
 */
export function serviceAuthMiddleware(
  config: PlatformConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : "";
    if (!token) {
      throw new PlatformError("UNAUTHENTICATED", "缺少服务凭证");
    }

    let matched: Caller | null = null;
    for (const credential of config.serviceCredentials) {
      if (constantTimeEquals(credential.token, token)) {
        matched = {
          clientId: credential.clientId,
          actorId: null,
          scopes: credential.scopes,
        };
      }
    }
    if (!matched) {
      throw new PlatformError("UNAUTHENTICATED", "服务凭证无效");
    }

    const actor = c.req.header(PLATFORM_ACTOR_HEADER)?.trim() || null;
    matched.actorId = actor && actor.length <= 128 ? actor : null;
    c.set("caller", matched);
    await next();
  };
}

export function moduleFromApiPath(pathname: string): PlatformServiceScope | null {
  const path = pathname.replace(/^\/+/, "");
  const parts = path.split("/");
  const versioned = parts[0] === "v1" ? parts.slice(1) : parts;
  const head = versioned[0] ?? "";
  if (head === "ai") return "ai";
  if (head === "storage") return "storage";
  if (head === "catalog") return "catalog";
  if (head === "payments" || head === "payment-webhooks") return "payments";
  if (head === "releases" || head === "products") return "releases";
  return null;
}

/** 已认证调用方必须拥有该模块 scope；未写 scope 的旧 token 默认全开 */
export function requireServiceScope(
  needed: PlatformServiceScope,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const caller = c.get("caller");
    if (!caller || !hasScope(caller.scopes, needed)) {
      throw new PlatformError("PERMISSION_DENIED", `服务凭证无权访问 ${needed}`, {
        needed,
      });
    }
    await next();
  };
}

export function scopeGuardMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const needed = moduleFromApiPath(new URL(c.req.url).pathname);
    if (needed) {
      const caller = c.get("caller");
      if (!caller || !hasScope(caller.scopes, needed)) {
        throw new PlatformError("PERMISSION_DENIED", `服务凭证无权访问 ${needed}`, {
          needed,
        });
      }
    }
    await next();
  };
}

export function toErrorBody(error: unknown, requestId: string): {
  status: number;
  body: PlatformErrorBody;
} {
  if (error instanceof PlatformError) {
    return {
      status: PLATFORM_ERROR_STATUS[error.code],
      body: {
        error: { code: error.code, message: error.message, details: error.details },
        requestId,
      },
    };
  }
  // 未预期异常不把栈或内部细节回给调用方，日志里另行记录
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL", message: "platform 内部错误" },
      requestId,
    },
  };
}

export function errorResponse(c: Context<AppEnv>, error: unknown): Response {
  const requestId = c.get("requestId") ?? "unknown";
  const { status, body } = toErrorBody(error, requestId);
  if (!(error instanceof PlatformError)) {
    console.error(`[platform] ${requestId} 未预期错误`, error);
  }
  return c.json(body, status as 400);
}
