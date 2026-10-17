export function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function backupFilePath(
  directory: string,
  now: Date,
  label = "manual",
): string {
  const safeLabel =
    label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "manual";
  return `${directory.replace(/\/$/, "")}/maworker-${backupTimestamp(now)}-${safeLabel}.dump`;
}

export function pgDumpArgs(databaseUrl: string, file: string): string[] {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file",
    file,
    databaseUrl,
  ];
}

export function pgRestoreArgs(databaseUrl: string, file: string): string[] {
  return [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--dbname",
    databaseUrl,
    file,
  ];
}

/** Keep the shape of the URL for logs while erasing credentials. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid database url>";
  }
}
