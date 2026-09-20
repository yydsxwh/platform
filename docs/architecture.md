# 公司架构边界

四层边界，一句话各管一件事：

> **Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。**

```
                    account
                 Identity / OIDC
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
     Storage       Releases       Payments
        │             │              │
        ▼             ▼              ▼
       OSS         Metadata     Payment Providers
```

## 各层职责

| 层 | 仓库 | 负责 | 不负责 |
|---|---|---|---|
| Account | 尚未建立 | 用户身份、注册登录、OIDC/OAuth、Session、账号安全、全局 user sub | 任何产品业务 |
| Platform | `yydsxwh/platform` | 多产品通过网络共用的后端能力 | 身份、产品业务、运营文案 |
| Shared | `yydsxwh/shared` | 多仓库编译期共同依赖的类型、SDK、Design System | 任何密钥、服务端实现、数据库 |
| Product | `Andyyyds` / `softwarelist` / 各产品 | 自己的领域业务与业务数据库 | 把公共能力再实现一遍 |

## 数据所有权

**谁拥有数据，谁提供接口。任何人不得直接读别人的库。**

| 所有者 | 数据 |
|---|---|
| **account** | 用户身份、凭证、Session、全局 user sub |
| **platform** | 公共平台数据：文件元数据、Release 与安装包、产品目录事实、支付记录与回调事件 |
| **Andyyyds** | 主站业务数据：课程、论坛、约搭、商城、优惠券、分销、商家、装扮、聊天 |
| **softwarelist** | 软件站业务与内容数据：产品运营文案、网页文档、MathCode 额度与用量 |
| **未来 rishi（日事）** | 待办、课表、提醒、笔记等业务数据 |

明确禁止：

- softwarelist 直接读 Andyyyds 数据库
- Andyyyds 直接读 platform 数据库
- 任何产品直接读 account 数据库

全部走 API 或标准协议。跨系统依赖优先通过 **API / SDK / 标准协议**，而不是复制源码。

## 数据库原则

不做「全公司超级数据库」。服务拥有自己的数据。

platform 当前共用一个 platform DB，但模块在逻辑上分区（表名前缀 + 模块内 Service 独占访问），
将来规模上来可以按模块拆库。**现在不提前微服务化。**

## platform 形态：模块化单体

不做微服务集群、不上 Kubernetes、不引 Kafka、不做 Service Mesh。
一个进程、一个库，模块之间只通过各自的 Service 交互，HTTP 层薄到可以随时换掉。

只实现**当前已经有真实调用方**的模块。下面这些只定义边界，不写空服务：

| 未实现 | 边界定义 | 什么时候做 |
|---|---|---|
| Notifications | 站内信 / 推送 / 邮件的统一下发 | 出现第二个真实调用方（例如日事的提醒推送）时 |
| Audit | 平台侧操作审计流 | 有合规或排查需求时；当前各模块已记 requestId |
| Entitlements | 见下 | 出现第二个需要跨产品判断权益的场景时 |
| Theme Service | 用户主题云端同步 | 出现第二个产品需要同一套用户主题时 |

## 支付 / Billing / Entitlements 的分工

三件不同的事，不要混成一个系统：

| 概念 | 回答什么问题 | 现状 |
|---|---|---|
| **Payment** | 钱怎么付 | 已在 platform 实现 |
| **Billing** | 用户买了什么 | 当前就是各产品自己的订单，未抽象 |
| **Entitlements** | 用户因此拥有什么能力 | 未实现，仅定义形态 |

Entitlements 的目标形态（**仅为 contract 提案，本轮不实现**）：

```
usr_xxx
  rishi.pro   = true
  course.vip  = true
  mathcode.quota = 150
```

当前真实存在的只有「支付订单 + MathCode 额度」一种情况。只有一个调用方时做完整
SaaS Billing 是过度设计，因此本轮只记录边界。

## 支付履约边界

```
用户支付 → platform payment → 验签 + 幂等落账 → 明确的履约结果 → 产品执行自己的业务
```

platform **不做**产品履约。这些仍属于产品：

| 履约动作 | 归属 |
|---|---|
| MathCode 加额度 | MathCode（softwarelist / 主站各自的库） |
| 课程开通、专栏解锁 | Andyyyds courses |
| 优惠券核销、分销结算、商家抽成 | Andyyyds 主站业务 |

产品处理履约事件必须**验签 + 按 eventId 幂等**，且不得相信客户端上报的「支付成功」。

## API 版本与兼容

路径带版本号（`/v1/...`）。

- v1 内只做向后兼容变更：可以加可选字段；消费端必须容忍未知枚举值
- 不能删字段、不能改字段含义、不能把可选变必填
- 破坏性变更开 v2，v1 保留到所有调用方升级完成，并在本文件标注下线时间
- 请求响应类型的唯一来源是 `@yydsxwh/shared/contracts/*`，platform 与调用方共用一份

错误模型统一：调用方按 `error.code` 分支，不要 match `message` 文案。

## 安全默认

- **OSS AccessKey、支付密钥、Webhook Secret、OAuth Secret、数据库 URL、SSH Key 一律不得进入 Git**，
  `.env.example` 只放占位符
- 浏览器永远拿不到长期凭证，只拿短期签名 URL
- 日志不打印支付密钥、OSS 密钥、Access Token、Session、私钥；只记错误码与 requestId
- 服务间认证一把 token 一个调用方，可单独吊销；数据按 clientId 隔离
- 越权访问按「不存在」返回，不泄露 id 是否有效
- 限流与审计的扩展点预留在 `src/http/context.ts` 的中间件链上

## 身份：NEEDS_ACCOUNT_MIGRATION

account 仓库尚未建立。当前 Andyyyds 与 softwarelist **各自持有**一套 cookie session、
密码校验、短信登录、微信登录实现。

本轮**没有**把登录系统迁入 platform，也**没有**新建第二套统一身份，只做了两件事：

1. 在 `@yydsxwh/shared/auth/identity` 定义 `UserSub` / `OidcIdTokenClaims` / `SessionUser` / `AuthClient`
2. platform 的 `X-Platform-Actor` 头现在传各站自己的 user id，account 上线后换成全局 sub，**头名称不变**

目标形态：

```
产品 → OIDC → account
```

account 建立后应迁走：用户表与身份、密码、Session 签发与校验、OIDC Server、
登录验证码业务逻辑、微信 OAuth 换取身份、角色申请审批流。

platform 之后可提供 SMS / Email Provider 供 account 调用，但**验证码业务逻辑属于 account**：

```
account → platform communications → SMS provider
日事    → platform communications/notification → push provider
```
