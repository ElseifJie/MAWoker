import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SHELL_LAYOUT,
  solveShellLayout,
  type ShellLayoutResult,
} from "./layout.js";
import {
  DEFAULT_SHELL_STATE,
  loadShellState,
  saveShellState,
  type ShellState,
  type ShellStorage,
} from "./shell-state.js";

export interface ShellLayoutController {
  layout: ShellLayoutResult;
  state: ShellState;
  setLeftWidth(width: number): void;
  setRightWidth(width: number): void;
  setLeftCollapsed(collapsed: boolean): void;
  setRightOpen(open: boolean): void;
  toggleLeft(): void;
  toggleRight(): void;
}

function currentViewportWidth(): number {
  if (typeof window === "undefined") return 1440;
  return window.innerWidth || 1440;
}

function browserStorage(): ShellStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function useShellLayout(
  input: {
    storage?: ShellStorage;
    initial?: Partial<ShellState>;
    /** Fixed viewport for tests; production reads window.innerWidth. */
    viewport?: number;
  } = {},
): ShellLayoutController {
  const storage = input.storage ?? browserStorage();
  const [state, setState] = useState<ShellState>(() => ({
    ...(storage ? loadShellState(storage) : DEFAULT_SHELL_STATE),
    ...input.initial,
  }));
  const [viewport, setViewport] = useState(
    () => input.viewport ?? currentViewportWidth(),
  );

  useEffect(() => {
    if (input.viewport !== undefined || typeof window === "undefined") return;
    const onResize = () => setViewport(currentViewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [input.viewport]);

  useEffect(() => {
    if (!storage) return;
    saveShellState(storage, state);
  }, [storage, state]);

  const layout = useMemo(
    () =>
      solveShellLayout({
        viewportWidth: viewport,
        requestedRightWidth: state.rightWidth,
        leftWidth: state.leftWidth,
        rightOpen: state.rightOpen,
        leftCollapsed:
          state.leftCollapsed || viewport < SHELL_LAYOUT.autoCollapseBelow,
      }),
    [
      viewport,
      state.leftCollapsed,
      state.leftWidth,
      state.rightOpen,
      state.rightWidth,
    ],
  );

  const setLeftWidth = useCallback(
    (width: number) =>
      setState((current) => ({ ...current, leftWidth: width })),
    [],
  );
  const setRightWidth = useCallback(
    (width: number) =>
      setState((current) => ({ ...current, rightWidth: width })),
    [],
  );
  const setLeftCollapsed = useCallback(
    (collapsed: boolean) =>
      setState((current) => ({ ...current, leftCollapsed: collapsed })),
    [],
  );
  const setRightOpen = useCallback(
    (open: boolean) => setState((current) => ({ ...current, rightOpen: open })),
    [],
  );
  const toggleLeft = useCallback(
    () =>
      setState((current) => ({
        ...current,
        leftCollapsed: !current.leftCollapsed,
      })),
    [],
  );
  const toggleRight = useCallback(
    () =>
      setState((current) => ({ ...current, rightOpen: !current.rightOpen })),
    [],
  );

  return {
    layout,
    state,
    setLeftWidth,
    setRightWidth,
    setLeftCollapsed,
    setRightOpen,
    toggleLeft,
    toggleRight,
  };
}
