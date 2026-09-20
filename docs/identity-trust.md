# Platform 身份信任模型

状态：`DOCUMENTED` + 服务凭证路径 `IMPLEMENTED` / `TESTED`  
User assertion 验签：`PLANNED` / `NEEDS_ACCOUNT_INTEGRATION`

## 两层身份，禁止混用

| 层 | 是什么 | 谁持有 | 如何验证 |
|---|---|---|---|
| **Service Identity** | 产品后端是谁 | 仅产品服务器环境变量 | `Authorization: Bearer <token>` |
| **End User Identity** | 哪个最终用户 | 不直接给 platform | 服务身份通过后，才接受后端传来的上下文 |

```
Browser / App
  → Product Backend
  → 验证自己的产品 Session / OIDC
  → 作为可信服务调用 Platform
  → Platform 验证 Service Identity
  → 再接受该后端传递的用户上下文
```

## 禁止

```
浏览器：
  X-Platform-Actor: usr_别人
  （没有有效服务凭证）

platform：
  直接相信   ← 不允许
```

当前实现：`/v1/*` 业务路由先跑 `serviceAuthMiddleware`。没有匹配 token 时直接 `UNAUTHENTICATED`，**不会读取 Actor**。

`/health`、`/ready`、本地对象签名 URL、支付渠道 webhook **不**走服务凭证；它们各有自己的信任根（进程探活、URL HMAC、渠道签名）。

## 当前兼容：`X-Platform-Actor`

- 头名冻结，account 接入后改为传全局 `usr_*` sub，调用方不用改头名
- 仅表示「这个可信后端声称代表谁」
- 产品后端必须先验自己的 Session，禁止把浏览器未校验的用户 id 原样转发

## 长期：Verified User Context

契约在 `@yydsxwh/shared/contracts/identity`。

未来可升级为（本轮**不实现**第二套 OAuth）：

- account 签发短期 assertion
- 可信产品后端签名的短期 JWT
- 标准 token exchange

预留头：`X-Platform-User-Assertion`。本轮不实现验签。

Owner 拍板的公开标识（写入环境变量 ≠ 已验签）：

```bash
ACCOUNT_ISSUER=https://account.yydsxwh.com
ACCOUNT_JWKS_URI=https://account.yydsxwh.com/.well-known/jwks.json
ACCOUNT_AUDIENCE=https://api.yydsxwh.com
```

长期 assertion：`iss = https://account.yydsxwh.com`，`sub = usr_*`，`aud = https://api.yydsxwh.com`。  
不要把产品 client_id 当成 audience。Discovery / JWKS 实测：`NEEDS_ACCOUNT_INTEGRATION`。

## Service Token

- 每个产品一把，可多把以便轮换：`andyyyds`、`softwarelist`、未来 `rishi`
- 格式：`clientId:token` 或 `clientId:token:ai+storage`
- 轮换：同一 clientId 加新 token → 切流量 → 删旧 token → 重启
- 吊销：从 `PLATFORM_SERVICE_TOKENS` 去掉并重启
- 最小权限：可选 scope。未写则五个已实现模块全开（兼容）
- 日志自动脱敏，禁止打印完整 token

一把 token 泄漏 ≠ 全公司失守：按 client 隔离数据，也可按 scope 收紧模块。
