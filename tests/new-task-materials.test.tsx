// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  ApiClientError,
  type ArtifactSummary,
} from "../apps/web/src/api.js";
import {
  SessionIntro,
  taskTemplates,
} from "../apps/web/src/components/SessionIntro.js";
import { readDraft } from "../apps/web/src/submission-drafts.js";

const files: ArtifactSummary[] = [
  {
    id: "shared-prefix-first",
    sessionId: "source-one",
    name: "报告.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    generatedAt: "2026-10-13T00:00:00Z",
    deletionState: "none",
    error: null,
  },
  {
    id: "shared-prefix-second",
    sessionId: "source-two",
    name: "报告.txt",
    mimeType: "text/plain",
    sizeBytes: 24,
    generatedAt: "2026-10-13T00:00:00Z",
    deletionState: "none",
    error: null,
  },
];

function page(
  draftKey = "new-task-materials",
  route = "/",
  onSessionCreated = vi.fn(),
) {
  return (
    <MemoryRouter initialEntries={[route]}>
      <SessionIntro
        draftKey={draftKey}
        agents={
          {
            agents: [{ id: "agent", name: "助手", kind: "platform" }],
            selection: { agentId: "agent" },
            blocker: null,
          } as never
        }
        usage={
          {
            exhausted: {
              monthlyTokens: false,
              dailySessions: false,
              concurrentSessions: false,
            },
          } as never
        }
        onAuthRequired={vi.fn()}
        onSessionCreated={onSessionCreated}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("new task composer and materials", () => {
  it.each(["MEMORY_BUSY", "MEMORY_REPAIR_REQUIRED"])(
    "explains %s and lets the user disable memory without losing the task or silently resubmitting",
    async (code) => {
      vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
      const accepted = { id: "without-memory" };
      const created = vi.fn();
      const create = vi
        .spyOn(apiClient, "createSession")
        .mockRejectedValueOnce(
          new ApiClientError(
            409,
            code as never,
            "Memory unavailable",
            "request",
            true,
          ),
        )
        .mockResolvedValue(accepted as never);
      render(page("memory-unavailable", "/", created));
      fireEvent.change(screen.getByLabelText("任务要求"), {
        target: { value: "保留这份任务要求" },
      });
      fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
      expect(
        await screen.findByText(
          "个人记忆暂不可用，请修复记忆或关闭个人记忆后重试。",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "修复个人记忆" }),
      ).toHaveAttribute("href", "/context/store");
      expect(
        screen.getByRole("checkbox", { name: "使用个人记忆" }),
      ).toBeChecked();
      const attempted = create.mock.calls[0]![0];
      expect(readDraft("memory-unavailable").attempt).toEqual(attempted);
      fireEvent.click(screen.getByRole("button", { name: "关闭个人记忆" }));
      expect(
        screen.getByRole("checkbox", { name: "使用个人记忆" }),
      ).not.toBeChecked();
      expect(screen.getByLabelText("任务要求")).toHaveValue(attempted.content);
      expect(create).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
      await waitFor(() =>
        expect(created).toHaveBeenCalledWith(accepted, attempted.content),
      );
      const retried = create.mock.calls[1]![0];
      expect(retried).toEqual({
        ...attempted,
        temporary: true,
        submissionId: expect.any(String),
      });
      expect(retried.submissionId).not.toBe(attempted.submissionId);
    },
  );

  it("labels the assistant selector without repeating its selected name as a hint", () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    render(page());
    const selector = screen.getByRole("combobox", { name: "助手" });
    expect(selector).toHaveValue("agent");
    expect(selector).not.toHaveAccessibleDescription("助手");
    expect(
      within(selector).getByRole("option", { selected: true }),
    ).toHaveTextContent("助手");
  });

  it("accepts a text-only task after StrictMode replay and releases submitting", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const accepted = { id: "strict-text-session" };
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockResolvedValue(accepted as never);
    const onCreated = vi.fn();
    render(
      <React.StrictMode>
        {page("strict-text", "/", onCreated)}
      </React.StrictMode>,
    );
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "StrictMode 文字任务" },
    });
    const draftId = readDraft("strict-text").submissionId;
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(accepted, "StrictMode 文字任务"),
    );
    expect(create).toHaveBeenCalledExactlyOnceWith({
      submissionId: draftId,
      content: "StrictMode 文字任务",
      agentId: "agent",
      uploadIds: [],
      title: "StrictMode 文字任务",
      temporary: false,
    });
    expect(screen.getByLabelText("任务要求")).toBeEnabled();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
    expect(readDraft("strict-text").content).toBe("");
  });

  it("reuses the selected original file with a live signal after StrictMode replay", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const reuse = vi
      .spyOn(apiClient, "reuseArtifact")
      .mockResolvedValue({ id: "strict-prepared-input" } as never);
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockResolvedValue({ id: "strict-file-session" } as never);
    const onCreated = vi.fn();
    render(
      <React.StrictMode>
        {page("strict-file", `/?artifactId=${files[1]!.id}`, onCreated)}
      </React.StrictMode>,
    );
    await screen.findByRole("button", {
      name: `移除材料 报告.txt · ${files[1]!.id}`,
    });
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "基于第二份报告开始" },
    });
    const draftId = readDraft("strict-file").submissionId;
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(reuse).toHaveBeenCalledTimes(1));
    expect(reuse.mock.calls[0]![0]).toBe("shared-prefix-second");
    expect(reuse.mock.calls[0]![1]?.aborted).toBe(false);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledExactlyOnceWith({
      submissionId: draftId,
      content: "基于第二份报告开始",
      agentId: "agent",
      uploadIds: ["strict-prepared-input"],
      title: "基于第二份报告开始",
      temporary: false,
    });
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
  });

  it("aborts StrictMode preparation on real unmount and ignores a late input beside a newer draft", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    let resolveReuse!: (value: never) => void;
    let preparationSignal!: AbortSignal;
    vi.spyOn(apiClient, "reuseArtifact").mockImplementation((_id, signal) => {
      preparationSignal = signal!;
      return new Promise((resolve) => {
        resolveReuse = resolve;
      });
    });
    const create = vi.spyOn(apiClient, "createSession");
    const oldNavigation = vi.fn();
    const old = render(
      <React.StrictMode>
        {page("strict-unmount", `/?artifactId=${files[0]!.id}`, oldNavigation)}
      </React.StrictMode>,
    );
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "准备旧任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(preparationSignal).toBeDefined());
    expect(preparationSignal.aborted).toBe(false);
    old.unmount();
    expect(preparationSignal.aborted).toBe(true);
    render(<React.StrictMode>{page("strict-unmount")}</React.StrictMode>);
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "新的草稿" },
    });
    const newer = readDraft("strict-unmount");
    await act(async () => resolveReuse({ id: "late-input" } as never));
    expect(create).not.toHaveBeenCalled();
    expect(oldNavigation).not.toHaveBeenCalled();
    expect(readDraft("strict-unmount")).toEqual(newer);
    expect(screen.getByLabelText("任务要求")).toHaveValue("新的草稿");
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
    expect(
      screen.queryByText("任务无法启动，请重试。"),
    ).not.toBeInTheDocument();
  });

  it("ignores an accepted StrictMode task's late response while a newer submission is pending", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const pending: Array<(value: never) => void> = [];
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockImplementation(
        () => new Promise((resolve) => pending.push(resolve)),
      );
    const oldNavigation = vi.fn();
    const newNavigation = vi.fn();
    const old = render(
      <React.StrictMode>
        {page("strict-late-create", "/", oldNavigation)}
      </React.StrictMode>,
    );
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "已接受的旧任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const originalId = create.mock.calls[0]![0].submissionId;
    old.unmount();
    render(
      <React.StrictMode>
        {page("strict-late-create", "/", newNavigation)}
      </React.StrictMode>,
    );
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "新任务正在提交" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const newer = readDraft("strict-late-create");
    expect(newer.submissionId).not.toBe(originalId);
    await act(async () => pending[0]!({ id: "durable-old-session" } as never));
    expect(oldNavigation).not.toHaveBeenCalled();
    expect(newNavigation).not.toHaveBeenCalled();
    expect(readDraft("strict-late-create")).toEqual(newer);
    expect(screen.getByLabelText("任务要求")).toHaveValue("新任务正在提交");
    expect(screen.getByLabelText("任务要求")).toBeDisabled();
    expect(screen.getByText("正在保存任务…")).toBeInTheDocument();
    await act(async () => pending[1]!({ id: "durable-new-session" } as never));
    expect(newNavigation).toHaveBeenCalledExactlyOnceWith(
      { id: "durable-new-session" },
      "新任务正在提交",
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
  });

  it("places described templates after the composer and only prefills the task", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const create = vi.spyOn(apiClient, "createSession");
    render(page());
    const start = screen.getByRole("button", { name: "开始任务" });
    expect(start).toHaveTextContent("开始任务");
    const form = start.closest("form")!;
    const templates = screen.getByRole("region", { name: "任务模板" });
    expect(
      form.compareDocumentPosition(templates) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const icons = templates.querySelectorAll("svg");
    expect(
      new Set([...icons].map((icon) => icon.getAttribute("class"))).size,
    ).toBe(3);
    for (const template of taskTemplates) {
      expect(template.outcome).toMatch(/[\u4e00-\u9fff]/);
      const card = within(templates).getByRole("button", {
        name: new RegExp(template.label),
      });
      expect(card).toHaveTextContent(template.outcome);
      fireEvent.click(card);
      expect(screen.getByLabelText("任务要求")).toHaveValue(template.prompt);
      expect(screen.getByLabelText("任务要求")).toHaveFocus();
    }
    await act(async () => {});
    expect(create).not.toHaveBeenCalled();
  });

  it("provides an independent keyboard-accessible memory explanation and visible disabled-memory choice", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    render(page("memory", "/?temporary=true"));
    const checkbox = screen.getByRole("checkbox", { name: "使用个人记忆" });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("不使用个人记忆，对话仍保存")).toBeVisible();
    const explanation = screen.getByRole("button", { name: "个人记忆说明" });
    explanation.focus();
    fireEvent.click(explanation);
    const dialog = screen.getByRole("dialog", { name: "个人记忆说明" });
    expect(dialog.closest("form")).toBeNull();
    expect(
      within(dialog).getByText(/本任务不读取或整理个人记忆/),
    ).toBeVisible();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(explanation).toHaveFocus();
    expect(checkbox).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "记忆选择" },
    });
    await act(async () => {});
    expect(readDraft("memory").temporary).toBe(true);
  });

  it("commits material changes only on confirmation, displays removable chips and does not create a task", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const create = vi.spyOn(apiClient, "createSession");
    const reuse = vi.spyOn(apiClient, "reuseArtifact");
    render(page("picker", `/?artifactId=${files[0]!.id}`));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "修改报告" },
    });
    await screen.findByRole("button", {
      name: `移除材料 报告.txt · ${files[0]!.id}`,
    });
    const before = readDraft("picker");
    fireEvent.click(screen.getByRole("button", { name: "选已有文件" }));
    const dialog = screen.getByRole("dialog", { name: "选择已有文件" });
    expect(dialog.closest("form")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /shared-prefix-second/ }),
    );
    fireEvent.submit(
      within(dialog).getByRole("searchbox", { name: "搜索文件" }),
    );
    expect(readDraft("picker")).toEqual(before);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(readDraft("picker")).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "选已有文件" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: /shared-prefix-second/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(readDraft("picker").submissionId).not.toBe(before.submissionId);
    const materials = screen.getByRole("list", { name: "已选材料" });
    expect(within(materials).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: `移除材料 报告.txt · ${files[0]!.id}`,
      }),
    );
    expect(within(materials).getAllByRole("listitem")).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(reuse).not.toHaveBeenCalled();
  });

  it("replays the exact attempted request after cancelling or confirming unchanged picker selection", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const reuse = vi
      .spyOn(apiClient, "reuseArtifact")
      .mockResolvedValue({ id: "prepared" } as never);
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockRejectedValue(new Error("response lost"));
    const first = render(page("exact-picker", `/?artifactId=${files[0]!.id}`));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "原任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("任务无法启动，请重试。");
    const attempted = readDraft("exact-picker");
    first.unmount();
    render(page("exact-picker", `/?artifactId=${files[0]!.id}`));
    fireEvent.click(screen.getByRole("button", { name: "选已有文件" }));
    await screen.findByRole("checkbox", { name: /shared-prefix-second/ });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /shared-prefix-second/ }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(readDraft("exact-picker")).toEqual(attempted);
    fireEvent.click(screen.getByRole("button", { name: "选已有文件" }));
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(readDraft("exact-picker")).toEqual(attempted);
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    expect(reuse).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a cleared user edit with a delayed source summary", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    let resolve!: (value: never) => void;
    vi.spyOn(apiClient, "listSessionTurns").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(page("cleared-summary", "/?sourceSessionId=source"));
    const input = screen.getByLabelText("任务要求");
    fireEvent.change(input, { target: { value: "我自己的任务" } });
    fireEvent.change(input, { target: { value: "" } });
    const edited = readDraft("cleared-summary");
    await act(async () =>
      resolve({ turns: [{ summary: "迟到摘要" }] } as never),
    );
    expect(input).toHaveValue("");
    expect(readDraft("cleared-summary")).toEqual(edited);
  });

  it("does not submit a new task while IME composition is active", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockResolvedValue({ id: "new" } as never);
    render(page("intro-ime"));
    const input = screen.getByLabelText("任务要求");
    fireEvent.change(input, { target: { value: "正在输入" } });
    fireEvent.compositionStart(input);
    fireEvent.submit(input.closest("form")!);
    await act(async () => {});
    expect(create).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("keeps local upload IDs and selected-source IDs in an exact reload replay", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const upload = vi
      .spyOn(apiClient, "upload")
      .mockResolvedValue({ id: "local-input" } as never);
    const reuse = vi
      .spyOn(apiClient, "reuseArtifact")
      .mockResolvedValue({ id: "source-input" } as never);
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ id: "created" } as never);
    const first = render(page("upload-replay", `/?artifactId=${files[0]!.id}`));
    const input = screen.getByLabelText("材料文件");
    const nativePicker = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "添加材料" }));
    expect(nativePicker).toHaveBeenCalledTimes(1);
    fireEvent.change(input, {
      target: { files: [new File(["notes"], "notes.txt")] },
    });
    await screen.findByText("已就绪");
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "结合两个材料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("任务无法启动，请重试。");
    expect(create.mock.calls[0]![0].uploadIds).toEqual([
      "local-input",
      "source-input",
    ]);
    const original = create.mock.calls[0]![0];
    first.unmount();
    render(page("upload-replay", `/?artifactId=${files[0]!.id}`));
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(original);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(reuse).toHaveBeenCalledTimes(1);
  });

  it("retries failed local uploads and selected-source preparation without dropping either material", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const upload = vi
      .spyOn(apiClient, "upload")
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValue({ id: "retried-local" } as never);
    const reuse = vi
      .spyOn(apiClient, "reuseArtifact")
      .mockRejectedValueOnce(new Error("reuse failed"))
      .mockResolvedValue({ id: "retried-source" } as never);
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockResolvedValue({ id: "created" } as never);
    render(page("retries", `/?artifactId=${files[0]!.id}`));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "重试材料" },
    });
    fireEvent.change(screen.getByLabelText("材料文件"), {
      target: { files: [new File(["notes"], "notes.txt")] },
    });
    await screen.findByText("notes.txt 上传失败。");
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试上传" }));
    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("任务无法启动，请重试。");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].uploadIds).toEqual([
      "retried-local",
      "retried-source",
    ]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(reuse).toHaveBeenCalledTimes(2);
  });

  it("caps local upload concurrency at three and cancels removed pending and active files", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const pending: Array<{
      name: string;
      signal: AbortSignal;
      resolve: (value: never) => void;
    }> = [];
    const upload = vi
      .spyOn(apiClient, "upload")
      .mockImplementation(
        (file, signal) =>
          new Promise((resolve) =>
            pending.push({ name: file.name, signal: signal!, resolve }),
          ),
      );
    const create = vi.spyOn(apiClient, "createSession");
    const rendered = render(page("cancel-uploads"));
    fireEvent.change(screen.getByLabelText("材料文件"), {
      target: {
        files: Array.from(
          { length: 4 },
          (_, index) => new File(["x"], `file-${index}.txt`),
        ),
      },
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "移除 file-3.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 file-0.txt" }));
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve({ id: "late" } as never));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("file-0.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("file-3.txt")).not.toBeInTheDocument();
    rendered.unmount();
    expect(pending.every((item) => item.signal.aborted)).toBe(true);
    await act(async () => {
      for (const item of pending.slice(1))
        item.resolve({ id: item.name } as never);
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      sizes: Array(21).fill(1) as number[],
      error: "每个任务最多添加 20 个材料。",
    },
    { sizes: [20 * 1024 * 1024 + 1], error: "单个材料不能超过 20 MB。" },
    {
      sizes: Array(6).fill(20 * 1024 * 1024) as number[],
      error: "每个任务的材料总量不能超过 100 MB。",
    },
  ])(
    "rejects invalid local material sizes/counts before uploading: $error",
    async ({ sizes, error }) => {
      vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
      const upload = vi.spyOn(apiClient, "upload");
      render(page("limits"));
      const local = sizes.map((size, index) => {
        const file = new File(["x"], `file-${index}.txt`);
        Object.defineProperty(file, "size", { value: size });
        return file;
      });
      fireEvent.change(screen.getByLabelText("材料文件"), {
        target: { files: local },
      });
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      await act(async () => {});
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it("validates combined local and selected-source material limits before preparing a task", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: [{ ...files[0]!, sizeBytes: 20 * 1024 * 1024 }],
    });
    vi.spyOn(apiClient, "upload").mockResolvedValue({ id: "local" } as never);
    const reuse = vi.spyOn(apiClient, "reuseArtifact");
    const create = vi.spyOn(apiClient, "createSession");
    render(page("combined-limit", `/?artifactId=${files[0]!.id}`));
    const local = Array.from({ length: 5 }, (_, index) => {
      const file = new File(["x"], `file-${index}.txt`);
      Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 });
      return file;
    });
    fireEvent.change(screen.getByLabelText("材料文件"), {
      target: { files: local },
    });
    await waitFor(() => expect(screen.getAllByText("已就绪")).toHaveLength(5));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "过量材料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "每个任务的材料总量不能超过 100 MB。",
    );
    expect(reuse).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
