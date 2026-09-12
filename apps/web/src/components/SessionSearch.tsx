import { ArrowDown, ArrowUp, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { SessionSummary } from "../api.js";
import { useModalDialog } from "../useModalDialog.js";
import { matchesQuery } from "./SessionList.js";

export interface SessionSearchProps {
  open: boolean;
  sessions: readonly SessionSummary[];
  archivedSessions: readonly SessionSummary[];
  onClose: () => void;
  onSelect: (session: SessionSummary) => void;
}

/** Today shows a clock time like the row's "09:52"; older work shows a date. */
function formatStamp(session: SessionSummary, now: Date): string {
  const stamp = session.lastEventAt ?? session.updatedAt ?? session.createdAt;
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return "";
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();
  return sameDay
    ? parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : parsed.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The task search surface, opened from the sidebar's Search entry. It replaces
 * the old inline sidebar field: a single overlay searches every loaded task
 * (active and archived) and opens one with the keyboard or a click.
 */
export function SessionSearch({
  open,
  sessions,
  archivedSessions,
  onClose,
  onSelect,
}: SessionSearchProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const dialogRef = useModalDialog({
    open,
    onClose,
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  const all = useMemo(
    () => [...sessions, ...archivedSessions],
    [sessions, archivedSessions],
  );
  const matches = useMemo(
    () => all.filter((session) => matchesQuery(session, query)),
    [all, query],
  );
  const active =
    matches.length === 0
      ? undefined
      : matches[Math.min(activeIndex, matches.length - 1)];
  const now = new Date();

  function commit() {
    if (!active) return;
    onClose();
    onSelect(active);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, matches.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  }

  if (!open) return null;

  return (
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="session-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search tasks"
        tabIndex={-1}
      >
        <div className="session-search__field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            className="ui-input session-search__input"
            type="text"
            role="combobox"
            aria-label="Search tasks"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-activedescendant={
              active ? `${listId}-option-${active.id}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search tasks by title or agent…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="session-search__meta">
          <span className="session-search__meta-label">All tasks</span>
          <span className="session-search__meta-hints">
            <kbd className="session-search__key" aria-hidden="true">
              <ArrowUp size={13} />
            </kbd>
            <kbd className="session-search__key" aria-hidden="true">
              <ArrowDown size={13} />
            </kbd>
            <span>Select</span>
            <kbd className="session-search__key session-search__key--wide">
              Enter
            </kbd>
            <span>Open</span>
            <span className="session-search__count">{matches.length}</span>
          </span>
        </div>

        {matches.length === 0 ? (
          <p className="session-search__empty">
            {all.length === 0 ? "No tasks yet." : `No tasks match “${query}”.`}
          </p>
        ) : (
          <ul
            id={listId}
            className="session-search__list"
            role="listbox"
            aria-label="Tasks"
          >
            {matches.map((session) => {
              const selected = session.id === active?.id;
              return (
                <li
                  key={session.id}
                  id={`${listId}-option-${session.id}`}
                  role="option"
                  aria-selected={selected}
                  className={`session-search__option${selected ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(matches.indexOf(session))}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onClose();
                    onSelect(session);
                  }}
                >
                  <span className="session-search__option-title">
                    {session.title}
                  </span>
                  <span className="session-search__option-meta">
                    {session.agent.name}
                    {session.archivedAt ? " · Archived" : ""}
                  </span>
                  <span className="session-search__option-time">
                    {formatStamp(session, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
