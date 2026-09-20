/** 路由层公用的请求解析，保证参数错误一律是 400 而不是 500 */

import type { z } from "zod";
import { invalidRequest } from "../../errors";

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest("请求体不是合法 JSON");
  }
}

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidRequest("请求参数不合法", {
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

export async function parseJsonBody<T>(
  schema: z.ZodType<T>,
  request: Request,
  /** 路径参数并进请求体，避免 body 与 URL 里各写一份 id */
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const body = await readJson(request);
  const merged =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), ...overrides }
      : overrides;
  return parseSchema(schema, merged);
}
