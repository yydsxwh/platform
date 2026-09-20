/**
 * 请求级结构化日志。
 *
 * 记录 requestId / clientId / module / route / duration / result / error code。
 * 不记录请求体、prompt、回复正文、token、签名 URL。
 */

import type { MiddlewareHandler } from "hono";

import { classifyStatus, logger } from "../observability/logger";
import { moduleFromApiPath, type AppEnv } from "./context";
import { PlatformError } from "../errors";

export function requestLogMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const url = new URL(c.req.url);
      const status = thrown
        ? thrown instanceof PlatformError
          ? statusOfError(thrown)
          : 500
        : c.res.status;
      const errorCode = thrown instanceof PlatformError ? thrown.code : null;
      const caller = (() => {
        try {
          return c.get("caller");
        } catch {
          return undefined;
        }
      })();
      const result = status < 400 ? "ok" : "error";
      logger.info("http", "request", {
        requestId: c.get("requestId"),
        clientId: caller?.clientId ?? null,
        module: moduleFromApiPath(url.pathname) ?? "http",
        route: `${c.req.method} ${url.pathname}`,
        durationMs: Date.now() - started,
        result,
        status,
        errorCode: errorCode ?? null,
        errorClass: result === "error" ? classifyStatus(status) : null,
      });
    }
  };
}

function statusOfError(error: PlatformError): number {
  switch (error.code) {
    case "INVALID_REQUEST":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "PERMISSION_DENIED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    case "FAILED_PRECONDITION":
      return 412;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "RATE_LIMITED":
      return 429;
    case "PROVIDER_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}
