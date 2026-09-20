/**
 * platform 内部统一异常。
 *
 * 模块层只抛 PlatformError，HTTP 层负责转成契约里的错误体。
 * 这样换传输协议时业务代码不用改，错误码也不会在每个路由里各写一套。
 */

import type { PlatformErrorCode } from "@yydsxwh/shared/contracts/error";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: PlatformErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.details = details;
  }
}

export const invalidRequest = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("INVALID_REQUEST", message, details);

export const notFound = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("NOT_FOUND", message, details);

export const permissionDenied = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("PERMISSION_DENIED", message, details);

export const failedPrecondition = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("FAILED_PRECONDITION", message, details);

export const payloadTooLarge = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("PAYLOAD_TOO_LARGE", message, details);

export const unsupportedMediaType = (
  message: string,
  details?: Record<string, unknown>,
) => new PlatformError("UNSUPPORTED_MEDIA_TYPE", message, details);

export const alreadyExists = (message: string, details?: Record<string, unknown>) =>
  new PlatformError("ALREADY_EXISTS", message, details);

export const providerUnavailable = (
  message: string,
  details?: Record<string, unknown>,
) => new PlatformError("PROVIDER_UNAVAILABLE", message, details);
