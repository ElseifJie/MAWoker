// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, IconButton } from "./index.js";

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
