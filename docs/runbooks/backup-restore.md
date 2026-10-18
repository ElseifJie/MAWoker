# MA Worker 备份、恢复与迁移回滚

## 备份

```bash
npm run db:backup -- --label pre-migration
# 自定义目录 / 覆盖同名（文件名含时间戳，通常无需 force）
npm run db:backup -- --out-dir /secure/backups --label release
```

- 使用 `pg_dump --format=custom`，不包含 owner/privilege。
- 输出文件名含 UTC 时间戳；日志中的数据库 URL 会脱敏。
- 建议：迁移前、发布前、批量数据操作前各做一次，备份文件放独立加密存储。

## 恢复

恢复是破坏性操作，会 `--clean --if-exists` 删除目标库现有对象。

```bash
RESTORE_CONFIRM=restore npm run db:restore -- \
  --file backups/maworker-2026-10-17T00-00-00-000Z-pre-migration.dump \
  --yes
```

- 必须显式 `--yes` + `RESTORE_CONFIRM=restore`。
- `NODE_ENV=production` 还需 `--allow-production`。
- 恢复后运行 `npm run db:migrate` 对齐最新迁移，再跑 healthcheck 与冒烟测试。

## 迁移回滚

迁移只向前。回滚步骤：

1. 停止 API/Worker，阻止新写入。
2. 用最近一次迁移前备份恢复到新库（或原地恢复）。
3. 将应用回退到与备份匹配的版本。
4. 启动 API/Worker，验证 `/health`、登录、任务读取。

不要手工执行 `DROP`/逆向 SQL；结构回滚只通过备份恢复。

## 演练清单

- 每季度一次从备份恢复到临时库。
- 记录备份时间、恢复耗时、校验行数/关键表。
- 迁移 PR 必须附迁移前备份路径与恢复演练结果。
