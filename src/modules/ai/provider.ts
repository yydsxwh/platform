/**
 * OpenAI 兼容 Chat Completions 调用。
 *
 * 现有调用方（一键翻译、MathCode 视觉识别）都是这个形状，迁移时提示词与
 * 消息结构原样保留。厂商差异靠 baseUrl + 模型名吸收，不为每家写一套适配。
 *
 * API Key 只在本函数内拼进 Authorization 头，**不写日志、不进任何返回值**。
 */

import type { AiChatMessage } from "@yydsxwh/shared/contracts/ai";

export type ChatCompletionInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
};

export type ChatCompletionOutput = {
  content: string;
  promptTokens: number;
  completionTokens: number;
};

export class AiProviderError extends Error {
  constructor(
    readonly kind: "TIMEOUT" | "HTTP" | "EMPTY" | "NETWORK",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export type ChatCompletionFn = (
  input: ChatCompletionInput,
) => Promise<ChatCompletionOutput>;

export const callChatCompletion: ChatCompletionFn = async (input) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        messages: input.messages,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = (cause as Error)?.name === "AbortError";
    throw new AiProviderError(
      aborted ? "TIMEOUT" : "NETWORK",
      aborted
        ? `模型调用超时（${input.timeoutMs}ms，已耗时 ${Date.now() - startedAt}ms）`
        : `模型调用失败：${(cause as Error)?.message || "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 只截断回显，避免把上游返回里的敏感内容整段带进日志
    throw new AiProviderError(
      "HTTP",
      `模型返回 ${response.status}：${body.slice(0, 200)}`,
      response.status,
    );
  }

  const data = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;

  const content = data?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new AiProviderError("EMPTY", "模型返回空内容");
  }
  return {
    content,
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };
};
