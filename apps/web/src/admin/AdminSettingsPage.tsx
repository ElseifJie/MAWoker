import { useEffect, useRef, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AdminQuota,
  type AdminQuotaPolicy,
} from "../api.js";
import {
  Alert,
  Button,
  Field,
  Input,
  PageHeader,
  Spinner,
} from "../ui/index.js";
import { useAdminLifetime } from "./useAdminLifetime.js";
import { formatDateTime } from "./format.js";

const QUOTA_FIELDS: Array<{ key: keyof AdminQuota; label: string }> = [
  { key: "personalAgentLimit", label: "个人助手上限" },
  { key: "concurrentSessionLimit", label: "同时运行任务上限" },
  { key: "dailySessionLimit", label: "每日任务上限" },
  { key: "monthlyTokenLimit", label: "每月 Token 上限" },
];

type QuotaDraft = Record<keyof AdminQuota, string>;

function draftFromPolicy(policy: AdminQuotaPolicy): QuotaDraft {
  return {
    personalAgentLimit: String(policy.personalAgentLimit),
    concurrentSessionLimit: String(policy.concurrentSessionLimit),
    dailySessionLimit: String(policy.dailySessionLimit),
    monthlyTokenLimit: String(policy.monthlyTokenLimit),
  };
}

function parseDraft(draft: QuotaDraft): AdminQuota | null {
  if (Object.values(draft).some((value) => value.trim().length === 0)) {
    return null;
  }
  const values = {
    personalAgentLimit: Number(draft.personalAgentLimit),
    concurrentSessionLimit: Number(draft.concurrentSessionLimit),
    dailySessionLimit: Number(draft.dailySessionLimit),
    monthlyTokenLimit: Number(draft.monthlyTokenLimit),
  };
  return Object.values(values).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
    ? values
    : null;
}

export function AdminSettingsPage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [policy, setPolicy] = useState<AdminQuotaPolicy | null>(null);
  const [draft, setDraft] = useState<QuotaDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger";
    message: string;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const capture = useAdminLifetime();
  const saveLock = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    apiClient
      .getAdminQuotaPolicy()
      .then((result) => {
        if (!active) return;
        setPolicy(result);
        setDraft(draftFromPolicy(result));
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, reloadKey]);

  async function savePolicy() {
    if (!draft || pending) return;
    const parsed = parseDraft(draft);
    if (!parsed) {
      setFeedback({
        tone: "danger",
        message: "所有配额必须为非负整数。",
      });
      return;
    }
    if (saveLock.current) return;
    saveLock.current = true;
    const isCurrent = capture();
    setPending(true);
    setFeedback(null);
    try {
      const updated = await apiClient.updateAdminQuotaPolicy(parsed);
      if (!isCurrent()) return;
      setPolicy(updated);
      setDraft(draftFromPolicy(updated));
      setFeedback({ tone: "success", message: "平台默认配额已保存。" });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError && error.retryable
            ? "服务暂时不可用，请稍后重试。"
            : "默认配额保存失败，请检查输入后重试。",
      });
    } finally {
      saveLock.current = false;
      if (isCurrent()) setPending(false);
    }
  }

  if (loading) {
    return (
      <div className="page admin-page admin-settings-page" aria-busy="true">
        <Spinner label="正在加载设置" />
        <p className="admin-dimmed">正在加载设置…</p>
      </div>
    );
  }

  if (loadError || !policy || !draft) {
    return (
      <div className="page admin-page admin-settings-page">
        <PageHeader eyebrow="管理工作台" title="设置" headingRef={headingRef} />
        <Alert tone="danger">设置加载失败，请重试。</Alert>
        <div className="admin-load-more">
          <Button
            variant="secondary"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            重试
          </Button>
        </div>
      </div>
    );
  }

  const parsed = parseDraft(draft);
  const dirty = QUOTA_FIELDS.some(
    ({ key }) => draft[key] !== String(policy[key]),
  );

  return (
    <div className="page admin-page admin-settings-page">
      <PageHeader
        title="设置"
        description="配置平台默认配额，用户账号可单独覆盖各项限制。"
        headingRef={headingRef}
      />

      <section className="admin-section admin-panel" aria-label="平台默认配额">
        <h2 className="admin-section__title">平台默认配额</h2>
        <p className="admin-dimmed admin-section__hint">
          默认值适用于未设置自定义配额的个人账号。每项配额均为非负整数，0
          表示不允许使用该项能力。
        </p>
        <Alert tone="info">
          降低每月 Token
          上限会重新检查当前用量，并中断已超出新上限的运行中任务。
        </Alert>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed && dirty) void savePolicy();
          }}
        >
          <div className="admin-quota-fields">
            {QUOTA_FIELDS.map(({ key, label }) => (
              <Field
                label={label}
                key={key}
                error={
                  draft[key].trim() === "" ||
                  !Number.isSafeInteger(Number(draft[key])) ||
                  Number(draft[key]) < 0
                    ? "请输入非负整数。"
                    : undefined
                }
              >
                <Input
                  aria-label={label}
                  type="number"
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={draft[key]}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? { ...current, [key]: event.target.value }
                        : current,
                    )
                  }
                />
              </Field>
            ))}
          </div>
          <div className="admin-settings-footer">
            <Button
              type="submit"
              loading={pending}
              disabled={!parsed || !dirty}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {pending ? <Spinner size={15} /> : null}
              </span>
              保存默认配额
            </Button>
            {dirty ? (
              <Button
                variant="text"
                disabled={pending}
                onClick={() => {
                  setDraft(draftFromPolicy(policy));
                  setFeedback(null);
                }}
              >
                撤销修改
              </Button>
            ) : null}
            <span className="admin-dimmed">
              更新于 {formatDateTime(policy.updatedAt)}
              {policy.updatedBy ? "" : " · 初始配置"}
            </span>
          </div>
        </form>
      </section>

      {feedback ? (
        <Alert
          className="admin-page-feedback"
          tone={feedback.tone}
          role={feedback.tone === "success" ? "status" : "alert"}
        >
          {feedback.message}
        </Alert>
      ) : null}
    </div>
  );
}
