// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "../apps/web/src/api.js";
import { ArtifactViewer } from "../apps/web/src/components/ArtifactViewer.js";
import { Dialog } from "../apps/web/src/ui/index.js";

const htmlFile: ArtifactSummary = {
  id: "file",
  sessionId: "session",
  name: "报告.html",
  mimeType: "text/html",
  sizeBytes: 100,
  generatedAt: "2026-10-13",
  deletionState: "none",
  error: null,
};
const pdfFile = { ...htmlFile, name: "报告.pdf", mimeType: "application/pdf" };

function Preview({
  artifact = htmlFile,
  closeDisabled = false,
  onClose = vi.fn(),
  nested = false,
}: {
  artifact?: ArtifactSummary;
  closeDisabled?: boolean;
  onClose?: () => void;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    onClose();
    setOpen(false);
  };
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        预览材料
      </button>
      <Dialog
        open={open}
        title="文件预览"
        closeLabel="关闭文件预览"
        closeDisabled={closeDisabled}
        onClose={close}
        returnFocusRef={trigger}
      >
        <ArtifactViewer artifact={artifact} onClose={close} hideHeader />
        {nested ? (
          <>
            <button onClick={() => setInnerOpen(true)}>打开确认</button>
            <Dialog
              open={innerOpen}
              title="确认"
              onClose={() => setInnerOpen(false)}
            >
              <button onClick={() => setInnerOpen(false)}>返回预览</button>
            </Dialog>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

async function openPreview(props: Parameters<typeof Preview>[0] = {}) {
  const view = render(<Preview {...props} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "预览材料" }));
  const frame = await waitFor(() => {
    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    return frame!;
  });
  return { ...view, frame };
}

function loadStaticFrame(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument!;
  expect(doc).not.toBeNull();
  // jsdom does not fetch /preview-frame. Supply that shell in the real iframe
  // document; the real viewer's load handler renders/sanitizes the file body.
  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();
  fireEvent.load(frame);
  expect(doc.querySelector("#first")).toHaveTextContent("第一段");
  return doc;
}

const urlDescriptors = new Map(
  ["createObjectURL", "revokeObjectURL"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(URL, name),
  ]),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of urlDescriptors) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

function stubTransport() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          '<p id="first" tabindex="0">第一段</p><p id="last" tabindex="0">最后一段</p>',
          { headers: { "content-type": "text/html" } },
        ),
    ),
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
}

it("allows native Tab into a PDF frame and provides a host return action after it", async () => {
  stubTransport();
  const { frame } = await openPreview({ artifact: pdfFile });
  const copy = screen.getByRole("button", { name: "Copy name" });
  copy.focus();
  expect(fireEvent.keyDown(copy, { key: "Tab" })).toBe(true);
  expect(copy).toHaveFocus(); // Native browsing-context navigation is browser-owned.
  const exit = screen.getByRole("button", { name: "返回预览操作" });
  expect(
    frame.compareDocumentPosition(exit) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.setup().click(exit);
  expect(screen.getByRole("button", { name: "关闭文件预览" })).toHaveFocus();
});

it("handles Escape in a real static frame document and restores the exact host trigger", async () => {
  stubTransport();
  const close = vi.fn();
  const { frame } = await openPreview({ onClose: close });
  const doc = loadStaticFrame(frame);
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  expect(doc.querySelector("script")).toBeNull();
  (doc.querySelector("#first") as HTMLElement).focus();
  expect(fireEvent.keyDown(doc, { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "预览材料" })).toHaveFocus();
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("preserves native internal Tab and moves only frame boundaries back to host controls", async () => {
  stubTransport();
  const { frame } = await openPreview();
  const doc = loadStaticFrame(frame);
  const first = doc.querySelector("#first") as HTMLElement;
  const last = doc.querySelector("#last") as HTMLElement;
  first.focus();
  expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
  expect(first).toHaveFocus();
  last.focus();
  expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
  expect(screen.getByRole("button", { name: "返回预览操作" })).toHaveFocus();
  first.focus();
  expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
  expect(screen.getByRole("button", { name: "Copy name" })).toHaveFocus();
});

it("replaces the frame document listener after navigation/load and removes the old listener", async () => {
  stubTransport();
  const close = vi.fn();
  const { frame } = await openPreview({ onClose: close });
  const oldDoc = loadStaticFrame(frame);
  await act(async () => {
    frame.setAttribute("src", "/preview-frame?next");
  });
  fireEvent.keyDown(oldDoc, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  const nextDoc =
    document.implementation.createHTMLDocument("Reloaded preview");
  const docGetter = vi
    .spyOn(frame, "contentDocument", "get")
    .mockReturnValue(nextDoc);
  fireEvent.load(frame);
  fireEvent.keyDown(oldDoc, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent(
    nextDoc,
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(close).toHaveBeenCalledOnce();
  docGetter.mockRestore();
});

it("detaches removed-frame handlers while leaving the host modal keyboard lifecycle active", async () => {
  stubTransport();
  const close = vi.fn();
  const view = await openPreview({ onClose: close });
  const doc = loadStaticFrame(view.frame);
  view.rerender(
    <Preview
      artifact={{ ...htmlFile, name: "报告.txt", mimeType: "text/plain" }}
      onClose={close}
    />,
  );
  await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("respects disabled close in the frame and uses updated close state without stale handlers", async () => {
  stubTransport();
  const close = vi.fn();
  const view = await openPreview({ onClose: close, closeDisabled: true });
  const doc = loadStaticFrame(view.frame);
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  view.rerender(<Preview onClose={close} closeDisabled={false} />);
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("retains host close/download/return controls when browser-owned PDF content is unreadable", async () => {
  stubTransport();
  const { frame } = await openPreview({ artifact: pdfFile });
  vi.spyOn(frame, "contentDocument", "get").mockImplementation(() => {
    throw new DOMException("Opaque preview", "SecurityError");
  });
  expect(() => fireEvent.load(frame)).not.toThrow();
  const copy = screen.getByRole("button", { name: "Copy name" });
  copy.focus();
  expect(fireEvent.keyDown(copy, { key: "Tab" })).toBe(true);
  expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "/api/v1/artifacts/file/download",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "返回预览操作" }));
  await user.click(screen.getByRole("button", { name: "关闭文件预览" }));
  expect(screen.getByRole("button", { name: "预览材料" })).toHaveFocus();
});

it("does not let a background frame close an inner active dialog or its parent", async () => {
  stubTransport();
  const close = vi.fn();
  const { frame } = await openPreview({ onClose: close, nested: true });
  const doc = loadStaticFrame(frame);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "打开确认" }));
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "确认" })).toBeInTheDocument();
  fireEvent.keyDown(
    within(screen.getByRole("dialog", { name: "确认" })).getByRole("button", {
      name: "返回预览",
    }),
    { key: "Escape" },
  );
  expect(
    screen.queryByRole("dialog", { name: "确认" }),
  ).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(doc, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("keeps native summary reachable and ignores closed, hidden, inert and negative-tabindex content at frame boundaries", async () => {
  stubTransport();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          '<details id="details"><summary id="summary">更多信息</summary><p id="first" tabindex="0">第一段</p><p id="last" tabindex="0">最后一段</p></details><p tabindex="-2">负索引</p><div hidden><p tabindex="0">隐藏内容</p></div><div inert><p tabindex="0">不可交互内容</p>',
          { headers: { "content-type": "text/html" } },
        ),
    ),
  );
  const { frame } = await openPreview();
  const doc = loadStaticFrame(frame);
  const summary = doc.querySelector("#summary") as HTMLElement;
  summary.focus();
  expect(summary).toHaveFocus();
  expect(fireEvent.keyDown(summary, { key: "Tab", shiftKey: true })).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "Copy name" })).toHaveFocus();
  summary.focus();
  expect(fireEvent.keyDown(summary, { key: "Tab" })).toBe(false);
  expect(screen.getByRole("button", { name: "返回预览操作" })).toHaveFocus();
  doc.querySelector("#details")!.setAttribute("open", "");
  summary.focus();
  expect(fireEvent.keyDown(summary, { key: "Tab" })).toBe(true);
  (doc.querySelector("#last") as HTMLElement).focus();
  expect(fireEvent.keyDown(doc, { key: "Tab" })).toBe(false);
  expect(screen.getByRole("button", { name: "返回预览操作" })).toHaveFocus();
});
