# Platform

公司公共平台服务仓库，包名 `@yydsxwh/platform`。

- **Account** 管身份（**已上线** `https://account.yydsxwh.com`）—— 不在本仓库，也不在这里再造一套
- **Platform** 管公共在线能力（本仓库）
- **Shared** 管公共代码与 SDK（`yydsxwh/shared`）
- **Product** 管自己的业务
- **Studio** 管运营 UI（在主站，调用本仓库管理 API）

## 形态：模块化单体

一个进程、一个库。**不做**微服务集群、K8s、Kafka、Service Mesh。

本轮不再为「像大公司」新增空模块。重点是让已有 5 个模块可部署、可观测、可接入。

## 探活

| 路径 | 含义 |
|---|---|
| `GET /health` | 进程活着 |
| `GET /ready` | 数据库与存储配置已就绪 |
| `GET /healthz` | `/health` 的兼容别名 |

## 快速开始

```bash
cp .env.example .env
npm install
npx prisma migrate deploy
npm run dev
```

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

预发域名（Owner 拍板）：`https://api-staging.yydsxwh.com`。  
生产规划：`https://api.yydsxwh.com`。方案见 `docs/staging.md`、`docs/owner-decisions.md`。  
**不要**对本仓库做生产自动部署。

## 认证

- Service Identity：每产品不同的 Bearer token，可轮换、可吊销、可加 scope
- End User Identity：仅在服务凭证通过后接受 `X-Platform-Actor`
- 浏览器不得持有服务 token。详见 `docs/identity-trust.md`

## 已实现模块

| 模块 | 代码状态 | 生产 |
|---|---|---|
| AI | IMPLEMENTED / TESTED / PR_READY | NOT_DEPLOYED |
| Storage | IMPLEMENTED / TESTED / PR_READY | NOT_DEPLOYED |
| Catalog | IMPLEMENTED / TESTED / PR_READY | NOT_DEPLOYED |
| Releases | IMPLEMENTED / TESTED / PR_READY | NOT_DEPLOYED |
| Payments 核心 | IMPLEMENTED / TESTED / PR_READY / STAGING_READY | NOT_DEPLOYED；NOT_PRODUCTION_MIGRATED |

## 文档

- `docs/owner-decisions.md` —— Owner 已拍板的域名 / Account / 支付 / PR 顺序
- `docs/next-execution-checklist.md` —— 拍板后执行清单与剩余阻塞
- `docs/company-architecture-round2-report.md` —— **当前第二轮收口报告（给其他 AI / Owner）**
- `docs/company-architecture-upgrade-report.md` —— 第一轮架构升级历史报告
- `docs/capability-registry.md`
- `docs/identity-trust.md`
- `docs/rishi-integration.md`
- `docs/staging.md`
- `docs/feature-flag-rollout.md`
- `docs/production-db-migration-checklist.md`
- `docs/company-platform-architecture.md`
- `docs/architecture.md`
- `docs/ai.md` / `storage.md` / `releases.md` / `payments.md`
