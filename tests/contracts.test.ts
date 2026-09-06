import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  createAgentSchema,
  normalizeArkEvent,
} from "../packages/contracts/src/index.js";

describe("shared contracts", () => {
  it("rejects authority fields and undeclared input", () => {
    const result = createAgentSchema.safeParse({
      name: "Research",
      description: "",
      modelId: "allowed-model",
      systemPrompt: "Be precise.",
      owner_id: "another-user",
    });

    expect(result.success).toBe(false);
  });

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
});
