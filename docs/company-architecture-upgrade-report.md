# 公司公共架构升级报告（Markdown 主文档）

> **给其他 AI 读本文档时**：本文是「架构决策 + 已完成工作 + 边界约束」的单一事实来源。
> 细节表与模块说明见同目录下的链接文档；**不要**把文中 `PR_READY` 误解为已上生产。

---

## 0. 元数据（机器可读）

| 字段 | 值 |
|---|---|
| 文档版本 | `2026-09-20` |
| 覆盖仓库 | `yydsxwh/andyyyds`、`yydsxwh/platform`、`yydsxwh/shared`、`yydsxwh/softwarelist` |
| 整体代码状态 | 多仓库 PR 已就绪；**默认开关均为关闭**，合并后行为应与合并前一致 |
| 生产部署 | **未**在本轮任务中执行；Capability Registry 中无 `DEPLOYED` / `PRODUCTION_VERIFIED` |
| shared 依赖 tag | `@yydsxwh/shared` → `git+https://github.com/yydsxwh/shared.git#v0.4.0` |
| 关联文档 | [capability-registry.md](./capability-registry.md)、[company-platform-architecture.md](./company-platform-architecture.md)、[architecture.md](./architecture.md) |
| shared 侧说明 | [shared/README.md](https://github.com/yydsxwh/shared/blob/main/README.md)、[NEEDS_ACCOUNT_MIGRATION.md](https://github.com/yydsxwh/shared/blob/main/NEEDS_ACCOUNT_MIGRATION.md) |

### 0.1 五层一句话

**Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。Studio 管运营和配置。**

### 0.2 状态词定义

| 状态 | 含义 |
|---|---|
| `IMPLEMENTED` | 代码已写入仓库 |
| `TESTED` | 对应仓库 `lint` / `typecheck` / `test` / `build` 已通过 |
| `PR_READY` | 已推分支、可审 PR；**不等于**已合并或已部署 |
| `MERGED` / `DEPLOYED` / `PRODUCTION_VERIFIED` | 本轮**均未**达到 |

---

## 1. 任务背景与目标

用户要求在四个仓库并存的前提下，从「解决重复代码」升级为「能支撑大量软件产品的公司级架构」：

1. 盘点公共能力归属（Capability Registry）。
2. 建立 `platform` 模块化单体（AI、Storage、Catalog、Releases、Payments 等）。
3. 建立独立 `shared`（`@yydsxwh/shared`）作为跨站代码唯一来源。
4. 产品侧通过**适配层 + 功能开关**渐进接入，默认关闭，可一键回滚。
5. **不**在本轮迁移：OSS/支付/登录的「生产切换」、account 仓库建设、platform 生产部署。
6. 账号 / OIDC 属于未来独立 **account** 仓库，**不**迁入 platform。

---

## 2. 仓库角色（当前）

| 仓库 | 角色 | 本轮主要变化 |
|---|---|---|
| **shared** | 类型、契约、platform-client SDK、i18n/validation/utils、Design Tokens | 从主站抽出真正跨站复用的纯代码；禁止 Secret 与 DB |
| **platform** | 模块化单体 HTTP 服务（Hono + Prisma） | 新增 ai / storage / catalog / releases / payments 模块与测试 |
| **andyyyds** | 公司主站 + Studio | 本地 `packages/shared` 改为 re-export 兼容层；新增 `platform-*.ts` 适配层 |
| **softwarelist** | 软件产品中心 | 同上；删除一批与软件站无关的 shared 副本文件 |

---

## 3. 架构分层与数据所有权

### 3.1 依赖方向

```
account（未来）
    │ OIDC
    ▼
Products（andyyyds / softwarelist / …）
    │  HTTPS + Bearer 服务 token
    ▼
platform（公共在线能力）
    ▲
    │ 编译期依赖
shared（contracts + platform-client + 纯工具）
```

### 3.2 谁拥有什么数据

| 所有者 | 数据 |
|---|---|
| account DB（未来） | 用户身份、凭证、Session、全局 user sub |
| platform DB | 文件元数据、Catalog、Release、Payment、AI 用量元数据 |
| Andyyyds DB | 课程、论坛、约搭、商城、优惠券、分销、商家、装扮、聊天等 |
| softwarelist DB | 软件站内容、MathCode 额度等 |

**禁止**跨库直读；跨系统只走 API / SDK / 标准协议。

### 3.3 Studio 定位

Studio **UI 留在 Andyyyds**；长期应调用 platform 管理 API，而不是在主站再实现一套 Storage/AI/Payments。
本轮已落地示例：Studio 设置中的 **Platform AI 状态**（Provider 健康、用途路由、近 7 天用量），**不展示任何 API Key**。

---

## 4. 阶段 A：shared 单一来源（已完成）

### 4.1 原则

- 以 `Andyyyds/packages/shared` 为**对照来源**，只迁「两个以上站点会用、纯函数、无 Prisma、无框架运行时」的模块。
- **不迁**：商城、工作室业务、约搭、装扮、主站 CMS、支付/OSS **实现**、账号实现。
- 两站保留 `packages/shared/src/*.ts` 作为**兼容层**（`export * from "@yydsxwh/shared/..."`），旧 import 路径不断。
- `SOFTWARE_PRODUCTS` 数组仍各站本地维护；类型统一到 `@yydsxwh/shared/types/software-product`。

### 4.2 已迁入 `@yydsxwh/shared` 的模块（摘要）

| 类别 | 子路径示例 |
|---|---|
| types | `types/roles`, `types/domain`, `types/product`, `types/software-product`, `types/media` |
| utils | `utils/format`, `utils/money`, `utils/referral-code`, `utils/request-origin` |
| validation | `validation/username`, `validation/email`, `validation/phone`, `validation/order-form` |
| i18n | `i18n/locales`, `resolve-locale`, `opencc`, `source-hash` |
| client | `client/wechat-env`, `auth-channel-preference`, `wechat-pay-trade`, `wechat-jsapi-pay` |
| contracts | `contracts/version`, `error`, `ai`, `storage`, `catalog`, `releases`, `payments` |
| platform SDK | `platform-client/http`, `ai`, `storage`, `catalog`, `releases`, `payments`, `index` |
| design | `design/tokens` |
| auth（仅类型） | `auth/identity`（见 NEEDS_ACCOUNT_MIGRATION） |

### 4.3 故意留在各产品仓库的内容

| 内容 | 原因 |
|---|---|
| `auth.ts`, `sms.ts`, session, 微信 OAuth 等 | 归属未来 account；本轮只抽象类型 |
| `storage.ts` 主站 OSS 实现（1000+ 行） | 实现将逐步由 platform 替代；适配层已接好 |
| `wechat-pay.ts` / `alipay.ts` 等 | 渠道证书与回调域名切换风险大；platform 仅有核心 + mock |
| 商城、studio、decorate、portal CMS | PRODUCT_ONLY |
| 各站 `SOFTWARE_PRODUCTS` 运营文案 | Catalog 只存机器可读事实 |

### 4.4 两站如何引用 shared

```jsonc
// package.json
"@yydsxwh/shared": "git+https://github.com/yydsxwh/shared.git#v0.4.0"
```

- `next.config.ts` → `transpilePackages` 包含 `@yydsxwh/shared`
- `tsconfig.json` → `"@yydsxwh/shared/*": ["./node_modules/@yydsxwh/shared/src/*"]`

### 4.5 已修复的跨站 bug

- `opencc-js`：`Converter()` 返回可调用函数，不是 `.convert()`；错误类型曾掩盖于本地 `.d.ts`，已在 shared 修正并删除两站错误声明。

### 4.6 shared 测试

- `npm test`：**54** 项通过（含 platform-client、design tokens、validation 等）。

---

## 5. 阶段 B～F：platform 模块化单体（已完成实现，未生产切换）

### 5.1 形态约束

- **一个进程**、模块经各自 `Service` 交互；**不**上 K8s / Kafka / Service Mesh。
- HTTP 路径预留统一网关形态：`/v1/{module}/...`
- 契约类型只在 **shared/contracts**；platform 与产品共用。

### 5.2 已实现模块

| 模块 | 主要 API 前缀 | platform DB 表（逻辑） | 状态 |
|---|---|---|---|
| **AI** | `/v1/ai/*` | `AiUsage`（元数据，不存 prompt/回复正文） | TESTED → PR_READY |
| **Storage** | `/v1/storage/*` | `File` | TESTED → PR_READY |
| **Catalog** | `/v1/catalog/*` | `CatalogProduct` | TESTED → PR_READY |
| **Releases** | `/v1/releases/*` | `Release`, `ReleaseAsset` | TESTED → PR_READY |
| **Payments** | `/v1/payments/*`, webhooks | `Payment`, `PaymentEvent`, `Refund` | TESTED → PR_READY（渠道未迁） |

### 5.3 故意未实现的 platform 模块（仅边界）

Notifications、Communications（SMS/Email 通道）、Maps、Search、Config/Feature Flags、Billing/Entitlements、Audit 流、Theme Service、VOD 完整链路——见 [capability-registry.md](./capability-registry.md)。

### 5.4 platform 测试

- `npm test`：**103** 项通过（Storage / Catalog / Releases / Payments / AI / HTTP 错误等）。

### 5.5 鉴权与调用约定

- 服务间：`Authorization: Bearer <PLATFORM_SERVICE_TOKEN>`（按调用方分 token）。
- 用户上下文：`X-Platform-Actor`（account 上线后换全局 sub，**头名不变**）。
- 客户端标识：`X-Platform-Client`（如 `andyyyds`、`softwarelist`）。
- 错误：统一 `error.code`（`PlatformApiError`），**不要** match 人类可读文案。

---

## 6. AI 迁移（优先完成项）

### 6.1 迁移前问题

- 主站 SiteSettings + `ai-providers.ts` + MathCode 环境变量；**softwarelist 重复一套**。
- 同一能力多处配 Key，易不一致；Key 曾靠近业务代码与设置 JSON。

### 6.2 迁移后形态

- **platform/ai**：Provider 配置（`apiKeyEnv` 间接引用环境变量）、**按 purpose 路由**（如 `translate`、`vision-ocr`）、限流、超时、Provider 健康与 fallback、用量与成本估算。
- **shared**：`contracts/ai` + `platform-client/ai`。
- **产品**：`packages/shared/src/platform-ai.ts` → `chatViaPlatform()`；`PLATFORM_AI_ENABLED=false` 时走原逻辑。

### 6.3 调用方（已接适配层）

| 场景 | 文件（主站；软件站有镜像） |
|---|---|
| 正文翻译 | `packages/shared/src/i18n/content-translate.ts` |
| MathCode OCR/转换 | `packages/mathcode/lib/mathcode.ts` |
| Studio 管理视图 | `src/app/api/studio/ai/route.ts`、`src/components/platform-ai-status.tsx` |

### 6.4 Secret 规则（AI）

- Key 只在 **platform 进程**的环境变量中（如 `AI_KEY_*`）。
- 配置 JSON 只写 `apiKeyEnv` 变量名；日志自动脱敏；API ** never ** 返回 Key。

---

## 7. Storage / Catalog / Releases 边界

### 7.1 Storage

- Namespace 策略（MIME、大小、访问控制）：如 `avatars`、`images`、`media`、`app-installers`。
- 适配器：本地盘 + 阿里云 OSS；对外仅**短期签名 URL**。
- 产品适配：`platform-storage.ts`，开关 `PLATFORM_STORAGE_ENABLED`。

### 7.2 Catalog

- 存「公司有哪些产品、状态、支持端」等**事实**；运营长文案仍在 softwarelist / 主站。
- 产品页：`loadSoftwareProducts()`（`platform-catalog.ts`），开关 `PLATFORM_CATALOG_ENABLED`。

### 7.3 Releases

- 安装包元数据在 platform；字节在 Storage。
- **旧下载 URL 不变**（如 `/api/app/download/...`），内部可改问 Releases。
- 开关 `PLATFORM_RELEASES_ENABLED`。

---

## 8. Payments 边界

### 8.1 platform 已做

- 创建支付、查询、退款；webhook 验签；**幂等**（支付单、事件 `eventId`）；金额核对；向产品下发**履约事件**（带签名）。

### 8.2 platform 未做（仍属产品或待迁渠道）

- 微信/支付宝**真实渠道**实现与商户证书（仍在主站/软件站）。
- **产品履约**：MathCode 加额度、课程开通、优惠券、分销、商家结算——**PRODUCT_ONLY**，禁止塞进 payment 模块长成「第二个业务系统」。

### 8.3 三概念分离

| 概念 | 问题 | 现状 |
|---|---|---|
| Payment | 钱怎么付 | platform 核心已有 |
| Billing | 买了什么 | 各产品订单，未抽象 |
| Entitlements | 因此有什么能力 | 仅 contract 提案 |

---

## 9. softwarelist 瘦身（已完成）

- 删除与软件站无关、不可达的 `packages/shared` 副本（如 admin-dashboard、shop、studio 等），减少分叉维护面。
- 仍通过 `@yydsxwh/shared` + 本地兼容层与主站对齐。

---

## 10. Design Tokens（第一批）

- 位置：`@yydsxwh/shared/design/tokens`。
- 原则：**品牌一致，产品 UI 独立**；token 名与主站 CSS 变量（`--ink`、`--brand` 等）对齐。
- **装扮/主题业务**未动；仅抽取可共享的品牌变量层。

---

## 11. docs / MathCode 重复（未合并）

- 两站仍有各自 MathCode / 文档部署；合并需要 **account + entitlements**，见 shared 的 `NEEDS_ACCOUNT_MIGRATION.md`。
- 本轮仅为 MathCode **调用 AI** 接 platform 适配层，**不**合并部署单元。

---

## 12. 渐进迁移与功能开关

### 12.1 原则

1. 每项能力有独立开关，**默认 `false`**。
2. platform 不可达或关闭时，**自动 fallback** 原有实现。
3. 回滚：改环境变量即可，无需回滚代码。
4. 旧数据与旧 URL 继续有效；不要求一次性回填。

### 12.2 产品侧环境变量（andyyyds `.env.example` 示例）

```bash
PLATFORM_API_URL=""
PLATFORM_SERVICE_TOKEN=""      # 仅服务端，禁止进浏览器包
PLATFORM_CLIENT_ID="andyyyds"  # softwarelist 用 softwarelist

PLATFORM_STORAGE_ENABLED="false"
PLATFORM_CATALOG_ENABLED="false"
PLATFORM_RELEASES_ENABLED="false"
PLATFORM_AI_ENABLED="false"
```

### 12.3 产品侧适配层文件

| 文件 | 作用 |
|---|---|
| `packages/shared/src/platform-ai.ts` | AI chat 走 platform |
| `packages/shared/src/platform-storage.ts` | 上传/存储走 platform |
| `packages/shared/src/platform-catalog.ts` | 产品目录合并 platform 事实与本地文案 |
| `packages/shared/src/platform-releases.ts` | 最新版/安装包下载 |

---

## 13. Secret 与安全（全公司规则）

**不得进入 Git 或 shared：**

AI Key、OSS AK/SK、微信/支付宝私钥、地图 Key、SMS Secret、数据库 URL、Webhook Secret 等。

1. 代码只读环境变量 / Secret Store；`.env.example` 仅占位。
2. AI：`apiKeyEnv` 间接引用。
3. 响应与管理面**不返回** Secret；管理面最多报告「是否已配置、变量名」。
4. 结构化日志对敏感字段 `[REDACTED]`。
5. 浏览器只拿短期签名 URL，不拿长期凭证。

---

## 14. Observability（platform）

- 请求贯穿 `requestId`（响应头回传）。
- JSON 日志：`ts / level / service / module / message`。
- 错误分类：`CLIENT_ERROR` / `AUTH_ERROR` / `PROVIDER_ERROR` / `INTERNAL_ERROR`。
- **未**引入 metrics/tracing 集群；格式先统一便于日后接入。

---

## 15. Capability Registry 汇总

完整 21 类能力见 **[capability-registry.md](./capability-registry.md)**。摘要：

| 分类 | 数量 | 代表项 |
|---|---|---|
| `PLATFORM_NOW` | 5 | AI、Storage、Catalog、Releases、Payments 核心 |
| `PLATFORM_FUTURE` | 8+ | VOD、SMS 通道、Email、Notifications、Maps、Search、Config、Billing/Entitlements、Audit |
| `PRODUCT_ONLY` | 5+ | 履约、装扮、CMS、背景音乐、分成营销 |
| `SHARED` | 1 | 公共代码 + Design Tokens |
| `ACCOUNT` | 1 | 身份 / 登录 / Session |

**Registry 维护规则：每新增一个公共能力，先更新 Registry 再写代码。**

---

## 16. 推荐后续迁移顺序

1. **合并 PR** → 各仓库 `lint/typecheck/test/build` 在 CI 再跑一遍。
2. **部署 platform** 到内网/预发 → 配置 `PLATFORM_SERVICE_TOKENS`、AI/OSS 等 Secret。
3. **单开关验证**：建议顺序 **AI → Catalog → Releases → Storage → Payments**（AI 面小、易观测；Payments 最后且需回调域名）。
4. **account 仓库**规划：OIDC、全局 sub、验证码业务；platform 头 `X-Platform-Actor` 只换值不改名。
5. **微信/支付宝渠道**迁入 platform（与商户号、回调 URL 一并切换）。
6. **VOD、SMS 通道、Maps**：出现第二个真实调用方再下沉。
7. **删除**各站重复实现：仅在开关全量开启且稳定后，按模块删旧代码（先确认再删）。

---

## 17. 验证清单（本轮本地结果）

| 仓库 | lint | typecheck | test | build | 备注 |
|---|---|---|---|---|---|
| **shared** | 通过 | 通过 | 54/54 | N/A（发 TS 源码） | tag `v0.4.0` |
| **platform** | 通过 | 通过 | 103/103 | 通过 | SQLite 开发库 |
| **andyyyds** | 通过 | 通过 | 通过 | 通过 | 适配层默认 off |
| **softwarelist** | 通过 | 通过 | 通过 | 通过 | 适配层默认 off |

合并 PR 后请在 **CI** 上重复上述命令；生产验证需单独标记 `PRODUCTION_VERIFIED`。

---

## 18. 给其他 AI 的执行约束

1. **不要**在没有 account 的情况下合并两站用户表或做 SSO。
2. **不要**把登录/OIDC 实现放进 platform。
3. **不要**在 shared 里放 Prisma、Secret、OSS/支付/AI Provider 实现。
4. **不要**为「只有一个调用方」的能力提前写空 microservice。
5. 改 public API 时：**先**改 `shared/contracts`，再改 platform，最后改产品适配层。
6. 产品调用 platform 请用 **`createPlatformClient`**，不要手写 URL 字符串。
7. 读 Capability 状态时以 [capability-registry.md](./capability-registry.md) 为准；本文是总览。

---

## 19. 分支与 PR（上下文）

多仓库并行开发，典型分支名模式：`cursor/<topic>-cd2f`。具体 PR 以 GitHub 上 open 状态为准；合并前以各 PR 描述为操作说明。

主站长期基线分支：`Andyyyds20260901independentpackage`（用户指定）；**platform/shared** 通常以 `main` 为集成目标。

---

## 20. 文档索引（platform/docs）

| 文件 | 内容 |
|---|---|
| [company-platform-architecture.md](./company-platform-architecture.md) | 五层架构、Studio、Secret、事件与迁移原则 |
| [capability-registry.md](./capability-registry.md) | 能力登记表（维护入口） |
| [architecture.md](./architecture.md) | 边界、数据所有权、API 版本 |
| [ai.md](./ai.md) | AI 配置、purpose 路由、限流 |
| [storage.md](./storage.md) | Namespace、签名、OSS |
| [releases.md](./releases.md) | 版本与安装包 |
| [payments.md](./payments.md) | 支付、webhook、履约事件 |
| [platform-boundaries.md](./platform-boundaries.md) | platform 模块边界补充 |

---

## 21. 用户原始 27 条反馈 — 对照结论

下列条目合并自架构盘点与多阶段实施反馈，便于与其他 AI 对齐「做过什么 / 没做什么」。

| # | 主题 | 结论 |
|---|---|---|
| 1 | 多仓库盘点 | 已完成；见 Capability Registry |
| 2 | shared 分叉 | 阶段 A 完成；`@yydsxwh/shared` 为唯一来源 + 兼容层 |
| 3 | 不迁 OSS/支付/登录到 shared | 遵守；实现留在 platform 或产品 |
| 4 | platform 模块化单体 | 已建立 ai/storage/catalog/releases/payments |
| 5 | 不微服务化 | 遵守 |
| 6 | account 独立 | 仅类型与文档；`NEEDS_ACCOUNT_MIGRATION.md` |
| 7 | Capability Registry 先行 | 已建并随实现更新 |
| 8 | AI 优先迁移 | platform + 两站适配层完成；开关默认 off |
| 9 | Storage 统一边界 | platform 实现 + 适配层；默认 off |
| 10 | Releases 统一 | 同上；旧 URL 兼容 |
| 11 | Payments 核心 | platform 幂等/webhook；渠道仍产品侧 |
| 12 | 履约不进 payment | 文档与代码边界已声明 |
| 13 | Studio 留主站 | UI 留主站；管理数据走 platform API |
| 14 | softwarelist 瘦身 | 已删无关 shared 副本 |
| 15 | Design Tokens | shared 第一批 |
| 16 | docs/MathCode 合并 | **未做**；等 account/entitlements |
| 17 | Secret 不进 Git | 已贯彻；日志脱敏 |
| 18 | 功能开关默认关 | 全部 `PLATFORM_*_ENABLED=false` |
| 19 | 兼容 import 路径 | re-export shim |
| 20 | 契约在 shared | contracts + platform-client |
| 21 | purpose 路由 AI | 已实现 |
| 22 | 跨库禁止 | 架构文档已写死 |
| 23 | 测试 | shared 54 + platform 103 |
| 24 | 不部署生产 | 本轮未部署 |
| 25 | 不修改 account（不存在） | 遵守 |
| 26 | PR 就绪 | 代码态 PR_READY；需人工合并与部署 |
| 27 | 交付可读报告 | **本文档**（MD 为主；便于 AI 与 Git 跟踪） |

---

*文档结束。修改架构决策时请同步更新本节与 capability-registry.md。*
