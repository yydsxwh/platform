import assert from "node:assert/strict";
import test from "node:test";

import { callChatCompletion, readAssistantText } from "../src/modules/ai/provider";

test("视觉模型的 content 数组会拼成一段文本", () => {
  const text = readAssistantText({
    content: [
      { type: "text", text: '{"courses":[' },
      { type: "text", text: '{"name":"高等数学"}]}' },
    ],
  });
  assert.equal(text, '{"courses":[{"name":"高等数学"}]}');
  assert.equal(readAssistantText({ content: "  纯文本  " }), "纯文本");
  assert.equal(readAssistantText({ content: "", reasoning_content: "兜底正文" }), "兜底正文");
  assert.equal(readAssistantText({ content: [{ type: "image_url" }] }), "");
});

test("Chat Completions 不再假设 content 一定是字符串", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: "text", text: '{"courses":[]}' }],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await callChatCompletion({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "qwen-vl-max",
      messages: [{ role: "user", content: "看图" }],
      timeoutMs: 1000,
    });
    assert.equal(result.content, '{"courses":[]}');
    assert.equal(result.promptTokens, 3);
    assert.equal(result.completionTokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});
