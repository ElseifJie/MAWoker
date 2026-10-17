import { Bot } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiClientError, apiClient } from "./api.js";
import { Alert, Button, Field, PasswordInput, Spinner } from "./ui/index.js";

export interface InvitePageProps {
  acceptInvite?: (
    code: string,
    password: string,
  ) => Promise<{ user: { userId: string; email: string } }>;
}

function inviteErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "INVITE_INVALID") {
      return "邀请链接无效、已过期或已经使用。请向管理员重新获取邀请。";
    }
    if (error.code === "USER_EMAIL_CONFLICT") {
      return "该邮箱已经有账号了，可以直接登录。";
    }
    return error.message;
  }
  return "开通失败，请稍后重试。";
}

export function InvitePage({ acceptInvite }: InvitePageProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get("code")?.trim() ?? "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ email: string } | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("密码至少 8 位。");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setPending(true);
    try {
      const result = await (acceptInvite ?? apiClient.acceptInvite)(
        code,
        password,
      );
      setAccepted({ email: result.user.email });
    } catch (acceptError) {
      setError(inviteErrorMessage(acceptError));
    } finally {
      setPending(false);
    }
  }

  if (!code) {
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="invite-heading">
          <h1 id="invite-heading">邀请链接不完整</h1>
          <Alert tone="danger">链接缺少邀请码，请向管理员重新获取邀请。</Alert>
          <Button type="button" onClick={() => navigate("/")}>
            返回登录
          </Button>
        </section>
      </main>
    );
  }

  if (accepted) {
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="invite-heading">
          <div className="brand-mark" aria-hidden="true">
            <Bot size={22} />
          </div>
          <p className="eyebrow">Work Agent</p>
          <h1 id="invite-heading">账号已开通</h1>
          <p className="login-panel__lede">{accepted.email}</p>
          <Alert tone="success">现在可以登录并开始使用个人助手。</Alert>
          <Button
            type="button"
            className="full-width"
            onClick={() => navigate("/")}
          >
            前往登录
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="invite-heading">
        <div className="brand-mark" aria-hidden="true">
          <Bot size={22} />
        </div>
        <p className="eyebrow">Work Agent</p>
        <h1 id="invite-heading">设置你的登录密码</h1>
        <p className="login-panel__lede">
          这个邀请只能使用一次。设置密码后，用受邀邮箱登录。
        </p>
        <form onSubmit={submit}>
          <Field label="密码" hint="至少 8 位">
            <PasswordInput
              id="invite-password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={pending}
            />
          </Field>
          <Field label="确认密码">
            <PasswordInput
              id="invite-confirmation"
              name="confirmation"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              disabled={pending}
              aria-describedby={error ? "invite-feedback" : undefined}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <Button type="submit" className="full-width" loading={pending}>
            {pending ? <Spinner size={17} aria-hidden="true" /> : null}
            开通账号
          </Button>
        </form>
        {error ? (
          <Alert id="invite-feedback" className="login-feedback" tone="danger">
            {error}
          </Alert>
        ) : null}
      </section>
    </main>
  );
}
