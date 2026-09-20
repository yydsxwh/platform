/**
 * Payments HTTP 层。
 *
 * 回调端点不走服务凭证：渠道不可能带我们的 Bearer，凭证是渠道自己的签名，
 * 由各 provider adapter 验。验不过一律当没发生，不改任何状态。
 */

import { Hono } from "hono";
import { z } from "zod";

import {
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
} from "@yydsxwh/shared/contracts/payments";

import type { AppEnv } from "../context";
import { invalidRequest } from "../../errors";
import type { PaymentService } from "../../modules/payments/service";
import { parseJsonBody } from "./shared";

const createPaymentSchema = z.object({
  clientOrderNo: z.string().min(1).max(64),
  provider: z.enum(PAYMENT_PROVIDERS),
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().positive(),
  subject: z.string().min(1).max(200),
  payerId: z.string().max(128).optional(),
  payerOpenId: z.string().max(128).optional(),
  returnUrl: z.string().url().optional(),
  expiresInSeconds: z.number().int().positive().max(86_400).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const refundSchema = z.object({
  clientRefundNo: z.string().min(1).max(64),
  amountCents: z.number().int().positive(),
  reason: z.string().max(200).optional(),
});

export function createPaymentRouter(deps: { payments: PaymentService }) {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    const body = await parseJsonBody(createPaymentSchema, c.req.raw);
    const result = await deps.payments.createPayment(body, c.get("caller").clientId);
    return c.json(result, 201);
  });

  router.get("/by-order-no", async (c) => {
    const clientOrderNo = c.req.query("clientOrderNo");
    if (!clientOrderNo) throw invalidRequest("缺少 clientOrderNo");
    return c.json({
      payment: await deps.payments.getPaymentByOrderNo(
        clientOrderNo,
        c.get("caller").clientId,
      ),
    });
  });

  router.get("/:paymentId", async (c) =>
    c.json({
      payment: await deps.payments.getPayment(
        c.req.param("paymentId"),
        c.get("caller").clientId,
      ),
    }),
  );

  router.post("/:paymentId/refunds", async (c) => {
    const body = await parseJsonBody(refundSchema, c.req.raw);
    return c.json(
      await deps.payments.refund(c.req.param("paymentId"), body, c.get("caller").clientId),
      201,
    );
  });

  return router;
}

/** 渠道回调：无服务凭证，靠渠道签名自证 */
export function createPaymentWebhookRouter(deps: { payments: PaymentService }) {
  const router = new Hono();

  router.post("/:provider", async (c) => {
    const provider = c.req.param("provider").toUpperCase();
    const match = PAYMENT_PROVIDERS.find((p) => p === provider);
    if (!match) throw invalidRequest(`未知支付渠道：${provider}`);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const result = await deps.payments.handleWebhook({
      provider: match,
      body: await c.req.text(),
      headers,
    });
    if (!result.handled) {
      // 不回显任何细节：验签失败的请求不该得到可用于试探的反馈
      return c.json({ ok: false }, 400);
    }
    // 渠道只看是否 2xx；重复送达同样回成功，让对方停止重推
    return c.json({ ok: true, duplicate: result.duplicate });
  });

  return router;
}
