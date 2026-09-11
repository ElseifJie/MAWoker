import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InMemoryArkGateway } from "../../packages/ark-client/src/stub.js";
import type { ArkEvent } from "../../packages/ark-client/src/types.js";

export const arkFixtures = {
  basic: "ark-events-basic.json",
  toolsetAndMcp: "ark-events-toolset-and-mcp.json",
  multiMessageTurn: "ark-events-multi-message-turn.json",
} as const;

export type ArkFixtureName = keyof typeof arkFixtures;

interface CapturedFixture {
  _fixture: Record<string, unknown>;
  events: Record<string, unknown>[];
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
  );
}

// Mirrors persistedEventSchema + normalizeEventData in packages/ark-client/src/http.ts.
function toArkEvent(raw: Record<string, unknown>): ArkEvent {
  const { id, type, processed_at: processedAt, ...data } = raw;
  if (Array.isArray(data.content)) {
    data.content = data.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join("");
  }
  return {
    id: String(id),
    type: String(type),
    createdAt: new Date(String(processedAt)).toISOString(),
    data,
  };
}

/** Events captured live from the Ark data plane, in the shape MAWork parses them into. */
export function loadArkFixture(name: ArkFixtureName): ArkEvent[] {
  const path = resolve(
    import.meta.dirname,
    "..",
    "fixtures",
    arkFixtures[name],
  );
  const fixture = JSON.parse(readFileSync(path, "utf8")) as CapturedFixture;
  return fixture.events.map(toArkEvent);
}

/** Replays a fixture through the gateway, preserving the real ids and timestamps. */
export function replayArkFixture(
  gateway: InMemoryArkGateway,
  sessionId: string,
  name: ArkFixtureName,
): ArkEvent[] {
  const events = loadArkFixture(name);
  for (const event of events) {
    gateway.emitEvent(sessionId, {
      type: event.type,
      data: event.data,
      id: event.id,
      createdAt: event.createdAt,
    });
  }
  return events;
}
