/**
 * Payments：只管「钱怎么付」。
 *
 * 边界：platform 负责发起支付、对接渠道、验签回调、幂等落账，然后给产品一个明确的
 * 履约结果。产品收到结果后执行自己的业务——MathCode 加额度、课程开通、优惠券与
 * 分销结算都属于产品，不进这里。否则 payment 会慢慢长成第二个业务系统。
 *
 * 三条不可退让的规则：
 * 1. 不相信客户端说的「支付成功」，只认渠道验签通过的服务端回调
 * 2. 回调按 providerEventId 幂等，重复送达只处理一次
 * 3. 回调金额与订单金额不符一律拒绝落账
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  CreatePaymentRequest,
  CreatePaymentResponse,
  PaymentAction,
  PaymentFulfillmentEvent,
  PaymentIntent,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  RefundRecord,
  RefundRequest,
} from "@yydsxwh/shared/contracts/payments";
import { PAYMENT_WEBHOOK_MAX_SKEW_SECONDS } from "@yydsxwh/shared/contracts/payments";

import type { PrismaClient } from "@prisma/client";
import {
  alreadyExists,
  failedPrecondition,
  invalidRequest,
  notFound,
  permissionDenied,
} from "../../errors";

/** 支付单默认有效期：超过后渠道侧多半也已关单 */
const DEFAULT_EXPIRES_SECONDS = 2 * 60 * 60;

type PaymentRow = {
  id: string;
  clientOrderNo: string;
  clientId: string;
  provider: string;
  method: string;
  amountCents: number;
  currency: string;
  subject: string;
  status: string;
  payerId: string | null;
  payerOpenId: string | null;
  providerTransactionId: string | null;
  returnUrl: string | null;
  paidAt: Date | null;
  expiresAt: Date | null;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
};

/** 渠道适配器：真实渠道下单在这里，核心流程不依赖具体渠道 */
export type PaymentProviderAdapter = {
  readonly provider: PaymentProvider;
  createTransaction(input: {
    payment: PaymentIntent;
    payerOpenId?: string;
    returnUrl?: string;
  }): Promise<PaymentAction>;
  /** 验签并解析渠道回调；验签不过返回 null */
  parseWebhook(input: {
    body: string;
    headers: Record<string, string>;
  }): Promise<ProviderWebhookEvent | null>;
};

export type ProviderWebhookEvent = {
  /** 渠道侧事件唯一键，用于幂等 */
  providerEventId: string;
  providerTransactionId: string;
  /** 与创建时的 clientOrderNo 对应 */
  outTradeNo: string;
  amountCents: number;
  status: "SUCCEEDED" | "FAILED" | "REFUNDED";
  paidAt?: string;
};

export type WebhookResult =
  | { handled: true; payment: PaymentIntent; duplicate: boolean }
  | { handled: false; reason: "INVALID_SIGNATURE" };

export class PaymentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly adapters: Map<PaymentProvider, PaymentProviderAdapter>,
    private readonly webhookSecret: string | null,
  ) {}

  /**
   * 创建支付。按 clientId + clientOrderNo 幂等：
   * 同一订单重复调用返回原单，前端重试或用户狂点都不会开出第二笔。
   */
  async createPayment(
    input: CreatePaymentRequest,
    clientId: string,
  ): Promise<CreatePaymentResponse> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw invalidRequest("金额须为正整数分", { amountCents: input.amountCents });
    }
    const adapter = this.adapters.get(input.provider);
    if (!adapter) {
      throw invalidRequest(`未启用的支付渠道：${input.provider}`, {
        provider: input.provider,
      });
    }
    if (input.provider === "WECHAT" && input.method === "JSAPI" && !input.payerOpenId) {
      throw invalidRequest("微信 JSAPI 支付需要 payerOpenId");
    }

    const existing = (await this.db.payment.findFirst({
      where: { clientId, clientOrderNo: input.clientOrderNo },
    })) as PaymentRow | null;

    if (existing) {
      if (existing.amountCents !== input.amountCents) {
        // 同一订单号换了金额，多半是产品侧算错或被篡改，不能覆盖原单
        throw alreadyExists("该订单号已存在且金额不同", {
          clientOrderNo: input.clientOrderNo,
          existingAmountCents: existing.amountCents,
        });
      }
      const payment = toPaymentIntent(existing);
      if (existing.status === "SUCCEEDED") {
        return { payment, action: { kind: "NONE" } };
      }
      const action = await adapter.createTransaction({
        payment,
        payerOpenId: input.payerOpenId ?? existing.payerOpenId ?? undefined,
        returnUrl: input.returnUrl ?? existing.returnUrl ?? undefined,
      });
      return { payment, action };
    }

    const row = (await this.db.payment.create({
      data: {
        id: `pay_${randomUUID().replace(/-/g, "")}`,
        clientOrderNo: input.clientOrderNo,
        clientId,
        provider: input.provider,
        method: input.method,
        amountCents: input.amountCents,
        currency: "CNY",
        subject: input.subject.slice(0, 200),
        status: "CREATED",
        payerId: input.payerId ?? null,
        payerOpenId: input.payerOpenId ?? null,
        returnUrl: input.returnUrl ?? null,
        expiresAt: new Date(
          Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS) * 1000,
        ),
        metadata: JSON.stringify(input.metadata ?? {}),
      },
    })) as PaymentRow;

    const payment = toPaymentIntent(row);
    const action = await adapter.createTransaction({
      payment,
      payerOpenId: input.payerOpenId,
      returnUrl: input.returnUrl,
    });
    const pending = (await this.db.payment.update({
      where: { id: row.id },
      data: { status: "PENDING" },
    })) as PaymentRow;
    return { payment: toPaymentIntent(pending), action };
  }

  async getPayment(paymentId: string, clientId: string): Promise<PaymentIntent> {
    const row = (await this.db.payment.findUnique({
      where: { id: paymentId },
    })) as PaymentRow | null;
    if (!row) throw notFound("支付单不存在", { paymentId });
    // 跨调用方按不存在处理，别让别的站点探到订单是否有效
    if (row.clientId !== clientId) throw notFound("支付单不存在", { paymentId });
    return toPaymentIntent(row);
  }

  async getPaymentByOrderNo(
    clientOrderNo: string,
    clientId: string,
  ): Promise<PaymentIntent> {
    const row = (await this.db.payment.findFirst({
      where: { clientId, clientOrderNo },
    })) as PaymentRow | null;
    if (!row) throw notFound("支付单不存在", { clientOrderNo });
    return toPaymentIntent(row);
  }

  /**
   * 处理渠道回调。
   * 验签 → 找单 → 核对金额 → 幂等落账，任一步不过都不改状态。
   */
  async handleWebhook(input: {
    provider: PaymentProvider;
    body: string;
    headers: Record<string, string>;
  }): Promise<WebhookResult> {
    const adapter = this.adapters.get(input.provider);
    if (!adapter) return { handled: false, reason: "INVALID_SIGNATURE" };

    const event = await adapter.parseWebhook({
      body: input.body,
      headers: input.headers,
    });
    if (!event) return { handled: false, reason: "INVALID_SIGNATURE" };

    const existingEvent = await this.db.paymentEvent.findFirst({
      where: { provider: input.provider, providerEventId: event.providerEventId },
    });
    if (existingEvent) {
      // 渠道会重推直到收到成功应答，重复送达必须当作一次
      const row = (await this.db.payment.findUnique({
        where: { id: existingEvent.paymentId },
      })) as PaymentRow;
      return { handled: true, payment: toPaymentIntent(row), duplicate: true };
    }

    const row = (await this.db.payment.findFirst({
      where: { clientOrderNo: event.outTradeNo },
    })) as PaymentRow | null;
    if (!row) throw notFound("回调对应的支付单不存在", { outTradeNo: event.outTradeNo });

    if (row.amountCents !== event.amountCents) {
      // 金额对不上绝不落账：这类回调要么是配置串了，要么是被构造的
      throw failedPrecondition("回调金额与支付单不一致", {
        paymentId: row.id,
        expected: row.amountCents,
        received: event.amountCents,
      });
    }

    const nextStatus: PaymentStatus =
      event.status === "SUCCEEDED"
        ? "SUCCEEDED"
        : event.status === "REFUNDED"
          ? "REFUNDED"
          : "FAILED";

    const [, updated] = await this.db.$transaction([
      this.db.paymentEvent.create({
        data: {
          id: `pevt_${randomUUID().replace(/-/g, "")}`,
          paymentId: row.id,
          provider: input.provider,
          providerEventId: event.providerEventId,
          type: `payment.${nextStatus.toLowerCase()}`,
          payload: input.body.slice(0, 20_000),
        },
      }),
      this.db.payment.update({
        where: { id: row.id },
        data: {
          status: nextStatus,
          providerTransactionId: event.providerTransactionId,
          paidAt:
            nextStatus === "SUCCEEDED"
              ? event.paidAt
                ? new Date(event.paidAt)
                : new Date()
              : row.paidAt,
        },
      }),
    ]);

    return {
      handled: true,
      payment: toPaymentIntent(updated as PaymentRow),
      duplicate: false,
    };
  }

  async refund(
    paymentId: string,
    input: RefundRequest,
    clientId: string,
  ): Promise<RefundRecord> {
    const payment = await this.getPayment(paymentId, clientId);
    if (payment.status !== "SUCCEEDED" && payment.status !== "PARTIALLY_REFUNDED") {
      throw failedPrecondition("只有已支付的订单可以退款", {
        status: payment.status,
      });
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw invalidRequest("退款金额须为正整数分");
    }

    const existing = await this.db.refund.findFirst({
      where: { paymentId, clientRefundNo: input.clientRefundNo },
    });
    if (existing) {
      // 按退款单号幂等，重试不会退第二次
      return toRefundRecord(existing as RefundRow);
    }

    const refunded = await this.db.refund.aggregate({
      where: { paymentId, status: { in: ["PENDING", "SUCCEEDED"] } },
      _sum: { amountCents: true },
    });
    const already = refunded._sum.amountCents ?? 0;
    if (already + input.amountCents > payment.amountCents) {
      throw failedPrecondition("退款总额超过支付金额", {
        paid: payment.amountCents,
        alreadyRefunded: already,
        requested: input.amountCents,
      });
    }

    const row = await this.db.refund.create({
      data: {
        id: `refund_${randomUUID().replace(/-/g, "")}`,
        paymentId,
        clientRefundNo: input.clientRefundNo,
        amountCents: input.amountCents,
        // 渠道退款是异步的，先记 PENDING，成功与否由渠道回调确认
        status: "PENDING",
        reason: input.reason ?? null,
      },
    });
    return toRefundRecord(row as RefundRow);
  }

  /**
   * 给产品的履约事件签名。
   * 产品收到后必须验签 + 按 eventId 幂等，才能执行加额度、开通课程等动作。
   */
  signFulfillmentEvent(event: PaymentFulfillmentEvent, timestamp: number): string {
    if (!this.webhookSecret) {
      throw failedPrecondition("未配置 PAYMENT_WEBHOOK_SECRET，无法下发履约事件");
    }
    return createHmac("sha256", this.webhookSecret)
      .update(`${timestamp}.${JSON.stringify(event)}`)
      .digest("hex");
  }

  verifyFulfillmentSignature(input: {
    rawBody: string;
    timestamp: number;
    signature: string;
    now?: number;
  }): boolean {
    if (!this.webhookSecret) return false;
    const skew = Math.abs((input.now ?? Date.now()) / 1000 - input.timestamp);
    // 超出时间窗的一律当重放拒绝
    if (skew > PAYMENT_WEBHOOK_MAX_SKEW_SECONDS) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${input.timestamp}.${input.rawBody}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  assertProviderEnabled(provider: PaymentProvider): void {
    if (!this.adapters.has(provider)) {
      throw permissionDenied(`未启用的支付渠道：${provider}`);
    }
  }
}

type RefundRow = {
  id: string;
  paymentId: string;
  clientRefundNo: string;
  amountCents: number;
  status: string;
  createdAt: Date;
};

export function toPaymentIntent(row: PaymentRow): PaymentIntent {
  return {
    paymentId: row.id,
    clientOrderNo: row.clientOrderNo,
    clientId: row.clientId,
    provider: row.provider as PaymentProvider,
    method: row.method as PaymentMethod,
    amountCents: row.amountCents,
    currency: "CNY",
    subject: row.subject,
    status: row.status as PaymentStatus,
    payerId: row.payerId,
    providerTransactionId: row.providerTransactionId,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    metadata: safeMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRefundRecord(row: RefundRow): RefundRecord {
  return {
    refundId: row.id,
    paymentId: row.paymentId,
    clientRefundNo: row.clientRefundNo,
    amountCents: row.amountCents,
    status: row.status as RefundRecord["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

function safeMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}
