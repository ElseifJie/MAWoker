import type { CSSProperties, ReactNode } from "react";
import type { ShellLayoutResult } from "./layout.js";
import "./shell.css";

export interface AppFrameProps {
  layout: ShellLayoutResult;
  left: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
}

export function AppFrame({
  layout,
  left,
  center,
  right,
  leftLabel = "Navigation",
  rightLabel = "Workspace panel",
}: AppFrameProps) {
  const style = {
    "--ui-shell-left-width": `${layout.leftWidth}px`,
    "--ui-shell-right-width": `${layout.rightWidth}px`,
  } as CSSProperties;

  return (
    <div
      className="ui-app-frame"
      data-left-mode={layout.leftMode}
      data-right-mode={layout.rightMode}
      style={style}
    >
      <aside className="ui-app-frame__left" aria-label={leftLabel}>
        {left}
      </aside>
      <main className="ui-app-frame__center">{center}</main>
      {layout.rightMode === "closed" ? null : (
        <aside
          className={
            layout.rightMode === "overlay"
              ? "ui-app-frame__right ui-app-frame__right--overlay"
              : "ui-app-frame__right"
          }
          aria-label={rightLabel}
        >
          {right}
        </aside>
      )}
    </div>
  );
}
