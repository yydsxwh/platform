# Payments

platform 只管**钱怎么付**：发起支付、对接渠道、验签回调、幂等落账，
然后给产品一个明确的履约结果。

产品收到结果后执行自己的业务。**绝不要把产品履约逻辑放进 payment**，
否则它会慢慢长成第二个业务系统。

## 正确的分工

```
用户支付
  → platform payment     创建、调起、验签、幂等落账
  → 明确的履约结果
  → 产品执行自己的业务
```

| 动作 | 归属 |
|---|---|
| 创建支付、调起渠道、查支付状态 | platform |
| 回调验签、幂等、防重放、金额核对 | platform |
| 退款发起与累计校验 | platform |
| MathCode 加额度 | MathCode |
| 课程开通、专栏解锁 | courses |
| 优惠券核销、分销结算、商家抽成 | Andyyyds 主站业务 |

## 三条不退让的规则

1. **不相信客户端说的「支付成功」**，只认渠道验签通过的服务端回调
2. **回调按 `providerEventId` 幂等**：渠道会重推直到收到 2xx，重复送达只能处理一次
3. **回调金额与订单金额不符一律拒绝落账**——这类回调要么配置串了，要么是构造的

## 幂等

| 操作 | 幂等键 |
|---|---|
| 创建支付 | `clientId` + `clientOrderNo` |
| 渠道回调 | `provider` + `providerEventId` |
| 退款 | `paymentId` + `clientRefundNo` |

同一订单号重复创建返回原单，用户狂点不会开出第二笔。
同一订单号换了金额则**拒绝**，不覆盖原单——多半是产品侧算错或被篡改。

退款校验累计不超过支付金额。

## 接口

```
POST /v1/payments                        创建（幂等）
GET  /v1/payments/{paymentId}
GET  /v1/payments/by-order-no?clientOrderNo=…    用产品自己的订单号反查
POST /v1/payments/{paymentId}/refunds
POST /v1/payment-webhooks/{provider}     渠道回调，无服务凭证
```

回调端点不走服务凭证：渠道不可能带我们的 Bearer，凭证是渠道自己的签名，
由各 provider adapter 验。验签失败只回 `{ ok: false }`，**不回显任何细节**——
不该给试探者可用的反馈。

## 履约事件

platform 通知产品时带签名与时间戳：

```
x-platform-signature   HMAC-SHA256(`{timestamp}.{rawBody}`, PAYMENT_WEBHOOK_SECRET)
x-platform-timestamp
```

超出 5 分钟的时间偏移按重放拒绝。**产品侧必须验签 + 按 `eventId` 幂等**
才能执行加额度、开通课程等动作。

## 渠道现状

| 渠道 | 状态 |
|---|---|
| `MOCK` | 已实现，仅开发与测试。配置层禁止生产开启，否则任何人都能把订单标成已付 |
| `WECHAT` | **未迁移**，服务端实现仍在主站 |
| `ALIPAY` | **未迁移**，服务端实现仍在主站 |

微信与支付宝的迁移要连同商户证书、API v3 密钥与回调域名一起切，是独立一步，
必须人工批准并安排窗口。本轮先把核心流程（幂等、验签、金额核对、退款累计、
履约事件签名）做实并测试到位，渠道按需接。

**两个站点当前的支付链路完全没有改动**，仍走各自的实现。
