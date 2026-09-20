/**
 * 结构化日志。
 *
 * 现在不建监控集群，但格式要先统一：service、module、level、requestId、
 * 错误分类固定字段。以后接日志采集或 tracing 时不用回头改每一处调用。
 *
 * 安全约束：**禁止记录密钥、Access Token、Session、私钥、签名 URL、完整提示词**。
 * 需要定位时记 requestId 与错误分类，去对应服务查。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 错误分类：便于按类聚合告警，而不是按文案 grep */
export type ErrorClass =
  | "CLIENT_ERROR"
  | "AUTH_ERROR"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";

const SERVICE = "platform";

/** 命中这些键名的字段一律不输出，防止顺手把凭证带进日志 */
const REDACT_KEYS =
  /(key|secret|token|password|authorization|signature|cookie|credential|prompt|reply)/i;

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEYS.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = typeof value === "string" && value.length > 500
      ? `${value.slice(0, 500)}…`
      : value;
  }
  return out;
}

function emit(level: LogLevel, moduleName: string, message: string, fields: LogFields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    module: moduleName,
    message,
    ...redact(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (moduleName: string, message: string, fields: LogFields = {}) =>
    emit("debug", moduleName, message, fields),
  info: (moduleName: string, message: string, fields: LogFields = {}) =>
    emit("info", moduleName, message, fields),
  warn: (moduleName: string, message: string, fields: LogFields = {}) =>
    emit("warn", moduleName, message, fields),
  error: (moduleName: string, message: string, fields: LogFields = {}) =>
    emit("error", moduleName, message, fields),
};

export function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 503) return "PROVIDER_ERROR";
  if (status >= 500) return "INTERNAL_ERROR";
  return "CLIENT_ERROR";
}
