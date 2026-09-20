# Capability Registry

公司所有公共 / 准公共能力的登记表。**每新增一个公共能力，先更新这张表再写代码。**

分类：`PRODUCT_ONLY` / `PLATFORM_NOW` / `PLATFORM_FUTURE` / `SHARED` / `ACCOUNT`

状态必须区分「代码存在」和「生产已经使用」：

`IMPLEMENTED` / `TESTED` / `PR_READY` / `MERGED` / `DEPLOYED` / `PRODUCTION_VERIFIED` / `DOCUMENTED` / `PLANNED`

**本文件中没有任何一项处于 `DEPLOYED` 或 `PRODUCTION_VERIFIED`（Account 除外，它已在独立系统上线）。**

---

## 一、Account / 身份

| 项 | 内容 |
|---|---|
| **Capability** | 用户身份、注册登录、OIDC/OAuth、Session、MFA/安全、全局 `usr_*` sub |
| **Current Owner** | Account（独立系统，已上线）+ 两站仍各有一份本地 session 实现 |
| **Target Owner** | Account；产品只保留本产品角色 |
| **Status** | Account 本体 `CURRENT` + `PRODUCTION`。产品 OIDC 接入 `NEEDS_ACCOUNT_INTEGRATION` |
| **Callers** | 未来所有产品；当前主站 / 软件站尚未切 OIDC |
| **Data Owner** | account DB |
| **Secret Owner** | account |
| **API** | OIDC Discovery / JWKS / Authorize / Token / UserInfo（以 account 为准） |
| **Feature Flag** | 无（本工作区不改 account） |
| **Production State** | **Account 已生产运行。** 产品接入未完成 |

不要再写成 `account（未来）` 或 `NEEDS_ACCOUNT_MIGRATION`（「还没建设」）。

## 二、AI / 大模型

| 项 | 内容 |
|---|---|
| **Capability** | Provider、用途路由、限流、超时、fallback、用量与成本 |
| **Current Owner** | platform/ai 已实现；两站适配层默认关 |
| **Target Owner** | `platform/ai` |
| **Status** | `IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED` |
| **Callers** | 正文翻译、MathCode OCR/转换；未来日事 AI |
| **Data Owner** | platform（`AiUsage`，不存 prompt/回复） |
| **Secret Owner** | platform（`AI_KEY_*`，配置只写 `apiKeyEnv`） |
| **API** | `POST /v1/ai/chat`、`GET /v1/ai/providers`、`GET /v1/ai/routes`、`GET /v1/ai/usage` |
| **Feature Flag** | `PLATFORM_AI_ENABLED` 默认 `false` |
| **Production State** | `NOT_DEPLOYED` |

## 三、Storage / Files

| 项 | 内容 |
|---|---|
| **Capability** | namespace、MIME/大小、权限、短时签名、元数据、删除 |
| **Current Owner** | platform/storage；两站适配层默认关；主站仍有旧 OSS 实现作 fallback |
| **Target Owner** | `platform/storage` |
| **Status** | `IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED` |
| **Callers** | 素材、封面、头像、装扮、安装包；未来日事附件 |
| **Data Owner** | platform（`File`）；业务含义由产品用 `fileId` 关联 |
| **Secret Owner** | platform（OSS AK/SK） |
| **API** | `/v1/storage/*` |
| **Feature Flag** | `PLATFORM_STORAGE_ENABLED` 默认 `false` |
| **Production State** | `NOT_DEPLOYED` |

结构化业务数据（待办、课表、笔记正文）不得用 OSS JSON 代替数据库。

## 四、Catalog

| 项 | 内容 |
|---|---|
| **Capability** | 公司产品事实：id/slug/name/status/webUrl/platforms/releaseProductKey |
| **Current Owner** | platform/catalog；两站本地 `SOFTWARE_PRODUCTS` 仍作 fallback 与运营文案 |
| **Target Owner** | 事实 → platform；展示文案 → softwarelist |
| **Status** | `IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED` |
| **Callers** | 主站产品页、softwarelist 产品页 |
| **Data Owner** | platform（`CatalogProduct`） |
| **Secret Owner** | 无 |
| **API** | `/v1/catalog/products` |
| **Feature Flag** | `PLATFORM_CATALOG_ENABLED` 默认 `false` |
| **Production State** | `NOT_DEPLOYED` |

Andyyyds 只应消费事实；大段营销文案留 softwarelist。本轮不删本地数组（兼容）。

## 五、Releases

| 项 | 内容 |
|---|---|
| **Capability** | 版本、渠道、端、架构、changelog、安装包元数据；字节在 Storage |
| **Current Owner** | platform/releases；旧下载 URL 与硬编码文件名仍作 fallback |
| **Target Owner** | `platform/releases` |
| **Status** | `IMPLEMENTED` / `TESTED` / `PR_READY` / `NOT_DEPLOYED` |
| **Callers** | 主站 / 软件站 App 下载页 |
| **Data Owner** | platform（`Release` / `ReleaseAsset`） |
| **Secret Owner** | 无（下载走短时签名） |
| **API** | `/v1/releases/*` |
| **Feature Flag** | `PLATFORM_RELEASES_ENABLED` 默认 `false` |
| **Production State** | `NOT_DEPLOYED` |

旧 URL `/api/app/download/...` 保留。softwarelist 静态目录是否切 nginx：`NEEDS_OWNER_CONFIRMATION`。

## 六、Payments

| 项 | 内容 |
|---|---|
| **Capability** | 下单、查询、退款、webhook 验签、幂等、金额核对、履约事件 |
| **Current Owner** | platform 核心 + mock；微信/支付宝渠道仍在产品仓库 |
| **Target Owner** | `platform/payments`（渠道实现待迁） |
| **Status** | 核心 `IMPLEMENTED` / `TESTED` / `PR_READY` / `STAGING_READY`。**不是** production migrated |
| **Callers** | 尚未切换 |
| **Data Owner** | platform（`Payment` / `PaymentEvent` / `Refund`） |
| **Secret Owner** | 迁移后只在 platform；当前渠道密钥仍在产品环境 |
| **API** | `/v1/payments/*`、`/v1/payment-webhooks/{provider}` |
| **Feature Flag** | 无产品总开关可开生产渠道 |
| **Production State** | `NOT_DEPLOYED` |

履约（额度、课程、优惠券、分销、商家结算）= `PRODUCT_ONLY`。

真实渠道切换需要商户号、回调 URL、证书：`NEEDS_OWNER_CONFIRMATION`。

## 七、产品履约

| 项 | 内容 |
|---|---|
| **Capability** | 加额度 / 开通课程 / 优惠券 / 分销 / 商家结算 |
| **Current Owner** | 各产品 |
| **Target Owner** | 各产品 |
| **Status** | 保持现状 |
| **Callers** | 支付成功后的产品逻辑 |
| **Data Owner** | 产品 DB |
| **Secret Owner** | 无 |
| **API** | 产品内部 |
| **Feature Flag** | 无 |
| **Production State** | 已在各产品生产使用（与 platform 无关） |

## 八、VOD

| 项 | 内容 |
|---|---|
| **Capability** | 视频上传凭证、转码、播放 |
| **Current Owner** | 主站 |
| **Target Owner** | 出现第二个调用方时 → `platform/storage` VIDEO |
| **Status** | `PLATFORM_FUTURE` / 未开始 |
| **Callers** | 仅课程视频 |
| **Data Owner** | 主站 |
| **Secret Owner** | 主站 `vod*` |
| **API** | 主站现有 |
| **Feature Flag** | 无 |
| **Production State** | 主站自用，未平台化 |

## 九、SMS / 邮件 / 推送

| 项 | 内容 |
|---|---|
| **Capability** | 发送通道 vs 验证码业务 |
| **Current Owner** | 短信在两站；邮件无真实发送；推送不存在 |
| **Target Owner** | 通道 → `platform/communications` 或 `notifications`；验证码业务 → account |
| **Status** | `PLATFORM_FUTURE` / `ACCOUNT` |
| **Callers** | 登录；未来日事提醒 |
| **Data Owner** | 分属 account / 产品 |
| **Secret Owner** | 迁移后 platform |
| **API** | 未实现 |
| **Feature Flag** | 无 |
| **Production State** | 未平台化 |

## 十、地图 / Search / Config / Flags / Billing / Entitlements / Audit

均为 `PLATFORM_FUTURE`：只保留 Registry 与架构边界，**不建空目录**。

Entitlements：account 已具备全局 sub；缺的是 Entitlements 实现与产品联调，不是再建账号中心。

Observability 日志：`IMPLEMENTED`（requestId、client、module、route、duration、result、error code）。metrics / tracing：`PLANNED`。

## 十一、主题 / CMS / 背景音乐 / 分成

`PRODUCT_ONLY`。Design tokens 在 shared，装扮业务留主站。

## 十二、公共代码

| 项 | 内容 |
|---|---|
| **Capability** | types / contracts / platform-client / validation / utils / i18n / design tokens |
| **Current Owner** | `@yydsxwh/shared` `v0.5.0` |
| **Target Owner** | shared |
| **Status** | `IMPLEMENTED` / `TESTED` / `PR_READY` |
| **Callers** | andyyyds、softwarelist、platform |
| **Data Owner** | 无 |
| **Secret Owner** | 禁止 |
| **API** | npm 子路径 |
| **Feature Flag** | 无 |
| **Production State** | 产品尚未把 v0.5.0 接到生产分支 |

---

## 汇总

| 分类 | 项 | 生产 |
|---|---|---|
| `ACCOUNT` + `PRODUCTION` | Account IdP | 已上线（独立系统） |
| `PLATFORM_NOW` 代码齐、`NOT_DEPLOYED` | AI、Storage、Catalog、Releases、Payments 核心 | 未部署 |
| `PLATFORM_FUTURE` | VOD、SMS 通道、Email、Notifications、Maps、Search、Config/Flags、Billing/Entitlements、Audit 流 | 无代码服务 |
| `PRODUCT_ONLY` | 履约、装扮、CMS、背景音乐、分成 | 各产品 |
| `SHARED` | 公共代码 | 以 git tag 引用 |
