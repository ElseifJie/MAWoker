import { useEffect, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AccountConsent,
  type AccountConsents,
} from "./api.js";
import { Alert, Button, Spinner } from "./ui/index.js";

const DOCUMENT_LABELS: Record<string, string> = {
  terms: "服务条款",
  privacy: "隐私政策",
};

function documentLabel(document: string): string {
  return DOCUMENT_LABELS[document] ?? document;
}

function acceptedOn(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export interface PrivacyConsentsProps {
  onAuthRequired?(): void;
  list?: () => Promise<AccountConsents>;
  accept?: (
    document: string,
    version: string,
  ) => Promise<{
    consent: AccountConsent;
  }>;
}

/**
 * Privacy/terms acceptance plus the retention and support copy that the invite
 * flow cannot show. Records are versioned, so a later document revision asks
 * again instead of silently reusing an old acceptance.
 */
export function PrivacyConsents({
  onAuthRequired,
  list = apiClient.listAccountConsents,
  accept = apiClient.acceptAccountConsent,
}: PrivacyConsentsProps = {}) {
  const [data, setData] = useState<AccountConsents | null>(null);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError(false);
    list()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiClientError && cause.isAuthRequired) {
          onAuthRequired?.();
          return;
        }
        setError(true);
      });
    return () => {
      active = false;
    };
  }, [list, onAuthRequired, reloadKey]);

  async function recordConsent(document: string) {
    if (!data || busy) return;
    setBusy(document);
    setFeedback(null);
    try {
      const { consent } = await accept(document, data.currentVersion);
      setData((current) =>
        current
          ? {
              ...current,
              consents: [
                ...current.consents.filter(
                  (item) =>
                    !(
                      item.document === consent.document &&
                      item.version === consent.version
                    ),
                ),
                consent,
              ],
            }
          : current,
      );
      setFeedback(`已记录${documentLabel(document)}同意。`);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.isAuthRequired) {
        onAuthRequired?.();
      } else {
        setFeedback("同意记录未能保存，请重试。");
      }
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="privacy-consents">
        <Alert tone="danger">隐私与数据状态加载失败。</Alert>
        <Button
          variant="secondary"
          size="compact"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="privacy-consents" aria-busy="true">
        <Spinner label="加载隐私与数据状态" />
      </div>
    );
  }

  return (
    <div className="privacy-consents">
      <p className="muted">
        当前文档版本 {data.currentVersion}。同意记录会保存文档、版本与时间。
      </p>
      <ul className="privacy-consents__list">
        {data.documents.map((document) => {
          const record = data.consents.find(
            (item) =>
              item.document === document &&
              item.version === data.currentVersion,
          );
          return (
            <li key={document}>
              <span>{documentLabel(document)}</span>
              {record ? (
                <span className="muted">
                  已同意 · {acceptedOn(record.acceptedAt)}
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="compact"
                  loading={busy === document}
                  onClick={() => void recordConsent(document)}
                >
                  同意{documentLabel(document)}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted">
        账号注销采用匿名化软删除；任务、用量与审计记录按合规要求保留，云文件与运行时对象由后台清理任务删除。
        你可以在「我的数据」导出副本。
      </p>
      <p className="muted">
        如需帮助，请联系邀请你的管理员，并提供任务链接（包含会话
        ID）与发生时间。
      </p>
      {feedback ? (
        <Alert tone={feedback.startsWith("已记录") ? "success" : "danger"}>
          {feedback}
        </Alert>
      ) : null}
    </div>
  );
}
