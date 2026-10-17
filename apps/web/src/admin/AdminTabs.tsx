import { useId } from "react";
import type { ReactNode } from "react";

export function AdminTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const prefix = useId();
  return (
    <>
      <div className="admin-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${prefix}-${tab.id}`}
            aria-selected={value === tab.id}
            aria-controls={`${prefix}-panel`}
            tabIndex={value === tab.id ? 0 : -1}
            className={`admin-tab${value === tab.id ? " admin-tab--active" : ""}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const target = tabs[next]!;
              onChange(target.id);
              document.getElementById(`${prefix}-${target.id}`)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${prefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${prefix}-${value}`}
        tabIndex={0}
        className="admin-tab-panel"
      >
        {children}
      </div>
    </>
  );
}
