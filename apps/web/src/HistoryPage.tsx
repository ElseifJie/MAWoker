import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { SessionSummary } from "./api.js";
import { taskStatus } from "./task-status.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
} from "./ui/index.js";

export function HistoryPage({
  sessions,
  archivedSessions,
}: {
  sessions: readonly SessionSummary[];
  archivedSessions: readonly SessionSummary[];
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const tasks = useMemo(() => {
    const unique = new Map(
      [...sessions, ...archivedSessions].map((task) => [task.id, task]),
    );
    return [...unique.values()]
      .filter((task) => task.deletionState !== "deleted")
      .filter(
        (task) =>
          scope === "all" ||
          (scope === "archived" ? task.archivedAt : !task.archivedAt),
      )
      .filter((task) =>
        `${task.title} ${task.agent.name}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          Date.parse(b.lastEventAt ?? b.updatedAt) -
          Date.parse(a.lastEventAt ?? a.updatedAt),
      );
  }, [sessions, archivedSessions, query, scope]);
  return (
    <div className="page history-page">
      <PageHeader
        title="历史任务"
        description="查看已有任务、继续补充要求或打开成果。任务详情以已保存的回合记录为准。"
      />
      <div
        className="page-toolbar page-toolbar--two"
        role="search"
        aria-label="历史任务筛选"
      >
        <Field label="搜索历史任务">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="任务名称或助手名称"
          />
        </Field>
        <Field label="任务范围">
          <Select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="all">全部任务</option>
            <option value="active">未归档</option>
            <option value="archived">已归档</option>
          </Select>
        </Field>
      </div>
      {tasks.length === 0 ? (
        <EmptyState
          className="ui-empty-state--page"
          title={
            sessions.length + archivedSessions.length === 0
              ? "还没有历史任务"
              : "没有符合条件的任务"
          }
          action={
            <>
              <Link
                className="ui-button ui-button--primary ui-button--default"
                to="/"
              >
                创建新任务
              </Link>
              {query || scope !== "all" ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setScope("all");
                  }}
                >
                  清除筛选
                </Button>
              ) : null}
            </>
          }
        />
      ) : (
        <ul className="history-list">
          {tasks.map((task) => {
            const status = taskStatus(task);
            return (
              <li key={task.id} className="history-record">
                <Link
                  className="history-record__link"
                  to={`/sessions/${encodeURIComponent(task.id)}`}
                >
                  <div className="history-record__copy">
                    <strong>{task.title}</strong>
                    <span>
                      {task.agent.name} ·{" "}
                      {new Date(
                        task.lastEventAt ?? task.updatedAt,
                      ).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <div className="history-record__status">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {task.archivedAt ? <Badge>已归档</Badge> : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
