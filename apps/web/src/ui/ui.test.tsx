// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, NavLink, useNavigate } from "react-router-dom";
import { useModalDialog } from "../useModalDialog.js";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  SectionHeader,
  Spinner,
  Textarea,
} from "./index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setMobileViewport(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function TestIcon({
  "aria-hidden": ariaHidden,
}: {
  size?: number;
  "aria-hidden"?: boolean;
}) {
  return <span aria-hidden={ariaHidden}>icon</span>;
}

function ProgrammaticNavigationButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/settings")}>
      Change location
    </button>
  );
}

function PageHeaderFallbackFocusHarness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [triggerVisible, setTriggerVisible] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeAfterDeletion = () => {
    setTriggerVisible(false);
    setDialogOpen(false);
  };
  const dialogRef = useModalDialog({
    open: dialogOpen,
    onClose: closeAfterDeletion,
    returnFocusRef: triggerRef,
    fallbackFocusRef: headingRef,
  });

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Agents" headingRef={headingRef} />
      {triggerVisible ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setDialogOpen(true)}
        >
          Delete Agent
        </button>
      ) : null}
      {dialogOpen ? (
        <section
          ref={dialogRef}
          role="dialog"
          aria-label="Delete Agent"
          tabIndex={-1}
        >
          <button type="button" onClick={closeAfterDeletion}>
            Confirm deletion
          </button>
        </section>
      ) : null}
    </>
  );
}

describe("Button", () => {
  it("uses the primary default-size presentation and button type by default", () => {
    render(<Button>Save changes</Button>);

    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass(
      "ui-button",
      "ui-button--primary",
      "ui-button--default",
    );
  });

  it("allows the native button type to be overridden", () => {
    render(<Button type="submit">Create Agent</Button>);

    expect(
      screen.getByRole("button", { name: "Create Agent" }),
    ).toHaveAttribute("type", "submit");
  });

  it.each(["primary", "secondary", "text", "danger"] as const)(
    "supports the %s variant",
    (variant) => {
      render(<Button variant={variant}>{variant}</Button>);

      expect(screen.getByRole("button", { name: variant })).toHaveClass(
        `ui-button--${variant}`,
      );
    },
  );

  it.each(["default", "compact"] as const)("supports the %s size", (size) => {
    render(<Button size={size}>{size}</Button>);

    expect(screen.getByRole("button", { name: size })).toHaveClass(
      `ui-button--${size}`,
    );
  });

  it("disables a loading button without removing its visible content", () => {
    render(
      <Button loading>
        <span>Publish report</span>
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Publish report" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Publish report")).toBeVisible();
  });
});

describe("IconButton", () => {
  it("uses its label as both the accessible name and title", () => {
    render(
      <IconButton label="Close dialog">
        <span aria-hidden="true">x</span>
      </IconButton>,
    );

    const button = screen.getByRole("button", { name: "Close dialog" });
    expect(button).toHaveAttribute("title", "Close dialog");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ui-icon-button", "ui-icon-button--default");
  });

  it("supports the fixed small size", () => {
    render(<IconButton label="Remove item" size="small" />);

    expect(screen.getByRole("button", { name: "Remove item" })).toHaveClass(
      "ui-icon-button--small",
    );
  });
});

describe("Form controls", () => {
  it("associates a generated control id with its label and hint", () => {
    render(
      <Field label="Email address" hint="Use your work email.">
        <Input name="email" type="email" autoComplete="email" />
      </Field>,
    );

    const input = screen.getByLabelText("Email address");
    const hint = screen.getByText("Use your work email.");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks an invalid control and combines existing, hint, and error descriptions", () => {
    render(
      <>
        <span id="password-requirements">At least 12 characters.</span>
        <Field
          label="Password"
          hint="Do not reuse a password."
          error="Password is required."
        >
          <Input
            id="account-password"
            aria-describedby="password-requirements"
          />
        </Field>
      </>,
    );

    const input = screen.getByLabelText("Password");
    const hint = screen.getByText("Do not reuse a password.");
    const error = screen.getByText("Password is required.");
    expect(input).toHaveAttribute("id", "account-password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute(
      "aria-describedby",
      `password-requirements ${hint.id} ${error.id}`,
    );
    expect(error).toHaveAttribute("role", "alert");
  });

  it("retains native props on select and textarea wrappers", () => {
    render(
      <>
        <Field label="Agent">
          <Select name="agent" defaultValue="research">
            <option value="research">Research</option>
          </Select>
        </Field>
        <Field label="Instructions">
          <Textarea name="instructions" rows={4} maxLength={500} />
        </Field>
      </>,
    );

    expect(screen.getByLabelText("Agent")).toHaveValue("research");
    expect(screen.getByLabelText("Agent")).toHaveAttribute("name", "agent");
    expect(screen.getByLabelText("Instructions")).toHaveAttribute("rows", "4");
    expect(screen.getByLabelText("Instructions")).toHaveAttribute(
      "maxlength",
      "500",
    );
  });

  it("forwards an Input ref to the native input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Name" />);

    expect(ref.current).toBe(screen.getByRole("textbox", { name: "Name" }));
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("forwards a Select ref to the native select", () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} aria-label="Agent">
        <option value="research">Research</option>
      </Select>,
    );

    expect(ref.current).toBe(screen.getByRole("combobox", { name: "Agent" }));
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
  });

  it("forwards a Textarea ref to the native textarea", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} aria-label="Instructions" />);

    expect(ref.current).toBe(
      screen.getByRole("textbox", { name: "Instructions" }),
    );
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});

describe("Feedback", () => {
  it.each(["neutral", "success", "warning", "danger"] as const)(
    "renders visible %s badge text",
    (tone) => {
      render(<Badge tone={tone}>{tone} state</Badge>);

      expect(
        screen.getByText(`${tone} state`).closest(".ui-badge"),
      ).toHaveClass("ui-badge", `ui-badge--${tone}`);
    },
  );

  it.each([
    ["info", "status"],
    ["success", "status"],
    ["warning", "alert"],
    ["danger", "alert"],
  ] as const)("uses the appropriate role for a %s alert", (tone, role) => {
    render(<Alert tone={tone}>{tone} message</Alert>);

    expect(screen.getByRole(role)).toHaveTextContent(`${tone} message`);
    expect(screen.getByRole(role)).toHaveClass(`ui-alert--${tone}`);
  });

  it("renders an accessible loading indicator", () => {
    render(<Spinner label="Loading Agents" />);

    expect(screen.getByRole("status", { name: "Loading Agents" })).toHaveClass(
      "ui-spinner",
    );
  });

  it("renders a compact empty state with an optional action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <EmptyState
        title="No Agents found"
        description="Create an Agent or try again."
        action={<Button onClick={onRetry}>Try again</Button>}
      />,
    );

    expect(screen.getByText("No Agents found")).toBeVisible();
    expect(screen.getByText("Create an Agent or try again.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("Dialog", () => {
  function DialogHarness({
    closeLabel,
    closeDisabled = false,
    hideCloseButton = false,
  }: {
    closeLabel?: string;
    closeDisabled?: boolean;
    hideCloseButton?: boolean;
  }) {
    const [open, setOpen] = useState(false);
    const triggerRef = createRef<HTMLButtonElement>();
    const initialFocusRef = createRef<HTMLInputElement>();

    return (
      <>
        <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
          Open editor
        </button>
        <Dialog
          open={open}
          title="Edit Agent"
          eyebrow="Personal Agent"
          onClose={() => setOpen(false)}
          closeLabel={closeLabel}
          closeDisabled={closeDisabled}
          hideCloseButton={hideCloseButton}
          initialFocusRef={initialFocusRef}
          returnFocusRef={triggerRef}
          footer={<Button variant="primary">Save changes</Button>}
        >
          <Input ref={initialFocusRef} aria-label="Agent name" />
          <Button variant="secondary">Cancel editing</Button>
        </Dialog>
      </>
    );
  }

  function FallbackFocusDialogHarness() {
    const [open, setOpen] = useState(false);
    const [triggerVisible, setTriggerVisible] = useState(true);
    const headingRef = useRef<HTMLHeadingElement>(null);

    const closeAfterDeletion = () => {
      setTriggerVisible(false);
      setOpen(false);
    };

    return (
      <>
        <h1 ref={headingRef} tabIndex={-1}>
          Agents
        </h1>
        {triggerVisible ? (
          <button type="button" onClick={() => setOpen(true)}>
            Delete Agent
          </button>
        ) : null}
        <Dialog
          open={open}
          title="Delete Agent?"
          onClose={() => setOpen(false)}
          fallbackFocusRef={headingRef}
          footer={
            <Button variant="danger" onClick={closeAfterDeletion}>
              Confirm deletion
            </Button>
          }
        >
          <p>This cannot be undone.</p>
        </Dialog>
      </>
    );
  }

  it("renders its heading, body, and footer and moves initial focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    await user.click(screen.getByRole("button", { name: "Open editor" }));

    expect(
      screen.getByRole("dialog", { name: "Edit Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Personal Agent")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveFocus();
  });

  it("uses a configurable close button label", async () => {
    const user = userEvent.setup();
    render(<DialogHarness closeLabel="Close Agent editor" />);

    await user.click(screen.getByRole("button", { name: "Open editor" }));

    const close = screen.getByRole("button", { name: "Close Agent editor" });
    expect(close).toHaveAttribute("title", "Close Agent editor");
    expect(
      screen.queryByRole("button", { name: "Close dialog" }),
    ).not.toBeInTheDocument();
  });

  it("can omit the close button", async () => {
    const user = userEvent.setup();
    render(<DialogHarness hideCloseButton />);

    await user.click(screen.getByRole("button", { name: "Open editor" }));

    expect(
      screen.queryByRole("button", { name: "Close dialog" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Agent" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the fallback when closing removes the trigger", async () => {
    const user = userEvent.setup();
    render(<FallbackFocusDialogHarness />);

    await user.click(screen.getByRole("button", { name: "Delete Agent" }));
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(
      screen.queryByRole("button", { name: "Delete Agent" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agents" })).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open editor" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("traps forward and backward focus within the dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open editor" }));

    const close = screen.getByRole("button", { name: "Close dialog" });
    const save = screen.getByRole("button", { name: "Save changes" });

    save.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
  });

  it("prevents close controls and Escape while closing is disabled", async () => {
    const user = userEvent.setup();
    render(<DialogHarness closeDisabled />);
    await user.click(screen.getByRole("button", { name: "Open editor" }));

    const close = screen.getByRole("button", { name: "Close dialog" });
    expect(close).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Edit Agent" })).toBeVisible();
  });

  it("focuses the dialog container when closing is disabled and no descendants are focusable", () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Open editor</button>
        <Dialog open title="Saving Agent" onClose={onClose} closeDisabled>
          <p>Saving changes.</p>
        </Dialog>
      </>,
    );

    const dialog = screen.getByRole("dialog", { name: "Saving Agent" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(dialog).toHaveFocus();

    const tabContinued = fireEvent.keyDown(document, { key: "Tab" });

    expect(tabContinued).toBe(false);
    expect(dialog).toHaveFocus();
  });
});

describe("Page headings", () => {
  it("places page copy and actions in the shared page header", () => {
    const headingRef = createRef<HTMLHeadingElement>();
    render(
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        description="Manage the Agents available to your account."
        actions={<Button>Create Agent</Button>}
        headingRef={headingRef}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Agents" });
    expect(headingRef.current).toBe(heading);
    expect(screen.getByText("Workspace")).toHaveClass(
      "ui-page-header__eyebrow",
    );
    expect(
      screen.getByText("Manage the Agents available to your account."),
    ).toHaveClass("ui-page-header__description");
    expect(
      screen.getByRole("button", { name: "Create Agent" }).parentElement,
    ).toHaveClass("ui-page-header__actions");
  });

  it("receives fallback focus after the deletion trigger unmounts", async () => {
    const user = userEvent.setup();
    render(<PageHeaderFallbackFocusHarness />);
    const heading = screen.getByRole("heading", { level: 1, name: "Agents" });

    expect(heading).toHaveAttribute("tabindex", "-1");
    await user.click(screen.getByRole("button", { name: "Delete Agent" }));
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(
      screen.queryByRole("button", { name: "Delete Agent" }),
    ).not.toBeInTheDocument();
    expect(heading).toHaveFocus();
  });

  it("renders section copy and actions with a level-two heading", () => {
    render(
      <SectionHeader
        title="Personal Agents"
        description="Agents available only to you."
        actions={<Button variant="secondary">Refresh</Button>}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Personal Agents" }),
    ).toHaveClass("ui-section-header__title");
    expect(screen.getByText("Agents available only to you.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Refresh" }).parentElement,
    ).toHaveClass("ui-section-header__actions");
  });
});

describe("DataTable", () => {
  it("renders a semantic table with an accessible caption", () => {
    render(
      <DataTable caption="Platform Agents">
        <thead>
          <tr>
            <th scope="col">Name</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Research Agent</td>
          </tr>
        </tbody>
      </DataTable>,
    );

    const table = screen.getByRole("table", { name: "Platform Agents" });
    expect(table).toHaveClass("ui-data-table", "ui-data-table--standard");
    expect(table.querySelector("caption")).toHaveTextContent("Platform Agents");
  });

  it("supports the wide minimum width and native table props", () => {
    render(
      <DataTable
        caption="User quotas"
        minWidth="wide"
        aria-describedby="quota-help"
      >
        <tbody>
          <tr>
            <td>User</td>
          </tr>
        </tbody>
      </DataTable>,
    );

    expect(screen.getByRole("table", { name: "User quotas" })).toHaveClass(
      "ui-data-table--wide",
    );
    expect(screen.getByRole("table")).toHaveAttribute(
      "aria-describedby",
      "quota-help",
    );
  });
});

describe("AppShell", () => {
  const navigation = [
    { to: "/", label: "New task", icon: TestIcon },
    { to: "/agents", label: "Agents", icon: TestIcon },
  ];

  function renderShell({
    backdropLabel,
    children = <button type="button">Page action</button>,
    closeNavigationLabel,
    initialPath = "/agents",
    navigationExtra,
    openNavigationLabel,
    onSignOut = vi.fn(),
  }: {
    backdropLabel?: string;
    children?: React.ReactNode;
    closeNavigationLabel?: string;
    initialPath?: string;
    navigationExtra?: React.ReactNode;
    openNavigationLabel?: string;
    onSignOut?: () => void;
  } = {}) {
    return {
      onSignOut,
      ...render(
        <MemoryRouter initialEntries={[initialPath]}>
          <AppShell
            backdropLabel={backdropLabel}
            brand="Work Agent"
            closeNavigationLabel={closeNavigationLabel}
            navigationLabel="Workspace"
            navigation={navigation}
            navigationExtra={navigationExtra}
            openNavigationLabel={openNavigationLabel}
            onSignOut={onSignOut}
          >
            {children}
          </AppShell>
        </MemoryRouter>,
      ),
    };
  }

  it("marks the current navigation item active and signs out", async () => {
    setMobileViewport(false);
    const user = userEvent.setup();
    const { onSignOut } = renderShell();

    expect(screen.getByRole("link", { name: "Agents" })).toHaveClass("active");
    expect(screen.getByRole("link", { name: "New task" })).not.toHaveClass(
      "active",
    );
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("keeps the closed mobile drawer out of the keyboard sequence", async () => {
    setMobileViewport(true);
    const user = userEvent.setup();
    renderShell({
      navigationExtra: <button type="button">Extra navigation action</button>,
    });

    const toggle = screen.getByRole("button", { name: "Open navigation" });
    const sidebar = screen.getByRole("complementary", { hidden: true });
    expect(sidebar).toHaveAttribute("hidden");
    expect(sidebar).toHaveAttribute("inert");
    expect(
      screen.getByRole("link", { name: "Agents", hidden: true }),
    ).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: "Sign out", hidden: true }),
    ).toHaveAttribute("tabindex", "-1");

    toggle.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Page action" })).toHaveFocus();
    expect(
      screen.getByRole("button", {
        name: "Extra navigation action",
        hidden: true,
      }),
    ).not.toHaveFocus();
  });

  it("moves focus into the open drawer, makes page content inert, and traps Tab", async () => {
    setMobileViewport(true);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const firstLink = screen.getByRole("link", { name: "New task" });
    const lastControl = screen.getByRole("button", { name: "Sign out" });
    expect(firstLink).toHaveFocus();
    expect(screen.getByRole("main")).toHaveAttribute("inert");

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(lastControl).toHaveFocus();
    await user.tab();
    expect(firstLink).toHaveFocus();
  });

  it("restores focus to the drawer toggle after Escape and backdrop closure", async () => {
    setMobileViewport(true);
    const user = userEvent.setup();
    renderShell();

    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await user.click(toggle);
    await user.keyboard("{Escape}");
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    await user.click(
      screen.getByRole("button", { name: "Close navigation drawer" }),
    );
    expect(toggle).toHaveFocus();
  });

  it("moves focus to the routed page heading after drawer navigation", async () => {
    setMobileViewport(true);
    const user = userEvent.setup();
    renderShell({
      children: (
        <>
          <h1 tabIndex={-1}>Destination</h1>
          <button type="button">Page action</button>
        </>
      ),
    });

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("link", { name: "New task" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Destination" }),
      ).toHaveFocus(),
    );
  });

  it("opens the mobile drawer and closes it from navigation or the backdrop", async () => {
    setMobileViewport(true);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary")).not.toHaveAttribute("inert");

    await user.click(screen.getByRole("link", { name: "New task" }));
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(
      screen.getByRole("button", { name: "Close navigation drawer" }),
    );
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the mobile drawer on Escape and removes its listener", () => {
    setMobileViewport(true);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const keydownListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "keydown",
    )?.[1];
    expect(keydownListener).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(removeEventListener).toHaveBeenCalledWith(
      "keydown",
      keydownListener,
    );
  });

  it("closes the mobile drawer whenever the location changes", () => {
    setMobileViewport(true);
    renderShell({
      children: <ProgrammaticNavigationButton />,
      navigationExtra: (
        <NavLink to="/sessions/session-1">Quarterly plan</NavLink>
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("link", { name: "Quarterly plan" }));
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    {
      shell: "Workspace",
      open: "Open navigation",
      close: "Close navigation",
      backdrop: "Close navigation",
    },
    {
      shell: "Administration",
      open: "Open administration navigation",
      close: "Close administration navigation",
      backdrop: "Close administration navigation",
    },
  ])("supports the existing $shell mobile navigation labels", (labels) => {
    setMobileViewport(true);
    renderShell({
      openNavigationLabel: labels.open,
      closeNavigationLabel: labels.close,
      backdropLabel: labels.backdrop,
    });

    fireEvent.click(screen.getByRole("button", { name: labels.open }));

    expect(
      screen.getByRole("button", { name: labels.close, expanded: true }),
    ).toHaveAttribute("title", labels.close);
    const backdrop = document.querySelector(".ui-app-shell__backdrop");
    expect(backdrop).toHaveAccessibleName(labels.backdrop);
    expect(backdrop).toHaveAttribute("title", labels.backdrop);
  });
});
