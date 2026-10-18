# Documentation

Long-lived project documentation is committed selectively. Internal execution
plans, implementation journals and historical evidence stay local-only and are
ignored by Git.

## Architecture and design

- [Architecture diagrams](assets/diagrams/README.md) — overall system, memory,
  file delivery and multi-tenant isolation.
- [Target architecture and refactoring notes](research/MAWork-个人助手目标架构与重构建议-2026-10-17.md)
- [MAWork vs. Open Muse research](research/MAWork-vs-open-muse-2026-10-15.md)

## Operations

- [Backup and restore](runbooks/backup-restore.md)
- [Event ingestor cutover](runbooks/event-ingestor-cutover.md)

## UI

- [Shell and panel parity checklist](ui/harness-parity.md)

## Local-only material

`docs/plans/` remains local-only. Historical implementation journals and
archive evidence were removed during repository cleanup; keep future working
records outside version control and promote durable material into this
directory before committing it.
