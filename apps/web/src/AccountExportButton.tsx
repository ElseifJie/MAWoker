import { useState } from "react";
import { apiClient } from "./api.js";
import { Alert, Button } from "./ui/index.js";

export function downloadJson(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ma-worker-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function AccountExportButton({
  exportAccount = apiClient.exportAccount,
  download = downloadJson,
}: {
  exportAccount?: () => Promise<Record<string, unknown>>;
  download?: (data: Record<string, unknown>) => void;
} = {}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);

  async function run() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const data = await exportAccount();
      download(data);
      setMessage({ tone: "success", text: "导出文件已开始下载。" });
    } catch {
      setMessage({ tone: "danger", text: "导出失败，请稍后重试。" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="account-export">
      <p className="muted">
        导出账号资料、任务、文件元数据、提醒与技能。导出不包含密码、令牌或云存储密钥。
      </p>
      <Button variant="secondary" loading={pending} onClick={() => void run()}>
        导出我的数据
      </Button>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </div>
  );
}
