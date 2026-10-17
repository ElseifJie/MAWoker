import { Bell, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type SessionSummary,
  type TaskNotification,
} from "../api.js";
import { Alert, Button, Dialog, IconButton } from "../ui/index.js";

const labels: Record<TaskNotification["kind"], string> = {
  completed: "任务已完成",
  failed: "任务执行失败",
  needs_action: "任务需要处理",
  sync_failed: "结果同步异常",
  reminder: "提醒",
};

export function TaskNotifications({
  onAuthRequired,
  sessions = [],
}: {
  onAuthRequired: () => void;
  sessions?: readonly SessionSummary[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<TaskNotification[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await apiClient.listNotifications();
        if (active) {
          setItems(result.notifications);
          setUnavailable(false);
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired)
          onAuthRequired();
        else setUnavailable(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [onAuthRequired, reloadKey]);

  const unread = items.filter((item) => item.readAt === null);
  async function markRead(id: string) {
    try {
      await apiClient.markNotificationRead(id);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
        ),
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired)
        onAuthRequired();
      else setUnavailable(true);
    }
  }
  return (
    <div className="task-notifications">
      <IconButton
        ref={triggerRef}
        className="task-notifications__trigger"
        label={unread.length ? `任务通知，${unread.length} 条未读` : "任务通知"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Bell size={17} aria-hidden="true" />
        {unread.length ? (
          <span className="task-notifications__count" aria-hidden="true">
            {unread.length}
          </span>
        ) : null}
      </IconButton>
      <Dialog
        open={open}
        title="任务通知"
        closeLabel="关闭任务通知"
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
      >
        {unavailable ? (
          <Alert tone="warning">
            通知暂时不可用。
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              重试通知
            </Button>
          </Alert>
        ) : null}
        {unread.length === 0 ? (
          <p className="task-notifications__empty">暂无未读通知</p>
        ) : (
          <ul className="task-notifications__list">
            {unread.map((item) => (
              <li key={item.id}>
                <div className="task-notifications__item-copy">
                  {item.sessionId ? (
                    <Link
                      to={`/sessions/${item.sessionId}`}
                      onClick={() => {
                        void markRead(item.id);
                        setOpen(false);
                      }}
                    >
                      {labels[item.kind]}
                    </Link>
                  ) : (
                    <span>{labels[item.kind]}</span>
                  )}
                  {item.sessionId &&
                  sessions.find((session) => session.id === item.sessionId)
                    ?.title ? (
                    <span>
                      {
                        sessions.find(
                          (session) => session.id === item.sessionId,
                        )!.title
                      }
                    </span>
                  ) : null}
                  <details className="task-notifications__details">
                    <summary>通知详情</summary>
                    {item.sessionId ? (
                      <>
                        <span>
                          任务编号：<code>{item.sessionId}</code>
                        </span>
                        <span>
                          回合编号：<code>{item.turnId}</code>
                        </span>
                      </>
                    ) : (
                      <span>
                        提醒内容：
                        {typeof item.payload?.title === "string"
                          ? item.payload.title
                          : "自动提醒"}
                      </span>
                    )}
                    <span>
                      完整时间：
                      {new Date(item.createdAt).toLocaleString("zh-CN")}
                    </span>
                  </details>
                  <time
                    dateTime={item.createdAt}
                    aria-label={new Date(item.createdAt).toLocaleString(
                      "zh-CN",
                    )}
                    title={new Date(item.createdAt).toLocaleString("zh-CN")}
                  >
                    {new Date(item.createdAt).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <IconButton
                  label="标为已读"
                  size="small"
                  className="task-notifications__read"
                  onClick={() => void markRead(item.id)}
                >
                  <Check size={16} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
