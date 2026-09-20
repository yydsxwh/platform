# 日事（Rishi）接入规范

日事是**第一个完整验证公司平台架构的产品**。  
本工作区没有 rishi 仓库，本文只定标准，**不修改 rishi**。

状态：`DOCUMENTED` / `PLANNED`

## 架构

```
Account  https://account.yydsxwh.com
  → OIDC
  → Rishi Backend   Service Identity = rishi
  → Rishi DB        End User = usr_*
  → Platform        预发 https://api-staging.yydsxwh.com
                    生产 https://api.yydsxwh.com（audience 用这个）
```

```
              Account
                │
               OIDC
                │
                ▼
          Rishi Backend
         ┌──────┴─────────┐
         │                │
      Rishi DB         Platform
                         │
              ┌──────────┼───────────┐
              │          │           │
             AI       Storage   Notifications（未来）
                         │
                        OSS
```

## 数据归属

### Rishi DB（产品自己的库）

- 今日提醒
- 待办
- 课表
- 周期规则
- 日历事件
- 纪念日 / 倒数日
- 便签 / 笔记**正文**
- Reminder
- 完成状态
- 用户设置
- Sync version
- Device / sync metadata

这些是结构化业务数据，**不能**用 OSS 上的 JSON 代替数据库。

### Platform Storage

- 图片
- 附件
- Word 文档
- 导出文件

对象文件走 Storage；业务记录走 Rishi DB。用 `fileId` 关联。

### Account

- 用户身份
- 登录
- 全局 `usr_*` sub

### Platform AI

- 日事 AI 能力（产品只传 purpose + 消息，不持有厂商 Key）

### Future Platform Notifications

- APNs / FCM / Huawei Push / Web Push / Windows  
  「什么时候提醒」由 Rishi Reminder Engine 决定；platform 只负责送达。  
  现在没有第二个真实调用方，**不写空实现**。

## Sync Engine 属于 Rishi

**不要放进 platform。**

```
Web / Android / iPhone / Huawei / Windows
        │
        ▼
Rishi Backend / Sync API
        │
        ▼
Rishi DB
        │
        ├→ Platform Storage
        ├→ Platform AI
        └→ Platform Notifications（未来）
```

Platform 不理解：Task 是什么、课表怎么算、纪念日怎么显示、用户完成了哪条待办。

## 移动端安全

禁止 App 携带 `PLATFORM_SERVICE_TOKEN` 或 OSS AccessKey。

```
Mobile App
  → Rishi Backend（验 Session / OIDC）
  → Platform
```

上传：

```
Mobile
  → Rishi Backend
  或安全授权流程
  → Platform Storage
  → 短期签名
```

## Shared SDK

日事应使用 `@yydsxwh/shared/platform-client`，不要手写 URL。

已足够的公共能力：

- AI
- Storage
- Catalog
- Releases

不要在 shared 增加 `RishiTask` / `RishiCourseSchedule` / `RishiReminder`。

## 服务凭证

为 rishi 单独发放 token，例如：

```bash
PLATFORM_SERVICE_TOKENS="...,rishi:REPLACE_RISHI_TOKEN:ai+storage"
```

不要与主站共用同一把。

## 身份接入

```
OIDC 用户身份 → Rishi Session → Rishi Backend → Platform Verified User Context
```

Owner 已拍板公开标识：issuer `https://account.yydsxwh.com`，
JWKS `https://account.yydsxwh.com/.well-known/jwks.json`，
audience `https://api.yydsxwh.com`。

Discovery / 验签 / 产品 Session 打通仍是 `NEEDS_ACCOUNT_INTEGRATION`。
