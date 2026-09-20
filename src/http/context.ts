/**
 * 请求上下文：认证、请求 id、错误归一。
 *
 * 认证一律在这里做，业务模块只拿到已验证的 caller，不再各自解析头。
 */

import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

import {
  PLATFORM_ERROR_STATUS,
  type PlatformErrorBody,
} from "@yydsxwh/shared/contracts/error";
import {
  PLATFORM_ACTOR_HEADER,
  PLATFORM_REQUEST_ID_HEADER,
} from "@yydsxwh/shared/contracts/version";
import type { PlatformConfig } from "../config";
import { PlatformError } from "../errors";
import { constantTimeEquals } from "../modules/storage/providers/signing";

export type Caller = {
  clientId: string;
  actorId: string | null;
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

    let matched: string | null = null;
    for (const [clientId, expected] of config.serviceTokens) {
      if (constantTimeEquals(expected, token)) matched = clientId;
    }
    if (!matched) {
      throw new PlatformError("UNAUTHENTICATED", "服务凭证无效");
    }

    const actor = c.req.header(PLATFORM_ACTOR_HEADER)?.trim() || null;
    c.set("caller", { clientId: matched, actorId: actor && actor.length <= 128 ? actor : null });
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
