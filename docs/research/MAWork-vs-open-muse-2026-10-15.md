# MAWork 与 open-muse 深度对比

分析日期：2026-10-15。结论依据两边源码、依赖配置、测试实现及版本化文档；没有运行开发服务、浏览器、云端请求或性能基准。

## 1. 核心判断

**MAWork 更接近“由平台运营的 AI 工作交付系统”；open-muse 更接近“由个人持有凭证、跨设备使用、持续跟进的 AI 助理”。** 两者都把实际 Agent 执行交给 Managed Agents，差异主要在产品编排、信任边界、状态持久化和交付方式，不能仅凭界面或功能数量判断谁的 Agent 更聪明。

MAWork 的优势集中在服务器接受任务之后的可靠投递、离线事件修复、成果复制、跨任务材料引用、删除保护、用量配额和运营管理。open-muse 的优势集中在原生设备连接、主对话连续性、身份与偏好、目标与提醒、Feed/Ideas、跨端同步以及用户自己的 MA 资源设置。

建议以 MAWork 为主线，借鉴 open-muse 的产品闭环和连接器设计。直接替换为 open-muse 或整仓搬运，会丢掉 MAWork 已投入较多的交付与治理机制，并引入新的凭证及跨端一致性问题。

### 分析基线

| 项目      | 本次实际分析对象                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MAWork    | `/Users/bytedance/Desktop/myProgram/MAWoker`；HEAD `5f2c5400d824aada4a6aac24723a73be3100f82f` 加当前未提交工作区，包含管理员 UI 等现有变动 |
| open-muse | 公开仓库默认分支的浅克隆；HEAD `499570f9f723f2a923ea10d39cad96c709440571`；提交时间 2026-10-13 12:30:14 +08:00                             |
| 修改范围  | 仅新增本报告及研究证据，不修改应用源代码或现有未提交文件                                                                                   |
| 结论等级  | “已实现”指找到代码入口及实现；“历史验证”指仓库保存的结果；“本次验证”仅指静态检查与报告核验                                                 |

本地目录名是 MAWoker，README 产品名是 MAWork，下文使用 MAWork。open-muse 的 README、实现和较早验收文档存在版本差异，本文优先采用当前代码，不将旧文档中的“未实现”直接当成当前缺失，也不将 README 的功能描述当成当前全链路验收通过。

## 2. 功能与工程取向

| 维度           | MAWork 当前实现                                                   | open-muse 当前实现                                                       | 对你的项目意味着什么                                                 |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 主要入口       | 新任务、历史任务、我的文件；助手/技能/记忆放在设置附近            | 主聊天、侧聊天、Feed、Ideas、Goals、Library；另有原生端入口              | 一个围绕工作成果，一个围绕持续的个人关系与行动                       |
| 凭证与计费责任 | API/Worker 从服务器配置读取 Ark 凭证，用户使用应用账号            | 用户连接自己的 MA key；客户端直连 MA，账号服务加密保存及协调             | 分别适合平台统一运营和个人 BYOK；目前不是两种可互换部署方式          |
| 多用户身份     | 自有邮箱密码、Cookie 会话、user/admin、授权与配额                 | Supabase 验证账号、Bearer、账号绑定资源、跨设备同步                      | open-muse 不是没有身份隔离的单用户前端                               |
| Agent 组织     | 平台助手、个人助手、默认助手、技能及版本绑定                      | 通常每个 workspace 一套个人 agent/environment/memory；设置与变更协调     | MAWork 更适合配置多种工作角色；open-muse 更强调“我的一个助理”        |
| 新任务投递     | 本地持久化 submission，202 回执，Worker 投递；精确重放和冲突检测  | 前台普通聊天直连 MA；另有服务端主动任务持久记录                          | 不可把“上游已在执行”与“尚未发出但已持久接受”混为一谈                 |
| 不确定写入     | unknown 状态保留、读取证据核对、不盲目重发                        | 会话 marker、待定状态、版本/事件证据和 review 流程                       | 两边都认真处理歧义结果，不能把 open-muse 归为简单聊天壳              |
| 离线能力       | Worker 补齐历史、发现完成回合、同步产物和站内通知                 | MA 继续执行；服务端提醒/check-in/Feed 与设备消息协调                     | MAWork 偏交付恢复，open-muse 偏主动跟进                              |
| 个人记忆       | 多目录记忆、人工编辑、来源、整理/压缩、CAS、维护锁、删除围栏      | 身份/人格/记忆等文档，目标与 Feed 设置也进入长期文档                     | MAWork 的记忆治理更细；open-muse 的人格和产品入口更直接              |
| 定时与目标     | 未找到完整的用户日程提醒、目标树、主动 check-in 产品链路          | 有 Goals、Upcoming、check-in、时区/重复规则和服务调度                    | 这是有价值的新增产品层，不应只加一个定时器按钮                       |
| 文件资产       | 成果复制至自有 TOS/Drive 记录，材料复用、引用保护、延迟清理       | MA 云文件 Library、回复收藏、媒体查看；各端能力不同                      | 长期工作资产与 MA 文件浏览不是同一种保证                             |
| 文件预览       | 静态 HTML/Office/PDF/媒体及受限 XLSX；隔离 CSP、无脚本、大小边界  | 媒体与 MA 文件预览/分享，临时下载 URL、类型/大小校验                     | MAWork 对办公文档和文件生命周期投入更深                              |
| 设备能力       | Web 工作台；没有原生设备执行桥                                    | iOS/Android/Mac 代码及设备工具；健康、日历、联系人、Mac 操作等           | 原生能力需要插件、系统权限及跨端路由，无法仅靠 React 组件复制        |
| 可见执行环境   | 时间线、工具活动、文件及静态成果预览；未找到等价的交互云桌面入口  | 有云端浏览器画面/输入中继，也有本 Mac 电脑操作                           | 云浏览器、设备电脑操作与静态 HTML 预览是三种能力，不能混为同一项     |
| 飞书连接       | 可以通过所配置的 MA 工具/技能扩展，未找到同等完整的自助连接产品   | 有 Lark 连接、状态与云环境工具链                                         | “Agent 可能能用飞书”与“用户能完成授权、撤销、恢复”要分开验收         |
| 工具权限       | 创建的个人助手默认 `always_allow`；未找到同等原生设备逐次确认链路 | 原生设备有 allow once/chat/always、拒绝与屏蔽策略                        | 扩展设备/外部写入前，需要独立权限交互和服务端归属约束                |
| 运营管理       | 用户、账号操作、助手、用量、配额、审计、设置                      | 以个人账号、设备、连接与个人资源设置为主                                 | MAWork 的管理控制台是明确差异化；未发现同等完整的运营端              |
| 供应商抽象     | 有 ArkGateway 接口及测试 stub，生产仍是 Ark 客户端                | 集中 provider 定义，Ark 默认，Claude Managed Agents 可选                 | 接口抽象不等于第二供应商可用；open-muse 自述 Claude 未完成端到端验证 |
| 发布形态       | npm workspaces、API/Worker/Web、Docker、PostgreSQL、TOS           | Web/Capacitor/Swift/Kotlin 等原生代码；Supabase/veFaaS 与 Worker/D1 备选 | 两边复杂度分布不同，均不能视为单个前端部署即可完整运行               |
| 语言           | 当前主要中文工作台                                                | 英文、简体中文与各端本地化                                               | 借鉴文案组织和本地化结构比直接替换样式更有价值                       |

本表证据见后面的具体机制及源码索引。未找到某项产品链路不代表通过 MA 配置永远无法实现该能力。

## 3. 架构与信任边界

### MAWork：应用服务器承担任务与资产治理

`浏览器 → Fastify API → PostgreSQL 持久意图/配额 → Worker → Ark MA`

`Ark 事件/文件 → 历史与交付处理 → 本地事件投影 / TOS 成果副本 → 工作台`

代码按 contracts/config/db/domain/ark-client/auth/storage 分层。API 与 Worker 共用领域服务和 Repository，浏览器经应用 API 使用能力，不持有服务端 Ark key。实际模型循环、工具与云端执行依然发生在 MA；本地 Worker 负责产品状态和外部副作用的编排。[M1][M2][M3]

这使平台可以在任务进入 MA 之前做账号、配额、所有权和准入检查，也能在用户离线后继续修复交付状态。代价是必须维护数据库迁移、后台处理器、对象存储和本地/上游双份状态的一致性。

需要精确区分配置资源与运行隔离：当前 API/Worker 使用配置中的 `environmentId`；不能据此断言所有用户共用同一运行中沙箱或文件系统。Environment 配置的复用与 MA 创建 session 时实际提供的隔离是不同层次，后者需要真实上游契约和隔离验收。[M2][M4]

### open-muse：直连执行，账号服务负责协调

`Web/原生端 → MA 数据面（普通聊天、资源、文件、事件）`

`Web/原生端 → 账号服务 → 认证/加密凭证/资源归属/同步/设备/调度`

`调度服务 → 该账号绑定的 MA 资源 → 主动消息或受限生成任务`

因此，“客户端直连 MA”不能推出“没有后端”。当前 server 有账户、workspace、连接、加密、同步、任务、Webhook、设备及账号删除等模块；生产部署资料以 Supabase/Postgres/veFaaS 为路径，同时保留 Cloudflare Worker/D1 适配。[O1][O2][O3]

账号资源分区也不能替代上游凭证权限边界。两名用户即便在 Open Muse 中各有独立资源，若持有同一把可直接访问这些资源的 Ark key，应用内的 owner 检查不能阻止他们绕过应用直接访问上游。该限制在其服务文档中有明确说明。MAWork 不把统一服务凭证交给浏览器，应用 API 的授权因此更关键；服务凭证的泄露或过宽权限影响面仍需要运营侧控制。[O2][M2]

## 4. 关键机制逐项比较

### 4.1 消息可靠性：MAWork 的持久接受协议是资产

MAWork 在创建任务时对 agent/title/materials/temporary/content 计算请求摘要；同 owner、同 submissionId 的相同请求返回原记录，变更内容报冲突。Repository 在事务内检查用户、准备 session/配额/材料、写消息意图并入后台任务。202 的意义是服务器接受了持久任务，不是上游已经完成。[M4][M5]

Worker 通过 owner、workerId、leaseGeneration 和有效租约验证执行权。claim/finish/checkpoint 受代际约束，避免旧 Worker 在接管后写回结果。普通读可重试，非安全写的网络歧义不会被客户端自动重试。[M5][M6]

这也有真实边界：如果消息 POST 的响应丢失，且没有保存到上游 event ID，当前实现不会靠“未查到事件”证明未执行，也不会自动重发。管理员 reconcile 对已记录的上游回执核对，另有快照校验失败但尚未发消息的特定恢复路径。因此是保守防重协议，不是已经证明的端到端 exactly-once。[M4]

open-muse 同样有持久 marker、并发创建保护、未确认写入和只读核对。普通前台交互更多依赖客户端本地状态、Web Locks/IndexedDB 等机制；服务端主动任务则有数据库状态和 claim。跨设备的所有写入并非天然享有一个全局顺序，主聊天续章和 inline choice 的边界需要按当前实现逐项核验。[O4]

**建议：借鉴 open-muse 的交互恢复提示和上下文续接，保留 MAWork 的服务器持久接受协议。** 不应为了直连架构减少 API 层而丢掉配额、材料绑定和投递的事务边界。

### 4.2 后台任务：恢复交付与主动工作是两个层次

MAWork 的 Worker 包含会话历史、成果交付、用量对账、额度中断、删除、上传及对象清理等处理器。回合完成不是只看一个 `idle`；交付逻辑识别结束证据、处理纯文本宽限期、迟到文件、失败恢复，并记录去重通知。[M3][M7]

open-muse 有两条必须分开的链路：

- 服务端 Feed/Ideas 类生成：读取有限的个人文档，将内容注入提示，创建关闭工具、MCP、skills、child agents 和 memory mounts 的受限 session；不能把这个路径等同于后台自主浏览网页得到实时资讯。
- Upcoming/提醒：到点向已有主对话投递 `user.message`，随后普通 agent 可使用该对话允许的工具。此路径可以触发工作，也需要独立处理迟到、重复、时区、断连和撤销。

前台用户触发的研究 Feed 也可能使用普通 MA 工具，与受限服务端 Feed 又不同。[O5][O6]

**MAWork 已具备“任务交出后不依赖打开页面”的基础；欠缺的是“用户授权未来何时做什么”的产品和持久调度模型。** 增加它时应新增 schedule/run/authorization 等明确记录，而不是复用清理 Job 的 type 后直接拼接 prompt。

### 4.3 记忆：MAWork 偏治理，open-muse 偏可感知的身份

MAWork 的目录区分 `/memories/`、`/procedures/`、`/episodes/`、`/resources/`。编辑有内容 hash 校验；后台整理有状态 revision、policy epoch、来源 fingerprint、快照/工作结果/合并计划；保护路径限制后台整理；删除还会排除历史来源，减少被再次抽取的可能。临时任务不挂个人记忆。[M8][M9]

这比“把聊天总结后写回一个 MEMORY.md”复杂，也更适合长期资料治理。但当前初始化或异常修复仍可能影响任务准入，自动整理与 Agent 原生读写的权限语义也需要用户理解。现有 UI 已解释“保护”只限制后台整理，不能把它承诺为所有 Agent 都不能改。[M8][M10]

open-muse 将名字、人格、偏好、目标、Feed 规则等直接呈现为个人助理的一部分；文档与会话衔接更接近用户的心智。其目标和身份编辑也有 revision/冲突/不确定写保护，不能简单归为没有一致性设计的文档存储。[O7]

**可借鉴：首次使用时建立偏好、对话中“记住/不记住”、清晰的记忆来源回链。** 保留 MAWork 的来源、CAS、删除和维护边界；更重要的是让用户知道“保存了什么、为什么、怎样撤回”，而不是把所有内部状态放在同一页面。

### 4.4 文件：这是 MAWork 比较明确的产品优势

MAWork 将 MA 输出复制到自有 TOS，Drive 记录管理对象，artifact 记录管理它与任务的关联。复用文件时，先在数据库锁定并保留对象版本引用，再读取私有字节上传为新的 Ark input；源任务删除与物理字节清理分别处理。被另一任务引用的对象不能因源任务删除被立即清走。[M11][M12]

删除流程还组合结算确认、外部删除意图日志、记忆围栏、有效租约及延迟清理。它的价值不只在“可以下载一个文件”，而在“这个成果能作为后续工作的材料持续存在”。这类规则修改必须保留真实 PostgreSQL 竞争测试。[M13][M14]

open-muse 的 Web/direct Library 已经支持云文件，不只是收藏文本：分页枚举 MA agent 文件，限定在当前会话集合，过滤过期文件，每次取临时下载 URL，预览/分享限制 10 MiB；收藏回复还可通过账号同步。但未发现等价于 MAWork 的独立成果归档、跨任务固定版本引用和清理保护层。Mac Library 与 Web/direct Library 也不是完全相同的实现。[O8][O9]

MAWork 的优势仍有条件：真实云端产物可见性、对象复制和删除契约尚需隔离环境验收；历史文件覆盖后无法凭当前 inventory 重建旧版本，已在 README 中注明。不要将本地引用保护测试推广为上游所有文件版本都已可恢复。[M15]

### 4.5 权限、账号和成本治理

MAWork 自有密码采用 scrypt，会话 token 只存 hash；认证和账号撤销通过 authEpoch 防止旧凭证继续使用。管理权限有命名 permission，但当前全部映射到 admin，两级角色不是完整的组织/项目 RBAC。OIDC 配置字段也不是现成 SSO 登录。[M16][M17][M15]

用量按上游事件投影，配额包含个人助手数、并发/每日任务数、月 token；有预留、去重及超限中断。它是产品额度和运营统计，不能当成云厂商结算账单。额度提醒的 `LoggingNotifier` 只输出结构化日志；站内任务通知是另一套已经存在的机制。[M18]

当前创建的个人助手使用 `always_allow` 工具策略。若以后引入日历写入、发送消息、联系人读取或电脑操作，不能把现有云工具默认策略直接搬到设备权限上。[M19]

open-muse 在设备执行上采用每次/会话/长期允许、拒绝、屏蔽等规则，并区分服务器任务与设备端执行。账号服务用 AES-GCM 绑定 purpose/owner/revision 加密凭证及部分同步数据，支持 key rotation；服务运行时仍可解密调用上游，因此不是端到端加密。[O10][O11]

这些权限也并非全部随账户同步：iPhone Health 连接按 workspace identity 和本设备保存，Mac 长期电脑操作策略保存在本 Mac 的 UserDefaults。服务 `devices` 模块只登记在线状态，不提供命令、push 或远程访问通道，不能把多设备共用会话宣传成可以唤醒离线 Mac 执行操作。Mac blockedFolders 的代码约束也不能扩张为操作系统级文件沙箱。[O11][O15][O16][O20]

两边的云工具默认策略都不能与设备确认混同：open-muse workspace 的内置云 toolset 同样使用 `always_allow`。它另有云浏览器中继，把沙箱 Chrome 的画面和输入经服务转发；这个通道与 Mac 原生 computer use 分开。[O17][O18]

**判断：MAWork 在平台运营与额度治理上更深入；open-muse 在个人设备权限与账号连接上更深入。** 两者的安全边界不同，不能概括成某一个“整体更安全”。

## 5. 当前不足及实际优先级

### MAWork 优先补什么

| 优先级 | 建议                          | 具体原因及验收方向                                                                                                                                      |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 完成隔离 Ark/TOS 真实闭环验收 | 持久回执重放、无人在线交付、纯文本/迟到成果、跨任务复用、源删除与保留引用；目前文档明确仍有待验收部分                                                   |
| P1     | 用户侧分页/搜索与大历史读取   | 用户 session/artifact API 仍以整批列表返回，搜索主要在已加载数组上过滤；管理端已有分页不能替代用户端分页；用大数据集验证稳定排序、游标无缺口            |
| P1     | 入口加载与故障隔离            | 用户工作区 bootstrap 的 Promise.all 把 agents、两份任务列表、capabilities、usage 绑在一起；一个失败会影响整个初始加载。管理端已有更细的隔离，可逐步推广 |
| P1     | 代理、限流及资源预算          | 已有按 IP/路由的内存限流和 SSE 计数；仍需按部署明确代理信任及多副本协调，补用户总存储/带宽/整体并发预算，不能写成“完全没有限流”                         |
| P1     | 一个可交付的主动提醒流程      | 用户创建/修改/暂停/撤销，时区与重复，run 幂等，未知投递核对，费用与权限预授权，站内通知；先闭环一个场景，再扩到目标跟进                                 |
| P2     | 成果到后续行动、目标跟进      | 将已交付结果一键形成下一任务、检查点或提醒；复用现有材料引用，不必照搬完整消费级 Feed                                                                   |
| P2     | 自助连接器授权                | 将 MA 工具能力包装成可连接、查看状态、撤销、恢复的用户流程；先做最有价值的一种连接器                                                                    |
| 持续   | 拆分超大组合模块              | API app.ts 约 4520 行、repositories.ts 约 6647 行；按会话、文件、配额等事务边界拆分，保持现有测试，不先重写成新框架                                     |

代码依据：[M20][M21][M22]；真实验收及 C 阶段待办依据：[M15][M23]。以上是本次源码分析的建议顺序，不是已经测得的生产瓶颈或本次实施承诺。

### open-muse 同样需要谨慎看待的地方

1. **跨端面广，能力并不整齐。** Web、iOS、Android、Mac 的入口、文件库、设备能力和验收范围不同，不能拿一个端的演示推定所有端一致。
2. **文档更新不一致。** how-it-works 的早期直连描述、较早 verification 的 Mac/通知/SSO 边界与当前实现可能冲突；当前 README 的功能叙述也不是每项功能的最新测试证据。[O12]
3. **两种后端和多套终端提高维护成本。** server 的 SQL 兼容适配与平台桥接、构建发布均需长期维护；源码更大不表示其复杂问题已全部解决。
4. **主动功能的运行模式有限制。** 受限后台 Feed 无工具，提醒依赖主对话的资源与授权；设备离线不能被云端绕过。需要分别确认任务送达、设备执行和通知送达。
5. **BYOK 降低平台统一代付需求，但增加接入摩擦。** 用户要有可用 MA 凭证与权限；账号服务还需安全托管这些凭证，不是完全零后端或无敏感数据。
6. **账号删除不等于删除 Ark 资源。** 其账号删除流程删除服务内账号数据和 Auth 身份，上游 agent/memory/session 仍保留在用户 Ark 账户。对“删账号是否也忘记和清除云数据”需要按产品承诺分别处理。[O19]

没有在本次运行其应用或测试，因此不声称上述边界构成已复现漏洞，也不以历史问题推断当前版本必然失败。

## 6. 哪些值得借鉴，哪些不宜直接移植

| open-muse 设计/模块                    | 借鉴价值       | 适合 MAWork 的做法                                                                        |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Upcoming/check-in 的 schedule/run 模型 | 高             | 研究时区、quiet hours、暂停、取消、投递结果不确定时的状态；用自己的用户/配额/Job 契约落地 |
| Goal → 提问 → 计划 → 检查进展          | 高             | 先支持任务关联与下一步检查；目标状态需要确定性 schema，不只存在自由文本里                 |
| 身份/人格与偏好建立                    | 高             | 把首次偏好写入现有记忆规则，保留来源和撤回能力                                            |
| 来源明确的内容卡片、继续讨论           | 中高           | 更适合做“成果摘要、待办、继续研究”入口；Feed 的实时来源能力需要区分运行模式               |
| Lark 及设备连接的状态/撤销体验         | 高             | 借鉴授权生命周期；实际 token/工具路由由 MAWork 服务端与 MA 绑定，避免前端拿平台密钥       |
| provider 差异集中                      | 中             | 当前先把 Ark wire shape 与领域模型隔开；有真实第二供应商需求再实现，不为形式统一丢失能力  |
| 直连 MA 的 transport 和凭证存储        | 低，架构不匹配 | 若没有明确 BYOK 产品需求，不改变现有服务端代理和配额边界                                  |
| Swift/Kotlin 设备执行桥                | 按战略决定     | Web 优先时先定义能力接口与授权模型；需要桌面端再单独投入原生发布、权限和离线队列          |
| server 的数据库兼容层                  | 低             | MAWork 已有 PostgreSQL/Drizzle，不必为复制功能引入 Worker/D1 兼容 SQL                     |

两边仓库都附 MIT LICENSE。复用源码时保留对应版权/许可，并逐项核对原生依赖和第三方资产声明；本报告没有做依赖许可证的完整审核，也没有复制外部源码进 MAWork。[M24][O13]

**产品方向建议：围绕“成果可持续复用的 AI 工作台”形成差异化，再加主动跟进。** 如果目标改为个人全设备助理，open-muse 的原生连接和关系型体验会成为更重要的参考，但这是产品方向扩展，不是一个低成本换 UI 的改动。

## 7. 测试、规模与证据边界

### 可重复的静态统计

统计 Git 已跟踪及未忽略的未跟踪文件；实现统计限定于各自业务源码目录，扩展名为 ts/tsx/swift/kt/java/mjs，排除 dist/build 与 `.test.`/`.spec.`；不计 CSS、文档、生成资源和主要构建脚本。测试按 `.test.`/`.spec.` 文件名统计。它只反映源码规模，不是覆盖率或质量分数。

| 指标                                | MAWork | open-muse |
| ----------------------------------- | -----: | --------: |
| 实现源码文件                        |    136 |       360 |
| 实现源码行                          |  46832 |     75502 |
| test/spec 文件                      |    133 |       186 |
| test/spec 行                        |  50876 |     38449 |
| 上述实现中的 Swift/Kotlin/Java 文件 |      0 |        33 |

MAWork 的测试在租约接管、quota 事务、材料/对象引用、删除竞争上有专门的真实 PostgreSQL 用例；这些用例在没有 `TEST_POSTGRES_URL` 时会跳过。普通 npm test 成功不自动证明真实 PostgreSQL 竞争验证通过。[M14]

open-muse 的根、server、macos 分别有测试配置。server 的 `TEST_DB=pg` 在已检查的测试支撑代码里使用 PGlite，不能直接写成外部真实 PostgreSQL 的多连接竞争验收。根目录 `npm run check` 也不能代表 server/macOS/原生测试全部执行过。[O14]

### 既有测试记录的正确读法

- MAWork A/B 收口保存过 130 文件、1557 测试通过及隔离 PostgreSQL 验证，属于历史提交 `884b8b5...` 的证据。本地当前 HEAD 和未提交源代码已经变化，不能把这份结果当成本次当前树全部通过。[M25]
- 最新管理员 UI 记录保存过 31 文件、375 用例以及 typecheck/build/Web lint 等结果，有对应源码 hash；它只覆盖记录中的范围，且明确仓库级 lint 当时仍有临时诊断脚本错误。[M26]
- open-muse verification 保存过真实 MA Web/iOS 和较早 Mac 记录，也明确列出缺口；文档开头统计和结尾部分边界已经落后于当前代码，不能将其 452 tests 或所有“未实现”照抄成当前事实。[O12]

本次没有运行这两边的测试、构建、真实 PostgreSQL、真实 MA/TOS、原生端或负载实验，因为任务是研究对比并只新增文档。没有测量延迟、成功率、月成本、安全漏洞或同任务效果，也没有截图或浏览器视觉检查。关于架构取舍和优先级的意见是源码推论，不是性能实验结果。

本次执行了仓库基线获取、文件/模块搜索、关键源码与测试/部署配置检查、静态规模统计、报告格式及 diff 检查。详细基线和 SHA-256 见相邻 `MAWork-vs-open-muse-2026-10-15.sources.json`，后续恢复应先检查 hash，避免复用到不同源码。

## 8. 源码索引

供应商差异与各端产品契约补充见 [O21]；后台和前台 Feed 的不同入口见 [O22][O23]；目标/人格与 Mac Library 见 [O24][O25][O26]。

以下本地链接指向本次工作区内容；open-muse 链接固定到本次提交。行号是定位起点，相关机制通常跨多个函数。

### MAWork

- [M1]：工作区与构建入口，`package.json`。
- [M2]：API 的凭证、领域与存储装配，`apps/api/src/index.ts`。
- [M3]：Worker 装配与后台处理器，`apps/worker/src/index.ts`。
- [M4]：会话准入、投递与不确定结果恢复，`packages/domain/src/sessions.ts`。
- [M5]：持久提交事务与租约状态，`packages/db/src/repositories.ts`。
- [M6]：安全读重试和写入歧义，`packages/ark-client/src/http.ts`。
- [M7]：回合发现与迟到成果交付，`packages/domain/src/session-delivery.ts`。
- [M8]：记忆状态机与编辑/删除，`packages/domain/src/memory.ts`。
- [M9]：记忆合并和容量规则，`packages/domain/src/memory-policy.ts`。
- [M10]：记忆入口与权限语义，`apps/web/src/MemoryPage.tsx`。
- [M11]：成果复制、关联与下载，`packages/domain/src/artifacts.ts`。
- [M12]：对象引用保留事务，`packages/db/src/file-reuse-repository.ts`。
- [M13]：删除、结算、记忆与租约围栏，`apps/worker/src/session-deletion.ts`。
- [M14]：真实 PostgreSQL 竞争测试及跳过条件，`tests/job-lease-postgres-contention.integration.test.ts`。
- [M15]：可靠性/文件阶段与云端验收边界，`README.md`。
- [M16]：会话 token、authEpoch 与原子签发，`packages/auth/src/index.ts`。
- [M17]：命名权限与当前两级角色，`packages/domain/src/permissions.ts`。
- [M18]：额度日志通知与额度状态，`packages/domain/src/notifications.ts`。
- [M19]：默认云工具权限策略，`packages/domain/src/platform-agents.ts`。
- [M20]：用户任务列表 API，`apps/api/src/app.ts`。
- [M21]：用户工作区加载与路由，`apps/web/src/App.tsx`。
- [M22]：内存限流与 SSE 管理，`apps/api/src/app.ts`。
- [M23]：后续验收与 C 阶段安排，`docs/implementation/MAWork-实际验收与阶段C推进-2026-10-14.md`。
- [M24]：本地许可，`LICENSE`。
- [M25]：A/B 历史验证范围，`docs/implementation/MAWork-阶段AB收口记录-2026-10-13.md`。
- [M26]：管理员 UI 历史证据及 hash 范围，`docs/implementation/MAWork-管理员UI优化交付记录-2026-10-15.md`。
- [M27]：配额真实 PostgreSQL 测试，`tests/session-quota-postgres-contention.integration.test.ts`。
- [M28]：复用、删除及清理竞争测试，`tests/file-reuse-postgres.integration.test.ts`。
- [M29]：静态预览隔离，`apps/web/src/components/ArtifactViewer.tsx`。
- [M30]：用量事件投影，`packages/domain/src/usage.ts`。
- [M31]：已加载任务的本地搜索，`apps/web/src/components/SessionSearch.tsx`。
- [M32]：容器构建与运行，`Dockerfile`。

### open-muse

- [O1]：普通请求直接访问 MA，`src/direct/transport.ts`。
- [O2]：账号服务、凭证、隔离及部署说明，`server/README.md`。
- [O3]：Supabase/Postgres 服务入口，`server/deploy/volcengine/function/entry.ts`。
- [O4]：主对话发送与续章恢复，`src/direct/conversations.ts`。
- [O5]：受限后台会话与能力校验，`server/src/ark.ts`。
- [O6]：提醒投递、状态与租约，`server/src/upcoming.ts`。
- [O7]：结构化记忆文档与编辑保护，`src/direct/identity.ts`。
- [O8]：MA 云文件与临时下载，`src/direct/library.ts`。
- [O9]：账号同步的命名空间和数据限制，`shared/account-sync.ts`。
- [O10]：凭证加密与绑定，`server/src/connection.ts`。
- [O11]：Mac 设备能力与 OS 权限，`macos/Computer.swift`。
- [O12]：历史验证及其边界，`docs/verification.md`。
- [O13]：上游许可，`LICENSE`。
- [O14]：D1 与 PGlite 测试路径，`server/tests/database.ts`。
- [O15]：iPhone 本设备身份权限，`src/api.ts`。
- [O16]：设备服务只记录在线状态，`server/src/devices.ts`。
- [O17]：云工具默认策略与 workspace，`shared/workspace-spec.ts`。
- [O18]：云浏览器中继，`server/src/browser.ts`。
- [O19]：删除账号的资源边界，`server/src/account-deletion.ts`。
- [O20]：本 Mac UserDefaults 电脑操作策略，`macos/OpenMuse.swift`。
- [O21]：供应商资源契约和能力差异，`shared/ma-provider.ts`。
- [O22]：后台生成任务状态与来源校验，`server/src/jobs.ts`。
- [O23]：前台 Feed 的普通 MA 路径，`src/direct/inspiration.ts`。
- [O24]：目标结构化 schema，`shared/goals.ts`。
- [O25]：人格与记忆的产品约定，`shared/identity.ts`。
- [O26]：Mac Library 的展示范围，`macos/ui/library.ts`。

[M1]: /Users/bytedance/Desktop/myProgram/MAWoker/package.json:1
[M2]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/api/src/index.ts:30
[M3]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/worker/src/index.ts:36
[M4]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/sessions.ts:489
[M5]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/db/src/repositories.ts:2823
[M6]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/ark-client/src/http.ts:1371
[M7]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/session-delivery.ts:115
[M8]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/memory.ts:280
[M9]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/memory-policy.ts:133
[M10]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/web/src/MemoryPage.tsx:255
[M11]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/artifacts.ts:118
[M12]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/db/src/file-reuse-repository.ts:7
[M13]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/worker/src/session-deletion.ts:261
[M14]: /Users/bytedance/Desktop/myProgram/MAWoker/tests/job-lease-postgres-contention.integration.test.ts:9
[M15]: /Users/bytedance/Desktop/myProgram/MAWoker/README.md:24
[M16]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/auth/src/index.ts:1
[M17]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/permissions.ts:1
[M18]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/notifications.ts:1
[M19]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/platform-agents.ts:15
[M20]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/api/src/app.ts:3128
[M21]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/web/src/App.tsx:363
[M22]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/api/src/app.ts:2246
[M23]: /Users/bytedance/Desktop/myProgram/MAWoker/docs/implementation/MAWork-实际验收与阶段C推进-2026-10-14.md:1
[M24]: /Users/bytedance/Desktop/myProgram/MAWoker/LICENSE:1
[M25]: /Users/bytedance/Desktop/myProgram/MAWoker/docs/implementation/MAWork-阶段AB收口记录-2026-10-13.md:1
[M26]: /Users/bytedance/Desktop/myProgram/MAWoker/docs/implementation/MAWork-管理员UI优化交付记录-2026-10-15.md:1
[M27]: /Users/bytedance/Desktop/myProgram/MAWoker/tests/session-quota-postgres-contention.integration.test.ts:1
[M28]: /Users/bytedance/Desktop/myProgram/MAWoker/tests/file-reuse-postgres.integration.test.ts:12
[M29]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/web/src/components/ArtifactViewer.tsx:160
[M30]: /Users/bytedance/Desktop/myProgram/MAWoker/packages/domain/src/usage.ts:69
[M31]: /Users/bytedance/Desktop/myProgram/MAWoker/apps/web/src/components/SessionSearch.tsx:36
[M32]: /Users/bytedance/Desktop/myProgram/MAWoker/Dockerfile:1
[O1]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/direct/transport.ts#L4
[O2]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/README.md#L1
[O3]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/deploy/volcengine/function/entry.ts#L19
[O4]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/direct/conversations.ts#L94
[O5]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/ark.ts#L168
[O6]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/upcoming.ts#L270
[O7]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/direct/identity.ts#L234
[O8]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/direct/library.ts#L24
[O9]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/shared/account-sync.ts#L6
[O10]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/connection.ts#L75
[O11]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/macos/Computer.swift#L63
[O12]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/docs/verification.md#L1
[O13]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/LICENSE#L1
[O14]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/tests/database.ts#L1
[O15]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/api.ts#L2747
[O16]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/devices.ts#L4
[O17]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/shared/workspace-spec.ts#L18
[O18]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/browser.ts#L1
[O19]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/account-deletion.ts#L33
[O20]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/macos/OpenMuse.swift#L689
[O21]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/shared/ma-provider.ts#L13
[O22]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/server/src/jobs.ts#L48
[O23]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/src/direct/inspiration.ts#L150
[O24]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/shared/goals.ts#L1
[O25]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/shared/identity.ts#L48
[O26]: https://github.com/chyroc/open-muse/blob/499570f9f723f2a923ea10d39cad96c709440571/macos/ui/library.ts#L25
