# 公司架构边界

五层，一句话各管一件事：

> **Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。Studio 管运营和配置。**

```
                    account
              Identity / OIDC（已上线）
                       │
                       ▼
      ┌────────────────────────────────┐
      │            Products            │
      │  Andyyyds / softwarelist / …   │
      └───────────────┬────────────────┘
                      │
              platform-client  ← 来自 @yydsxwh/shared
                      │
                      ▼
                   platform
        ┌─────────────┼──────────────┐
       AI          Storage        Releases
                      │              │
                   Payments       Catalog
```

## 各层职责

| 层 | 仓库 | 负责 | 不负责 |
|---|---|---|---|
| Account | 独立系统，**已上线** | 用户身份、OIDC/OAuth、Session、全局 user sub | 任何产品业务 |
| Platform | `yydsxwh/platform` | 多产品通过网络共用的后端能力 | 身份、产品业务、运营文案 |
| Shared | `yydsxwh/shared` | 编译期共同依赖的类型、SDK、Design System | 密钥、服务端实现、数据库 |
| Product | `Andyyyds` / `softwarelist` / 日事 | 自己的领域业务与业务数据库 | 把公共能力再实现一遍 |
| Studio | UI 在 Andyyyds | 运营与配置界面 | 再实现一份 OSS / AI / 支付 |

## 数据所有权

**谁拥有数据，谁提供接口。禁止跨库直读。**

| 所有者 | 数据 |
|---|---|
| **account** | 用户身份、凭证、Session、全局 user sub |
| **platform** | 文件元数据、Release、产品目录事实、支付记录、AI 用量元数据 |
| **Andyyyds** | 课程、论坛、约搭、商城、优惠券、分销、商家、装扮、聊天 |
| **softwarelist** | 产品运营文案、网页文档、MathCode 额度 |
| **日事 rishi** | 待办、课表、提醒、笔记正文、同步元数据 |

## 身份：NEEDS_ACCOUNT_INTEGRATION

Account **不是未来规划**。缺的是产品与 platform 接到已有 IdP。

当前两站仍各持 cookie session。platform 只在服务凭证通过后接受 `X-Platform-Actor`。  
详见 `docs/identity-trust.md` 与 shared `NEEDS_ACCOUNT_INTEGRATION.md`。

目标：

```
OIDC 用户身份 → Product Session → Product Backend → Platform Verified User Context
```

## platform 形态

模块化单体。不做微服务集群、K8s、Kafka、Service Mesh。

只实现已有真实调用方的模块。Notifications / Audit / Entitlements / Theme / Maps / Search 只留边界。

## 支付 / Billing / Entitlements

| 概念 | 问题 | 现状 |
|---|---|---|
| Payment | 钱怎么付 | platform 核心已实现，渠道未迁 |
| Billing | 买了什么 | 各产品订单 |
| Entitlements | 因此有什么能力 | 仅 contract。account 已有全局 sub |

## API 版本

路径 `/v1/...`。v1 内只做向后兼容。契约唯一来源：`@yydsxwh/shared/contracts/*`。

## 安全默认

- Secret 不进 Git / shared
- 浏览器只拿短时签名
- 服务 token 按产品分发，可轮换、可吊销、可加 scope
- 日志脱敏；不记 prompt / 回复 / token
- `/health` 不因外部模型故障变红
