# Releases

解决的问题：现在安装包文件名写死在前端（`yyds.apk`、`yyds-windows-setup.exe`），
两个站点各维护一套下载逻辑，发新版要回代码里改字符串。

切过来之后，**发版只在 platform 登记，站点只问「这个端的最新稳定版是什么」**。

## 概念

```
Product（catalog）
   └─ releaseProductKey
        └─ Release        productKey + version + channel 唯一
             └─ ReleaseAsset   一个端 + 一个架构 = 一个安装包
                  └─ fileId → Storage 里的对象
```

| Release 字段 | 说明 |
|---|---|
| `productKey` | 对应 `CatalogProduct.releaseProductKey` |
| `version` | 语义化版本，同 productKey + channel 下唯一 |
| `channel` | `STABLE` / `BETA` / `ALPHA` |
| `status` | `DRAFT` / `PUBLISHED` / `REVOKED` |
| `releasedAt` | 发布时间，未发布为 null |
| `changelog` | 更新说明 |
| `minimumUpgradeFrom` | 低于此版本必须升级 |

| ReleaseAsset 字段 | 说明 |
|---|---|
| `fileId` | 安装包对象，字节由 Storage 保管 |
| `platform` | `WINDOWS` / `ANDROID` / `IOS` / `HARMONYOS` / `MACOS` / `LINUX` / `WEB` |
| `architecture` | `X64` / `X86` / `ARM64` / `ARMV7` / `UNIVERSAL` |
| `checksum` | 形如 `sha256:…`，供客户端校验完整性 |
| `labels` | 供应商要求的额外标记，如 Android 的 versionCode |

## 发版流程

```
1. 上传安装包到 app-installers namespace     → fileId
2. POST /v1/internal/releases                → 建 DRAFT
3. POST /v1/internal/releases/{id}/assets    → 逐端挂包
4. POST /v1/internal/releases/{id}/publish   → 发布
```

没有任何安装包**不能** publish——否则发出去的版本用户点下载只会拿到 404。

撤回用 `POST /v1/internal/releases/{id}/revoke`：`latest` 立即跳过它，
但按版本号仍可查到，历史链接不会变成无法解释的 id。

## 查询

```
GET  /v1/releases/{productKey}                   列出已发布版本
GET  /v1/releases/{productKey}/latest            最新稳定版
GET  /v1/releases/{productKey}/{version}         指定版本
POST /v1/releases/{productKey}/{version}/download   换短期签名下载链接
```

`latest` 支持 `?channel=BETA`、`?platform=ANDROID`、`?architecture=ARM64`。

两个行为值得注意：

- 按端过滤时，如果最新版没有该端的包，会**回落到仍有该端包的更早版本**，
  而不是直接说「没有」
- 选包先精确匹配架构，再退到 `UNIVERSAL`，最后才用该端的任意一个；
  单架构产品不必把每种架构都登记一遍

下载链接有效期 2 小时，够慢网拉完几百 MB，又不至于被长期转发。

## 产品侧接入

兼容适配层在两个站点的 `packages/shared/src/platform-releases.ts`：

- `PLATFORM_RELEASES_ENABLED` 不为 `true` 时行为与迁移前一致
- 旧的按文件名下载入口（`/api/app/download/yyds.apk`）保留，
  内部把文件名映射到端与架构，**URL 不变**，用户收藏的链接与安卓端更新逻辑不受影响
- 查不到已发布版本时返回 null，页面显示「准备中」，不报错刷屏

## 未完成

- softwarelist 的 `/app` 下载页目前仍直链静态路径，没有走 Release 下载接口。
  切换需要先确认该站的 nginx 静态目录布局，标记为 **NEEDS_OWNER_CONFIRMATION**。
- 发版流程尚未接入 CI。当前需要人工调用上述 4 步接口。
