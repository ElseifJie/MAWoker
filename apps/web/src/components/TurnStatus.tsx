import type { SessionTurn } from "../api.js";
import { Alert, Button } from "../ui/index.js";
import { Markdown } from "./Markdown.js";

export function TurnStatus({
  turn,
  hasAnswer,
  recovering,
  disabled,
  onRecover,
}: {
  turn: SessionTurn;
  hasAnswer: boolean;
  recovering: boolean;
  disabled: boolean;
  onRecover: () => void;
}) {
  const syncFailed = turn.artifactState === "failed";
  const failed = turn.outcome === "failed";
  const label = syncFailed
    ? "结果同步异常"
    : turn.outcome === "waiting"
      ? "等待处理"
      : failed
        ? "本轮执行失败"
        : turn.outcome === "confirming"
          ? "正在确认本轮结果"
          : turn.artifactState === "synced" || turn.artifactState === "none"
            ? "本轮完成"
            : "结果正在后台同步";
  return (
    <div className="turn-status">
      <Alert
        className="turn-status__alert"
        tone={syncFailed || failed ? "warning" : "info"}
      >
        <div className="turn-status__row">
          <div>
            <strong>{label}</strong>
            <p>
              {syncFailed
                ? "文件同步尚未完成，可重试同步或继续补充要求。"
                : failed
                  ? "本轮未能完成。可补充要求后重试，或新建后续任务。"
                  : turn.outcome === "waiting"
                    ? "助手正在等待你补充信息。"
                    : turn.outcome === "confirming"
                      ? "后台正在核对本轮结果，页面关闭后仍会继续。"
                      : turn.artifactState === "none"
                        ? "本轮没有生成成果文件。"
                        : turn.artifactState === "synced"
                          ? "本轮结果已同步。"
                          : "后台正在核对本轮结果，页面关闭后仍会继续。"}
            </p>
          </div>
          {syncFailed ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={onRecover}
              loading={recovering}
              disabled={disabled}
            >
              重试同步
            </Button>
          ) : null}
        </div>
        <details className="turn-status__details">
          <summary>状态详情</summary>
          {turn.errorCode ? (
            <p>
              {failed ? "本轮未能完成，错误码：" : "错误码："}
              <code>{turn.errorCode}</code>
            </p>
          ) : null}
          {turn.usageState === "pending" ? <p>用量统计中</p> : null}
          <p>
            回合编号：<code>{turn.id}</code>
          </p>
        </details>
      </Alert>
      {!hasAnswer && turn.summary ? (
        <section className="turn-status__summary" aria-label="结果摘要">
          <h2>结果摘要</h2>
          <Markdown artifactLinks>{turn.summary}</Markdown>
        </section>
      ) : null}
    </div>
  );
}
