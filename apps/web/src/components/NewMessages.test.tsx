// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NewMessages } from "./NewMessages.js";

afterEach(cleanup);
function view(revision: string) {
  return (
    <NewMessages revision={revision}>
      <p>{revision}</p>
    </NewMessages>
  );
}
function metrics() {
  const viewport = screen.getByRole("region", { name: "任务消息" });
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  return viewport;
}
describe("new-message scrolling", () => {
  it("does not scroll someone reading history and provides an explicit latest action", () => {
    const { rerender } = render(view("first"));
    const viewport = metrics();
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    rerender(view("second"));
    expect(viewport.scrollTop).toBe(100);
    expect(screen.getByRole("status")).toHaveTextContent("有新消息");
    fireEvent.click(screen.getByRole("button", { name: "查看最新消息" }));
    expect(viewport.scrollTop).toBe(2000);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(view("third"));
    expect(viewport.scrollTop).toBe(2000);
  });
  it("follows changes only while already at the bottom", () => {
    const { rerender } = render(view("first"));
    const viewport = metrics();
    viewport.scrollTop = 1600;
    fireEvent.scroll(viewport);
    rerender(view("second"));
    expect(viewport.scrollTop).toBe(2000);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not notify for unrelated renders and clears the notice when manually reaching latest", () => {
    const { rerender } = render(view("first"));
    const viewport = metrics();
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    rerender(view("first"));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(view("second"));
    expect(screen.getByRole("status")).toBeInTheDocument();
    viewport.scrollTop = 1600;
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
