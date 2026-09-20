# Platform

公司公共平台服务仓库，包名 `@yydsxwh/platform`。

四层边界中的 **Platform 层：多个产品通过网络共同使用的后端能力**。

- **Account** 管身份（用户、OIDC、Session、密码、验证码业务）—— 不在本仓库
- **Platform** 管公共在线能力（本仓库）
- **Shared** 管公共代码与 SDK（`yydsxwh/shared`）
- **Product** 管自己的业务（Andyyyds / softwarelist / 日事 …）

## 形态：模块化单体

一个进程、一个库，模块之间只通过各自的 Service 交互，HTTP 层薄到可以随时换掉。
**不做微服务集群、不上 Kubernetes、不引 Kafka、不做 Service Mesh。** 规模真的上来了
再按模块拆进程，现在不提前微服务化。

```
src/
  modules/
    ai/           AI Provider、模型路由、限流、用量
    storage/      文件与对象存储
    catalog/      公司产品目录
    releases/     软件版本与安装包
    payments/     支付公共核心
  http/           路由与认证，薄层
  config.ts       环境校验，配置不合法就在启动时失败
```

接口契约不在本仓库定义，而在 `@yydsxwh/shared/contracts/*`——platform 实现与各产品
调用共用同一份类型，避免两边各写一套慢慢对不上。

## 技术栈

TypeScript + Hono + Prisma（SQLite）。构建用 esbuild 打成单文件，生产 `node dist/server.js`。

## 快速开始

```bash
cp .env.example .env     # 填服务凭证；OSS 留空则用本地盘
npm install
npm run db:push
npm run dev
```

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## 认证与边界

- 服务间认证：`Authorization: Bearer <token>`，一个调用方一把 token，可单独吊销
- `X-Platform-Actor` 携带最终用户标识；account 上线后换成全局 user sub，头名称不变
- 数据按 `clientId` 隔离：跨调用方读别人的对象一律按「不存在」处理，不泄露 id 是否有效
- **OSS AccessKey 只存在于本服务进程**，任何响应都不会带出去；浏览器只拿短期签名 URL

## 已实现的模块

| 模块 | 状态 | 说明 |
|---|---|---|
| AI | 已实现 | 多 Provider、按用途路由、超时、fallback、限流、用量与成本 |
| Storage / Files | 已实现 | 本地盘与阿里云 OSS，签名直传、分片、签名下载 |
| Catalog | 已实现 | 公司产品目录的唯一机器可读来源 |
| Releases | 已实现 | Release / ReleaseAsset、latest 查询、签名下载 |
| Payments | 已实现（未接入生产） | 支付单、幂等、回调验签、履约事件 |

**故意没做**：Notifications、Communications、Maps、Search、Config / Feature Flags、
Billing / Entitlements、Audit、Theme Service。这些目前没有第二个真实调用方，
只在文档里定义边界，不写空服务撑架构图。

## 文档

- `docs/company-architecture-upgrade-report.md` —— **架构升级总报告（Markdown，给其他 AI / 协作者首选）**
- `docs/company-platform-architecture.md` —— 公司级五层架构、Studio 定位、Secret 原则
- `docs/capability-registry.md` —— **每新增一个公共能力先更新这张表**
- `docs/architecture.md` —— 四层边界、数据所有权、版本策略
- `docs/ai.md`
- `docs/storage.md`
- `docs/releases.md`
- `docs/payments.md`
