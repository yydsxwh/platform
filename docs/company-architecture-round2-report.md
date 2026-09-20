# 公司公共架构第二轮收口报告

> 状态词：`IMPLEMENTED` / `TESTED` / `PR_READY` / `MERGED` / `DEPLOYED` /
> `PRODUCTION_VERIFIED` / `DOCUMENTED` / `PLANNED`  
> **禁止**把 `PR_READY` 写成 `DEPLOYED`，把「预发准备完成」写成「生产上线」，
> 把「contract 已写」写成「真实 account 集成完成」。

文档版本：`2026-09-20`  
覆盖仓库：`andyyyds`、`platform`、`shared`、`softwarelist`  
本工作区**没有** account / rishi 源码。

---

## 1. 最终五层架构

`DOCUMENTED`

**Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。Studio 管运营和配置。**

```
                         Studio / Admin
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
       Account             Platform             Products
  Identity / OIDC       Shared Services       Business Domains
  （已上线）              AI / Storage
                         Releases / Catalog
                         Payments
                              │
                           Shared
                 Contracts / SDK / Types
```

## 2. Account 当前真实状态

`PRODUCTION`（独立系统）+ 产品接入 `NEEDS_ACCOUNT_INTEGRATION`

Account **已经上线**：OAuth 2.0、OIDC、Auth Code + PKCE、Discovery、JWKS、
RS256 ID Token、UserInfo、Refresh Token Rotation、Session、全局不可变 `usr_*` sub。

本工作区未改 account 源码。主站与 softwarelist **尚未**切到 OIDC，仍各持 cookie session。

## 3. 本轮修正了哪些错误文档

`DOCUMENTED`

| 旧陈述 | 现陈述 |
|---|---|
| `account（未来）` / 「尚未建立」 | Account 已是正式 IdP |
| `NEEDS_ACCOUNT_MIGRATION`（还没建设） | `NEEDS_ACCOUNT_INTEGRATION`（缺接入联调） |
| 「等待 account + entitlements」 | account 已具备；缺 Entitlements 或产品联调 |
| Actor 头「account 上线后再换 sub」 | Account 已上线；头名不变，产品接入后传 `usr_*` |

已改：shared README / identity / 新 INTEGRATION 文档；platform 全部架构文档。

## 4. Platform 身份信任模型

`IMPLEMENTED` / `TESTED` / `PR_READY`

浏览器不能单独让 platform 相信 `X-Platform-Actor`。  
`/v1/*` 先验 Bearer 服务凭证，失败则 401，不读 Actor。  
详见 `docs/identity-trust.md`。

## 5. Service Identity 模型

`IMPLEMENTED` / `TESTED` / `PR_READY`

- 每产品不同 token（andyyyds / softwarelist / 可加 rishi）
- 同一 client 多 token = 轮换
- 从环境变量删除 = 吊销（需重启）
- 可选 scope：`clientId:token:ai+storage`
- 日志脱敏，不打印完整 token

## 6. Verified User Context 长期方案

`DOCUMENTED` / `PLANNED` / `NEEDS_ACCOUNT_INTEGRATION`

契约：`@yydsxwh/shared/contracts/identity`  
预留头：`X-Platform-User-Assertion`  
本轮**不**实现第二套 OAuth 或 assertion 验签。

## 7. Shared 当前状态

`IMPLEMENTED` / `TESTED` / `PR_READY`（tag `v0.5.1`，未 merge 到生产使用方）

仍是唯一公共代码来源。两站 `packages/shared` 只有 re-export 与 adapter，
本轮未发现新复制的公共实现。禁止项（Prisma / Secret / Provider 实现）未进入 shared。

日事领域类型**没有**放进 shared。platform-client 已覆盖 AI / Storage / Catalog / Releases。

## 8. AI

`IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED`

purpose 路由、timeout、fallback、限流、用量与成本、错误归一、Secret masking。  
Studio 管理面不返回 Key。产品开关默认 `false`。

## 9. Storage

`IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED`

namespace / MIME / 大小 / 权限 / 短时 URL / 删除 / 404 / 未授权。  
新增可选 `STORAGE_LOCAL_SIGNING_KEY`，避免轮换 service token 时本地签名全部失效。  
业务数据不得用 OSS JSON 代替数据库。

## 10. Catalog

`IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED`

事实唯一来源在 platform。两站本地 `SOFTWARE_PRODUCTS` 保留为文案 + fallback。  
默认开关 `false`。本轮不删旧数组。

## 11. Releases

`IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED`

旧 `/api/app/download/...` 兼容。硬编码 apk/exe 仅 fallback。

## 12. Payments

`IMPLEMENTED` / `TESTED` / `PR_READY` / `STAGING_READY` / `NOT_DEPLOYED` / `NOT_PRODUCTION_MIGRATED`

核心：create / query / refund / webhook / 幂等 / 金额核对 / 履约事件。  
履约仍属产品。Owner 拍板：本轮**不切**真实微信/支付宝生产商户。**不是** `PRODUCTION_VERIFIED`。

## 13. Studio / Admin

`DOCUMENTED`

UI 留 Andyyyds。服务实现属 platform。已有 Platform AI 状态面板（无 Key）。

## 14. Secret 管理结果

`DOCUMENTED`（审计）

Git 跟踪文件中**未发现**真实 AI Key / OSS AK / 支付私钥 / SSH / 数据库口令。  
`.env` 已被 gitignore。`.env.example` 仅占位。

疑似需 Owner 知晓（**不打印值**）：

| 路径 | 类型 | 是否需要 rotate |
|---|---|---|
| `andyyyds/.env`（本地未跟踪） | 开发环境变量，可能含真实商户材料 | 若曾提交或泄漏则 rotate；当前未进 Git |
| `andyyyds/.env.example` 中的证书**路径** | 生产机路径提示，不是密钥本身 | 否 |
| 测试里的 `sk-dashscope-secret` 等 | 假值 | 否 |

## 15. Observability

`IMPLEMENTED` / `TESTED`

请求日志含 requestId、clientId、module、route、durationMs、result、errorCode。  
不记录 prompt / 回复 / Secret。metrics/tracing：`PLANNED`。

## 16. Platform DB / migrations

`DOCUMENTED`

两条已有 migration，可 `prisma migrate deploy` 重复执行。  
禁止 reset / drop production。本轮无新表。  
清单：`docs/production-db-migration-checklist.md`。

## 17. Health / Ready

`IMPLEMENTED` / `TESTED` / `PR_READY`

- `GET /health` `GET /healthz`：进程活着，不受 AI Provider 影响
- `GET /ready`：数据库 + 存储配置；失败 503

## 18. 预发部署方案

`DOCUMENTED`（不是 `DEPLOYED`）

见 `docs/staging.md`、`docs/owner-decisions.md`。  
Owner 已拍板：预发 `https://api-staging.yydsxwh.com`（目录 `/var/www/platform-staging`，进程 `platform-staging`，`127.0.0.1:4000`）；生产规划 `https://api.yydsxwh.com`。  
DNS/TLS/装机 **未执行**，不是 `DEPLOYED`。

## 19. Feature Flag 验证顺序

`DOCUMENTED`

默认全 `false`（本轮未改默认）。顺序：AI → Catalog → Releases → Storage → Payments。  
每次只开一个。Payments 最后。

## 20. account 下一轮如何接

`PLANNED` / `NEEDS_ACCOUNT_INTEGRATION`

Owner 已拍板公开标识：

- issuer `https://account.yydsxwh.com`
- JWKS `https://account.yydsxwh.com/.well-known/jwks.json`
- audience `https://api.yydsxwh.com`（不是产品 client_id）

仍要打开 account 仓库联调：Discovery 实测、JWKS 行为、aud 兼容、assertion 验签、产品 Session。  
不在本工作区伪造 account，不擅自改 account。

## 21. Rishi 接入标准

`DOCUMENTED`

见 `docs/rishi-integration.md`。Account → OIDC → Rishi Backend → Rishi DB → Platform。

## 22. Rishi 数据应该存哪里

| 数据 | 位置 |
|---|---|
| 待办、课表、笔记正文、Reminder、同步元数据 | Rishi DB |
| 图片、附件、Word、导出文件 | Platform Storage |
| 用户身份 / sub | Account |
| AI 调用 | Platform AI |
| 推送送达 | 未来 Platform Notifications |

## 23. Rishi Sync Engine 应该在哪里

**在 Rishi，不在 platform。** `DOCUMENTED`

## 24. 移动端如何安全调用 Platform

App → 产品后端 → Platform。禁止 App 持有 service token 或 OSS AK。上传走短时签名。

## 25. Shared 还缺哪些 SDK

对日事公共能力：AI / Storage / Catalog / Releases **已够**。  
缺的是 **account OIDC 客户端实现**（类型已有）与 **assertion 验签**（仅契约）。  
不要把 Rishi 领域模型放进 shared。

## 26. Package 长期 Roadmap

`PLANNED`（本轮不迁发布基础设施）

未来拆 `@yydsxwh/types` / `platform-client` / `auth-client` / `design-system`，
走正式 registry + SemVer。现在继续 `git+…#v0.5.1`。

## 27. Capability Registry 更新结果

`DOCUMENTED`

每项含 Current/Target Owner、Status、Callers、Data/Secret Owner、API、Flag、Production State。  
Account = `CURRENT` + `PRODUCTION`。五模块 = 代码齐 + `NOT_DEPLOYED`。

## 28. lint / typecheck / test / build

| 仓库 | lint | typecheck | test | build |
|---|---|---|---|---|
| shared | 通过 | 通过 | 59/59 | N/A（发 TS 源码） |
| platform | 通过 | 通过 | 116/116 | 通过 |
| andyyyds | **仓库级 eslint 本就失败**（desktop `require`、既有 React Compiler 规则；本轮未改这些文件） | `tsc --noEmit` 通过 | 8/8 | 通过 |
| softwarelist | 未作为本轮门禁重跑全量 eslint（仓库无 `typecheck`/`test` 脚本） | `tsc --noEmit` 通过 | 6/6 | 通过 |

产品仓库没有 `npm run typecheck` / `npm run test` 脚本，上表用的是等价命令。
产品 Feature Flag 默认值仍全部为 `false`。

## 29. PR 列表

全部 **draft**，禁止自动 merge。

| 仓库 | PR | base |
|---|---|---|
| shared | https://github.com/yydsxwh/shared/pull/3 | `main` |
| platform | https://github.com/yydsxwh/platform/pull/3 | `main` |
| Andyyyds | https://github.com/yydsxwh/Andyyyds/pull/26 | `cursor/platform-adapters-cd2f`（**不是**生产分支） |
| softwarelist | https://github.com/yydsxwh/softwarelist/pull/4 | `cursor/platform-adapters-cd2f` |

既有、不要当成本轮已上生产：

| PR | 说明 |
|---|---|
| Andyyyds #24 | base = `Andyyyds20260901independentpackage` → **合并即生产部署** |
| Andyyyds #25 | adapters，叠在 shared-single-source 上 |
| softwarelist #2 / #3 | shared 接入与 adapters |
| platform #2 | 第一轮 Markdown 报告（可与本轮 #3 一并看） |

## 30. 推荐 merge 顺序（Owner 拍板）

```
1. shared v0.5.1
2. platform（依赖 shared tag）
3. softwarelist / 产品非生产适配层
4. Andyyyds 非生产中间分支（本轮 #26，base 不是生产基线）
5. Platform 预发部署（人工；本 Agent 不执行）
6. 单项 Feature Flag 验证（AI → Catalog → Releases → Storage → Payments）
7. 主站生产分支最后
```

**禁止**自动 merge 任何进入 `Andyyyds20260901independentpackage` 的 PR（含 #24）。

## 31. 哪些 PR 会触发生产部署

**标红：`Andyyyds` 合并进 `Andyyyds20260901independentpackage` 会触发**
`.github/workflows/deploy.yml`，SSH 到香港生产机并 `pm2 restart`。

本轮 **andyyyds 的 PR 不得以该分支为 merge 目标**。  
platform / shared / softwarelist **没有**同等自动生产部署。

不要 merge：`Andyyyds#24`（base 即生产分支）除非 Owner 明确要部署。

## 32. 需要配置哪些 Secret（预发，非本轮自动写入）

| 变量 | 谁用 |
|---|---|
| `PLATFORM_SERVICE_TOKENS` | platform，每产品不同 |
| `PLATFORM_SERVICE_TOKEN` | 各产品后端 |
| `DATABASE_URL` | platform |
| `AI_KEY_*` | 仅 platform |
| `OSS_ACCESS_KEY_ID` / `SECRET` | 仅 platform（若用 OSS） |
| `PAYMENT_WEBHOOK_SECRET` | platform |
| `STORAGE_LOCAL_SIGNING_KEY` | platform 推荐 |
| `ACCOUNT_ISSUER` / `JWKS_URI` / `AUDIENCE` | 公开标识已拍板，写入预发即可；验签下一轮 |

## 33. NEEDS_ACCOUNT_INTEGRATION

（issuer / JWKS URL / audience **值**已拍板，下面是行为联调）

- Discovery 实际响应是否与拍板值一致
- JWKS 行为
- account 现有实现是否接受 Platform audience（不要改 account）
- User Assertion / Platform 验签
- 产品 Session 与 OIDC 打通
- 两站用户合并（必须经 account）
- Entitlements 挂全局 sub
- docs/mathcode 跨站合并

## 34. NEEDS_OWNER_CONFIRMATION

（域名规划已拍板，下面是落地）

- DNS 记录是否已添加
- TLS 证书策略
- 服务器是否已建 `/var/www/platform-staging`、是否占用 4000
- 生产 Secret 配置
- 主站生产分支 PR 何时 merge（**禁止 Agent 自动合**）
- 真实支付商户资料 / 生产回调切换（Owner：本轮不做）
- softwarelist 静态安装包 nginx 布局
- 本地未跟踪的 `andyyyds/.env` 是否含需轮换材料

## 35. 下一步建议（执行清单）

1. 人工 review draft PR：shared#3 → platform#3 → 产品非生产 PR（**不要合 Andyyyds#24 / 生产基线**）
2. Owner 在香港机落地预发：目录、独立 DB/Secret、Nginx、DNS/TLS → `https://api-staging.yydsxwh.com/health`
3. 预发按 AI → Catalog → Releases → Storage → Payments 每次开一个 Flag
4. 打开 account 仓库联调 Discovery / JWKS / aud
5. 日事按 `rishi-integration.md` 接 Storage / AI
6. 支付真实渠道：另开受控任务，本轮不切

---

*本报告描述收口、Owner 拍板与预发准备，不是生产上线。*
