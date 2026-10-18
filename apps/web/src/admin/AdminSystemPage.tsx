import { useEffect, useRef, useState } from "react";
import { ApiClientError, apiClient, type AdminSystemSnapshot } from "../api.js";
import { Alert, Button, DataTable, PageHeader, Spinner } from "../ui/index.js";
import { useAdminLifetime } from "./useAdminLifetime.js";

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时`;
}

function ago(seconds: number | null): string {
  return seconds === null ? "—" : `${duration(seconds)}前`;
}

const RUN_LABELS: Record<string, string> = {
  queued: "排队",
  starting: "启动中",
  running: "运行中",
  waiting_user: "等待用户",
  waiting_device: "等待设备",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  unknown: "未知",
};

export function AdminSystemPage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [snapshot, setSnapshot] = useState<AdminSystemSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const capture = useAdminLifetime();

  useEffect(() => {
    let active = true;
    setLoadError(false);
    const load = async () => {
      const isCurrent = capture();
      try {
        const result = await apiClient.getAdminSystem();
        if (active && isCurrent()) {
          setSnapshot(result);
          setLoadError(false);
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        if (isCurrent()) setLoadError(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onAuthRequired, reloadKey]);

  if (loadError && !snapshot) {
    return (
      <div className="page admin-page">
        <PageHeader title="系统状态" headingRef={headingRef} />
        <Alert tone="danger">系统状态加载失败，请重试。</Alert>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="正在加载系统状态" />
      </div>
    );
  }

  const activeRuns =
    (snapshot.runs.queued ?? 0) +
    (snapshot.runs.starting ?? 0) +
    (snapshot.runs.running ?? 0) +
    (snapshot.runs.waiting_user ?? 0) +
    (snapshot.runs.waiting_device ?? 0);

  return (
    <div className="page admin-page">
      <PageHeader
        title="系统状态"
        description="队列、运行与提醒的实时积压情况。每 15 秒自动刷新。"
        headingRef={headingRef}
      />
      {loadError ? (
        <Alert tone="warning">刷新失败，显示上次结果。</Alert>
      ) : null}
      <dl className="admin-system-cards">
        <div>
          <dt>数据库延迟</dt>
          <dd>{snapshot.database.latencyMs} ms</dd>
        </div>
        <div>
          <dt>待处理后台任务</dt>
          <dd>{snapshot.jobs.pending}</dd>
        </div>
        <div>
          <dt>运行中后台任务</dt>
          <dd>{snapshot.jobs.running}</dd>
        </div>
        <div>
          <dt>24h 失败任务</dt>
          <dd>{snapshot.jobs.failedLast24h}</dd>
        </div>
        <div>
          <dt>最老待处理</dt>
          <dd>{duration(snapshot.jobs.oldestPendingSeconds)}</dd>
        </div>
        <div>
          <dt>事件消费者</dt>
          <dd>{snapshot.eventIngestors.consumers}</dd>
        </div>
        <div>
          <dt>过期租约</dt>
          <dd>{snapshot.eventIngestors.expiredLeases}</dd>
        </div>
        <div>
          <dt>最后消费</dt>
          <dd>{ago(snapshot.eventIngestors.lastConsumedSecondsAgo)}</dd>
        </div>
        <div>
          <dt>最久未消费</dt>
          <dd>{ago(snapshot.eventIngestors.oldestConsumedSecondsAgo)}</dd>
        </div>
        <div>
          <dt>活跃 Run</dt>
          <dd>{activeRuns}</dd>
        </div>
        <div>
          <dt>运行中会话</dt>
          <dd>{snapshot.sessions.running}</dd>
        </div>
        <div>
          <dt>未读通知</dt>
          <dd>{snapshot.notifications.unread}</dd>
        </div>
        <div>
          <dt>启用中的提醒</dt>
          <dd>{snapshot.automations.active}</dd>
        </div>
        <div>
          <dt>逾期提醒</dt>
          <dd>{snapshot.automations.overdue}</dd>
        </div>
      </dl>

      <section className="admin-section" aria-label="Run 状态分布">
        <h2 className="admin-section__title">Run 状态分布</h2>
        <DataTable caption="Run 状态分布">
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">数量</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(RUN_LABELS).map(([status, label]) => (
              <tr key={status}>
                <td>{label}</td>
                <td>{snapshot.runs[status] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </section>

      <div className="admin-load-more">
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          立即刷新
        </Button>
        <span className="admin-dimmed">
          生成于 {new Date(snapshot.generatedAt).toLocaleString("zh-CN")}
        </span>
      </div>
    </div>
  );
}
