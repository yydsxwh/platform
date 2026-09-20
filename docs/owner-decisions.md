# Owner 已拍板的架构决策（2026-09-20）

来源：Owner 正式文件《公司公共架构拍板决定》。  
智能体不得自行改这些值。真实 DNS / TLS / 支付生产切换 / 主站生产 merge **尚未执行**。

## 已确认

| 项 | 正式值 | 代码/文档状态 | 线上状态 |
|---|---|---|---|
| Platform 预发域名 | `https://api-staging.yydsxwh.com` | `DOCUMENTED` | 未由本 Agent 配置 DNS/TLS。`NEEDS_OWNER_CONFIRMATION`（落地执行） |
| Platform 生产域名 / audience | `https://api.yydsxwh.com` | `DOCUMENTED` | 五模块仍 `NOT_DEPLOYED` |
| Account | `https://account.yydsxwh.com` | `DOCUMENTED` | Account 系统已上线 |
| Account issuer | `https://account.yydsxwh.com` | `DOCUMENTED` | Discovery 实测 `NEEDS_ACCOUNT_INTEGRATION` |
| Account JWKS | `https://account.yydsxwh.com/.well-known/jwks.json` | `DOCUMENTED` | JWKS 行为 `NEEDS_ACCOUNT_INTEGRATION` |
| 预发进程目录 | `/var/www/platform-staging` | `DOCUMENTED` | 未自动创建 |
| 预发进程名 | `platform-staging` | `DOCUMENTED` | 未自动安装 |
| 预发监听 | `127.0.0.1:4000` | 进程默认 `HOST=127.0.0.1` `IMPLEMENTED` / `TESTED` | 未在服务器落地 |
| 支付真实商户 | **本轮不切生产** | `STAGING_READY` / `NOT_PRODUCTION_MIGRATED` | 线上仍走产品现有链路 |
| Flag 顺序 | AI → Catalog → Releases → Storage → Payments | `DOCUMENTED` | 默认全关 |
| PR 顺序 | shared → platform → 产品非生产 → staging → 单项验证 → **主站生产最后** | `DOCUMENTED` | 主站生产 PR **禁止自动 merge** |

预发与生产必须分开：环境变量、Service Token、数据库、Secret、日志、进程、Nginx。禁止混用。

audience **不是** `andyyyds` / `softwarelist` / `rishi` 的 client_id。

## 仍是阻塞项

### NEEDS_OWNER_CONFIRMATION

- DNS 记录是否已添加
- TLS 证书策略
- 服务器上是否已建目录 / 是否用 4000 端口（规划已定，落地未做）
- 生产支付回调切换（Owner 决定本轮**不做**）
- 主站生产分支 PR 合并
- 生产 Secret 配置
- 真实支付商户资料

### NEEDS_ACCOUNT_INTEGRATION

- Discovery 实际响应
- JWKS 行为
- audience 与 account 现有实现是否兼容（不要改 account 迁就）
- User Assertion / 验签
- 产品 Session 与 OIDC 打通
