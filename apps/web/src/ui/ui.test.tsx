// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  Spinner,
  Textarea,
} from "./index.js";

afterEach(cleanup);

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
    closeDisabled = false,
  }: {
    closeDisabled?: boolean;
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
          closeDisabled={closeDisabled}
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
