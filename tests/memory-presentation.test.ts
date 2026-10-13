import { describe, expect, it } from "vitest";
import { presentMemory } from "../apps/web/src/memory-presentation.js";
describe("memory explanations", () => {
  it("uses explicit classification and source evidence while keeping unknown honest", () => {
    expect(
      presentMemory({
        path: "/procedures/review.md",
        content: "review slowly",
      }),
    ).toMatchObject({ category: "协作习惯", source: "来源未知" });
    expect(
      presentMemory({
        path: "/memories/preferences.md",
        content: "偏好中文\nsourceSessionId: local-session",
      }),
    ).toMatchObject({ category: "偏好", source: "任务 local-session" });
  });
});
