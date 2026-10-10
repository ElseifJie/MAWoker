import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type MemoryEntry,
  type MemoryList,
  type MemoryState,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Textarea,
} from "./ui/index.js";

function ongoing(state: MemoryState | null) {
  return !!state?.run && !["completed", "failed"].includes(state.run.stage);
}

function memoryError(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "MEMORY_BUSY":
        return "Memory is busy. Wait for the current operation.";
      case "MEMORY_CONFLICT":
        return "Memory content changed. Reload before editing.";
      case "MEMORY_INVALID":
        return "Check the path and content. Credentials cannot be stored in memory.";
      case "MEMORY_CAPACITY":
        return "Memory capacity exceeded. Use smaller entries or compress your memory.";
      case "MEMORY_REPAIR_REQUIRED":
        return "Memory requires repair. Contact support.";
    }
  }
  return "Memory could not be loaded or updated. Retry when your connection is available.";
}

export function MemoryPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [list, setList] = useState<MemoryList | null>(null);
  const [state, setState] = useState<MemoryState | null>(null);
  const [editor, setEditor] = useState<MemoryEntry | null>(null);
  const [existing, setExisting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;
  const accepted = useRef<"Save" | "Delete" | "Dream" | "Compress" | null>(
    null,
  );
  const alive = useRef(true);

  const handleError = useCallback((error: unknown) => {
    if (!alive.current) return;
    if (error instanceof ApiClientError && error.isAuthRequired)
      authRef.current();
    else setError(memoryError(error));
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setError(null);
    apiClient
      .listMemory()
      .then((result) => {
        if (!active) return;
        setList(result);
        setState(result.state);
      })
      .catch(async (error) => {
        if (!active) return;
        handleError(error);
        // Listing is unavailable while the worker drains/applies; status still works.
        if (error instanceof ApiClientError && error.code === "MEMORY_BUSY") {
          try {
            const next = await apiClient.getMemoryStatus();
            if (active) setState(next);
          } catch (statusError) {
            if (active) handleError(statusError);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [handleError, reload]);

  const running = ongoing(state);
  useEffect(() => {
    if (!running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await apiClient.getMemoryStatus();
        if (!active) return;
        if (!ongoing(next)) {
          const result = await apiClient.listMemory();
          if (!active) return;
          setList(result);
          setState(result.state);
          setError(null);
          if (next.run?.stage === "failed") {
            setError(next.run.error ?? "Memory operation failed.");
            setFeedback(null);
          } else if (accepted.current) {
            const action = accepted.current;
            setFeedback(
              action === "Save"
                ? "Memory saved."
                : action === "Delete"
                  ? "Memory deleted."
                  : `${action} completed.`,
            );
            if (action === "Save") {
              setEditor(
                (current) =>
                  result.entries.find(
                    (entry) => entry.path === current?.path,
                  ) ?? current,
              );
              setExisting(true);
            }
            if (action === "Delete") {
              setEditor(null);
              setExisting(false);
            }
          }
          accepted.current = null;
          return;
        }
        setState(next);
      } catch (error) {
        if (!active) return;
        handleError(error);
        if (error instanceof ApiClientError && error.isAuthRequired) return;
      }
      if (active)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    }
    timer = setTimeout(() => {
      void poll();
    }, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [running, handleError]);

  async function mutate(
    operation: () => Promise<MemoryState>,
    action?: "Save" | "Delete" | "Dream" | "Compress",
  ) {
    if (pending || running || state?.status !== "active") return;
    setPending(true);
    setError(null);
    setFeedback(null);
    try {
      const next = await operation();
      if (!alive.current) return;
      if (action) {
        accepted.current = action;
        setFeedback(
          `${action} queued; ${action === "Save" ? "not saved" : action === "Delete" ? "not deleted" : "not completed"} yet.`,
        );
      }
      setState(next);
    } catch (error) {
      handleError(error);
    } finally {
      if (alive.current) setPending(false);
    }
  }

  const blocked = pending || running || state?.status !== "active";
  const usage = list?.capacity;
  return (
    <div className="page page--wide">
      <PageHeader
        title="Context"
        description="Review and edit the personal memory your Agents use."
        actions={
          <Button
            disabled={blocked}
            onClick={() => {
              setEditor({ path: "", content: "" });
              setExisting(false);
              setFeedback(null);
            }}
          >
            New entry
          </Button>
        }
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {feedback ? (
        <Alert tone={running ? "info" : "success"}>{feedback}</Alert>
      ) : null}
      {state ? (
        <section className="settings-section" aria-label="Memory status">
          <Badge tone={running ? "warning" : "neutral"}>{state.status}</Badge>
          {state.run ? (
            <p>
              Operation: {state.run.kind} / {state.run.stage}
            </p>
          ) : null}
          {state.run?.error ? (
            <Alert tone="danger">{state.run.error}</Alert>
          ) : null}
          {state.run?.before && state.run.after ? (
            <p>
              Before: {state.run.before.count} entries, {state.run.before.bytes}{" "}
              bytes. After: {state.run.after.count} entries,{" "}
              {state.run.after.bytes} bytes.
            </p>
          ) : null}
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload
          </Button>
        </section>
      ) : null}
      {usage ? (
        <section className="settings-section" aria-label="Memory capacity">
          <h2>Capacity</h2>
          <p>
            {usage.count} / 2,000 entries ({(usage.countRatio * 100).toFixed(1)}
            %)
          </p>
          <p>
            {usage.bytes} bytes total; largest entry {usage.maxEntryBytes} /
            102,400 bytes ({((usage.maxEntryBytes / 102400) * 100).toFixed(1)}%)
          </p>
          <p>
            Byte budget:{" "}
            {usage.byteRatio === null
              ? "Not configured"
              : `${(usage.byteRatio * 100).toFixed(1)}%`}
            . Level: {usage.level}. Target: {usage.targetCount} entries.
          </p>
        </section>
      ) : null}
      <section className="settings-section" aria-label="Memory maintenance">
        <Button
          disabled={blocked}
          onClick={() => void mutate(apiClient.dreamMemory, "Dream")}
        >
          Dream
        </Button>
        <Button
          variant="secondary"
          disabled={blocked}
          onClick={() => void mutate(apiClient.compressMemory, "Compress")}
        >
          Compress
        </Button>
        <Field label="Automatic Dream">
          <Input
            type="checkbox"
            checked={state?.autoDream ?? false}
            disabled={blocked}
            onChange={(event) =>
              void mutate(() =>
                apiClient.setMemorySettings(event.target.checked),
              )
            }
          />
        </Field>
      </section>
      {!list ? (
        error ? (
          <EmptyState
            title="Memory unavailable"
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                Retry
              </Button>
            }
          />
        ) : (
          <Spinner label="Loading memory" />
        )
      ) : (
        <section className="settings-section" aria-label="Memory directory">
          <h2>Directory</h2>
          {list.entries.length ? (
            <ul aria-label="Memory entries">
              {list.entries.map((entry) => (
                <li key={entry.path}>
                  <Button
                    variant="text"
                    disabled={pending || running}
                    onClick={() => {
                      setEditor(entry);
                      setExisting(true);
                      setFeedback(null);
                    }}
                  >
                    {entry.path}
                  </Button>
                  {state?.protectedPaths.includes(entry.path) ? (
                    <Badge>Protected</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No memory entries yet." />
          )}
        </section>
      )}
      {editor ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(() => apiClient.writeMemory(editor), "Save");
          }}
        >
          <Field
            label="Path"
            hint="Use /memories/, /resources/, or /sessions/."
          >
            <Input
              value={editor.path}
              required
              maxLength={512}
              disabled={blocked || existing}
              onChange={(event) =>
                setEditor({ ...editor, path: event.target.value })
              }
            />
          </Field>
          <Field label="Content">
            <Textarea
              rows={16}
              value={editor.content}
              disabled={blocked}
              onChange={(event) =>
                setEditor({ ...editor, content: event.target.value })
              }
            />
          </Field>
          <Field label="Protected">
            <Input
              type="checkbox"
              checked={state?.protectedPaths.includes(editor.path) ?? false}
              disabled={blocked || !existing}
              onChange={(event) =>
                void mutate(() =>
                  apiClient.protectMemory(editor.path, event.target.checked),
                )
              }
            />
          </Field>
          <Button
            type="submit"
            disabled={blocked || !editor.path}
            loading={pending}
          >
            Save
          </Button>
          {existing ? (
            <Button
              variant="danger"
              disabled={blocked}
              onClick={() =>
                void mutate(() => apiClient.removeMemory(editor.path), "Delete")
              }
            >
              Delete
            </Button>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
