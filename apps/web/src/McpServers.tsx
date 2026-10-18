import { useEffect, useState, type SyntheticEvent } from "react";
import { ApiClientError, apiClient, type McpServer } from "./api.js";
import { Alert, Button, DataTable, Field, Input, Spinner } from "./ui/index.js";

export function McpServers({
  list = apiClient.listMcpServers,
  create = apiClient.createMcpServer,
  setEnabled = apiClient.setMcpServerEnabled,
  remove = apiClient.deleteMcpServer,
}: {
  list?: () => Promise<{ servers: McpServer[] }>;
  create?: (name: string, url: string) => Promise<{ server: McpServer }>;
  setEnabled?: (id: string, enabled: boolean) => Promise<{ server: McpServer }>;
  remove?: (id: string) => Promise<void>;
} = {}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
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
        if (active) setServers(result.servers);
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
      setServers((current) => [result.server, ...(current ?? [])]);
      setName("");
      setUrl("");
      setFeedback({ tone: "success", message: "MCP 服务已添加。" });
    } catch (createError) {
      setFeedback({
        tone: "danger",
        message:
          createError instanceof ApiClientError &&
          createError.code === "MCP_URL_UNSAFE"
            ? "该地址不安全：只允许 HTTPS 公网地址，不能指向本机或私网。"
            : createError instanceof ApiClientError &&
                createError.code === "MCP_NAME_CONFLICT"
              ? "已有同名 MCP 服务。"
              : "添加失败，请稍后重试。",
      });
    } finally {
      setPending(false);
    }
  }

  async function toggle(server: McpServer) {
    if (busyId) return;
    setBusyId(server.id);
    try {
      const result = await setEnabled(server.id, !server.enabled);
      setServers((current) =>
        (current ?? []).map((item) =>
          item.id === server.id ? result.server : item,
        ),
      );
    } catch {
      setFeedback({ tone: "danger", message: "操作失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteServer(server: McpServer) {
    if (busyId) return;
    setBusyId(server.id);
    try {
      await remove(server.id);
      setServers((current) =>
        (current ?? []).filter((item) => item.id !== server.id),
      );
      setFeedback({ tone: "success", message: "MCP 服务已删除。" });
    } catch {
      setFeedback({ tone: "danger", message: "删除失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <Alert tone="danger">MCP 服务加载失败，请刷新页面后重试。</Alert>;
  }
  if (!servers) {
    return <Spinner label="正在加载 MCP 服务" />;
  }

  return (
    <div className="settings-panel">
      <p className="muted">
        添加远程 MCP 服务地址。地址必须使用 HTTPS
        且指向公网；本版本先保存注册信息， 工具绑定将在后续版本启用。
      </p>
      <form className="settings-form" onSubmit={add}>
        <Field label="名称">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：Feishu"
            maxLength={80}
            required
            disabled={pending}
          />
        </Field>
        <Field label="MCP URL">
          <Input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.example.com/mcp"
            required
            disabled={pending}
          />
        </Field>
        <Button type="submit" loading={pending}>
          添加 MCP 服务
        </Button>
      </form>
      {feedback ? <Alert tone={feedback.tone}>{feedback.message}</Alert> : null}
      {servers.length === 0 ? (
        <p className="muted">还没有 MCP 服务。</p>
      ) : (
        <DataTable caption="MCP 服务">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">地址</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr key={server.id}>
                <td>{server.name}</td>
                <td>
                  <code>{server.url}</code>
                </td>
                <td>{server.enabled ? "已启用" : "已停用"}</td>
                <td>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={busyId === server.id}
                    onClick={() => void toggle(server)}
                  >
                    {server.enabled ? "停用" : "启用"}
                  </Button>{" "}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyId !== null}
                    onClick={() => void deleteServer(server)}
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
