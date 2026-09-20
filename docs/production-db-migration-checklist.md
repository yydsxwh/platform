# 生产数据库 Migration Checklist

状态：`DOCUMENTED`。本轮**不执行**任何生产数据库操作。

当前 migration（开发库已用）：

| 目录 | 内容 |
|---|---|
| `prisma/migrations/20260919235930_init_platform` | File / CatalogProduct / Release / ReleaseAsset / Payment / PaymentEvent / Refund |
| `prisma/migrations/20260920015926_add_ai_usage` | AiUsage（用量元数据，不含 prompt / 回复正文） |

## 预发 / 生产允许

```bash
npx prisma migrate status
npx prisma migrate deploy
```

`migrate deploy` 只应用尚未应用的、已提交的 SQL，可重复执行。

## 禁止

- `prisma migrate reset`
- `prisma migrate dev` 对着生产库
- `prisma db push` 对着生产库
- 手工 `DROP TABLE` / `DROP DATABASE`
- 把开发 SQLite 文件拷到生产冒充迁移

## 上生产前人工确认

- [ ] 备份
- [ ] 在预发对**同一份** migration 跑过 `migrate deploy`
- [ ] `migrate status` 显示无 drift
- [ ] 回滚方案已写明（本轮无自动 down）
- [ ] Owner 确认窗口 `NEEDS_OWNER_CONFIRMATION`

本轮 schema **没有**新增需要生产 migrate 的表。已有两条 SQL 仅在 platform 自己的库执行。
