import { useEffect, useState } from "react";
import { apiClient, type AccountSession } from "./api.js";
import { Alert, Button, DataTable, Spinner } from "./ui/index.js";

export function AccountSessions({
  list = apiClient.listAccountSessions,
  revokeOthers = apiClient.revokeOtherAccountSessions,
}: {
  list?: () => Promise<{ sessions: AccountSession[] }>;
  revokeOthers?: () => Promise<{ revoked: number }>;
} = {}) {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    list()
      .then((result) => {
        if (active) setSessions(result.sessions);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [list]);

  async function revoke() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await revokeOthers();
      setSessions((current) =>
        (current ?? []).filter((session) => session.current),
      );
      setFeedback(
        result.revoked === 0
          ? "没有其他需要退出的设备。"
          : `已退出 ${result.revoked} 个其他设备。`,
      );
    } catch {
      setFeedback("退出失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  if (error) {
    return <Alert tone="danger">登录设备加载失败，请刷新页面后重试。</Alert>;
  }
  if (!sessions) {
    return <Spinner label="正在加载登录设备" />;
  }

  return (
    <div>
      <DataTable caption="登录设备">
        <thead>
          <tr>
            <th scope="col">设备</th>
            <th scope="col">登录时间</th>
            <th scope="col">有效期至</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>{session.current ? "当前设备" : "其他设备"}</td>
              <td>{new Date(session.createdAt).toLocaleString("zh-CN")}</td>
              <td>{new Date(session.expiresAt).toLocaleString("zh-CN")}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <Button
        variant="secondary"
        loading={pending}
        disabled={sessions.every((session) => session.current)}
        onClick={() => void revoke()}
      >
        退出其他设备
      </Button>
      {feedback ? <Alert tone="info">{feedback}</Alert> : null}
    </div>
  );
}
