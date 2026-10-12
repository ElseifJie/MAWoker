const prefix = "mawork:submission-draft:";
export function readDraft(key: string): {
  content: string;
  submissionId: string;
} {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(prefix + key) ?? "null",
    ) as { content?: unknown; submissionId?: unknown } | null;
    if (
      typeof value?.content === "string" &&
      typeof value.submissionId === "string"
    )
      return { content: value.content, submissionId: value.submissionId };
  } catch {
    /* Storage is optional for unaccepted drafts. */
  }
  return { content: "", submissionId: crypto.randomUUID() };
}
export function writeDraft(
  key: string,
  content: string,
  submissionId: string,
): void {
  try {
    sessionStorage.setItem(
      prefix + key,
      JSON.stringify({ content, submissionId }),
    );
  } catch {
    /* Draft can remain in memory. */
  }
}
export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(prefix + key);
  } catch {
    /* Optional storage. */
  }
}
export function clearSubmissionDrafts(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    /* Optional storage. */
  }
}
