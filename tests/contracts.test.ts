import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  createAgentSchema,
  normalizeArkEvent,
} from "../packages/contracts/src/index.js";

describe("shared contracts", () => {
  it.each(["owner_id", "tenant_id", "role"])(
    "rejects the authority field %s and undeclared input",
    (field) => {
      const result = createAgentSchema.safeParse({
        name: "Research",
        description: "",
        modelId: "allowed-model",
        systemPrompt: "Be precise.",
        [field]: "untrusted",
      });

      expect(result.success).toBe(false);
    },
  );

  it("normalizes Ark events while retaining source identity", () => {
    expect(
      normalizeArkEvent({
        id: "evt-1",
        type: "agent.thinking",
        createdAt: "2026-09-06T00:00:00.000Z",
        data: {},
      }),
    ).toEqual({
      id: "evt-1",
      sourceType: "agent.thinking",
      type: "thinking",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: {},
    });
  });

  it("defines a stable API error envelope", () => {
    expect(
      apiErrorSchema.parse({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Not found",
          requestId: "req-1",
          retryable: false,
        },
      }),
    ).toBeTruthy();
  });

  it("rejects undeclared fields in error and event envelopes", () => {
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Not found",
          requestId: "req-1",
          retryable: false,
        },
        tenant_id: "untrusted",
      }).success,
    ).toBe(false);

    expect(() =>
      normalizeArkEvent({
        id: "evt-1",
        type: "agent.message",
        createdAt: "2026-09-06T00:00:00.000Z",
        data: {},
        role: "admin",
      } as never),
    ).toThrow();
  });
});
