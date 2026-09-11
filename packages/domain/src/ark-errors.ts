export function isArkCategory(error: unknown, category: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === category
  );
}

export function arkErrorCode(error: unknown): string {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? String(error.category)
      : "unavailable";
  return `ARK_${category.toUpperCase()}`;
}

export function arkRequestId(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "arkRequestId" in error &&
    typeof error.arkRequestId === "string"
  ) {
    return error.arkRequestId;
  }
  return undefined;
}
