# Platform 预发部署方案

状态：`DOCUMENTED` / `STAGING_READY` 准备  
**不是** `DEPLOYED`。本轮不连接生产服务器，不使用 `DEPLOY_HOST` / `DEPLOY_SSH_KEY` / `DEPLOY_USER`，不自动部署。

## 推荐拓扑

- 独立进程，不要塞进主站 Next.js
- 推荐域名（**不要假设 DNS 已存在**）：`https://api.yydsxwh.com`  
  未配 DNS 前可用内网 IP + 端口，或预发子域。`NEEDS_OWNER_CONFIRMATION`
- 推荐端口：`4000`（可用环境变量 `PORT` 覆盖）

```
客户端 / 产品后端
    → nginx :443
    → 127.0.0.1:4000  (platform)
```

产品继续走自己的域名。Feature Flag 默认 `false`，预发按模块单独打开。

## Health

| URL | 含义 | 鉴权 |
|---|---|---|
| `GET /health` | 进程活着 | 无 |
| `GET /healthz` | 同上（兼容） | 无 |
| `GET /ready` | DB 与存储配置已就绪 | 无 |

`/health` **不**因外部 AI Provider 暂时失败而变红。  
`/ready` 在数据库不可用时返回 `503`。

反代与 systemd 探活用 `/health`；编排「能否接流量」用 `/ready`。

## 数据库 migration

开发 / 预发：

```bash
npx prisma migrate deploy
```

**禁止**在预发或生产执行：

- `prisma migrate reset`
- `prisma db push` 覆盖生产
- `DROP TABLE`

详见 `docs/production-db-migration-checklist.md`。本轮不执行生产库操作。

## 环境变量

见仓库根目录 `.env.example`。上预发前至少：

- `NODE_ENV=production`（预发若要禁 mock，也设 production 或确保 `PAYMENT_ALLOW_MOCK=false`）
- `DATABASE_URL`
- `PLATFORM_SERVICE_TOKENS`（每产品不同）
- 若用 OSS：整套 `OSS_*`
- 若验 AI：`AI_PROVIDERS` + 对应 `AI_KEY_*`
- 建议：`STORAGE_LOCAL_SIGNING_KEY`

## systemd 方案（建议，不自动安装）

```ini
[Unit]
Description=yydsxwh platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/yydsxwh/platform
EnvironmentFile=/opt/yydsxwh/platform/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

构建：`npm ci && npm run build`，产物 `dist/server.js`。

## nginx 方案（建议，不自动配置）

```nginx
server {
  listen 443 ssl;
  server_name api.yydsxwh.com;  # DNS 未定时不要启用此 server_name

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_read_timeout 120s;
  }

  location /health {
    proxy_pass http://127.0.0.1:4000/health;
  }
}
```

TLS 证书、DNS、防火墙端口：`NEEDS_OWNER_CONFIRMATION`。

## 回滚

1. 产品侧：把对应 `PLATFORM_*_ENABLED` 改回 `false`，不必回滚产品代码
2. platform 进程：停掉新进程，恢复上一份 `dist/` 与 `.env`，再启动
3. 数据库：只允许向前的 migrate；回滚表结构需要单独、经确认的 down SQL，本轮不准备自动 down

## 明确不做

- 不写会连生产机的 deploy workflow
- 不把 platform 并进 Andyyyds 的 `Andyyyds20260901independentpackage` 自动部署
- 不假设 `api.yydsxwh.com` 已经解析
