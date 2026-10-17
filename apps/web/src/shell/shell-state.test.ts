import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_STATE,
  loadShellState,
  sanitizeShellState,
  saveShellState,
  SHELL_STATE_KEY,
  type ShellState,
} from "./shell-state.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const state: ShellState = {
  leftWidth: 320,
  rightWidth: 420,
  leftCollapsed: false,
  rightOpen: true,
  panels: [
    { id: "panel-1", type: "file", title: "方案.md", resourceRef: "file-1" },
    { id: "panel-2", type: "artifact", title: "报表.xlsx" },
  ],
  activePanelId: "panel-2",
};

describe("shell state persistence", () => {
  it("round-trips layout and panel state", () => {
    const storage = memoryStorage();
    saveShellState(storage, state);

    expect(loadShellState(storage)).toEqual(state);
    expect(storage.values.has(SHELL_STATE_KEY)).toBe(true);
  });

  it("falls back to defaults for missing or invalid storage", () => {
    const storage = memoryStorage();
    expect(loadShellState(storage)).toEqual(DEFAULT_SHELL_STATE);

    storage.setItem(SHELL_STATE_KEY, "{not-json");
    expect(loadShellState(storage)).toEqual(DEFAULT_SHELL_STATE);
  });

  it("clamps widths and drops invalid panels and active ids", () => {
    const sanitized = sanitizeShellState({
      leftWidth: 999,
      rightWidth: 10,
      leftCollapsed: "yes",
      rightOpen: 1,
      panels: [
        { id: "panel-1", type: "file", title: "方案.md" },
        { id: 2, type: "file", title: "bad" },
        null,
      ],
      activePanelId: "missing",
    });

    expect(sanitized).toEqual({
      leftWidth: 420,
      rightWidth: 300,
      leftCollapsed: false,
      rightOpen: false,
      panels: [{ id: "panel-1", type: "file", title: "方案.md" }],
      activePanelId: "panel-1",
    });
  });

  it("caps the restored panel set", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `panel-${index}`,
      type: "file",
      title: `File ${index}`,
    }));
    expect(sanitizeShellState({ panels: many }).panels).toHaveLength(12);
  });
});
