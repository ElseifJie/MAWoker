import type { ReactNode } from "react";
import { AppFrame } from "./AppFrame.js";
import { PanelHost } from "./PanelHost.js";
import type { PanelDescriptor } from "./shell-state.js";
import type { ShellLayoutController } from "./useShellLayout.js";

export interface WorkspaceFrameProps {
  shell: ShellLayoutController;
  left: ReactNode;
  /** Center content; `children` is accepted as an alias for routing trees. */
  center?: ReactNode;
  children?: ReactNode;
  panels: readonly PanelDescriptor[];
  activePanelId: string | null;
  onSelectPanel(panelId: string): void;
  onClosePanel(panelId: string): void;
  renderPanel(panel: PanelDescriptor): ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  emptyPanelLabel?: string;
}

/**
 * Composes the Harness frame with the panel host. The frame remains unaware of
 * routing; a page supplies navigation, the conversation surface, and the panel
 * renderer, so the same shell can host artifacts, files, or automations.
 */
export function WorkspaceFrame({
  shell,
  left,
  center,
  children,
  panels,
  activePanelId,
  onSelectPanel,
  onClosePanel,
  renderPanel,
  leftLabel = "Navigation",
  rightLabel = "Workspace panel",
  emptyPanelLabel = "Open a file or result to see it here.",
}: WorkspaceFrameProps) {
  const right =
    shell.layout.rightMode === "closed" ? undefined : (
      <PanelHost
        panels={panels}
        activeId={activePanelId}
        onSelect={onSelectPanel}
        onClose={onClosePanel}
        renderPanel={renderPanel}
        emptyLabel={emptyPanelLabel}
      />
    );

  return (
    <AppFrame
      layout={shell.layout}
      left={left}
      center={center ?? children}
      right={right}
      leftLabel={leftLabel}
      rightLabel={rightLabel}
    />
  );
}
