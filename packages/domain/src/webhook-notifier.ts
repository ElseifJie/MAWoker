export interface WebhookChannel {
  id: string;
  ownerUserId: string;
  url: string;
}

export interface WebhookPayload {
  title: string;
  text: string;
}

export function buildWebhookBody(
  url: string,
  payload: WebhookPayload,
): Record<string, unknown> {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "open.feishu.cn" || host.endsWith(".feishu.cn")) {
    return {
      msg_type: "text",
      content: { text: `${payload.title}\n${payload.text}` },
    };
  }
  return { title: payload.title, text: payload.text, source: "ma-worker" };
}

export async function sendWebhookNotifications(input: {
  channels: readonly WebhookChannel[];
  payload: WebhookPayload;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onResult?: (
    channel: WebhookChannel,
    errorCode: string | null,
  ) => PromiseLike<void>;
}): Promise<{ sent: number; failed: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let sent = 0;
  let failed = 0;
  for (const channel of input.channels) {
    let errorCode: string | null = null;
    try {
      const response = await fetchImpl(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildWebhookBody(channel.url, input.payload)),
        signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
      });
      if (!response.ok) errorCode = `HTTP_${response.status}`;
    } catch {
      errorCode = "WEBHOOK_DELIVERY_FAILED";
    }
    if (errorCode === null) sent += 1;
    else failed += 1;
    await input.onResult?.(channel, errorCode);
  }
  return { sent, failed };
}
