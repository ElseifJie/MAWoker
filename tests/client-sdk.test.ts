import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  createApiClient,
  type SseEvent,
} from "../packages/client-sdk/src/index.js";

const assistant = {
  profile: {
    ownerUserId: "user-1",
    defaultAgentId: "agent-1",
    displayName: "Assistant",
    persona: "",
    preferences: {},
    revision: 2,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:01:00.000Z",
  },
  agent: null,
};

describe("client SDK", () => {
  it("calls the JSON API with same-origin credentials and a typed body", async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.com/api/v1/assistant/profile",
        );
        expect(init?.method).toBe("PATCH");
        expect(init?.credentials).toBe("same-origin");
        expect(new Headers(init?.headers).get("accept")).toBe(
          "application/json",
        );
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          displayName: "Assistant",
          expectedRevision: 2,
        });
        return Response.json(assistant);
      },
    );
    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch,
    });

    await expect(
      client.updateAssistantProfile({
        displayName: "Assistant",
        expectedRevision: 2,
      }),
    ).resolves.toEqual(assistant);
  });

  it("turns an API error envelope into ApiClientError", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "ASSISTANT_PROFILE_CONFLICT",
            message: "Assistant profile changed",
            requestId: "request-1",
            retryable: false,
          },
        },
        { status: 409 },
      ),
    );
    const client = createApiClient({ fetch });

    await expect(client.getAssistantProfile()).rejects.toMatchObject({
      name: "ApiClientError",
      status: 409,
      code: "ASSISTANT_PROFILE_CONFLICT",
      retryable: false,
    });
    await expect(client.getAssistantProfile()).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });

  it("encodes sync cursor pagination and Run identifiers", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ cursor: 0, hasMore: false, changes: [] });
    });
    const client = createApiClient({ baseUrl: "", fetch });

    await client.getSyncChanges(4, 10);
    await client.getSyncSnapshot();
    await client.getRun("run/with space");

    expect(urls).toEqual([
      "/api/v1/sync/changes?cursor=4&limit=10",
      "/api/v1/sync/snapshot",
      "/api/v1/runs/run%2Fwith%20space",
    ]);
  });

  it("parses SSE frames split across chunks and sends Last-Event-ID", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"status":'));
        controller.enqueue(encoder.encode('"running"}\n\n'));
        controller.enqueue(
          encoder.encode('event: message\ndata: {"content":"hi"}\n\n'),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("last-event-id")).toBe("12");
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    const client = createApiClient({ fetch });
    const events: SseEvent[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((complete) => {
      resolve = complete;
    });

    const opened = await client.openEventStream({
      sessionId: "session-1",
      lastEventId: "12",
      onEvent(event) {
        events.push(event);
        if (events.length === 2) resolve();
      },
    });
    await done;
    opened.close();

    expect(events).toEqual([
      { event: "ready", data: { status: "running" } },
      { event: "message", data: { content: "hi" } },
    ]);
  });

  it("rejects an SSE response that is not successful", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 401 }));
    const client = createApiClient({ fetch });

    await expect(
      client.openEventStream({ sessionId: "session-1", onEvent: vi.fn() }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
