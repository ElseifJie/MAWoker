import {
  FileText,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { type ChangeEvent, type SyntheticEvent, useRef, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type SessionSummary,
  type UploadedInput,
  type UsageSummary,
} from "../api.js";
import {
  Alert,
  Button,
  IconButton,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "../ui/index.js";

export interface TaskTemplate {
  id: string;
  label: string;
  outcome: string;
  prompt: string;
}

/**
 * Result-oriented starting points. Each one only prefills the composer; nothing
 * here promises a capability the Agent does not have.
 */
export const taskTemplates: TaskTemplate[] = [
  {
    id: "summarize",
    label: "Summarize source material",
    outcome: "A one-page brief with the decisions and open questions.",
    prompt:
      "Read the attached material and produce a one-page brief: what it says, the decisions it implies, and the open questions. Cite the section each point comes from.",
  },
  {
    id: "compare",
    label: "Compare options and recommend",
    outcome: "A comparison table plus a recommendation with its trade-offs.",
    prompt:
      "Compare the options below on cost, effort and risk, present the comparison as a table, then recommend one and state what you would give up by choosing it.",
  },
  {
    id: "structure",
    label: "Turn notes into a document",
    outcome: "A structured document with clear headings, fit to hand on.",
    prompt:
      "Turn the attached notes into a structured document with clear headings, a short summary at the top, and consistent terminology. Keep every factual claim from the notes.",
  },
];

type UploadState =
  | { key: number; file: File; status: "uploading" }
  | { key: number; file: File; status: "ready"; upload: UploadedInput }
  | { key: number; file: File; status: "failed" };

function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAuthRequired;
}

export function quotaBlocker(usage: UsageSummary): string | null {
  if (usage.exhausted.monthlyTokens) {
    return "Monthly token quota is exhausted. Existing work remains available.";
  }
  if (usage.exhausted.dailySessions) {
    return "Daily Session quota is exhausted. Try again tomorrow.";
  }
  if (usage.exhausted.concurrentSessions) {
    return "Concurrent Session quota is exhausted. Wait for a running task to finish.";
  }
  return null;
}

export interface SessionIntroProps {
  agents: AgentList;
  usage: UsageSummary;
  onAuthRequired: () => void;
  onSessionCreated: (session: SessionSummary, content: string) => void;
}

export function SessionIntro({
  agents,
  usage,
  onAuthRequired,
  onSessionCreated,
}: SessionIntroProps) {
  const nextUploadKey = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(
    agents.selection?.agentId ?? "",
  );
  const [message, setMessage] = useState("");
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [submissionStatus, setSubmissionStatus] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const agentBlocker = agents.blocker
    ? "No default Agent is available. Contact an administrator to continue."
    : null;
  const blocker = agentBlocker ?? quotaBlocker(usage);
  const hasUnreadyUploads = uploads.some((upload) => upload.status !== "ready");

  async function uploadFile(item: UploadState) {
    setUploads((current) =>
      current.map((upload) =>
        upload.key === item.key
          ? { key: item.key, file: item.file, status: "uploading" }
          : upload,
      ),
    );
    try {
      const uploaded = await apiClient.upload(item.file);
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? {
                key: item.key,
                file: item.file,
                status: "ready",
                upload: uploaded,
              }
            : upload,
        ),
      );
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? { key: item.key, file: item.file, status: "failed" }
            : upload,
        ),
      );
    }
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const remaining = Math.max(0, 20 - uploads.length);
    const items: UploadState[] = files.slice(0, remaining).map((file) => ({
      key: nextUploadKey.current++,
      file,
      status: "uploading",
    }));
    if (items.length > 0) {
      setUploads((current) => [...current, ...items]);
      for (const item of items) void uploadFile(item);
    }
    event.target.value = "";
  }

  function applyTemplate(template: TaskTemplate) {
    setMessage(template.prompt);
    messageInput.current?.focus();
  }

  async function submitTask(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const content = message.trim();
    if (
      submitting ||
      blocker ||
      hasUnreadyUploads ||
      !selectedAgentId ||
      !content
    ) {
      return;
    }

    setSubmitting(true);
    setSubmissionError(null);
    setSubmissionStatus("Creating Session…");
    try {
      const session = await apiClient.createSession({
        agentId: selectedAgentId,
        uploadIds: uploads.flatMap((upload) =>
          upload.status === "ready" ? [upload.upload.id] : [],
        ),
        title: content.slice(0, 120),
      });
      onSessionCreated(session, content);
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      const quotaError =
        error instanceof ApiClientError &&
        (error.code === "QUOTA_EXCEEDED" ||
          error.code === "CONCURRENCY_LIMITED");
      setSubmissionError(
        quotaError
          ? "Task execution quota is exhausted. Existing work remains available."
          : "The task could not be started. Try again.",
      );
      setSubmissionStatus("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page session-intro">
      <PageHeader title="New task" />

      <section className="session-intro__templates" aria-label="Task templates">
        {taskTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            className="template-card"
            title={template.outcome}
            onClick={() => applyTemplate(template)}
            disabled={submitting || Boolean(blocker)}
          >
            <Sparkles size={16} aria-hidden="true" />
            <span className="template-card__label">{template.label}</span>
          </button>
        ))}
      </section>

      <form className="composer" onSubmit={submitTask}>
        <label className="sr-only" htmlFor="task-message">
          Task message
        </label>
        <Textarea
          id="task-message"
          ref={messageInput}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Describe what you need done…"
          rows={6}
          disabled={submitting}
        />

        {uploads.length > 0 ? (
          <ul className="upload-list" aria-label="Attachments">
            {uploads.map((upload) => (
              <li key={upload.key}>
                <FileText size={16} aria-hidden="true" />
                <span className="upload-name">{upload.file.name}</span>
                {upload.status === "uploading" ? (
                  <span className="upload-state">
                    <Spinner size={14} aria-hidden="true" />
                    Uploading
                  </span>
                ) : null}
                {upload.status === "ready" ? (
                  <span className="upload-state ready">Ready</span>
                ) : null}
                {upload.status === "failed" ? (
                  <>
                    <span className="upload-error">
                      {upload.file.name} could not be uploaded.
                    </span>
                    <Button
                      variant="text"
                      size="compact"
                      onClick={() => void uploadFile(upload)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Retry upload
                    </Button>
                  </>
                ) : null}
                <IconButton
                  className="small-control"
                  label={`Remove ${upload.file.name}`}
                  size="small"
                  onClick={() =>
                    setUploads((current) =>
                      current.filter((item) => item.key !== upload.key),
                    )
                  }
                  disabled={submitting}
                >
                  <X size={15} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="composer-footer">
          <div className="composer-feedback" aria-live="polite">
            {blocker ? (
              <Alert tone="danger">{blocker}</Alert>
            ) : submissionError ? (
              <Alert tone="danger">{submissionError}</Alert>
            ) : submissionStatus ? (
              <span>
                <Spinner size={15} aria-hidden="true" />
                {submissionStatus}
              </span>
            ) : null}
          </div>
          <div className="composer-controls">
            <IconButton
              className="attachment-button"
              label="Attach files"
              size="small"
              onClick={() => fileInput.current?.click()}
              disabled={submitting || uploads.length >= 20}
            >
              <Paperclip size={16} aria-hidden="true" />
            </IconButton>
            <input
              ref={fileInput}
              className="file-input"
              type="file"
              multiple
              aria-label="File picker"
              onChange={addFiles}
              disabled={submitting || uploads.length >= 20}
              tabIndex={-1}
            />
            <Select
              className="agent-picker"
              aria-label="Agent"
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
              disabled={submitting || agents.agents.length === 0}
            >
              {agents.agents.length === 0 ? (
                <option value="">No Agent available</option>
              ) : null}
              {agents.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.kind === "platform" ? " · Platform" : ""}
                </option>
              ))}
            </Select>
            <IconButton
              type="submit"
              className="send-button"
              label="Send task"
              size="small"
              disabled={
                submitting ||
                Boolean(blocker) ||
                hasUnreadyUploads ||
                !selectedAgentId ||
                message.trim().length === 0
              }
            >
              <Send size={15} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </form>
    </div>
  );
}
