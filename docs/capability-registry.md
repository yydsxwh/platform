# Capability Registry

公司所有公共 / 准公共能力的登记表。**每新增一个公共能力，先更新这张表再写代码。**

分类标记：

| 标记 | 含义 |
|---|---|
| `PRODUCT_ONLY` | 属于某个产品自己的业务，不下沉 |
| `PLATFORM_NOW` | 已经或本轮就该下沉到 platform |
| `PLATFORM_FUTURE` | 未来会被多个产品调用，先定边界不写实现 |
| `SHARED` | 编译期共用的类型 / 工具 / SDK / Design System |
| `ACCOUNT` | 属于独立的 account 仓库 |

状态标记严格区分：`IMPLEMENTED` / `TESTED` / `PR_READY` / `MERGED` / `DEPLOYED` / `PRODUCTION_VERIFIED`。
**本文件中没有任何一项处于 `DEPLOYED` 或 `PRODUCTION_VERIFIED`。**

---

## 一、AI / 大模型

| 项 | 内容 |
|---|---|
| **能力** | Provider 配置、模型路由、API Key、限流、超时、fallback、用量与成本 |
| **迁移前在哪** | 主站 `SiteSettings.translateApiBaseUrl/Key/Model`（面板叫「AI 接口」）+ `ai-providers.ts` 预设表 + MathCode 的 `MATHCODE_API_*` 环境变量覆盖；**softwarelist 另存一份同样的配置** |
| **调用方** | 正文一键翻译（i18n）、MathCode 视觉识别、MathCode 文档转换 |
| **分类** | `PLATFORM_NOW` |
| **最终归属** | `platform/ai` |
| **是否已迁移** | 是。platform 已实现，两站通过适配层接入，开关默认关闭 |
| **Secret** | `AI_KEY_*` 环境变量，只在 platform 进程。配置里只放 `apiKeyEnv` 指向变量名 |
| **数据所有者** | platform（`AiUsage` 表，只记元数据，**不存提示词与模型输出**） |
| **API** | `POST /v1/ai/chat`、`GET /v1/ai/providers`、`GET /v1/ai/routes`、`GET /v1/ai/usage` |
| **状态** | `TESTED` → `PR_READY` |

> 迁移前同一把 Key 要在主站和软件专栏各填一次，还能各自改成不同的值。
> Provider 预设表（哪些厂商、baseUrl、型号清单）是静态参考数据，留在 shared 供 Studio 下拉使用，**不含 Key**。

## 二、Storage / Files（OSS）

| 项 | 内容 |
|---|---|
| **能力** | 对象存储、签名直传、分片、签名下载、MIME 与大小策略 |
| **迁移前在哪** | 主站 `SiteSettings.oss*` + `storage.ts`（1200+ 行）；softwarelist 另存一份 |
| **调用方** | 素材中心、课程封面、论坛图片、头像、装扮图、安装包；未来日事 / course / forum |
| **分类** | `PLATFORM_NOW` |
| **最终归属** | `platform/storage` |
| **是否已迁移** | 是。适配层已接，开关默认关闭。主站素材中心保留为管理 UI |
| **Secret** | `OSS_ACCESS_KEY_ID/SECRET`，只在 platform 进程 |
| **数据所有者** | platform（`File` 表）；业务含义由产品用 `fileId` 关联 |
| **API** | `/v1/storage/*` |
| **状态** | `TESTED` → `PR_READY` |

## 三、阿里云点播 VOD

| 项 | 内容 |
|---|---|
| **能力** | 视频上传凭证、转码、播放地址 |
| **现在在哪** | 主站 `SiteSettings.vod*` + `aliyun-vod.ts` |
| **调用方** | 只有课程视频 |
| **分类** | `PLATFORM_FUTURE` |
| **最终归属** | `platform/storage`（作为 VIDEO provider） |
| **是否已迁移** | **否**。上传凭证 / 转码 / 播放是另一条独立链路，需要真实凭证才能验证 |
| **状态** | 未开始 |

## 四、微信支付 / 支付宝

| 项 | 内容 |
|---|---|
| **能力** | 下单、调起、回调验签、退款 |
| **现在在哪** | 主站 `SiteSettings.wechat*/alipay*` + `wechat-pay.ts` / `alipay.ts`；softwarelist 另存一份 |
| **分类** | `PLATFORM_NOW`（渠道实现仍待迁） |
| **最终归属** | `platform/payments` |
| **是否已迁移** | **核心流程已迁**（幂等、验签、金额核对、退款、履约事件）；**微信 / 支付宝渠道实现未迁**，要连同商户证书与回调域名一起切 |
| **Secret** | 商户私钥、API v3 Key、支付宝私钥；迁移后只在 platform |
| **数据所有者** | platform（`Payment` / `PaymentEvent` / `Refund`） |
| **API** | `/v1/payments/*`、`/v1/payment-webhooks/{provider}` |
| **状态** | `TESTED` → `PR_READY`（两站尚未切换） |

## 五、产品履约（加额度 / 开通课程 / 优惠券 / 分销 / 商家结算）

| 项 | 内容 |
|---|---|
| **分类** | `PRODUCT_ONLY` |
| **最终归属** | MathCode 额度归 MathCode；课程开通归 courses；优惠券、分销、商家抽成归 Andyyyds |
| **说明** | 绝不进 payment，否则支付会长成第二个业务系统 |
| **状态** | 保持现状 |

## 六、短信（SMS）

| 项 | 内容 |
|---|---|
| **能力** | 阿里云短信发送 + 验证码校验 |
| **现在在哪** | 主站 `SiteSettings.sms*` + `sms.ts`；softwarelist 另存一份 |
| **分类** | 发送通道 `PLATFORM_FUTURE`；**验证码业务逻辑 `ACCOUNT`** |
| **最终归属** | 通道 → `platform/communications`；业务 → account |
| **是否已迁移** | 否。拆通道会动到登录链路，风险不对称，本轮只定边界 |
| **Secret** | `smsAccessKeyId/Secret`，迁移后只在 platform |
| **状态** | 未开始，见 `NEEDS_ACCOUNT_INTEGRATION` |

## 七、邮件

| 项 | 内容 |
|---|---|
| **现状** | **代码里没有真实邮件发送能力**。只有 `auth-email.ts` 的占位邮箱字符串规则（已在 shared） |
| **分类** | `PLATFORM_FUTURE` |
| **最终归属** | `platform/communications` |
| **状态** | 未实现，仅定义边界 |

## 八、推送通知

| 项 | 内容 |
|---|---|
| **现状** | 不存在。站内聊天是主站自己的 WebSocket，不是通知中台 |
| **分类** | `PLATFORM_FUTURE` |
| **最终归属** | `platform/notifications`（Web Push / APNs / FCM / 华为 / Windows） |
| **边界** | 「什么时候提醒」由业务决定（如日事的 Reminder Engine），platform 只负责送达 |
| **状态** | 未实现，仅定义边界。等日事成为第一个真实调用方 |

## 九、高德地图 / 地理

| 项 | 内容 |
|---|---|
| **能力** | POI 搜索、逆地理编码、坐标转换、时区、瓦片代理 |
| **现在在哪** | 主站 `SiteSettings.amapWebKey` + `amap-place.ts` / `geo-china.ts` + `/api/geo/*` |
| **调用方** | 目前只有论坛与约搭 |
| **分类** | `PLATFORM_FUTURE` |
| **最终归属** | 出现第二个产品需要时 → `platform/maps`；shared 提供 maps client 与类型 |
| **是否已迁移** | 否。**当前只有主站在用，按规则不下沉** |
| **Secret** | `amapWebKey`；下沉后各产品不再各存一份 Key |
| **状态** | 未实现，仅定义边界 |

## 十、软件产品目录

| 项 | 内容 |
|---|---|
| **能力** | 公司有哪些产品、状态、正式页面、支持哪些端 |
| **迁移前在哪** | 主站与 softwarelist **各一份** `SOFTWARE_PRODUCTS` 硬编码数组，已分叉 |
| **分类** | `PLATFORM_NOW` |
| **最终归属** | `platform/catalog`；运营文案留 softwarelist |
| **是否已迁移** | 是。两站产品页已改为读 Catalog，开关默认关闭 |
| **数据所有者** | platform（`CatalogProduct`） |
| **API** | `/v1/catalog/products` |
| **状态** | `TESTED` → `PR_READY` |

## 十一、软件版本 / 安装包下载

| 项 | 内容 |
|---|---|
| **迁移前在哪** | 安装包文件名写死在代码里，两站各维护一套下载逻辑 |
| **分类** | `PLATFORM_NOW` |
| **最终归属** | `platform/releases` |
| **是否已迁移** | 是。主站旧下载入口 URL 不变，内部改问 Releases |
| **数据所有者** | platform（`Release` / `ReleaseAsset`），字节在 Storage |
| **API** | `/v1/releases/*` |
| **状态** | `TESTED` → `PR_READY` |

## 十二、主题 / 装扮

| 项 | 内容 |
|---|---|
| **能力** | 主题包、配色、Logo、首页挂件、排版 |
| **现在在哪** | 主站 `@andyyyds/decorate` + `SiteSettings.decorateJson` |
| **分类** | `PRODUCT_ONLY`；其中 token 部分 `SHARED` |
| **最终归属** | 装扮产品留主站；品牌 token 进 shared `design/tokens` |
| **是否已迁移** | Design Token 已进 shared；装扮业务**一行没动** |
| **说明** | 只有未来第二个产品确实需要「用户主题云端同步」，才建 `platform/theme`。现在不提前设计 |
| **状态** | Token `TESTED`；装扮保持现状 |

## 十三、网站配置 / CMS

| 项 | 内容 |
|---|---|
| **能力** | 门户导航、页面模板、UI 文案、下单表单、工作室导航 |
| **现在在哪** | 主站 `SiteSettings.portalJson / pageTemplatesJson / uiCopyJson / orderFormJson / studioNavJson` |
| **分类** | `PRODUCT_ONLY`（主站自己的配置） |
| **说明** | 公共平台配置归 `platform/config`，产品配置归产品。主站 CMS 不是公共能力 |
| **状态** | 保持现状 |

## 十四、背景音乐

| 项 | 内容 |
|---|---|
| **现在在哪** | 主站 `SiteSettings.bgMusicJson` + `jamendoClientId` |
| **分类** | `PRODUCT_ONLY` |
| **说明** | 只有主站门面会用，不下沉 |
| **状态** | 保持现状 |

## 十五、分成与营销规则

| 项 | 内容 |
|---|---|
| **现在在哪** | 主站 `SiteSettings.merchantPlatformCutPercent` 等 5 个比例字段 + 优惠券 / 分销模块 |
| **分类** | `PRODUCT_ONLY` |
| **说明** | 字段名里的「platform」指**商业上的平台抽成**，与 `yydsxwh/platform` 仓库无关，别混淆 |
| **状态** | 保持现状 |

## 十六、身份 / 登录 / Session

| 项 | 内容 |
|---|---|
| **现在在哪** | 两站各一份 cookie session、密码、微信 OAuth、短信登录、角色申请 |
| **分类** | `ACCOUNT` |
| **说明** | platform **不建立第二套用户身份**，只接收已验证的 user/service identity |
| **状态** | `NEEDS_ACCOUNT_INTEGRATION` |

## 十七、Billing / Entitlements

| 项 | 内容 |
|---|---|
| **现状** | 只有「支付订单 + MathCode 额度」一种情况 |
| **分类** | `PLATFORM_FUTURE` |
| **说明** | 支付=钱怎么付；Billing=买了什么；Entitlements=因此拥有什么能力。目标形态 `usr_xxx → rishi.pro=true`。只有一个调用方时做完整 SaaS Billing 是过度设计 |
| **状态** | 仅 contract 提案 |

## 十八、Search

| 项 | 内容 |
|---|---|
| **现状** | 没有统一搜索能力 |
| **分类** | `PLATFORM_FUTURE` |
| **说明** | platform 提供基础设施；搜什么、谁能搜、怎么排序由各产品决定 |
| **状态** | 仅架构预留 |

## 十九、Config / Feature Flags

| 项 | 内容 |
|---|---|
| **现状** | 没有灰度与 A/B 需求；当前的「开关」是环境变量 |
| **分类** | `PLATFORM_FUTURE` |
| **说明** | 公共平台配置 → `platform/config`；灰度 / A/B → `platform/feature-flags` |
| **状态** | 仅 contract 设计 |

## 二十、Audit / Observability

| 项 | 内容 |
|---|---|
| **现状** | platform 已有 requestId 贯穿、结构化 JSON 日志、错误分类、敏感字段自动脱敏 |
| **分类** | `PLATFORM_NOW`（日志）/ `PLATFORM_FUTURE`（审计流、metrics、tracing） |
| **说明** | 不建监控集群，但格式先统一，以后接采集不用回头改调用点 |
| **状态** | 日志 `IMPLEMENTED`；审计与 metrics 未实现 |

## 二十一、公共代码（类型 / 工具 / SDK / Design System）

| 项 | 内容 |
|---|---|
| **分类** | `SHARED` |
| **内容** | types、contracts、platform-client、validation、utils、i18n、design tokens |
| **禁止** | Prisma 业务、Secret、数据库、支付实现、OSS 实现、AI Provider 实现 |
| **状态** | `TESTED` → `PR_READY` |

---

## 汇总

| 分类 | 数量 | 项 |
|---|---|---|
| `PLATFORM_NOW` | 5 | AI、Storage、Catalog、Releases、Payments 核心 |
| `PLATFORM_FUTURE` | 8 | VOD、SMS 通道、Email、Notifications、Maps、Search、Config/Flags、Billing/Entitlements、Audit |
| `PRODUCT_ONLY` | 5 | 履约、装扮、网站 CMS、背景音乐、分成营销 |
| `SHARED` | 1 | 公共代码与 Design System |
| `ACCOUNT` | 1 | 身份 / 登录 / Session |
