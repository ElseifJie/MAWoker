import { Copy, MailPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, apiClient, type AdminInvite } from "../api.js";
import {
  Alert,
  Button,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from "../ui/index.js";
import { formatDateTime } from "./format.js";
import { useAdminLifetime } from "./useAdminLifetime.js";

const STATUS_LABELS: Record<AdminInvite["status"], string> = {
  pending: "待使用",
  used: "已使用",
  revoked: "已撤销",
  expired: "已过期",
};

function inviteLink(code: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/invite?code=${encodeURIComponent(code)}`;
}

export function AdminInvitesPage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [email, setEmail] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    email: string;
    code: string;
  } | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger";
    message: string;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const capture = useAdminLifetime();

  useEffect(() => {
    let active = true;
    setLoadError(false);
    setInvites(null);
    apiClient
      .listAdminInvites()
      .then((result) => {
        if (active) setInvites(result.invites);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, reloadKey]);

  async function createInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      setFeedback({ tone: "danger", message: "请输入受邀邮箱。" });
      return;
    }
    const isCurrent = capture();
    setPending(true);
    setFeedback(null);
    try {
      const result = await apiClient.createAdminInvite(
        normalized,
        Number(expiresInDays),
      );
      if (!isCurrent()) return;
      setInvites((current) => [result.invite, ...(current ?? [])]);
      setCreated({ email: result.invite.email, code: result.code });
      setEmail("");
      setFeedback({
        tone: "success",
        message: "邀请已生成，链接只显示这一次。",
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError &&
          error.code === "USER_EMAIL_CONFLICT"
            ? "该邮箱已经有账号了，无需再邀请。"
            : "邀请生成失败，请稍后重试。",
      });
    } finally {
      if (isCurrent()) setPending(false);
    }
  }

  async function revokeInvite(id: string) {
    if (revoking) return;
    const isCurrent = capture();
    setRevoking(id);
    setFeedback(null);
    try {
      const result = await apiClient.revokeAdminInvite(id);
      if (!isCurrent()) return;
      setInvites((current) =>
        (current ?? []).map((invite) =>
          invite.id === id ? result.invite : invite,
        ),
      );
      setFeedback({ tone: "success", message: "邀请已撤销。" });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({ tone: "danger", message: "撤销失败，请稍后重试。" });
    } finally {
      if (isCurrent()) setRevoking(null);
    }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(inviteLink(created.code));
      setFeedback({ tone: "success", message: "邀请链接已复制。" });
    } catch {
      setFeedback({
        tone: "danger",
        message: "复制失败，请手动选择链接。",
      });
    }
  }

  if (loadError) {
    return (
      <div className="page admin-page">
        <PageHeader title="邀请" headingRef={headingRef} />
        <Alert tone="danger">邀请列表加载失败，请重试。</Alert>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (invites === null) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="正在加载邀请" />
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <PageHeader
        title="邀请"
        description="生成一次性邀请链接，受邀人设置密码后即可登录。"
        headingRef={headingRef}
      />

      <section className="admin-section admin-panel" aria-label="生成邀请">
        <h2 className="admin-section__title">生成邀请</h2>
        <form onSubmit={createInvite}>
          <div className="admin-quota-fields">
            <Field label="受邀邮箱">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="invitee@example.com"
                required
                disabled={pending}
              />
            </Field>
            <Field label="有效期">
              <Select
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
                disabled={pending}
              >
                <option value="7">7 天</option>
                <option value="14">14 天</option>
                <option value="30">30 天</option>
              </Select>
            </Field>
          </div>
          <Button type="submit" loading={pending}>
            <MailPlus size={16} aria-hidden="true" />
            生成邀请
          </Button>
        </form>
        {created ? (
          <div className="admin-invite-created" role="status">
            <p>已为 {created.email} 生成邀请。链接只显示这一次，请现在复制。</p>
            <Input
              aria-label="邀请链接"
              readOnly
              value={inviteLink(created.code)}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => void copyLink()}
            >
              <Copy size={16} aria-hidden="true" />
              复制链接
            </Button>
          </div>
        ) : null}
        {feedback ? (
          <Alert tone={feedback.tone}>{feedback.message}</Alert>
        ) : null}
      </section>

      <section className="admin-section" aria-label="邀请列表">
        <h2 className="admin-section__title">邀请列表</h2>
        {invites.length === 0 ? (
          <p className="admin-dimmed">还没有邀请。</p>
        ) : (
          <DataTable caption="邀请列表">
            <thead>
              <tr>
                <th scope="col">邮箱</th>
                <th scope="col">状态</th>
                <th scope="col">有效期至</th>
                <th scope="col">创建时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.email}</td>
                  <td>{STATUS_LABELS[invite.status]}</td>
                  <td>{formatDateTime(invite.expiresAt)}</td>
                  <td>{formatDateTime(invite.createdAt)}</td>
                  <td>
                    {invite.status === "pending" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void revokeInvite(invite.id)}
                        loading={revoking === invite.id}
                      >
                        撤销
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>
    </div>
  );
}
