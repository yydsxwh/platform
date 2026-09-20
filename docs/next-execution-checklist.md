# Owner 拍板后的执行清单与剩余阻塞

状态截止本轮 Agent：**文档与契约已按拍板更新。未部署。未 merge 主站生产 PR。**

## 已完成（本工作区）

- [x] 域名 / Account 公开标识写入 shared 常量（tag `v0.5.1`）与 platform 文档
- [x] 支付标注 `NOT_PRODUCTION_MIGRATED`，预发只验核心
- [x] PR 顺序与「主站生产最后、禁止自动 merge」写入文档
- [x] Flag 顺序保持 AI → Catalog → Releases → Storage → Payments
- [x] 预发 systemd / nginx **示例文件**（不自动安装）
- [x] 进程默认监听 `127.0.0.1:4000`（可用 `HOST` / `PORT` 覆盖）
- [x] Account 公开标识写入配置默认值（不验签）
- [x] 身份边界代码（上一轮）：无服务凭证则不接受 Actor

## 人工下一步（Agent 不会做）

1. Review 并 merge：shared → platform → 产品**非生产**分支  
   **禁止** merge `Andyyyds#24` 或任何进入 `Andyyyds20260901independentpackage` 的 PR，除非 Owner 再次明确。
2. 在香港机创建 `/var/www/platform-staging`、独立 DB 与 Secret、进程 `platform-staging`、`127.0.0.1:4000`
3. DNS + TLS：`api-staging.yydsxwh.com` → 该进程  
   `GET https://api-staging.yydsxwh.com/health` 与 `/ready`
4. 预发产品实例只开 `PLATFORM_AI_ENABLED`，验通再往下
5. 打开 account 仓库联调 Discovery / JWKS / aud

## 阻塞

| 标记 | 项 |
|---|---|
| `NEEDS_OWNER_CONFIRMATION` | DNS、TLS、装机落地、生产 Secret、主站生产 merge、支付生产切换（本轮不做） |
| `NEEDS_ACCOUNT_INTEGRATION` | Discovery 实测、JWKS 行为、aud 兼容、assertion 验签、产品 OIDC |
