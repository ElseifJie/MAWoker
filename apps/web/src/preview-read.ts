export async function readPreviewResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("预览超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取预览");
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("预览超过大小限制");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
