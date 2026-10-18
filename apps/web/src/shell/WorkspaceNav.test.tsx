// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { History, Plus } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceNav } from "./WorkspaceNav.js";

const navigation = [
  { to: "/", label: "新任务", icon: Plus },
  { to: "/history", label: "历史任务", icon: History },
];

function renderNav(
  options: {
    collapsed?: boolean;
    path?: string;
    onSignOut?: () => void;
    onOpenDrawer?: () => void;
    onCloseDrawer?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? "/"]}>
      <WorkspaceNav
        brand="Work Agent"
        navigationLabel="工作区"
        navigation={navigation}
        navigationExtra={<p>Quarterly plan</p>}
        user={{ handle: "user@example.com" }}
        onSignOut={options.onSignOut ?? vi.fn()}
        collapsed={options.collapsed}
        {...(options.onOpenDrawer
          ? { onOpenDrawer: options.onOpenDrawer }
          : {})}
        {...(options.onCloseDrawer
          ? { onCloseDrawer: options.onCloseDrawer }
          : {})}
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("WorkspaceNav", () => {
  it("renders the brand, primary destinations, session extra, and account", () => {
    renderNav();

    expect(screen.getByText("Work Agent")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "工作区" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["新任务", "历史任务"]);
    expect(within(nav).getByText("Quarterly plan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "账号：user@example.com" }),
    ).toBeInTheDocument();
  });

  it("hides the session list and labels while keeping icon links named", () => {
    renderNav({ collapsed: true });

    expect(screen.queryByText("Work Agent")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "工作区" });
    expect(within(nav).queryByText("Quarterly plan")).toBeNull();
    expect(within(nav).getByRole("link", { name: "新任务" })).toHaveAttribute(
      "title",
      "新任务",
    );
    expect(
      screen.getByRole("button", { name: "账号：user@example.com" }),
    ).toBeInTheDocument();
  });

  it("marks the current destination and signs out from the account menu", async () => {
    const onSignOut = vi.fn();
    renderNav({ path: "/history", onSignOut });
    const user = userEvent.setup();

    const current = screen.getByRole("link", { name: "历史任务" });
    expect(current).toHaveClass("active");
    expect(current).toHaveAttribute("aria-current", "page");

    await user.click(
      screen.getByRole("button", { name: "账号：user@example.com" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("[shell.narrow] offers the drawer trigger on the collapsed rail", async () => {
    const onOpenDrawer = vi.fn();
    renderNav({ collapsed: true, onOpenDrawer });
    const trigger = screen.getByRole("button", { name: "打开导航" });

    expect(trigger).toHaveAttribute("data-drawer-trigger");
    await userEvent.setup().click(trigger);
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it("[shell.narrow] shows the close control while the drawer is open", async () => {
    const onCloseDrawer = vi.fn();
    renderNav({ onCloseDrawer });
    const close = screen.getByRole("button", { name: "关闭导航" });

    expect(screen.getByText("Work Agent")).toBeInTheDocument();
    expect(close).toHaveAttribute("data-drawer-trigger");
    await userEvent.setup().click(close);
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
  });
});
