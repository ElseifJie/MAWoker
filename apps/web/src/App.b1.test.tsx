// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { App } from "./App.js";
import { apiClient, type AgentList, type ClientCapabilities } from "./api.js";

vi.mock("./components/SessionIntro.js", () => ({
  SessionIntro: () => <h1>新任务</h1>,
}));
vi.mock("./AgentPage.js", () => ({ AgentPage: () => <h1>助手配置</h1> }));
vi.mock("./AgentEditorPage.js", () => ({
  AgentEditorPage: () => <h1>编辑助手</h1>,
}));
vi.mock("./MemoryPage.js", () => ({
  MemoryPage: () => <h1>记忆配置</h1>,
  clearMemoryCache: vi.fn(),
}));
vi.mock("./SkillsPage.js", () => ({ SkillsPage: () => <h1>技能配置</h1> }));
vi.mock("./components/TaskNotifications.js", () => ({
  TaskNotifications: () => null,
}));

const capabilities: ClientCapabilities = {
  skills: { available: true },
  memoryStores: { available: true },
  mcpServers: { available: false },
  vaults: { available: false },
  personalAgentModels: ["model"],
};
const agents: AgentList = {
  agents: [],
  selection: { agentId: "agent", source: "default" },
  blocker: null,
};
function Probe() {
  const location = useLocation();
  return (
    <output aria-label="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount(path = "/") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Probe />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.spyOn(apiClient, "getMe").mockResolvedValue({
    user: { userId: "u", authSubject: "local:u@example.com", role: "user" },
  });
  vi.spyOn(apiClient, "listAgents").mockResolvedValue(agents);
  vi.spyOn(apiClient, "listSessions").mockResolvedValue({ sessions: [] });
  vi.spyOn(apiClient, "getCapabilities").mockResolvedValue(capabilities);
  vi.spyOn(apiClient, "getUsage").mockResolvedValue(
    {} as Awaited<ReturnType<typeof apiClient.getUsage>>,
  );
  vi.spyOn(apiClient, "listAccountConsents").mockResolvedValue({
    consents: [],
    currentVersion: "2026-10-18",
    documents: ["terms", "privacy"],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("B1 workspace navigation", () => {
  it("shows only primary task destinations, search action and settings", async () => {
    mount();
    await screen.findByRole("heading", { name: "新任务" });
    const primary = document.querySelector(
      ".ui-app-shell__navigation-primary",
    )!;
    expect(
      within(primary as HTMLElement)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["新任务", "历史任务", "我的文件", "自动化", "设置"]);
    expect(
      within(primary as HTMLElement).getByRole("button", { name: "搜索" }),
    ).toBeInTheDocument();
    expect(primary.querySelector('[aria-disabled="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "历史任务" }));
    expect(
      await screen.findByRole("heading", { name: "历史任务" }),
    ).toBeInTheDocument();
    expect(screen.getByText("还没有历史任务")).toBeInTheDocument();
  });
  it("places available capabilities under settings and keeps memory's exact route", async () => {
    mount("/settings");
    await screen.findByRole("heading", { name: "设置" });
    expect(screen.getByRole("link", { name: "助手配置" })).toHaveAttribute(
      "href",
      "/settings/agents",
    );
    expect(screen.getByRole("link", { name: "记忆" })).toHaveAttribute(
      "href",
      "/context",
    );
    expect(screen.getByRole("link", { name: "技能" })).toHaveAttribute(
      "href",
      "/settings/skills",
    );
    expect(screen.queryByRole("link", { name: /MCP|凭据/ })).toBeNull();
  });
  it.each([
    ["/agents", "/settings/agents"],
    ["/agents/new?from=old", "/settings/agents/new?from=old"],
    ["/agents/a/edit", "/settings/agents/a/edit"],
    ["/skills", "/settings/skills"],
  ])(
    "redirects legacy %s without dropping query parameters",
    async (from, to) => {
      mount(from);
      await waitFor(() =>
        expect(screen.getByLabelText("location")).toHaveTextContent(to),
      );
    },
  );
  it("keeps /context rendering compatible instead of redirecting memory's route detector", async () => {
    mount("/context");
    expect(
      await screen.findByRole("heading", { name: "记忆配置" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent("/context");
  });
  it("offers setup when the default selection is absent", async () => {
    vi.mocked(apiClient.listAgents).mockResolvedValue({
      agents: [],
      selection: null,
      blocker: { code: "NO_DEFAULT_AGENT", message: "No default" },
    });
    mount();
    expect(
      await screen.findByRole("link", { name: "配置任务助手" }),
    ).toHaveAttribute("href", "/settings/agents");
  });
  it("guards an unavailable skills route", async () => {
    vi.mocked(apiClient.getCapabilities).mockResolvedValue({
      ...capabilities,
      skills: { available: false },
    });
    mount("/settings/skills");
    expect(
      await screen.findByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "技能配置" })).toBeNull();
  });
});
