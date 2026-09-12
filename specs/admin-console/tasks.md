# 实施计划

R1（权限与账户生命周期）是地基，最先实施；R2（审计）与 R3（用量与配额）可并行；R4（账户详情页）消费 R2 / R3 的查询接口，最后实施。UI 规范落地（阶段 5）与验收（阶段 6）收尾。

- [x] 1. R1：权限模型与账户生命周期
  - [x] 1.1 定义权限常量与集中映射表，重构管理路由守卫
    - 在 `packages/domain` 定义六个权限常量与 `ROLE_PERMISSIONS` 映射（admin 全量、user 空）；`apps/api` 的 `requireAdmin` 替换为 `requirePermission(perm)`，全部既有与新管理路由声明权限。
    - 断言非 admin 访问的对外响应与重构前完全一致。
    - _需求: 1.1, 1.2, 1.3_
  - [x] 1.2 实现用户启停与强制下线 API
    - `PATCH /admin/users/:id/status`（禁用同事务吊销全部 `auth_sessions`）与 `POST /admin/users/:id/sessions/revoke`（幂等）。
    - 守卫：`SELF_TARGET_FORBIDDEN`、`LAST_ACTIVE_ADMIN`（事务内 `FOR UPDATE` 锁定判定），新增两个错误码进 contracts；成功与被拒均写审计（`user.status.update`、`user_sessions.revoke`）。
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7；6.4_
  - [x] 1.3 实现角色变更 API
    - `PATCH /admin/users/:id/role`，复用 1.2 守卫；成功后吊销目标用户会话使权限即刻生效；审计 `user.role.update`（from/to）。
    - _需求: 2.4, 2.5, 2.6, 2.7_
  - [x] 1.4 用户列表分页与检索
    - `GET /admin/users` 支持 `cursor` / `limit≤100` / `q` 邮箱子串检索（转义 `%` `_`），按创建时间倒序 keyset 分页，响应含 `nextCursor`；web 镜像类型同步。
    - _需求: 3.1, 3.2, 3.3, 3.4_
  - [x] 1.5 用户列表页改造
    - Users 页改 `DataTable` 列表（含配额摘要与维度状态徽标）、搜索框（300ms 防抖）、Load more 翻页；行操作 View / Disable / Enable / Force sign-out / Change role，危险操作走确认 Dialog 并明示影响。
    - _需求: 2.1–2.7, 3.1–3.4, 11.2, 11.5_

- [x] 2. R2：审计查询
  - [x] 2.1 审计读取 repository 与查询 API
    - `GET /admin/audit-logs`：`since`/`until`/`actorId`/`action`/`resourceType`/`resourceId`/`result` 筛选，`created_at desc, id desc` keyset 分页；新增 §5.3 审计索引；断言响应不含用户内容与 System Prompt 全文。
    - _需求: 5.1, 5.2, 5.3_
  - [x] 2.2 审计事件补全与变更明细
    - 新增 `auth.login`（成功/失败，无凭据信息）、`quota_interrupt.enqueue`（worker 处理器内）、`user.view`；`platform_agent.update` metadata 记录变更字段与版本前后值，System Prompt 仅记 changed + length；`user_quota.update` 补继承来源。
    - _需求: 4.4, 6.1, 6.2, 6.3, 6.4_
  - [x] 2.3 审计日志页面
    - 筛选行（时间范围 / 操作者 / 动作 / 资源类型 / 结果）+ 表格（时间、操作者、动作、资源、结果徽标、错误码等宽）+ Load more；默认最近 7 天。
    - _需求: 5.4, 11.2, 11.6_

- [x] 3. R3：用量与配额
  - [x] 3.1 `usage_ledger` 归因列迁移与回填
    - 加 `agent_kind` / `platform_agent_id` / `personal_agent_id` / `model_id` 可空列与 §5.3 索引；入账事务内随 Session 上下文冗余写入；一次性回填脚本（幂等可重跑）；断言唯一键与 `on conflict do nothing` 行为不变。
    - _需求: 10.1, 10.2, 10.3_
  - [x] 3.2 管理侧用量聚合 API
    - `GET /admin/usage/overview`：UTC 月窗口 totals（token 三项、活跃用户、新建 Session、触顶用户）+ 逐用户行（按 Token 倒序 keyset 分页）+ 维度状态（ok/near/exhausted，阈值常量 0.8，limit=0 视为 exhausted）；与用户侧 `GET /usage` 同源同口径。
    - _需求: 7.1, 7.2, 7.3, 7.5_
  - [x] 3.3 按 Agent 用量 API
    - `GET /admin/usage/agents`：平台 Agent（默认指派数 + 当月 Token，走归因列聚合）与个人 Agent（数量 + Token 合计）。
    - _需求: 8.1, 8.2_
  - [x] 3.4 默认配额策略运行时编辑
    - `quota_policies` 加 `updated_by` / `updated_at` 列；`GET` / `PUT /admin/quota-policy`（四维全量替换、非负校验、审计 old→new）；修改后复用既有越限检查为超限用户入队 quota interrupt。
    - _需求: 9.1, 9.2, 9.4；6.3_
  - [x] 3.5 `Notifier` 接口与埋点
    - `packages/domain` 定义接口 + `LoggingNotifier` 空实现；worker 对账与配额下调复查两处按 0.8 / 1.0 阈值调用。
    - _需求: 12.2_
  - [x] 3.6 用量页与设置页
    - Usage 页：四张统计卡（Linear 卡片令牌）、按用户明细表（Token 等宽右对齐、状态徽标、行点击进详情）、By Agent 区块、Export CSV（客户端 Blob）、计费窗口说明。
    - Settings 页：仅 "Default quota policy" 卡（四维输入 + 最后修改人/时间），不放未来项空壳。
    - _需求: 7.1–7.5, 8.1, 8.2, 9.1, 11.2, 11.4_
  - [x] 3.7 用户配额继承 / 覆盖改造
    - `PUT /admin/users/:id/quota` 请求体四维改可空（null=继承），响应返回生效值与继承来源；详情页配额卡与既有配额表单改为"继承默认 / 单独覆盖"表达，清空即继承。
    - _需求: 9.3, 9.4_

- [x] 4. R4：账户详情页
  - [x] 4.1 详情聚合 API
    - `GET /admin/users/:id`（身份 + 生效配额及继承来源 + 当月用量摘要，写 `user.view` 审计）、`GET /admin/users/:id/sessions`（元数据 + 每会话累计 Token，分页）、`GET /admin/users/:id/audit`（actor/owner 相关审计，分页）。
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 4.2 详情页 UI
    - Overview / Usage / Sessions / Audit 四 Tab（`?tab=` 路由承载），操作区含重置密码 / 强制下线 / 启停 / 改角色；Tokens 与 ID 等宽展示；无任何正文入口。
    - _需求: 4.1–4.5, 11.2, 11.5, 11.6_

- [x] 5. UI 规范与导航落地
  - [x] 5.1 设计令牌映射与双主题校验
    - `ui/components.css` 变量对齐 `docs/ui-design.md`（深色近黑体系 + 浅色 Light Neutrals 等价映射、靛蓝仅主 CTA / 激活态、状态色仅徽标、6/8/12px 圆角、8px 网格）；随 `theme.ts` 切换，两主题对比度 ≥ WCAG AA。
    - _需求: 11.2, 11.3, 11.4, 11.6_
  - [x] 5.2 管理导航与数据加载重构
    - 导航改为 Users / Usage / Audit / Platform Agents / Settings，默认路由改 `/admin/users`；`AdminWorkspace` 拆掉一次性全量加载，Agent 列表与模型允许列表保留外壳级加载，其余按页自取。
    - _需求: 11.1_

- [x] 6. 验收与回归
  - [x] 6.1 权限与隐私安全回归
    - 非 admin 访问全部新增管理路由的拒绝矩阵；详情 / 用量 / 审计响应无 transcript、载荷、附件与产物内容；客户端角色声明被忽略——覆盖率 100%。
    - _需求: 1.2, 1.3, 4.2, 5.3, 7.5_
  - [x] 6.2 生命周期守卫与并发测试
    - 自操作与最后活跃管理员保护（含并发互斥窗口）；禁用后会话即刻失效、登录被拒；强制下线幂等。
    - _需求: 2.2–2.7_
  - [x] 6.3 端到端管理员工作流
    - 检索 → 详情 → 禁用 / 启用 → 改角色 → 审计筛选定位操作 → 用量总览与 CSV → 默认策略修改触发越限拦截；管理侧与用户侧用量数值一致性断言。
    - _需求: 2.x, 3.x, 4.x, 5.x, 6.x, 7.x, 8.x, 9.x_
  - [x] 6.4 UI 走查
    - 浅 / 深双主题渲染与对比度、键盘遍历与 Dialog 焦点管理、危险操作确认流、响应式断点（表格堆叠、统计卡折行）。
    - _需求: 11.1–11.6, 12.4_
