import { describe, expect, it, vi } from "vitest";
import {
  buildWebhookBody,
  sendWebhookNotifications,
} from "../packages/domain/src/index.js";

describe("webhook notifications", () => {
  it("uses Feishu text payloads for Feishu hosts and generic JSON otherwise", () => {
    expect(
      buildWebhookBody("https://open.feishu.cn/open-apis/bot/v2/hook/x", {
        title: "喝水",
        text: "提醒时间到了。",
      }),
    ).toEqual({
      msg_type: "text",
      content: { text: "喝水\n提醒时间到了。" },
    });
    expect(
      buildWebhookBody("https://hooks.example.com/x", {
        title: "喝水",
        text: "提醒时间到了。",
      }),
    ).toEqual({
      title: "喝水",
      text: "提醒时间到了。",
      source: "ma-worker",
    });
  });

  it("reports per-channel success and failure without throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockRejectedValueOnce(new Error("offline"));
    const results: Array<string | null> = [];
    const channels = [
      { id: "a", ownerUserId: "u", url: "https://a.example.com/hook" },
      { id: "b", ownerUserId: "u", url: "https://b.example.com/hook" },
      { id: "c", ownerUserId: "u", url: "https://c.example.com/hook" },
    ];

    await expect(
      sendWebhookNotifications({
        channels,
        payload: { title: "t", text: "x" },
        fetchImpl,
        onResult: async (_channel, errorCode) => {
          results.push(errorCode);
        },
      }),
    ).resolves.toEqual({ sent: 1, failed: 2 });
    expect(results).toEqual([null, "HTTP_500", "WEBHOOK_DELIVERY_FAILED"]);
  });
});
