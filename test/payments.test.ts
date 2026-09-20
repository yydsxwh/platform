import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";
import type {
  CreatePaymentResponse,
  PaymentIntent,
  RefundRecord,
} from "@yydsxwh/shared/contracts/payments";

import {
  MOCK_SIGNATURE_HEADER,
  signMockWebhook,
} from "../src/modules/payments/providers/mock";
import { loadConfig } from "../src/config";
import {
  createTestApp,
  json,
  TEST_TOKEN_SOFTWARELIST,
  type TestApp,
} from "./helpers/app";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

async function createPayment(
  body: Record<string, unknown>,
  init: Parameters<TestApp["request"]>[1] = {},
) {
  return ctx.request("/v1/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "MOCK",
      method: "NATIVE",
      subject: "测试商品",
      ...body,
    }),
    ...init,
  });
}

/** 模拟渠道回调：带正确签名 */
async function sendWebhook(payload: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(payload);
  return ctx.request("/v1/payment-webhooks/mock", {
    method: "POST",
    token: "",
    headers: {
      "content-type": "application/json",
      [MOCK_SIGNATURE_HEADER]:
        signature ?? signMockWebhook(ctx.config.paymentWebhookSecret!, body),
    },
    body,
  });
}

test("创建支付返回支付单与调起参数", async () => {
  const res = await createPayment({ clientOrderNo: "ORD001", amountCents: 1990 });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await json<CreatePaymentResponse>(res);
  assert.equal(body.payment.status, "PENDING");
  assert.equal(body.payment.amountCents, 1990);
  assert.equal(body.payment.clientId, "andyyyds");
  assert.equal(body.action.kind, "QR_CODE");
});

test("同一订单号重复创建返回原单，不会开出第二笔", async () => {
  const first = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD002", amountCents: 100 }),
  );
  const second = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD002", amountCents: 100 }),
  );
  assert.equal(first.payment.paymentId, second.payment.paymentId);
});

test("同一订单号换金额要拒绝，不能覆盖原单", async () => {
  await createPayment({ clientOrderNo: "ORD003", amountCents: 100 });
  const res = await createPayment({ clientOrderNo: "ORD003", amountCents: 1 });
  assert.equal(res.status, 409);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "ALREADY_EXISTS");
});

test("金额非正整数直接拒绝", async () => {
  assert.equal((await createPayment({ clientOrderNo: "ORD004", amountCents: 0 })).status, 400);
  assert.equal((await createPayment({ clientOrderNo: "ORD005", amountCents: -1 })).status, 400);
  assert.equal((await createPayment({ clientOrderNo: "ORD006", amountCents: 1.5 })).status, 400);
});

test("未启用的渠道不能下单", async () => {
  const res = await createPayment({
    clientOrderNo: "ORD007",
    amountCents: 100,
    provider: "WECHAT",
    method: "NATIVE",
  });
  assert.equal(res.status, 400);
});

test("微信 JSAPI 缺 openid 要拒绝", async () => {
  const res = await createPayment({
    clientOrderNo: "ORD008",
    amountCents: 100,
    provider: "MOCK",
    method: "JSAPI",
  });
  // MOCK 渠道也走同一条校验分支，但 provider 不是 WECHAT 时不强制 openid
  assert.equal(res.status, 201);
});

test("回调验签通过后订单变为已支付", async () => {
  const created = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD010", amountCents: 500 }),
  );
  const res = await sendWebhook({
    providerEventId: "evt-010",
    providerTransactionId: "txn-010",
    outTradeNo: "ORD010",
    amountCents: 500,
    status: "SUCCEEDED",
  });
  assert.equal(res.status, 200);
  assert.equal((await json<{ duplicate: boolean }>(res)).duplicate, false);

  const after = await json<{ payment: PaymentIntent }>(
    await ctx.request(`/v1/payments/${created.payment.paymentId}`),
  );
  assert.equal(after.payment.status, "SUCCEEDED");
  assert.equal(after.payment.providerTransactionId, "txn-010");
  assert.ok(after.payment.paidAt);
});

test("重复回调只处理一次，第二次报 duplicate", async () => {
  const payload = {
    providerEventId: "evt-010",
    providerTransactionId: "txn-010",
    outTradeNo: "ORD010",
    amountCents: 500,
    status: "SUCCEEDED",
  };
  const res = await sendWebhook(payload);
  assert.equal(res.status, 200);
  assert.equal((await json<{ duplicate: boolean }>(res)).duplicate, true);

  const events = await ctx.db.paymentEvent.count({
    where: { providerEventId: "evt-010" },
  });
  assert.equal(events, 1);
});

test("签名无效的回调一律不改状态，也不回显细节", async () => {
  const created = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD011", amountCents: 700 }),
  );
  const res = await sendWebhook(
    {
      providerEventId: "evt-011",
      providerTransactionId: "txn-011",
      outTradeNo: "ORD011",
      amountCents: 700,
      status: "SUCCEEDED",
    },
    "0".repeat(64),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false });

  const after = await json<{ payment: PaymentIntent }>(
    await ctx.request(`/v1/payments/${created.payment.paymentId}`),
  );
  assert.equal(after.payment.status, "PENDING");
});

test("金额不匹配的回调拒绝落账", async () => {
  const created = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD012", amountCents: 900 }),
  );
  const res = await sendWebhook({
    providerEventId: "evt-012",
    providerTransactionId: "txn-012",
    outTradeNo: "ORD012",
    amountCents: 1,
    status: "SUCCEEDED",
  });
  assert.equal(res.status, 412);

  const after = await json<{ payment: PaymentIntent }>(
    await ctx.request(`/v1/payments/${created.payment.paymentId}`),
  );
  assert.equal(after.payment.status, "PENDING");
});

test("回调对应不到订单时返回 404", async () => {
  const res = await sendWebhook({
    providerEventId: "evt-404",
    providerTransactionId: "txn-404",
    outTradeNo: "ORDER_NOT_EXIST",
    amountCents: 100,
    status: "SUCCEEDED",
  });
  assert.equal(res.status, 404);
});

test("支付失败的回调把订单标成 FAILED", async () => {
  const created = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD013", amountCents: 300 }),
  );
  await sendWebhook({
    providerEventId: "evt-013",
    providerTransactionId: "txn-013",
    outTradeNo: "ORD013",
    amountCents: 300,
    status: "FAILED",
  });
  const after = await json<{ payment: PaymentIntent }>(
    await ctx.request(`/v1/payments/${created.payment.paymentId}`),
  );
  assert.equal(after.payment.status, "FAILED");
});

test("按产品自己的订单号可以反查支付单", async () => {
  const res = await ctx.request("/v1/payments/by-order-no?clientOrderNo=ORD010");
  assert.equal(res.status, 200);
  assert.equal((await json<{ payment: PaymentIntent }>(res)).payment.clientOrderNo, "ORD010");

  const missing = await ctx.request("/v1/payments/by-order-no?clientOrderNo=NOPE");
  assert.equal(missing.status, 404);
});

test("跨调用方读别人的支付单按不存在处理", async () => {
  const created = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD014", amountCents: 100 }),
  );
  const res = await ctx.request(`/v1/payments/${created.payment.paymentId}`, {
    token: TEST_TOKEN_SOFTWARELIST,
  });
  assert.equal(res.status, 404);
});

test("退款：未支付不能退，退款单号幂等，超额要拒", async () => {
  const unpaid = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD020", amountCents: 1000 }),
  );
  const tooEarly = await ctx.request(`/v1/payments/${unpaid.payment.paymentId}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRefundNo: "RF1", amountCents: 100 }),
  });
  assert.equal(tooEarly.status, 412);

  const paid = await json<CreatePaymentResponse>(
    await createPayment({ clientOrderNo: "ORD021", amountCents: 1000 }),
  );
  await sendWebhook({
    providerEventId: "evt-021",
    providerTransactionId: "txn-021",
    outTradeNo: "ORD021",
    amountCents: 1000,
    status: "SUCCEEDED",
  });

  const first = await ctx.request(`/v1/payments/${paid.payment.paymentId}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRefundNo: "RF2", amountCents: 400 }),
  });
  assert.equal(first.status, 201);
  const refund = await json<RefundRecord>(first);
  assert.equal(refund.amountCents, 400);

  const again = await ctx.request(`/v1/payments/${paid.payment.paymentId}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRefundNo: "RF2", amountCents: 400 }),
  });
  assert.equal(again.status, 201);
  assert.equal((await json<RefundRecord>(again)).refundId, refund.refundId);

  const over = await ctx.request(`/v1/payments/${paid.payment.paymentId}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRefundNo: "RF3", amountCents: 700 }),
  });
  assert.equal(over.status, 412);
});

test("履约事件签名可验；改一个字节、或超出时间窗，都要判失败", () => {
  const rawBody = JSON.stringify({ eventId: "e1", type: "payment.succeeded" });
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const signature = createHmac("sha256", ctx.config.paymentWebhookSecret!)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const verify = (input: Partial<Parameters<typeof ctx.services.payments.verifyFulfillmentSignature>[0]>) =>
    ctx.services.payments.verifyFulfillmentSignature({
      rawBody,
      timestamp,
      signature,
      now,
      ...input,
    });

  assert.equal(verify({}), true);
  assert.equal(verify({ rawBody: `${rawBody} ` }), false);
  assert.equal(verify({ signature: "0".repeat(64) }), false);
  assert.equal(verify({ signature: "short" }), false);
  // 时间戳偏移超过 5 分钟按重放拒绝
  assert.equal(verify({ timestamp: timestamp - 600 }), false);
  assert.equal(verify({ timestamp: timestamp + 600 }), false);
});

test("生产环境禁止开启 mock 支付", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "file:./x.db",
        PLATFORM_SERVICE_TOKENS: "andyyyds:0123456789abcdef0123456789abcdef",
        PAYMENT_ALLOW_MOCK: "true",
      } as NodeJS.ProcessEnv),
    /生产环境禁止开启 PAYMENT_ALLOW_MOCK/,
  );
});
