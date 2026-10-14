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
  const waiting = turn.outcome === "waiting";
  const showNotice = syncFailed || failed || waiting;
  const label = syncFailed
    ? "结果同步异常"
    : failed
      ? "本轮执行失败"
      : "等待补充信息";
  return (
    <div className="turn-status">
      {showNotice ? (
        <Alert
          className="turn-status__alert"
          tone={syncFailed || failed ? "warning" : "info"}
        >
          <div className="turn-status__row">
            <div>
              <strong>{label}</strong>
              <p>
                {syncFailed
                  ? "部分成果文件暂不可用。"
                  : failed
                    ? "可补充要求后重试，或新建后续任务。"
                    : "助手需要你补充信息。"}
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
          {turn.errorCode ? (
            <details className="turn-status__details">
              <summary>错误详情</summary>
              <code>{turn.errorCode}</code>
            </details>
          ) : null}
        </Alert>
      ) : null}
      {!hasAnswer && turn.summary ? (
        <section className="turn-status__summary" aria-label="结果摘要">
          <h2>结果摘要</h2>
          <Markdown artifactLinks>{turn.summary}</Markdown>
        </section>
      ) : null}
    </div>
  );
}
