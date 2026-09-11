import type { UiEvent } from "./api.js";
import { buildBlocks, type TranscriptBlock } from "./timeline/blocks.js";
import { foldEvents } from "./timeline/fold.js";
import { messageRoles } from "./timeline/messageRole.js";
import type { Item } from "./timeline/items.js";

function itemLine(item: Item): string | undefined {
  if (item.kind === "tool") {
    const name = item.name ?? "tool";
    const status = item.status === "ok" ? "" : ` (${item.status})`;
    const args = item.argsSummary ? ` ${item.argsSummary}` : "";
    const result = item.preview
      ? `\n\n  > ${item.preview.replace(/\n/g, "\n  > ")}`
      : "";
    return `- \`${name}\`${args}${status}${result}`;
  }
  if (item.kind === "thinking") return "- Thinking…";
  return undefined;
}

function blockMarkdown(block: TranscriptBlock): string[] {
  if (block.kind === "user") {
    return [`## You\n\n${block.item.text}`];
  }
  if (block.kind === "notice") {
    return [`> ${block.item.tone.toUpperCase()}: ${block.item.text}`];
  }
  const parts: string[] = [];
  const steps = block.items.map(itemLine).filter((line) => line !== undefined);
  if (steps.length > 0) {
    parts.push(
      `<details>\n<summary>${block.stepCount} steps</summary>\n\n${steps.join("\n")}\n\n</details>`,
    );
  }
  if (block.answer) parts.push(`## Agent\n\n${block.answer.text}`);
  return parts;
}

/**
 * Renders a Session as Markdown using the same fold the transcript uses, so an
 * export reads exactly like the screen it was taken from.
 */
export function transcriptMarkdown(
  title: string,
  events: readonly UiEvent[],
): string {
  const state = foldEvents([...events]);
  const blocks = buildBlocks(
    state.items,
    messageRoles(state.items, state.status),
    state.status,
  );
  const body = blocks.flatMap(blockMarkdown).join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, " ").trim();
  return `${cleaned.length > 0 ? cleaned.slice(0, 60) : "session"}.md`;
}

export function downloadMarkdown(filename: string, content: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function transcriptFilename(title: string): string {
  return safeFilename(title);
}
