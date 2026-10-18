import { useEffect, useState, type SyntheticEvent } from "react";
import { ApiClientError, apiClient, type NotificationChannel } from "./api.js";
import { Alert, Button, DataTable, Field, Input, Spinner } from "./ui/index.js";

export function NotificationChannels({
  list = apiClient.listNotificationChannels,
  create = apiClient.createNotificationChannel,
  setEnabled = apiClient.setNotificationChannelEnabled,
  remove = apiClient.deleteNotificationChannel,
}: {
  list?: () => Promise<{ channels: NotificationChannel[] }>;
  create?: (
    name: string,
    url: string,
  ) => Promise<{
    channel: NotificationChannel;
  }>;
  setEnabled?: (
    id: string,
    enabled: boolean,
  ) => Promise<{ channel: NotificationChannel }>;
  remove?: (id: string) => Promise<void>;
} = {}) {
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger";
    message: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    list()
      .then((result) => {
        if (active) setChannels(result.channels);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [list]);

  async function add(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await create(name.trim(), url.trim());
      setChannels((current) => [result.channel, ...(current ?? [])]);
      setName("");
      setUrl("");
      setFeedback({ tone: "success", message: "通知渠道已添加。" });
    } catch (createError) {
      setFeedback({
        tone: "danger",
        message:
          createError instanceof ApiClientError &&
          createError.code === "CHANNEL_URL_UNSAFE"
            ? "该地址不安全：只允许 HTTPS 公网地址，不能指向本机或私网。"
            : createError instanceof ApiClientError &&
                createError.code === "CHANNEL_NAME_CONFLICT"
              ? "已有同名通知渠道。"
              : "添加失败，请稍后重试。",
      });
    } finally {
      setPending(false);
    }
  }

  async function toggle(channel: NotificationChannel) {
    if (busyId) return;
    setBusyId(channel.id);
    try {
      const result = await setEnabled(channel.id, !channel.enabled);
      setChannels((current) =>
        (current ?? []).map((item) =>
          item.id === channel.id ? result.channel : item,
        ),
      );
    } catch {
      setFeedback({ tone: "danger", message: "操作失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteChannel(channel: NotificationChannel) {
    if (busyId) return;
    setBusyId(channel.id);
    try {
      await remove(channel.id);
      setChannels((current) =>
        (current ?? []).filter((item) => item.id !== channel.id),
      );
      setFeedback({ tone: "success", message: "通知渠道已删除。" });
    } catch {
      setFeedback({ tone: "danger", message: "删除失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <Alert tone="danger">通知渠道加载失败，请刷新页面后重试。</Alert>;
  }
  if (!channels) {
    return <Spinner label="正在加载通知渠道" />;
  }

  return (
    <div className="settings-panel">
      <p className="muted">
        添加飞书机器人或通用 Webhook。到期提醒与定时任务启动时会推送；
        地址创建后只显示掩码。
      </p>
      <form className="settings-form" onSubmit={add}>
        <Field label="名称">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：飞书提醒"
            maxLength={80}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Webhook URL">
          <Input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
            required
            disabled={pending}
          />
        </Field>
        <Button type="submit" loading={pending}>
          添加通知渠道
        </Button>
      </form>
      {feedback ? <Alert tone={feedback.tone}>{feedback.message}</Alert> : null}
      {channels.length === 0 ? (
        <p className="muted">还没有通知渠道。</p>
      ) : (
        <DataTable caption="通知渠道">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">地址</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td>{channel.name}</td>
                <td>
                  <code>{channel.url}</code>
                </td>
                <td>
                  {channel.enabled ? "已启用" : "已停用"}
                  {channel.lastErrorCode ? `（${channel.lastErrorCode}）` : ""}
                </td>
                <td>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={busyId === channel.id}
                    onClick={() => void toggle(channel)}
                  >
                    {channel.enabled ? "停用" : "启用"}
                  </Button>{" "}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyId !== null}
                    onClick={() => void deleteChannel(channel)}
                  >
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
