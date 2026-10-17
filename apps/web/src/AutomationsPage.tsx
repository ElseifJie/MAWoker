import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  ApiClientError,
  apiClient,
  type AutomationRecord,
  type AutomationSchedule,
} from "./api.js";
import {
  Alert,
  Button,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  Spinner,
} from "./ui/index.js";

const WEEKDAYS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
] as const;

type ScheduleType = AutomationSchedule["type"];

function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.type === "once") {
    return `仅一次 · ${new Date(schedule.at).toLocaleString("zh-CN")}`;
  }
  if (schedule.type === "daily") return `每天 ${schedule.time}`;
  return `每周 ${schedule.weekdays
    .map((day) => WEEKDAYS.find((item) => item.value === day)?.label ?? day)
    .join("、")} ${schedule.time}`;
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function buildSchedule(input: {
  type: ScheduleType;
  time: string;
  weekdays: number[];
  onceAt: string;
}): AutomationSchedule | null {
  if (input.type === "once") {
    const at = new Date(input.onceAt);
    if (Number.isNaN(at.getTime())) return null;
    return { type: "once", at: at.toISOString() };
  }
  if (!/^\d{2}:\d{2}$/.test(input.time)) return null;
  if (input.type === "daily") return { type: "daily", time: input.time };
  return input.weekdays.length > 0
    ? { type: "weekly", weekdays: [...input.weekdays].sort(), time: input.time }
    : null;
}

export function AutomationsPage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [items, setItems] = useState<AutomationRecord[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"reminder" | "execute">("reminder");
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState<ScheduleType>("daily");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [onceAt, setOnceAt] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger";
    message: string;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    setItems(null);
    apiClient
      .listAutomations()
      .then((result) => {
        if (active) setItems(result.automations);
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

  async function create(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (pending) return;
    const schedule = buildSchedule({ type, time, weekdays, onceAt });
    if (!schedule) {
      setFeedback({
        tone: "danger",
        message:
          type === "once"
            ? "请选择未来的提醒时间。"
            : type === "weekly"
              ? "请至少选择一个星期。"
              : "请输入 HH:mm 时间。",
      });
      return;
    }
    if (!title.trim()) {
      setFeedback({ tone: "danger", message: "请输入提醒内容。" });
      return;
    }
    if (kind === "execute" && !prompt.trim()) {
      setFeedback({ tone: "danger", message: "请输入要执行的任务内容。" });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const result = await apiClient.createAutomation({
        title: title.trim(),
        ...(kind === "execute"
          ? { kind, prompt: prompt.trim() }
          : { kind: "reminder" }),
        schedule,
        timezone,
      });
      setItems((current) => [result.automation, ...(current ?? [])]);
      setTitle("");
      setPrompt("");
      setFeedback({
        tone: "success",
        message: kind === "execute" ? "定时任务已创建。" : "提醒已创建。",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError
            ? error.message
            : "创建失败，请稍后重试。",
      });
    } finally {
      setPending(false);
    }
  }

  async function toggle(item: AutomationRecord) {
    if (busyId) return;
    setBusyId(item.id);
    setFeedback(null);
    try {
      const result = await apiClient.setAutomationEnabled(
        item.id,
        !item.enabled,
      );
      setItems((current) =>
        (current ?? []).map((candidate) =>
          candidate.id === item.id ? result.automation : candidate,
        ),
      );
      setFeedback({
        tone: "success",
        message: result.automation.enabled ? "提醒已恢复。" : "提醒已暂停。",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({ tone: "danger", message: "操作失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: AutomationRecord) {
    if (busyId) return;
    setBusyId(item.id);
    setFeedback(null);
    try {
      await apiClient.deleteAutomation(item.id);
      setItems((current) =>
        (current ?? []).filter((candidate) => candidate.id !== item.id),
      );
      setFeedback({ tone: "success", message: "提醒已删除。" });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({ tone: "danger", message: "删除失败，请稍后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <PageHeader title="自动化" headingRef={headingRef} />
        <Alert tone="danger">自动化列表加载失败，请重试。</Alert>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="page" aria-busy="true">
        <Spinner label="正在加载自动化" />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="自动化"
        description="按固定时间提醒你。提醒会出现在任务通知中。"
        headingRef={headingRef}
      />

      <section aria-label="新建提醒">
        <h2>新建提醒</h2>
        <form onSubmit={create}>
          <Field label="提醒内容">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：下午三点起来走动"
              maxLength={120}
              required
              disabled={pending}
            />
          </Field>
          <Field label="类型">
            <Select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as "reminder" | "execute")
              }
              disabled={pending}
            >
              <option value="reminder">提醒</option>
              <option value="execute">执行任务</option>
            </Select>
          </Field>
          {kind === "execute" ? (
            <Field label="任务内容" hint="到期后用默认助手创建并执行">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                maxLength={8000}
                required
                disabled={pending}
              />
            </Field>
          ) : null}
          <div className="automation-form-row">
            <Field label="重复">
              <Select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as ScheduleType)
                }
                disabled={pending}
              >
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="once">仅一次</option>
              </Select>
            </Field>
            {type === "once" ? (
              <Field label="提醒时间">
                <Input
                  type="datetime-local"
                  value={onceAt}
                  onChange={(event) => setOnceAt(event.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            ) : (
              <Field label="时间">
                <Input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            )}
            <Field label="时区">
              <Input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
                disabled={pending}
              />
            </Field>
          </div>
          {type === "weekly" ? (
            <fieldset className="automation-weekdays">
              <legend>星期</legend>
              {WEEKDAYS.map((day) => (
                <label key={day.value}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(day.value)}
                    onChange={(event) =>
                      setWeekdays((current) =>
                        event.target.checked
                          ? [...current, day.value]
                          : current.filter((value) => value !== day.value),
                      )
                    }
                    disabled={pending}
                  />
                  {day.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          <Button type="submit" loading={pending}>
            <Plus size={16} aria-hidden="true" />
            {kind === "execute" ? "创建任务" : "创建提醒"}
          </Button>
        </form>
        {feedback ? (
          <Alert tone={feedback.tone}>{feedback.message}</Alert>
        ) : null}
      </section>

      <section aria-label="提醒列表">
        <h2>提醒列表</h2>
        {items.length === 0 ? (
          <p>还没有提醒。</p>
        ) : (
          <DataTable caption="提醒列表">
            <thead>
              <tr>
                <th scope="col">内容</th>
                <th scope="col">类型</th>
                <th scope="col">规则</th>
                <th scope="col">下次提醒</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.title}</td>
                  <td>{item.kind === "execute" ? "执行任务" : "提醒"}</td>
                  <td>{scheduleLabel(item.schedule)}</td>
                  <td>
                    {new Date(item.nextRunAt).toLocaleString("zh-CN")}
                    <span>（{item.timezone}）</span>
                  </td>
                  <td>{item.enabled ? "已启用" : "已暂停"}</td>
                  <td>
                    <div className="automation-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        loading={busyId === item.id}
                        onClick={() => void toggle(item)}
                      >
                        {item.enabled ? "暂停" : "恢复"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void remove(item)}
                        disabled={busyId !== null}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        删除
                      </Button>
                    </div>
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
