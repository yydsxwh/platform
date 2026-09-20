# Storage / Files

platform 负责「对象存在哪、叫什么 key、谁能拿到、链接怎么签」。
业务含义（这是哪门课的封面、哪个帖子的图）由产品自己的库用 `fileId` 关联。

**不要把结构化业务数据塞进文件 labels，或存成 OSS 上的 JSON 来代替数据库。**

日事的待办、课表、纪念日、提醒、便签正文必须进 **Rishi DB**。
只有附件、图片、Word、安装包、媒体走 Storage。

OSS AccessKey 只在 platform。浏览器与 App 不得得到长期 AK/SK。

## 数据流

```
产品服务端 → platform Storage API → 签名 → 浏览器直传 OSS
产品服务端 → platform Storage API → 短期签名下载链接 → 浏览器
```

OSS AccessKey **只存在于 platform 进程**。浏览器任何时候拿到的都是短期签名 URL，
过期即失效，改一个字符即失效。

## namespace

namespace 是一类文件的存放区与策略边界，**登记制**——调用方不能随便传个字符串
就开出新分区，否则策略与配额就失控了。新增在 `src/modules/storage/namespaces.ts`。

| namespace | 可见性 | 上限 | 允许直传 | 限定调用方 |
|---|---|---|---|---|
| `avatars` | PUBLIC | 5 MB | 否 | 全部 |
| `images` | PRIVATE | 20 MB | 是 | 全部 |
| `media` | PRIVATE | 2 GB | 是 | 全部 |
| `forum-media` | PRIVATE | 200 MB | 是 | andyyyds |
| `decorate` | PUBLIC | 20 MB | 否 | andyyyds |
| `app-installers` | PRIVATE | 4 GB | 是 | andyyyds / softwarelist / release-bot |

对象 key 形如 `{namespace}/{yyyy}/{mm}/{fileId}-{文件名}`，带 namespace 前缀，
不同业务不会互相覆盖。

## 上传的两条路

**直传（大文件必走）**

```
POST /v1/storage/uploads                     → 建 PENDING 记录 + 短期签名地址
PUT  <签名地址>                               → 浏览器直接传到 OSS
POST /v1/storage/files/{fileId}/complete     → 核对字节确实到了，置为 READY
```

**分片直传（超大文件）**

```
POST /v1/storage/uploads  { multipart: true }
POST /v1/storage/files/{fileId}/multipart/parts     → 逐片签名
PUT  <各片签名地址>
POST /v1/storage/files/{fileId}/multipart/complete
```

**服务端代传（小文件，≤8 MB）**

```
POST /v1/storage/files   multipart/form-data
```

超过 8 MB 必须直传：经服务端中转会把整包缓冲在中间节点。

## 每一次上传都要过的闸

1. 有调用方身份（服务凭证）
2. namespace 已登记，且该调用方有权使用
3. MIME 在白名单（浏览器给空或 `octet-stream` 时按扩展名补全）
4. 大小不超 namespace 上限
5. 直传回执时**再核对一次实际字节**——直传绕过了建单时的检查，超限即删对象

只有回执没有字节的文件保持 `PENDING`，不会变成「查得到却下不动」的幽灵文件。

## 下载

```
POST /v1/storage/files/{fileId}/download-url
```

每次现签，**不要把返回的 URL 写进页面或数据库**。PUBLIC 且配了自定义域名时返回
可缓存直链（`signed: false`）。

## 权限

数据按 `clientId` 隔离。跨调用方访问别人的对象一律返回 404，
不区分「不存在」与「无权限」，避免被用来探测 fileId 是否有效。

## provider

| provider | 用途 |
|---|---|
| `LOCAL` | 开发、测试与 OSS 未配置时的兜底。上传下载同样走 platform 的签名端点，行为与 OSS 对齐 |
| `ALIYUN_OSS` | 生产。V1 预签名（HMAC-SHA1），沿用主站已在生产跑通的实现 |
| `ALIYUN_VOD` | **尚未迁移**，见下 |

OSS 上传不发 `x-oss-object-acl`：新版 Bucket 常关闭对象 ACL，带上会直接 403；
对象继承 Bucket 默认私有，读一律走签名。

大文件下载可开 `OSS_ACCELERATE_ENABLED`，走传输加速域名。

## 尚未迁移

- **阿里云点播（VOD）**：上传凭证、转码、播放地址是另一条独立链路，仍留在主站。
  `storeUpload` 里 `kind === "video"` 的分支不走 platform。
- **浏览器直连 OSS 的分片上传**：主站素材中心现有的 `createOssBrowserMultipart`
  仍在用主站自己的签名。platform 侧能力已具备，切换是独立一步。

## 产品侧接入

产品通过 `@yydsxwh/shared/platform-client` 调用，不要自己写 fetch。

兼容适配层在两个站点的 `packages/shared/src/platform-storage.ts`：

- `PLATFORM_STORAGE_ENABLED` 不为 `true` 时，行为与迁移前**完全一致**
- 开启后新上传交给 platform，库里存稳定引用 `platform://<fileId>`
- 历史数据仍是 OSS / 本地 URL，继续走原路径，**不需要回填**
- platform 不可达时取链接返回 null，调用方按缺图处理，不让整页挂掉
