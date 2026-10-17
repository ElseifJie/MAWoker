import { useState, type SyntheticEvent } from "react";
import { apiClient } from "./api.js";
import { Alert, Button, Field, Input, PasswordInput } from "./ui/index.js";

export function AccountDeletion({
  deleteAccount = apiClient.deleteAccount,
  onDeleted = () => window.location.assign("/"),
}: {
  deleteAccount?: (password: string) => Promise<{ deleted: true }>;
  onDeleted?: () => void;
} = {}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (confirmation !== "DELETE") {
      setError("请输入 DELETE 以确认注销。");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await deleteAccount(password);
      onDeleted();
    } catch {
      setError("注销失败：请确认密码后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="account-deletion">
      <p className="muted">
        注销后账号会立即停用并匿名化，连接器与记忆会被删除。任务与用量记录按合规要求保留。
      </p>
      <form onSubmit={remove}>
        <Field label="当前密码">
          <PasswordInput
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={pending}
          />
        </Field>
        <Field label="输入 DELETE 确认">
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="DELETE"
            required
            disabled={pending}
          />
        </Field>
        <Button type="submit" variant="danger" loading={pending}>
          注销账号
        </Button>
      </form>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
