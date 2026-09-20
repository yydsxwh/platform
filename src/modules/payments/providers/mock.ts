/**
 * 本地与测试用的支付渠道。
 *
 * 生产禁止启用：配置层已经在 NODE_ENV=production 且 PAYMENT_ALLOW_MOCK=true 时
 * 直接拒绝启动——否则任何人都能把订单标成已付。
 *
 * 回调用 HMAC 签名，与真实渠道一样要验签，这样幂等、重放、金额核对这些逻辑
 * 在测试里跑的是同一条代码路径。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  PaymentAction,
  PaymentIntent,
  PaymentProvider,
} from "@yydsxwh/shared/contracts/payments";

import type {
  PaymentProviderAdapter,
  ProviderWebhookEvent,
} from "../service";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export function signMockWebhook(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class MockPaymentAdapter implements PaymentProviderAdapter {
  readonly provider: PaymentProvider = "MOCK";

  constructor(private readonly secret: string) {}

  async createTransaction(input: {
    payment: PaymentIntent;
    returnUrl?: string;
  }): Promise<PaymentAction> {
    if (input.returnUrl) {
      return { kind: "REDIRECT", url: input.returnUrl };
    }
    return { kind: "QR_CODE", codeUrl: `mock://pay/${input.payment.paymentId}` };
  }

  async parseWebhook(input: {
    body: string;
    headers: Record<string, string>;
  }): Promise<ProviderWebhookEvent | null> {
    const signature = input.headers[MOCK_SIGNATURE_HEADER] ?? "";
    const expected = signMockWebhook(this.secret, input.body);
    if (!constantTimeEquals(expected, signature)) return null;

    try {
      const parsed = JSON.parse(input.body) as Partial<ProviderWebhookEvent>;
      if (
        !parsed.providerEventId ||
        !parsed.outTradeNo ||
        typeof parsed.amountCents !== "number"
      ) {
        return null;
      }
      return {
        providerEventId: parsed.providerEventId,
        providerTransactionId: parsed.providerTransactionId ?? parsed.providerEventId,
        outTradeNo: parsed.outTradeNo,
        amountCents: parsed.amountCents,
        status: parsed.status ?? "SUCCEEDED",
        paidAt: parsed.paidAt,
      };
    } catch {
      return null;
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
