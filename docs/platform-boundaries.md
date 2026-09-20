# 公司级边界速查

放在 platform/docs 下，因为目前没有独立的公司文档仓库。

> **Account 管身份。Platform 管公共在线能力。Shared 管公共代码。Product 管自己的业务。**

## 一件事该放哪

| 问题 | 归属 |
|---|---|
| 用户是谁？怎么登录？ | **account**（尚未建立，见 NEEDS_ACCOUNT_MIGRATION） |
| 文件存哪、怎么签链接？ | platform / storage |
| 软件版本与安装包下载？ | platform / releases |
| 公司有哪些产品、在哪些端？ | platform / catalog |
| 钱怎么付、回调怎么验？ | platform / payments |
| 短信、邮件、推送怎么发？ | platform / communications（未实现，仅定义边界） |
| 跨仓库共用的类型、工具、SDK？ | **shared** |
| 品牌色、间距、圆角、基础控件？ | shared / design |
| 这门课多少钱、谁能看？ | **Andyyyds** |
| 优惠券、分销、商家结算？ | Andyyyds |
| 网站装扮、主题包？ | Andyyyds（`@andyyyds/decorate`） |
| 软件产品的介绍文案、分类、卡片排版？ | **softwarelist** |
| MathCode 额度怎么扣？ | MathCode 产品自己 |
| 日事的待办、课表、提醒？ | 未来 rishi 仓库 |

## 硬性禁止

- 把所有公共功能重新塞回主站
- 产品之间直接读对方数据库
- 产品直接读 account / platform 数据库
- 复制源码来代替 API / SDK 依赖
- 在 shared 里放密钥、服务端实现或数据库访问
- 在 platform 里放产品履约逻辑或运营文案
- 为了架构图先写一堆没有调用方的空服务

## 新增能力时先问三句

1. **有第二个真实调用方吗？** 没有就先留在产品里，别先下沉。
2. **它需要密钥或数据库吗？** 需要就不能进 shared。
3. **它是身份问题吗？** 是就属于 account，不要在 platform 或产品里再造一套。

## 当前状态

| 能力 | 状态 |
|---|---|
| Storage / Files | platform 已实现；两站通过兼容层接入，默认关闭 |
| Releases | platform 已实现；主站旧下载入口已可切换，默认关闭 |
| Catalog | platform 已实现；两站产品页已可切换，默认关闭 |
| Payments | platform 核心已实现；**两站仍走各自实现，未切换** |
| 身份 / 登录 | 仍在两站各自实现，**NEEDS_ACCOUNT_MIGRATION** |
| 阿里云 VOD | 仍在主站 |
| 微信 / 支付宝渠道实现 | 仍在主站 |
| Notifications / Audit / Entitlements / Theme Service | 未实现，仅定义边界 |
