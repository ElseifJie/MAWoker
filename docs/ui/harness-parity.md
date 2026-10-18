# Harness UI 外壳 13 态对照清单（B0-2）

> **冻结日期：2026-10-18。** 参考上游：Harness `687f282e`、Open Muse `499570f9`。对应实施方案 B0-2、6.8，以及下一阶段计划 P1-a / P1-c / P1-d。
>
> 适用范围：`apps/web/src/shell/` 新外壳（`AppFrame`、`WorkspaceFrame`、`WorkspaceNav`、`PanelHost`、`useShellLayout`）。P1-a 已把 `App.tsx` 切到 `WorkspaceFrame`（旧 `AppShell` 仍用于 `/admin`）；`App.test.tsx` 的 shell 组已开始按新壳改写，但抽屉本身仍待 P1-d。
>
> **验证边界：只做非视觉组件/交互测试。hover、focus ring、间距、层级等视觉效果由用户在各 P1 批次完成后验收；不做截图或浏览器视觉检查。**
>
> **2026-10-18 P1-d 更新：** 窄屏抽屉、焦点陷阱 / Esc / 滚动锁、右栏全屏 overlay 与关闭、左右栏拖拽调宽、PanelHost 标签拖拽、按 `conversationId` 过滤面板均已落地；下方“已知缺口”表已按当前代码改写。
>
> 本清单冻结后不随上游漂移。确需变更时，在同一个 P1 批次更新本文件，并把变化写入该批 checkpoint。

## ID 约定

- 格式为 `<area>.<state>[.<sub>]`：`shell.*` 管外壳/导航/全局，`panel.*` 管 `PanelHost`，`layout.*` 管尺寸求解，`session.*` 管切会话。
- 每个 ID 至少绑定一个测试，或明确标注“用户视觉验收”；不允许无归属的 ID。
- 现有测试早于本约定，不强制改名；新写或被触碰的测试在标题前加 `[ID]`，例如 `it("[shell.default] ...")`。

### 1. 默认（`shell.default`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 右栏打开时，1440 宽：左 280、右 648（45%）、中 512；1024 宽：左 280、右 344、中 400。右栏关闭时不渲染右 `aside`，中栏占满。`AppFrame` 用 CSS Grid 与 `--ui-shell-left/right-width` 求解，`WorkspaceFrame` 仅在 `rightMode !== "closed"` 时组合 `PanelHost`。 |
| 涉及文件 | `apps/web/src/shell/AppFrame.tsx`、`WorkspaceFrame.tsx`、`layout.ts`、`shell.css`、`useShellLayout.ts`、`apps/web/src/ui/AppShell.tsx`（当前生产入口） |
| 现有测试 | 新壳：`apps/web/src/shell/layout.test.ts`、`AppFrame.test.tsx`、`WorkspaceFrame.test.tsx`、`useShellLayout.test.tsx`。接线级：`apps/web/src/App.test.tsx` 的 `workspace shell` 组；旧 `AppShell` 的 `/admin` 用法仍由 `apps/web/src/ui/ui.test.tsx` 覆盖。 |
| 计划测试 ID | `shell.default`、`shell.default.closed` |
| P1 新增测试 | P1-a：需要路由级测试，确认 `WorkspaceFrame` 替换 `AppShell` 后默认三栏；P1-c：确认右栏关闭时 `PanelHost` 不挂载。几何单测已足够，不重复。 |
| 用户视觉检查 | 1440 与 1024 下三栏比例正确，页面只有中栏一个纵向滚动容器。 |

### 2. hover / focus（`shell.focus`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 可 hover 的 tab、关闭按钮、导航项、调宽手柄有可见反馈；键盘聚焦有清晰 `focus-visible` 环且不被容器裁剪；Tab 顺序为左栏 → 中栏 → 右栏；tab 采用 roving tabindex（选中项 0，其余 -1）；切 tab 或关闭面板后焦点不丢失；composer 焦点仍显示在卡片上。 |
| 涉及文件 | `apps/web/src/shell/shell.css`、`PanelHost.tsx`、`AppFrame.tsx`、`apps/web/src/ui/Dialog.tsx`、`apps/web/src/ui/AppShell.tsx` |
| 现有测试 | 部分。`apps/web/src/shell/PanelHost.test.tsx` 只验证键盘选择回调，不验证焦点；`apps/web/src/App.test.tsx` 验证 composer 的 focus 样式；`apps/web/src/ui/ui.test.tsx` 验证 Dialog/AppShell 的焦点陷阱。P1-d 已覆盖抽屉焦点陷阱与关闭归还；tab hover / 关闭面板后的焦点归还仍未覆盖。 |
| 计划测试 ID | `shell.focus`、`shell.focus.visible`、`shell.focus.return` |
| P1 新增测试 | P1-c：需要，tab 选中后的焦点与 tabIndex；P1-d：需要，focus-visible 与关闭后焦点归还。hover 颜色无法在 jsdom 断言，交由用户视觉验收。 |
| 用户视觉检查 | 浅色/深色两套主题下 hover 与 focus ring 均可辨，tab 焦点不被裁切。 |

### 3. 展开 / 折叠（`shell.expand`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 左栏展开（默认 280，或用户宽度）↔ 折叠 56；<1024 自动折叠，回到桌面宽度后恢复用户选择。右栏 `rightOpen` 打开/关闭，关闭后无占位列，重新打开保留 `panels/activePanelId`；右栏关闭时 `PanelHost` 不渲染。旧壳 artifacts 列表折叠仅作迁移参考。 |
| 涉及文件 | `apps/web/src/shell/useShellLayout.ts`、`layout.ts`、`AppFrame.tsx`、`WorkspaceFrame.tsx`、`WorkspaceNav.tsx`、`PanelHost.tsx`、`shell-state.ts`、`apps/web/src/components/WorkspaceRail.tsx`（旧壳） |
| 现有测试 | 新壳：`useShellLayout.test.tsx`（自动折叠、右栏关闭/重开）、`layout.test.ts`（关闭右栏）、`AppFrame.test.tsx`、`WorkspaceFrame.test.tsx`、`WorkspaceNav.test.tsx`（折叠图标标签）。接线级：`apps/web/src/App.test.tsx` 的 `workspace shell` 组验证默认展开/折叠栏。旧壳 artifacts 列表折叠由 `WorkspaceRail.b5.test.tsx` 覆盖。 |
| 计划测试 ID | `shell.expand`、`shell.expand.left`、`shell.expand.right`、`shell.expand.panels` |
| P1 新增测试 | P1-a：需要，左右栏真实切换与状态保持；P1-c：需要，面板关闭/空态；P1-d：窄屏下的抽屉开合。 |
| 用户视觉检查 | 左栏 56px 时图标不换行；右栏关闭后没有残留空白列。 |

### 4. 加载（`shell.loading`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 首屏无数据时有可见加载态，不出现空白页面；切会话立即清空旧内容并显示 `正在加载任务...`，容器带 `aria-busy`；面板/文件预览有加载态；按钮 loading 时保留可访问名称与固定图标槽；迟到响应在卸载后不得写状态。 |
| 涉及文件 | `apps/web/src/App.tsx`、`apps/web/src/SessionPage.tsx`、`apps/web/src/components/ArtifactViewer.tsx`、`apps/web/src/shell/WorkspaceFrame.tsx`、`PanelHost.tsx`、`apps/web/src/components/WorkspaceRail.tsx` |
| 现有测试 | 部分。`apps/web/src/App.test.tsx` 覆盖 pending 操作 loading 与切会话 loading；`apps/web/src/ui/ui.test.tsx` 覆盖通用 loading indicator。新壳/面板无 loading 测试，`ArtifactViewer.test.tsx` 未断言加载态。 |
| 计划测试 ID | `shell.loading`、`panel.loading` |
| P1 新增测试 | P1-a：需要，首屏与页面迁移后的加载；P1-c：需要，面板首帧与卸载/迟到响应。StrictMode 重挂载不重复请求在 P1-c 覆盖。 |
| 用户视觉检查 | 加载态不引起布局跳动，切会话时不闪现上一会话内容。 |

### 5. 空态（`shell.empty`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 无任务、无搜索结果、无通知、无面板、无文件时均有明确空态与下一步入口；空结果不能渲染为空 `listbox`；`PanelHost` 空文案可由 `WorkspaceFrame` 定制；无默认助手时给出配置入口。 |
| 涉及文件 | `apps/web/src/shell/PanelHost.tsx`、`WorkspaceFrame.tsx`、`apps/web/src/components/SessionList.tsx`、`SessionSearch.tsx`、`TaskNotifications.tsx`、`CommandPalette.tsx`、`WorkspaceRail.tsx`、`apps/web/src/App.tsx` |
| 现有测试 | 部分。`apps/web/src/shell/PanelHost.test.tsx` 与 `WorkspaceFrame.test.tsx` 覆盖无面板空态；`apps/web/src/App.test.tsx` 覆盖命令面板“没有匹配的操作”和“无默认助手”。`SessionList`、`SessionSearch`、`TaskNotifications`、`WorkspaceRail` 的空态均无专门断言。 |
| 计划测试 ID | `shell.empty`、`panel.empty` |
| P1 新增测试 | P1-a：需要，导航/搜索/会话列表空态；P1-c：需要，面板与 artifacts 空态。 |
| 用户视觉检查 | 空态文案在窄栏不溢出，空态中的操作按钮可点击。 |

### 6. 错误（`shell.error`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 会话加载失败显示 `无法加载此任务。` 与重试；发送/删除失败使用 danger alert；失败回合显示“执行失败”，不伪装为成功；SSE 错误可重连且不丢已有消息；文件列表/预览失败有可恢复错误；面板内资源错误由 `renderPanel` 负责展示，宿主不得丢失其他区域。 |
| 涉及文件 | `apps/web/src/SessionPage.tsx`、`apps/web/src/App.tsx`、`apps/web/src/components/ArtifactViewer.tsx`、`WorkspaceRail.tsx`、`apps/web/src/shell/PanelHost.tsx`、`apps/web/src/timeline/useSessionTimeline.ts` |
| 现有测试 | 部分。`apps/web/src/App.test.tsx` 覆盖文件错误重试、消息发送失败、删除失败；`apps/web/src/SessionPage.b1.test.tsx` 覆盖失败证据与恢复；`apps/web/src/timeline/useSessionTimeline.test.tsx` 覆盖 SSE 错误/重连；`ArtifactViewer.test.tsx` 只覆盖不支持格式。`PanelHost` 无错误测试。 |
| 计划测试 ID | `shell.error`、`panel.error` |
| P1 新增测试 | P1-a：需要，页面级加载失败与重试；P1-c：需要，会话/面板错误不拖垮外壳。 |
| 用户视觉检查 | 错误层级清楚，不叠两个 alert；点击重试后页面能恢复。 |

### 7. 菜单（`shell.menu`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 菜单触发器带 `aria-haspopup`/`aria-expanded`；打开后焦点进入首个菜单项；Esc 关闭并把焦点还给触发器；外部 pointerdown、滚动、窗口缩放关闭菜单；菜单不被视口裁剪；会话菜单含重命名/导出/置顶/归档/删除；账号菜单含退出登录；命令面板可用键盘选择。 |
| 涉及文件 | `apps/web/src/ui/AppShell.tsx`、`apps/web/src/components/SessionList.tsx`、`TaskNotifications.tsx`、`CommandPalette.tsx`、`apps/web/src/shell/PanelHost.tsx`、`apps/web/src/shell/WorkspaceNav.tsx`（P1-a 已接入 `App.tsx`） |
| 现有测试 | 部分。`apps/web/src/shell/WorkspaceNav.test.tsx` 覆盖导航、折叠图标标签、当前项与账号菜单退出；`apps/web/src/components/SessionList.test.tsx` 覆盖行操作菜单、重命名、导出、置顶/取消置顶；`apps/web/src/App.test.tsx` 覆盖命令面板。`TaskNotifications` 无测试；菜单 Esc/焦点归还无专门测试。 |
| 计划测试 ID | `shell.menu`、`panel.menu` |
| P1 新增测试 | P1-a：需要，补充菜单开合与键盘路径（`WorkspaceNav.test.tsx` 已有基础覆盖）；P1-d：需要，Esc/焦点归还与通知入口。 |
| 用户视觉检查 | 靠右或靠下的菜单自动翻转，不遮挡触发器，滚动时能关闭。 |

### 8. 拖动（`panel.drag`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 面板标签可拖拽重排，`dragstart` 只传 `panel.id`，drop 后顺序持久；拖拽取消不改变顺序；左右栏可拖拽调宽并实时遵守 bounds；pointer capture 正确释放；拖动/调宽不得误触选中；窄屏不提供分栏拖拽。 |
| 涉及文件 | `apps/web/src/shell/PanelHost.tsx`、`shell.css`、`useShellLayout.ts`、`layout.ts`、`apps/web/src/components/WorkspaceRail.tsx`（旧壳拖动） |
| 现有测试 | 部分。`apps/web/src/components/WorkspaceRail.b5.test.tsx` 覆盖旧 rail 的 pointer 拖动与 bounds；`apps/web/src/App.test.tsx` 的“drag and keyboard”实际只断言键盘；`apps/web/src/shell/PanelHost.test.tsx` 的 `[panel.drag]` 覆盖拖拽重排。P1-d 已新增左右栏 resizer（pointer + 键盘 + aria），由 `AppFrame.test.tsx` 的 `[layout.bounds]` 覆盖。 |
| 计划测试 ID | `panel.drag`、`panel.drag.reorder`、`panel.drag.resize` |
| P1 新增测试 | P1-c：需要，tab 拖拽重排；P1-a/P1-d：需要，左右栏调宽。jsdom 需 mock `getBoundingClientRect` 与 pointer capture。 |
| 用户视觉检查 | 拖动跟手，落点有高亮，松手后宽度/顺序不跳变。 |

### 9. 宽度边界（`layout.bounds`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 左栏 264–420、默认 280、折叠 56，<1024 自动折叠；右栏最小 300、初始 45%、最大 70%、中栏至少 400；<768 右栏为 overlay；右栏关闭时中栏满宽；读取持久化宽度时再次 clamp；拒绝负宽/NaN。 |
| 涉及文件 | `apps/web/src/shell/layout.ts`、`shell-state.ts`、`useShellLayout.ts`、`shell.css`、`AppFrame.tsx`、`apps/web/src/components/WorkspaceRail.tsx`（旧壳） |
| 现有测试 | 新壳：`layout.test.ts` 覆盖全部边界；`shell-state.test.ts` 覆盖宽度 clamp；`useShellLayout.test.tsx` 覆盖 resize clamp 与持久化。旧壳：`WorkspaceRail.b5.test.tsx` 覆盖容器/视口约束，`App.test.tsx` 覆盖键盘调宽。 |
| 计划测试 ID | `layout.bounds`、`layout.bounds.left`、`layout.bounds.right`、`layout.bounds.narrow` |
| P1 新增测试 | P1-d：需要，真实调宽手柄到边界；P1-a：需要，页面迁移后不产生横向溢出。求解器单测可复用。 |
| 用户视觉检查 | 从 1440 拖到 767，中栏不被挤破，页面无横向滚动条。 |

### 10. 切会话（`session.switch`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | route/sessionId 变化时立即清空旧 session/timeline/artifacts，关闭旧 EventSource；新会话显示 loading；旧请求返回后不得写入新会话；composer 草稿按会话隔离；面板集合按 `conversationId` 保留/恢复，非法面板丢弃；切会话不重复请求。 |
| 涉及文件 | `apps/web/src/SessionPage.tsx`、`apps/web/src/App.tsx`、`apps/web/src/timeline/useSessionTimeline.ts`、`apps/web/src/shell/shell-state.ts`、`apps/web/src/components/WorkspaceRail.tsx` |
| 现有测试 | 部分。`apps/web/src/App.test.tsx` 覆盖“route 变化立即清空旧 Session、关闭旧 SSE、显示 loading”；`useSessionTimeline.test.tsx` 覆盖卸载关闭与重连。P1-c 已按 `conversationId` 过滤可见面板，并在 shell 单测覆盖 open/close/reorder；切会话的端到端导航恢复仍未覆盖。 |
| 计划测试 ID | `session.switch`、`session.switch.panels` |
| P1 新增测试 | P1-c：需要，按 `conversationId` 保留/过滤面板；StrictMode 与迟到响应同批覆盖。 |
| 用户视觉检查 | 快速 A→B→A 切换，不闪回旧消息或旧 artifact。 |

### 11. 窄屏（`shell.narrow`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | <1024 左栏折叠为 56；<768 右栏为全屏 overlay；左栏抽屉可打开/关闭，具备焦点陷阱、Esc、路由切换后焦点与滚动锁；overlay 有 backdrop/关闭且不挤压中栏；无横向溢出；键盘可完成主流程。 |
| 涉及文件 | `apps/web/src/shell/layout.ts`、`AppFrame.tsx`、`shell.css`、`apps/web/src/shell/useNarrowDrawer.ts`（P1-d 新增）、`apps/web/src/ui/AppShell.tsx`（旧壳） |
| 现有测试 | 新壳：`layout.test.ts`/`AppFrame.test.tsx`/`WorkspaceFrame.test.tsx`/`useShellLayout.test.tsx` 覆盖自动折叠与 overlay 类名；`App.test.tsx` 的 `[shell.narrow]` 覆盖 600px 下抽屉开合、Esc、滚动锁、焦点归还与路由切换焦点；`[panel.overlay]` 覆盖全屏右栏关闭。`AppFrame.test.tsx` 覆盖焦点陷阱、backdrop、inert/scroll lock。旧壳：`apps/web/src/ui/ui.test.tsx` 覆盖 `AppShell` 抽屉（现用于 `/admin`）。 |
| 计划测试 ID | `shell.narrow`、`shell.narrow.drawer`、`shell.narrow.overlay` |
| P1 新增测试 | P1-d：需要，抽屉焦点陷阱、Esc、滚动锁、overlay 关闭与断点 767/768、1023/1024。 |
| 用户视觉检查 | 四个断点逐一检查：无横向滚动，overlay 覆盖中栏而非压缩三栏。 |

### 12. 键盘（`shell.keyboard`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | Tab 顺序稳定；`PanelHost` 支持左右/Home/End 切换，选中 tab `tabIndex=0`；Enter/Space 激活；Esc 关闭 overlay/菜单/命令面板；全局 Cmd/Ctrl+K 打开命令面板；抽屉焦点陷阱；关闭后焦点返回触发器；隐藏/卸载控件不可 Tab 到。 |
| 涉及文件 | `apps/web/src/shell/PanelHost.tsx`、`AppFrame.tsx`、`apps/web/src/ui/AppShell.tsx`、`Dialog.tsx`、`apps/web/src/components/CommandPalette.tsx`、`SessionSearch.tsx`、`apps/web/src/components/WorkspaceRail.tsx` |
| 现有测试 | 部分。`apps/web/src/shell/PanelHost.test.tsx` 覆盖 arrow/Home/End；`apps/web/src/ui/ui.test.tsx` 覆盖抽屉与 Dialog；`apps/web/src/App.test.tsx` 覆盖命令面板键盘；`SessionSearch.test.tsx` 覆盖 Enter；`WorkspaceRail.b5.test.tsx` 覆盖键盘调宽；会话输入区另有 `SessionComposer.b1.test.tsx` 与 `tests/composer-ime.test.tsx` 覆盖 IME/Enter，不替代外壳焦点测试。P1-d 已在 `AppFrame.test.tsx` 覆盖抽屉 Esc、焦点陷阱与关闭后焦点归还，并在 `App.test.tsx` 覆盖窄屏菜单键盘路径。 |
| 计划测试 ID | `shell.keyboard`、`shell.keyboard.tabs`、`shell.keyboard.escape` |
| P1 新增测试 | P1-c：需要，tab 选中/关闭后的焦点；P1-d：需要，Esc、抽屉与全局快捷键。 |
| 用户视觉检查 | 全键盘走完“新任务→会话→面板→关闭”，焦点环始终可见且不逃出抽屉。 |

### 13. 恢复（`shell.restore`）

| 项 | 冻结验收点 / 证据 |
| --- | --- |
| 必须成立 | 刷新后恢复左右宽度、折叠状态、`rightOpen`、`panels`、`activePanelId`；缺省/损坏/私密模式回退默认；宽度与面板数量（上限 12）再次 clamp；非法 panel 丢弃；按 `conversationId` 恢复；StrictMode 重挂载不重复写/重复请求；存储键为 `maworker.shell.v1`。 |
| 涉及文件 | `apps/web/src/shell/shell-state.ts`、`useShellLayout.ts`、`shell-state.test.ts`、`useShellLayout.test.tsx`、`apps/web/src/App.tsx`、`SessionPage.tsx`、`apps/web/src/components/WorkspaceRail.tsx` |
| 现有测试 | 部分。`apps/web/src/shell/shell-state.test.ts` 覆盖 round-trip、损坏值、宽度/面板 clamp、12 个上限；`useShellLayout.test.tsx` 覆盖宽度持久化；`WorkspaceRail.b5.test.tsx` 覆盖旧 rail 恢复宽度。P1-c/P1-d 已覆盖面板写入（`useShellLayout` open/close/reorder）、按会话过滤与 `ArtifactPanel` StrictMode 单请求；整页刷新后的端到端恢复仍未覆盖。 |
| 计划测试 ID | `shell.restore`、`shell.restore.storage`、`shell.restore.strict` |
| P1 新增测试 | P1-a：需要，宽度/折叠/右栏开关刷新恢复；P1-c：需要，面板按会话恢复与 StrictMode 重挂载。 |
| 用户视觉检查 | 改宽、折叠、打开两个面板后刷新，布局与面板一致；清空 storage 后回到默认。 |

## 已知缺口（2026-10-18 P1-d 后）

| 缺口 | 事实依据 | 归属 |
| --- | --- | --- |
| 无分栏/浮动 | `PanelHost.tsx` 仍只渲染一个 `active` panel；无 pane、分隔条、浮层、几何状态。D9 已定 M1 只做“单右栏 + 多标签 + 拖动重排”。 | M3 / B2-10 |
| 无类型注册表 | 只有 `PanelDescriptor` + 外部 `renderPanel` 回调，没有 `type → 组件` 注册表；当前只有 artifact 一类。 | M3 / 文件面板 |
| hover/focus 部分 | 抽屉焦点陷阱/Esc/关闭归还、PanelHost tab 键盘与拖拽已有测试；tab hover、关闭面板后的焦点归还、通知/会话菜单的 Esc 仍未覆盖。 | P1 收口 / P4 |
| 外壳自身无 loading/error | 新壳只有 `PanelHost` 空态；无 skeleton、无 error boundary；页面 loading/error 仍由 `App.tsx` / `SessionPage.tsx` 提供。 | P4 |
| 切会话/刷新恢复缺端到端 | 面板按 `conversationId` 过滤、shell open/close/reorder、StrictMode 单请求均有覆盖；整页刷新后的面板恢复没有 E2E。 | P1 收口 |
| 无浮层几何 | `ShellState` 无 pane、分隔比例、浮窗矩形；`maworker.shell.v1` 只保存 widths/rightOpen/panels/activePanelId。 | M3 |
| 产物列表面板缺失 | 页内 `WorkspaceRail` 已不再由 SessionPage 渲染；产物入口是时间线 chips 与文件页，尚未提供完整的“产物列表”面板。 | B2-5 / 文件面板 |
| 事件源默认 upstream | `SESSION_EVENT_INGESTOR_ENABLED=false`、`SESSION_EVENT_SOURCE=upstream`；切主需按 `docs/runbooks/event-ingestor-cutover.md` 在真实会话验收。 | P2 真实云验收 |
| 视觉验收未自动化 | 按项目规则只做非视觉测试；hover、间距、层级、动画由用户验收。 | 每个 P1 批次 |

## 使用方式

1. P1-a/P1-c/P1-d 每个批次开工前，先按本表 ID 建测试；测试标题用 `[ID]` 前缀，checkpoint 记录 `ID → 测试文件 → 结果`。
2. P1-a 至少绑定 `shell.default`、`shell.expand`、`shell.loading`、`shell.empty`、`shell.error`、`shell.menu`、`shell.restore`；P1-c 绑定 `panel.*`、`session.switch`、`panel.loading`、`shell.error`、`shell.restore`；P1-d 绑定 `shell.focus`、`shell.narrow`、`shell.keyboard`、`panel.drag`、`layout.bounds`。
3. 旧测试可保留原名；下次修改该测试时补 ID。新增测试不得断言截图或浏览器视觉结果。
4. 任何验收点或 ID 变更，必须在同一批次更新本文件，并在 checkpoint 写明变更原因；只改测试不改清单视为未完成。
5. 每批完成后由用户做视觉验收；未被测试覆盖的视觉项在验收记录中逐条打勾，不以“测试全绿”代替。
