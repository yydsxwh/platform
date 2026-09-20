# Platform 预发部署方案

状态：`DOCUMENTED`（Owner 已拍板域名与隔离原则）  
**不是** `DEPLOYED`。本 Agent **不**连接生产机、不配 DNS、不装 TLS、不写会 SSH 的 workflow。

## Owner 拍板的拓扑

| 项 | 预发 | 生产（规划，未部署 platform） |
|---|---|---|
| 域名 | `https://api-staging.yydsxwh.com` | `https://api.yydsxwh.com` |
| 目录 | `/var/www/platform-staging` | `/var/www/platform` |
| 进程 | `platform-staging` | `platform` |
| 监听 | `127.0.0.1:4000`（`HOST` + `PORT`） | 独立进程与独立配置 |

```
api-staging.yydsxwh.com
  → Nginx :443
  → 127.0.0.1:4000  (platform-staging)
```

预发与生产必须各自拥有：环境变量、Service Token、数据库、Secret、日志、进程、Nginx。  
即使暂时与主站在同一台香港机器，也禁止混用敏感配置。

不要用 `api.yydsxwh.com` 当预发。不必再单独建 dev 域名。

## 探活（预发配好之后）

```text
GET https://api-staging.yydsxwh.com/health
GET https://api-staging.yydsxwh.com/ready
```

本机未反代时：`GET http://127.0.0.1:4000/health`。  
`/health` 不因外部 AI Provider 故障变红。`/ready` 在数据库不可用时 `503`。

预发不得影响主站生产流量。

## 数据库

```bash
npx prisma migrate deploy
```

预发使用**独立** `DATABASE_URL`，禁止与主站或未来生产 platform 共用。  
禁止 `migrate reset` / 对预发库 `db push` 当生产迁移。见 `production-db-migration-checklist.md`。

## 环境变量

见 `.env.example`。预发至少：

- 独立 `DATABASE_URL`
- 独立 `PLATFORM_SERVICE_TOKENS`（每产品不同，且与生产不同）
- `PAYMENT_ALLOW_MOCK`：预发可用 mock；**生产必须 false**
- Owner 已拍板、可写入预发（公开标识，不是 Secret）：

```bash
ACCOUNT_ISSUER=https://account.yydsxwh.com
ACCOUNT_JWKS_URI=https://account.yydsxwh.com/.well-known/jwks.json
ACCOUNT_AUDIENCE=https://api.yydsxwh.com
```

写入这些变量 **不等于** 已实现 assertion 验签。验签：`NEEDS_ACCOUNT_INTEGRATION`。

## systemd / PM2 示例（不自动安装）

工作目录：`/var/www/platform-staging`  
进程名：`platform-staging`  
`EnvironmentFile` 必须是预发专用文件。

完整片段：`docs/examples/platform-staging.service`。

构建：`npm ci && npm run build`，启动 `node dist/server.js`。

## Nginx 示例（不自动配置）

`docs/examples/platform-staging.nginx.conf`

`server_name api-staging.yydsxwh.com;` → `127.0.0.1:4000`。

DNS 记录与 TLS 证书：**规划已拍板，落地仍是** `NEEDS_OWNER_CONFIRMATION`。

## Feature Flag

产品侧默认全 `false`。预发只对**测试用的产品实例**按  
AI → Catalog → Releases → Storage → Payments  
每次开一个。见 `feature-flag-rollout.md`。

Payments 预发只验核心 + mock，**不切**真实微信/支付宝生产商户。

## 回滚

1. 产品：对应 `PLATFORM_*_ENABLED=false`
2. 停 `platform-staging`，恢复上一份 `dist/` 与预发 `.env`
3. 库只向前 migrate

## 明确不做

- 不自动部署、不写生产 SSH workflow
- 不把 platform 并进 `Andyyyds20260901independentpackage`
- 不把预发 Secret 写进 Git
- 不声称预发文档完成 = `DEPLOYED`
