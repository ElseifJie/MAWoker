// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown.js";

function chip(path: string) {
  return document.querySelector(`[data-artifact-path="${path}"]`);
}

afterEach(cleanup);

describe("remarkArtifactLinks", () => {
  it("links a prose path with a CJK filename and strips the trailing full stop", () => {
    render(
      <Markdown artifactLinks>
        {"搞定啦！文件在 /mnt/session/outputs/康冠科技介绍.html。\n"}
      </Markdown>,
    );
    const linked = chip("/mnt/session/outputs/康冠科技介绍.html");
    expect(linked).toHaveTextContent("康冠科技介绍.html");
    expect(linked?.closest("p")?.textContent).toMatch(/。$/);
  });

  it("strips trailing ASCII punctuation without consuming it", () => {
    render(
      <Markdown artifactLinks>
        {"See /mnt/session/outputs/summary.md."}
      </Markdown>,
    );
    expect(chip("/mnt/session/outputs/summary.md")).toBeInTheDocument();
  });

  it("keeps a closing bracket outside the link", () => {
    render(
      <Markdown artifactLinks>{"(see /mnt/session/outputs/a.html)"}</Markdown>,
    );
    expect(chip("/mnt/session/outputs/a.html")).toBeInTheDocument();
  });

  it("links an inline code span that is exactly an output path", () => {
    render(
      <Markdown artifactLinks>
        {"Written to `/mnt/session/outputs/report.html` ok"}
      </Markdown>,
    );
    expect(chip("/mnt/session/outputs/report.html")).toBeInTheDocument();
  });

  it("never links paths inside fenced code", () => {
    render(
      <Markdown artifactLinks>
        {"```\ncat /mnt/session/outputs/secret.html\n```"}
      </Markdown>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("ignores paths outside the outputs mount", () => {
    render(
      <Markdown artifactLinks>
        {"Uploaded to /mnt/session/inputs/brief.txt and /etc/hosts."}
      </Markdown>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
