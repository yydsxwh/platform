# 公司级架构

面向「未来要支撑大量软件产品」设计，而不只是解决眼下的重复代码。

> **Account 管身份。Platform 管公共在线能力。Shared 管公共代码。
> Product 管自己的业务。Studio 管运营和配置。**

```
                          ┌───────────────┐
                          │    account    │   已上线 IdP：OIDC / OAuth / Session
                          │  Identity 层  │   JWKS / RS256 / 全局 usr_* sub
                          └───────┬───────┘
                                  │ OIDC
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
   ┌──────┴──────┐      ┌─────────┴────────┐     ┌────────┴────────┐
   │  Andyyyds   │      │   softwarelist   │     │  未来：日事 /   │
   │  公司主站    │      │  软件产品中心     │     │  course / ...   │
   │  + Studio   │      │                  │     │                 │
   └──────┬──────┘      └─────────┬────────┘     └────────┬────────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
                        ┌─────────┴──────────┐
                        │      shared        │  types / contracts
                        │  platform-client   │  SDK / Design System
                        └─────────┬──────────┘
                                  │  HTTPS + 服务凭证
                        ┌─────────┴──────────┐
                        │      platform      │  模块化单体
                        ├────────────────────┤
                        │ ai       storage   │
                        │ catalog  releases  │
                        │ payments           │
                        │ （预留：billing /   │
                        │  entitlements /    │
                        │  communications /  │
                        │  notifications /   │
                        │  maps / search /   │
                        │  config / flags /  │
                        │  audit）            │
                        └─────────┬──────────┘
                                  │
             ┌────────────┬───────┴───────┬─────────────┐
             ▼            ▼               ▼             ▼
        Qwen/OpenAI   阿里云 OSS      微信/支付宝     （未来）推送厂商
```

## 五层各管什么

| 层 | 管 | 不管 |
|---|---|---|
| **Account** | 用户、注册登录、OIDC/OAuth、Session、MFA、Passkey、账号安全、全局 user sub | 任何产品业务 |
| **Platform** | 多产品通过网络共用的后端能力 | 身份、产品业务、运营文案 |
| **Shared** | 编译期共同依赖的类型、SDK、Design System | 密钥、服务端实现、数据库 |
| **Product** | 自己的领域业务与业务数据库 | 把公共能力再实现一遍 |
| **Studio** | 运营与配置的管理 UI | 服务实现本身 |

## Studio 的长期定位

Studio **继续留在 Andyyyds**，不搬去 platform。它是「公司运营 / 管理控制台」：

```
Studio（UI 在主站）
  → 管主站配置        直接读写主站库
  → 管 Platform AI    调 platform /v1/ai/*
  → 管 Storage        调 platform /v1/storage/*
  → 管 Payments       调 platform /v1/payments/*
  → 管 Releases       调 platform /v1/releases/*
  → 管 Catalog        调 platform /v1/catalog/*
  → 看 Audit / Usage  调 platform 管理面
```

关键一条：**管理 UI 在主站，不等于服务实现也要留主站。**
Studio 逐步改成调用 platform 管理 API，主站不再持有这些能力的实现与密钥。

本轮已落地的第一例：Studio 的「AI 接口」面板保留，但新增一块 platform 接管状态
（Provider 健康度、用途路由、近 7 天用量与成本），数据来自 platform 管理 API，
**面板拿不到、也不展示任何 Key**。

## 模块化单体，不是微服务

platform 是一个进程、一个库，模块之间只通过各自的 Service 交互。

**不做**微服务集群、Kubernetes、Kafka、Service Mesh、复杂 API Gateway。
规模真的上来了再按模块拆进程。

新增模块的准入规则：

1. 已有真实能力，或**至少两个产品明确会用** → 可以实现
2. 只是未来可能 → 只写边界与文档，不写空代码

## API 边界与未来 Gateway

当前由 platform 单体直接提供，路径已经按未来统一域名的形状组织：

```
/v1/ai/…        /v1/storage/…     /v1/releases/…
/v1/catalog/…   /v1/payments/…
```

Owner 拍板：预发 `https://api-staging.yydsxwh.com`，生产 `https://api.yydsxwh.com`。
路径与鉴权不用改，反代即可。audience 用生产资源标识 `https://api.yydsxwh.com`，
不要用产品 client_id。

- 服务间认证：`Authorization: Bearer <token>`，一个调用方一把，可单独吊销
- 用户身份：仅在服务凭证通过后接受 `X-Platform-Actor`；产品接好 account 后传全局 sub，**头名称不变**。详见 `identity-trust.md`
- 版本：路径带 `/v1`，v1 内只做向后兼容变更
- 错误：统一 `error.code`，调用方不要 match 文案

## 数据所有权

**谁拥有数据，谁提供接口。禁止跨库直接读取。**

| 所有者 | 数据 |
|---|---|
| account DB | 用户身份、凭证、Session、全局 user sub |
| platform DB | 文件元数据、Release、产品目录事实、支付记录、AI 用量 |
| Andyyyds DB | 主站业务：课程、论坛、约搭、商城、优惠券、分销、商家、装扮、聊天 |
| softwarelist DB | 软件站业务与内容、网页文档、MathCode 额度 |
| rishi DB（产品未进本工作区） | 待办、课表、提醒、笔记正文、同步元数据 |
| 未来 course DB | 课程业务数据 |

跨系统一律走 API / event / SDK。

## Secret 管理原则

**这些永远不得进入 Git，也不得进入 shared：**
AI API Key、OSS AccessKey、微信支付私钥、支付宝私钥、地图 Key、SMS Secret、
数据库 URL、SSH Key、Webhook Secret。

规则：

1. 代码只从**环境变量 / Secret Store** 读取，`.env.example` 只放占位符
2. AI Key 再加一层间接：配置里写 `apiKeyEnv` 指向变量名，Key 在它自己的变量里，
   可以单独轮换、单独收紧读取权限
3. **任何 API 响应都不返回 Key**；管理面只报「有没有配、来自哪个环境变量名」
4. 日志自动脱敏：命中 `key|secret|token|password|authorization|signature|cookie|credential`
   的字段一律输出 `[REDACTED]`
5. Studio 可以配置非敏感 metadata（选哪个 provider、哪个模型、限额），
   **Secret 本身不在管理界面明文展示**
6. 浏览器永远只拿短期签名，不拿长期凭证

## 未来事件架构

现在**不引入 Kafka**。但公共平台要能长成下面这些领域事件：

```
PaymentSucceeded    FileUploaded    ReleasePublished
EntitlementChanged  UserNotificationRequested
```

当前的最简实现：**数据库事务 + 出站 webhook**。
支付回调已经是这个形状——事务内同时写入 `PaymentEvent`（幂等去重）与支付状态，
再向产品下发带签名和时间戳的履约事件。

升级路径：先把出站 webhook 抽成 `EventPublisher` 接口，再换队列实现；
消费方本来就要求按 `eventId` 幂等，换传输不影响正确性。

## Observability

不建监控集群，但格式先统一，以后接采集不用回头改每个调用点：

- **requestId** 贯穿请求，响应头回传，可与调用方日志对账
- **结构化 JSON 日志**：`ts / level / service / module / message / clientId / route / durationMs / result / errorCode`
- **错误分类**：`CLIENT_ERROR` / `AUTH_ERROR` / `PROVIDER_ERROR` / `INTERNAL_ERROR`（仅失败请求）
- **敏感字段自动脱敏**（含 prompt / reply / token）
- **探活**：`GET /health` 进程活着；`GET /ready` 检查 DB。外部 AI 故障不拖死 `/health`

metrics / tracing / 错误聚合：契约预留，**不部署集群**。

## 迁移原则

1. **渐进**：每项能力都有开关，默认关闭，上线后行为零变化
2. **兼容旧路由**：`/api/app/download/{file}` 这类 URL 不变，内部改实现
3. **保留旧数据**：历史 OSS / 本地 URL 继续走原路径，不需要回填
4. **先确认再删**：新实现跑稳、消费方切完、测试通过，才删旧副本
5. **可回滚**：出问题改一个环境变量即可，不用回滚代码
