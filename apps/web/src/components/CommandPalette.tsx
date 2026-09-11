import { Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Dialog } from "../ui/index.js";

export interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly Command[];
  onClose: () => void;
}

/**
 * Keyboard-first navigation. The dialog primitive owns focus trapping and
 * Escape; this adds filtering and arrow-key selection over a listbox, so every
 * destination reachable by mouse is also reachable without one.
 */
export function CommandPalette({
  open,
  commands,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...commands];
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        command.group.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  const active =
    matches.length === 0
      ? undefined
      : matches[Math.min(activeIndex, matches.length - 1)];

  function commit() {
    if (!active) return;
    onClose();
    active.run();
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

  return (
    <Dialog
      open={open}
      title="Command palette"
      onClose={onClose}
      initialFocusRef={inputRef}
    >
      <div className="command-palette">
        <div className="command-palette__field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            data-dialog-initial-focus
            className="ui-input command-palette__input"
            type="text"
            role="combobox"
            aria-label="Search commands"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-activedescendant={
              active ? `${listId}-option-${active.id}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            placeholder="Search tasks, pages and themes…"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {matches.length === 0 ? (
          <p className="command-palette__empty">No matching commands.</p>
        ) : (
          <ul
            id={listId}
            className="command-palette__list"
            role="listbox"
            aria-label="Commands"
          >
            {matches.map((command) => {
              const selected = command.id === active?.id;
              return (
                <li
                  key={command.id}
                  id={`${listId}-option-${command.id}`}
                  role="option"
                  aria-selected={selected}
                  className={`command-palette__option${selected ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(matches.indexOf(command))}
                  onClick={() => {
                    onClose();
                    command.run();
                  }}
                >
                  <span className="command-palette__label">
                    {command.label}
                  </span>
                  <span className="command-palette__group">
                    {command.group}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
