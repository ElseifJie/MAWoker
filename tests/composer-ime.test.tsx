// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionComposer } from "../apps/web/src/components/SessionComposer.js";
afterEach(cleanup);
it("does not submit while the input method is composing", () => {
  const send = vi.fn(async () => true);
  render(
    <SessionComposer
      disabled={false}
      feedback={null}
      pendingAction={null}
      onSend={send}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "正在输入" } });
  fireEvent.compositionStart(input);
  fireEvent.submit(input.closest("form")!);
  expect(send).not.toHaveBeenCalled();
});
