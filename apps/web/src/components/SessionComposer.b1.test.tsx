// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionComposer } from "./SessionComposer.js";
import { readDraft } from "../submission-drafts.js";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
describe("B1 follow-up composer", () => {
  it("does not send while an IME composition is active, and clears only after acceptance", async () => {
    const send = vi.fn().mockResolvedValue(true);
    render(
      <SessionComposer
        draftKey="u:task"
        disabled={false}
        pendingAction={null}
        feedback={null}
        onSend={send}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "补充要求" } });
    fireEvent.compositionStart(input);
    fireEvent.submit(input.closest("form")!);
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("补充要求", expect.any(String)),
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });
  it("restores a failed draft with its id, keeps tasks isolated and exposes the material fallback", async () => {
    const send = vi.fn().mockResolvedValue(false);
    const attach = vi.fn();
    const mount = (draftKey: string) =>
      render(
        <SessionComposer
          draftKey={draftKey}
          disabled={false}
          pendingAction={null}
          feedback={null}
          onSend={send}
          onAttach={attach}
        />,
      );
    const first = mount("u:first");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this draft" },
    });
    const saved = readDraft("u:first");
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    first.unmount();
    const second = mount("u:second");
    expect(screen.getByRole("textbox")).toHaveValue("");
    second.unmount();
    mount("u:first");
    expect(screen.getByRole("textbox")).toHaveValue(saved.content);
    fireEvent.click(
      screen.getByRole("button", { name: "添加材料，创建后续任务" }),
    );
    expect(attach).toHaveBeenCalledOnce();
    expect(readDraft("u:first")).toEqual(saved);
  });
});

function mountComposer(
  onSend: (content: string, submissionId: string) => Promise<boolean>,
) {
  return render(
    <SessionComposer
      draftKey="u:delayed"
      disabled={false}
      pendingAction={null}
      feedback={null}
      onSend={onSend}
    />,
  );
}

it("preserves a newer draft and UUID across remounts when an old submission is acknowledged late", async () => {
  let accept!: (accepted: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    accept = resolve;
  });
  const oldSend = vi.fn(() => pending);
  const first = mountComposer(oldSend);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "first submitted draft" },
  });
  const submitted = readDraft("u:delayed");
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(oldSend).toHaveBeenCalledWith(
    submitted.content,
    submitted.submissionId,
  );
  first.unmount();
  const newSend = vi.fn().mockResolvedValue(false);
  const second = mountComposer(newSend);
  expect(screen.getByRole("textbox")).toHaveValue(submitted.content);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "new unsent text" },
  });
  const newer = readDraft("u:delayed");
  expect(newer.submissionId).not.toBe(submitted.submissionId);
  await act(async () => {
    accept(true);
    await pending;
  });
  expect(readDraft("u:delayed")).toEqual(newer);
  expect(screen.getByRole("textbox")).toHaveValue(newer.content);
  second.unmount();
  mountComposer(newSend);
  expect(screen.getByRole("textbox")).toHaveValue(newer.content);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() =>
    expect(newSend).toHaveBeenCalledWith(newer.content, newer.submissionId),
  );
  expect(readDraft("u:delayed")).toEqual(newer);
});

it("does not replace current local content or UUID after acknowledging an earlier edited draft", async () => {
  let accept!: (accepted: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    accept = resolve;
  });
  const send = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(false);
  mountComposer(send);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "submitted text" },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "current edited text" },
  });
  const newer = readDraft("u:delayed");
  await act(async () => {
    accept(true);
    await pending;
  });
  expect(screen.getByRole("textbox")).toHaveValue(newer.content);
  expect(readDraft("u:delayed")).toEqual(newer);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() =>
    expect(send).toHaveBeenLastCalledWith(newer.content, newer.submissionId),
  );
});

it("still clears an exact accepted stored draft after its composer unmounts", async () => {
  let accept!: (accepted: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    accept = resolve;
  });
  const first = mountComposer(() => pending);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "accepted exact draft" },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  first.unmount();
  await act(async () => {
    accept(true);
    await pending;
  });
  expect(readDraft("u:delayed").content).toBe("");
  mountComposer(vi.fn().mockResolvedValue(false));
  expect(screen.getByRole("textbox")).toHaveValue("");
});
