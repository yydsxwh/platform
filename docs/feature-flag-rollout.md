# 预发 Feature Flag 验证顺序

产品适配层开关，**默认必须保持 `false`**。本轮不改默认值。

| 开关 | 模块 | 默认 |
|---|---|---|
| `PLATFORM_AI_ENABLED` | AI | `false` |
| `PLATFORM_CATALOG_ENABLED` | Catalog | `false` |
| `PLATFORM_RELEASES_ENABLED` | Releases | `false` |
| `PLATFORM_STORAGE_ENABLED` | Storage | `false` |

Payments **没有**产品侧总开关可开生产渠道。platform 仅有核心 + mock。真实微信/支付宝切换：`NEEDS_OWNER_CONFIRMATION`。

## 顺序（每次只开一个）

1. AI
2. Catalog
3. Releases
4. Storage
5. Payments（必须最后）

## 每次验证清单

| 项 | 期望 |
|---|---|
| 正常路径 | 开关 true 且 platform `/ready` 为 200 时走新实现 |
| platform 不可达 | 适配层 fallback 旧逻辑，站点不 500 |
| timeout | 与不可达相同，回落旧逻辑 |
| fallback | 旧 URL / 旧 import / 旧下载入口仍可用 |
| rollback | 只关这一个开关即回到旧行为 |

## 建议预发操作

```bash
# 例：只开 AI
PLATFORM_AI_ENABLED=true
PLATFORM_CATALOG_ENABLED=false
PLATFORM_RELEASES_ENABLED=false
PLATFORM_STORAGE_ENABLED=false
```

验证正文翻译或 MathCode 走 platform（看 platform 用量与 requestId），再关开关确认旧路径恢复。

Catalog：开之后产品页事实来自 `/v1/catalog/products`；关之后回到本地 `SOFTWARE_PRODUCTS`。

Releases：旧 `/api/app/download/...` URL 不变；开之后内部问 Releases。

Storage：开之后新上传走签名；历史 OSS / 本地 URL 不回填。

Payments：预发只用 mock + webhook 签名；**不要**改生产商户证书或回调域名。
