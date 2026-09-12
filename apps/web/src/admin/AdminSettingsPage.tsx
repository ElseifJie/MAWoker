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
import { formatDateTime } from "./format.js";

const QUOTA_FIELDS: Array<{ key: keyof AdminQuota; label: string }> = [
  { key: "personalAgentLimit", label: "Personal Agent limit" },
  { key: "concurrentSessionLimit", label: "Concurrent Session limit" },
  { key: "dailySessionLimit", label: "Daily Session limit" },
  { key: "monthlyTokenLimit", label: "Monthly token limit" },
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
        message: "Every limit must be a non-negative whole number.",
      });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const updated = await apiClient.updateAdminQuotaPolicy(parsed);
      setPolicy(updated);
      setDraft(draftFromPolicy(updated));
      setFeedback({ tone: "success", message: "Default quota policy saved." });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError && error.retryable
            ? "The service is temporarily unavailable. Try again."
            : "The policy could not be saved. Review the values and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  if (loading) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="Loading settings" />
        <p className="admin-dimmed">Loading settings…</p>
      </div>
    );
  }

  if (loadError || !policy || !draft) {
    return (
      <div className="page admin-page">
        <PageHeader
          eyebrow="Administration"
          title="Settings"
          headingRef={headingRef}
        />
        <Alert tone="danger">Settings could not be loaded.</Alert>
        <div className="admin-load-more">
          <Button
            variant="secondary"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const parsed = parseDraft(draft);
  const dirty =
    parsed !== null &&
    QUOTA_FIELDS.some(({ key }) => parsed[key] !== policy[key]);

  return (
    <div className="page admin-page">
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="Platform-wide defaults. User-level overrides take precedence per dimension."
        headingRef={headingRef}
      />

      <section className="admin-section" aria-label="Default quota policy">
        <h2 className="admin-section__title">Default quota policy</h2>
        <p className="admin-dimmed admin-section__hint">
          Applies to every account that has no explicit override on a dimension.
          Lowering the monthly token limit re-evaluates current usage and
          interrupts running sessions that now exceed it.
        </p>
        <div className="admin-quota-fields">
          {QUOTA_FIELDS.map(({ key, label }) => (
            <Field label={label} key={key}>
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
            onClick={() => void savePolicy()}
            loading={pending}
            disabled={!parsed || !dirty}
          >
            <span className="admin-loading-icon-slot" aria-hidden="true">
              {pending ? <Spinner size={15} /> : null}
            </span>
            Save policy
          </Button>
          <span className="admin-dimmed">
            Last updated {formatDateTime(policy.updatedAt)}
            {policy.updatedBy ? "" : " · seeded"}
          </span>
        </div>
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
