const statuses: Record<string, string> = {
  active: "已启用",
  disabled: "已停用",
  provisioning: "准备中",
  deleting: "删除中",
  deleted: "已删除",
  failed: "失败",
  idle: "就绪",
  running: "运行中",
  creating: "创建中",
  terminated: "已结束",
  terminating: "结束中",
  archived: "已归档",
  ok: "正常",
  near: "接近上限",
  exhausted: "已用尽",
  succeeded: "成功",
};
export function statusLabel(value: string): string {
  return statuses[value] ?? value;
}

const actions: Record<string, string> = {
  "auth.login": "登录",
  "platform_agent.create": "创建平台助手",
  "platform_agent.update": "更新平台助手",
  "platform_agent.enable": "启用平台助手",
  "platform_agent.disable": "停用平台助手",
  "platform_agent.delete": "删除平台助手",
  "user.create": "创建账号",
  "user.view": "查看账号",
  "user.status.update": "更改账号状态",
  "user.role.update": "更改账号角色",
  "user_password.reset": "重置密码",
  "user_sessions.revoke": "强制退出登录",
  "user_default_agent.assign": "分配默认助手",
  "user_quota.update": "修改用户配额",
  "quota_policy.update": "修改默认配额",
  "quota_interrupt.enqueue": "触发配额中断",
  "session.create": "创建任务",
  "session.message": "发送任务消息",
  "session.interrupt": "中断任务",
};
export function actionLabel(value: string): string {
  return actions[value] ?? value;
}
const resources: Record<string, string> = {
  platform_agent: "平台助手",
  user: "用户账号",
  user_password: "账号密码",
  user_default_agent: "默认助手",
  user_quota: "用户配额",
  user_session: "用户登录",
  authentication: "身份认证",
  quota_policy: "默认配额",
  quota_interrupt: "配额中断",
};
export function resourceLabel(value: string): string {
  return resources[value] ?? value;
}
