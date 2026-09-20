# 公司级边界速查

> **Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。Studio 管运营和配置。**

## 一件事该放哪

| 问题 | 归属 |
|---|---|
| 用户是谁？怎么登录？ | **account**（已上线；产品接入见 `NEEDS_ACCOUNT_INTEGRATION`） |
| 文件存哪、怎么签链接？ | platform / storage |
| 软件版本与安装包下载？ | platform / releases |
| 公司有哪些产品、在哪些端？ | platform / catalog |
| 钱怎么付、回调怎么验？ | platform / payments |
| 短信、邮件、推送怎么发？ | platform / communications 或 notifications（未实现，仅定义边界） |
| 跨仓库共用的类型、工具、SDK？ | **shared** |
| 品牌色、间距、圆角、基础控件？ | shared / design |
| 这门课多少钱、谁能看？ | **Andyyyds** |
| 优惠券、分销、商家结算？ | Andyyyds |
| 网站装扮、主题包？ | Andyyyds（`@andyyyds/decorate`） |
| 软件产品的介绍文案、分类、卡片排版？ | **softwarelist** |
| MathCode 额度怎么扣？ | MathCode 产品自己 |
| 日事的待办、课表、提醒、同步？ | **rishi**（Sync Engine 也在 rishi） |

## 硬性禁止

- 把所有公共功能重新塞回主站
- 产品之间直接读对方数据库
- 产品直接读 account / platform 数据库
- 复制源码来代替 API / SDK 依赖
- 在 shared 里放密钥、服务端实现或数据库访问
- 在 platform 里放产品履约逻辑、运营文案或第二套账号
- 浏览器 / App 持有 `PLATFORM_SERVICE_TOKEN` 或 OSS 长期密钥
- 为了架构图先写一堆没有调用方的空服务

## 新增能力时先问三句

1. **有第二个真实调用方吗？** 没有就先留在产品里。
2. **它需要密钥或数据库吗？** 需要就不能进 shared。
3. **它是身份问题吗？** 是就属于 **已存在的 account**，不要再造一套。

## 当前状态

| 能力 | 状态 |
|---|---|
| Account IdP | **已生产运行**（独立系统） |
| AI / Storage / Catalog / Releases | platform 已实现；两站适配层默认关；`NOT_DEPLOYED` |
| Payments | platform 核心已实现；渠道未迁；`NOT_DEPLOYED` |
| 产品登录实现 | 仍在两站，`NEEDS_ACCOUNT_INTEGRATION` |
| VOD / 微信支付宝渠道 | 仍在主站 |
| Notifications / Audit / Entitlements / Theme | 未实现，仅定义边界 |
