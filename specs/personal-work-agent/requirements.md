# Personal Work Agent 一期需求规格

## 1. 介绍

本项目基于火山引擎方舟 Managed Agents 构建一个面向个人工作的多用户 Web 应用。产品体验参考 TRAE Work 的简洁工作台，但一期仅交付 Agent 创建管理、Session 任务执行、输入附件和任务产物管理的完整闭环。

一期采用共享火山工作空间，并由应用后端实施严格的用户级租户隔离。每个普通用户是一个独立租户，不支持团队空间、用户间资源共享或管理员代查用户内容。管理员维护的平台 Agent 是唯一例外：它们可被多个用户共享引用，但普通用户只能使用，不能修改。Skills、MCP、Vault 和 Memory Store 在一期仅保留清晰的产品入口、领域边界和后端扩展接口，不实现完整管理流程。

本文中的“平台 Agent”指由管理员创建和维护、可分配给普通用户使用的共享只读 Agent；“个人 Agent”指由普通用户创建和维护的私有 Agent；“Session”指绑定特定 Agent 版本、在共享 Environment 中运行的一次独立任务实例；“产物”指 Agent 写入 `/mnt/session/outputs/` 的输出文件。

## 2. 目标

- 让获得默认平台 Agent 分配的用户登录后无需配置即可立即发起任务。
- 让用户创建和维护多个私有 Agent。
- 让管理员创建和维护多个平台 Agent，并为每个普通用户指定默认平台 Agent。
- 让用户通过持久化 Session 完成多轮、异步、可中断的工作任务。
- 实时展示 Agent 回复、思考状态、工具调用、状态变化和错误。
- 支持任务输入附件以及 Agent 产物的查看、下载和删除。
- 在共享方舟工作空间中保证用户资源隔离并限制平台成本风险。

## 3. 非目标

- 团队、组织、成员角色及普通用户之间的资源共享。
- Agent 版本历史浏览、版本对比或版本回滚。
- 用户自定义 Environment。
- 自定义 Skill 上传、SkillHub 管理、MCP Server 配置及 Vault 凭据管理。
- Memory Store 的创建、挂载和内容管理。
- 输入附件的跨 Session 复用或个人资料库。
- 用户计费、套餐购买或支付。
- 用户自带 `ARK_API_KEY` 或其他模型供应商接入。

## 4. 用户故事与验收标准

### 需求 1：用户认证

**用户故事：** 作为用户，我希望通过邮箱验证码安全登录，以便访问自己的工作空间。

#### 验收标准

1.1 WHEN 用户提交有效邮箱地址，THE 系统 SHALL 通过托管身份服务发送一次性登录验证码。

1.2 WHEN 用户提交有效且未过期的验证码，THE 系统 SHALL 建立经过服务端验证的登录会话。

1.3 IF 验证码无效、过期或超过尝试限制，THEN THE 系统 SHALL 拒绝登录并显示不泄露账户状态的错误信息。

1.4 WHILE 用户未通过身份验证，THE 系统 SHALL 拒绝访问所有 Agent、Session、附件、产物和用量接口。

1.5 THE 系统 SHALL 仅使用可信身份令牌中的稳定 `user_id` 标识租户，不接受客户端提交的 `owner_id`。

### 需求 2：用户级租户隔离

**用户故事：** 作为用户，我希望我的 Agent、任务和文件与其他用户完全隔离，以保护个人数据。

#### 验收标准

2.1 THE 系统 SHALL 将每个普通用户视为独立租户，并将其个人 Agent、Session、输入附件、产物及用量记录绑定至该用户。

2.2 WHEN 普通用户访问任一方舟资源，THE 系统 SHALL 在调用方舟 API 前校验该资源属于当前用户或是已分配给该用户的平台 Agent。

2.3 IF 用户请求不属于自己的资源，THEN THE 系统 SHALL 返回 `404`，且不得泄露该资源是否存在。

2.4 THE 系统 SHALL 禁止浏览器直接持有或使用平台 `ARK_API_KEY`。

2.5 THE 系统 SHALL 禁止普通用户查看、修改或导出其他用户的资源以及未分配给自己的平台 Agent。

2.6 THE 系统 SHALL 不提供团队空间、普通用户之间的资源共享或管理员代查用户内容功能。

### 需求 3：默认平台 Agent 与首次使用

**用户故事：** 作为新用户，我希望登录后可以立即发起任务，而无需先理解 Agent 配置。

#### 验收标准

3.1 THE 系统 SHALL 允许每个普通用户关联一个由管理员指定的默认平台 Agent。

3.2 WHEN 用户尚未主动选择 Agent，THE 系统 SHALL 使用该用户最近使用的可用 Agent；若不存在最近使用记录，则使用为该用户指定的默认平台 Agent。

3.3 WHEN 用户在新建任务界面提交首条消息，THE 系统 SHALL 使用所选 Agent 和平台默认 Environment 创建 Session 并启动任务。

3.4 IF 用户没有可用的默认平台 Agent，THEN THE 系统 SHALL 阻止任务启动并显示联系管理员处理的明确状态。

3.5 THE 系统 SHALL 允许普通用户使用已分配的平台 Agent，但不得编辑、删除或导出其配置。

3.6 WHEN 管理员更改用户的默认平台 Agent，THE 系统 SHALL 仅将新分配应用于后续新建 Session。

3.7 WHILE 已有 Session 继续存在，THE 系统 SHALL 保持其创建时绑定的平台 Agent 及版本不变。

### 需求 4：Agent 管理

**用户故事：** 作为用户，我希望创建和维护多个个人 Agent，以适配不同工作场景。

#### 验收标准

4.1 THE 系统 SHALL 在 Agent 列表中区分已分配的平台 Agent 和用户拥有的个人 Agent。

4.2 THE 系统 SHALL 允许用户使用名称、描述、模型和 System Prompt 创建个人 Agent。

4.3 THE 系统 SHALL 允许用户编辑其个人 Agent 的名称、描述、模型和 System Prompt。

4.4 THE 系统 SHALL 允许用户删除其拥有的个人 Agent。

4.5 THE 系统 SHALL 为一期 Agent 固定启用 `agent_toolset_20260701`。

4.6 THE 系统 SHALL 将内置工具权限策略设置为 `always_allow`。

4.7 THE 系统 SHALL 只允许用户从平台配置的模型允许列表中选择模型。

4.8 IF 方舟 Agent 创建、更新或删除失败，THEN THE 系统 SHALL 保留可对账的本地状态并向用户显示可重试错误。

### 需求 5：Agent 版本行为

**用户故事：** 作为用户，我希望 Agent 修改不会改变已有任务的行为，以便历史任务可复现。

#### 验收标准

5.1 WHEN 普通用户保存个人 Agent 配置变更或管理员保存平台 Agent 配置变更，THE 系统 SHALL 基于方舟当前版本执行更新并记录返回的新版本号。

5.2 WHEN Session 创建成功，THE 系统 SHALL 记录该 Session 实际绑定的 Agent 版本。

5.3 WHILE Session 已存在，THE 系统 SHALL 保持其绑定的 Agent 版本不变。

5.4 WHEN 用户基于某 Agent 创建新 Session，THE 系统 SHALL 默认使用该 Agent 的最新版本。

5.5 THE 系统 SHALL 在会话详情中只读展示 Agent 版本。

5.6 THE 系统 SHALL 不向普通用户提供版本历史、版本对比或版本回滚操作。

### 需求 6：Session 创建与持续对话

**用户故事：** 作为用户，我希望每个会话对应一个持续存在的任务，以便进行多轮工作。

#### 验收标准

6.1 WHEN 用户新建任务，THE 系统 SHALL 创建一个绑定所选 Agent 版本和平台默认 Environment 的新 Session。

6.2 WHEN Session 创建完成但尚未收到用户消息，THE 系统 SHALL 将其显示为等待输入状态。

6.3 WHEN 用户向空闲或运行中的 Session 发送消息，THE 系统 SHALL 将消息作为 `user.message` 事件提交。

6.4 WHILE Session 处于运行状态，THE 系统 SHALL 允许用户继续提交补充消息，并明确显示消息处于已接收或待处理状态。

6.5 WHEN 用户中断正在运行的 Session，THE 系统 SHALL 提交 `user.interrupt`，并在收到状态事件后更新界面。

6.6 IF Session 已终止，THEN THE 系统 SHALL 禁止继续发送消息，并保留其历史记录供查看。

6.7 THE 系统 SHALL 允许用户查看自己的 Session 历史并继续尚未终止的 Session。

### 需求 7：实时事件体验

**用户故事：** 作为用户，我希望实时了解 Agent 正在做什么，以判断任务是否正常推进。

#### 验收标准

7.1 WHILE Session 正在执行，THE 系统 SHALL 通过 SSE 实时展示 `agent.message` 内容。

7.2 WHILE Agent 正在思考，THE 系统 SHALL 根据 `agent.thinking` 展示非阻塞的思考中状态，且不得伪造思考内容。

7.3 WHEN Agent 使用内置工具，THE 系统 SHALL 展示工具名称、执行状态和对应结果状态。

7.4 WHEN Session 状态变化，THE 系统 SHALL 展示 `idle`、`running`、`rescheduled` 或 `terminated` 的当前状态。

7.5 WHEN 收到 `session.error`，THE 系统 SHALL 显示可理解的错误状态，并区分可自动恢复与不可恢复错误。

7.6 IF 浏览器或上游 SSE 连接中断，THEN THE 系统 SHALL 自动重连、补取事件历史并按 `event.id` 去重。

7.7 THE 系统 SHALL 保证重新连接后已持久化事件不丢失且不重复展示。

### 需求 8：输入附件

**用户故事：** 作为用户，我希望给任务附加文件，以便 Agent 处理相关材料。

#### 验收标准

8.1 WHEN 用户为新任务选择附件，THE 系统 SHALL 通过 Files API 以 `purpose=agent` 上传文件。

8.2 WHEN Session 创建时存在附件，THE 系统 SHALL 将这些文件作为当前 Session 的只读资源挂载。

8.3 THE 系统 SHALL 仅在所属 Session 中展示输入附件。

8.4 THE 系统 SHALL 不在“我的文件”中展示输入附件。

8.5 THE 系统 SHALL 不允许一期输入附件跨 Session 复用。

8.6 IF 文件上传或挂载失败，THEN THE 系统 SHALL 阻止任务启动并允许用户重试。

### 需求 9：Agent 产物

**用户故事：** 作为用户，我希望集中管理 Agent 生成的文件，以便查看和下载工作成果。

#### 验收标准

9.1 THE 系统 SHALL 将 `/mnt/session/outputs/` 中生成的文件识别为 Agent 产物。

9.2 THE 系统 SHALL 在“我的文件”中只展示当前用户的 Agent 产物。

9.3 THE 系统 SHALL 支持按来源 Session 筛选产物。

9.4 THE 系统 SHALL 展示产物名称、类型、大小、生成时间和来源 Session。

9.5 WHEN 用户下载产物，THE 系统 SHALL 在完成租户归属校验后提供有效下载响应。

9.6 WHEN 用户永久删除产物，THE 系统 SHALL 删除对应存储对象和本地产物索引。

9.7 IF 产物存储操作失败，THEN THE 系统 SHALL 保留可对账状态并允许后台重试。

### 需求 10：Session 归档与永久删除

**用户故事：** 作为用户，我希望整理历史任务，并能在明确确认后彻底删除不再需要的数据。

#### 验收标准

10.1 WHEN 用户归档 Session，THE 系统 SHALL 将其从默认任务列表隐藏，且保留方舟 Session、事件和产物。

10.2 WHEN 用户恢复已归档 Session，THE 系统 SHALL 将其重新显示在默认任务列表中。

10.3 WHEN 用户请求永久删除 Session，THE 系统 SHALL 要求明确的二次确认。

10.4 IF 待删除 Session 正在运行，THEN THE 系统 SHALL 先中断执行并等待其退出运行状态。

10.5 WHEN Session 可删除，THE 系统 SHALL 删除方舟 Session、应用层关联记录和该 Session 的 TOS 产物。

10.6 IF 永久删除任一步骤失败，THEN THE 系统 SHALL 保留删除任务记录并标记为 `deletion_failed`。

10.7 WHILE 删除任务处于失败状态，THE 系统 SHALL 由后台任务重试且不得向用户展示为删除成功。

### 需求 11：共享运行环境

**用户故事：** 作为平台运营者，我希望使用统一、受控的运行环境，以降低配置漂移和密钥泄露风险。

#### 验收标准

11.1 THE 系统 SHALL 为所有一期 Session 使用同一个平台管理的 Environment。

11.2 THE 系统 SHALL 禁止普通用户创建、编辑或删除 Environment。

11.3 THE 系统 SHALL 禁止在 Environment 中存放用户专属密钥。

11.4 THE 系统 SHALL 默认使用出站域名白名单，而不是 unrestricted 网络访问。

11.5 THE 系统 SHALL 将用户级第三方凭据的未来扩展边界定义为 Session 创建时引用用户专属 Vault。

### 需求 12：密钥与模型安全

**用户故事：** 作为平台运营者，我希望平台密钥和用户凭据受到保护，以控制共享工作空间风险。

#### 验收标准

12.1 THE 系统 SHALL 仅在服务端运行环境中读取平台 `ARK_API_KEY`。

12.2 THE 系统 SHALL 不在浏览器响应、日志或错误信息中返回平台 `ARK_API_KEY`。

12.3 THE 系统 SHALL 不允许普通用户配置或替换平台 `ARK_API_KEY`。

12.4 THE 系统 SHALL 为未来用户凭据采用 Vault 存储，并将凭据值设计为只写不可读。

12.5 THE 系统 SHALL 禁止自定义 Skill 包含明文密钥。

12.6 THE 系统 SHALL 不允许一期用户接入平台允许列表之外的模型或模型供应商。

### 需求 13：用户级硬配额

**用户故事：** 作为平台运营者，我希望限制每个用户的资源和用量，以避免共享账号被滥用。

#### 验收标准

13.1 THE 系统 SHALL 默认限制每个用户最多拥有 10 个个人 Agent，已分配的平台 Agent 不计入该额度。

13.2 THE 系统 SHALL 默认限制每个用户同时运行最多 2 个 Session。

13.3 THE 系统 SHALL 支持配置每用户每日新建 Session 上限。

13.4 THE 系统 SHALL 支持配置每用户月度 Token 上限。

13.5 WHEN 用户达到月度 Token 上限，THE 系统 SHALL 禁止其发起新任务或继续触发模型执行。

13.6 WHILE 用户处于额度受限状态，THE 系统 SHALL 允许其查看历史内容并下载已有产物。

13.7 THE 系统 SHALL 按用户记录 Token、运行时长和工具调用量。

13.8 THE 系统 SHALL 允许管理员在服务端调整单个用户的配额。

13.9 THE 系统 SHALL 不在一期实现用户计费、套餐购买或支付。

### 需求 14：一期界面与导航

**用户故事：** 作为用户，我希望使用简洁、工作导向的界面，以快速创建 Agent 和执行任务。

#### 验收标准

14.1 THE 系统 SHALL 提供以“新建任务”为主要入口的工作台首页。

14.2 THE 系统 SHALL 提供 Agent 管理、我的文件、上下文管理和设置导航入口。

14.3 THE 系统 SHALL 在一期将 Skills、MCP、Vault 和上下文管理入口标记为尚未开放，且不得展示不可用的可操作控件。

14.4 THE 系统 SHALL 在侧边栏展示当前用户的未归档 Session 列表及其状态。

14.5 THE 系统 SHALL 在新建任务输入区提供 Agent 选择、附件上传、发送和运行状态反馈。

14.6 THE 系统 SHALL 使用安静、紧凑、适合持续工作的视觉风格，并保持桌面端和移动端内容不重叠。

14.7 THE 系统 SHALL 为仅图标按钮提供可访问名称和悬停提示。

### 需求 15：平台 Agent 管理

**用户故事：** 作为管理员，我希望集中创建和管理平台 Agent，并为用户指定默认项，以控制普通用户的开箱即用体验。

#### 验收标准

15.1 THE 系统 SHALL 仅允许管理员访问平台 Agent 管理和用户默认 Agent 分配功能。

15.2 THE 系统 SHALL 允许管理员创建多个平台 Agent。

15.3 THE 系统 SHALL 允许管理员配置平台 Agent 的名称、描述、模型、System Prompt 和一期内置工具策略。

15.4 THE 系统 SHALL 允许管理员编辑、启用和停用平台 Agent。

15.5 THE 系统 SHALL 允许管理员为每个普通用户指定一个已启用的平台 Agent 作为默认 Agent。

15.6 IF 管理员尝试把已停用或不存在的平台 Agent 分配给用户，THEN THE 系统 SHALL 拒绝该操作。

15.7 IF 管理员尝试删除仍被用户分配或被 Session 引用的平台 Agent，THEN THE 系统 SHALL 拒绝删除并返回引用冲突信息。

15.8 WHEN 管理员更新平台 Agent，THE 系统 SHALL 使后续新建 Session 使用其最新版本，并保持已有 Session 的版本不变。

15.9 THE 系统 SHALL 不允许管理员通过平台 Agent 管理功能查看普通用户的 Session 内容、输入附件或产物。

### 需求 16：部署、可靠性与可运维性

**用户故事：** 作为平台运营者，我希望系统可在火山引擎中国区稳定部署和排障。

#### 验收标准

16.1 THE 系统 SHALL 以可容器化的长驻 Node.js 服务部署，而不依赖具有短执行时限的 Serverless 运行时。

16.2 THE 系统 SHALL 使用 React、Fastify 和 PostgreSQL 构成模块化单体。

16.3 THE 系统 SHALL 将 Web、API 和后台任务保存在同一代码库中，并允许 API 与 worker 作为独立进程运行。

16.4 THE 系统 SHALL 为所有对外请求生成关联 ID，并在日志中记录用户、资源类型、操作结果和方舟请求 ID，且不得记录敏感凭据或完整附件内容。

16.5 IF 方舟 API 暂时不可用或返回限流错误，THEN THE 系统 SHALL 使用有上限的退避重试，并向用户展示可恢复状态。

16.6 THE 系统 SHALL 支持通过健康检查确认 Web 服务、数据库和方舟连接配置状态。

16.7 THE 系统 SHALL 使 Agent、Session、文件和用量接口的租户越权测试覆盖率达到 100%。

16.8 THE 系统 SHALL 在自动化测试中验证 SSE 重连后事件不丢失且不重复。

## 5. 一期完成标准

一期完成时，管理员应能够创建和维护多个平台 Agent，并为每个普通用户指定默认平台 Agent。获得分配的用户应能够通过邮箱验证码登录，直接使用默认平台 Agent 创建任务，实时观察执行过程，进行多轮对话或中断任务，上传当前任务附件，并在“我的文件”中查看和下载 Agent 产物。用户还应能够创建和编辑个人 Agent、归档或永久删除任务，并始终无法访问其他用户的任何资源。

Skills、MCP、Vault 和 Memory Store 的界面入口与后端边界应存在，但不计入一期功能验收。
