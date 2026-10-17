import { describe, expect, it } from "vitest";
import {
  backupFilePath,
  pgDumpArgs,
  pgRestoreArgs,
  redactDatabaseUrl,
} from "../scripts/lib/db-backup.js";

describe("database backup helpers", () => {
  it("builds a timestamped, label-safe backup path", () => {
    const path = backupFilePath(
      "/secure/backups/",
      new Date("2026-10-17T01:02:03.004Z"),
      "pre release/../x",
    );
    expect(path).toBe(
      "/secure/backups/maworker-2026-10-17T01-02-03-004Z-pre-release----x.dump",
    );
  });

  it("uses custom-format dump and clean restore arguments", () => {
    expect(pgDumpArgs("postgres://u:p@db/app", "/tmp/a.dump")).toEqual([
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      "/tmp/a.dump",
      "postgres://u:p@db/app",
    ]);
    expect(pgRestoreArgs("postgres://u:p@db/app", "/tmp/a.dump")).toEqual([
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      "postgres://u:p@db/app",
      "/tmp/a.dump",
    ]);
  });

  it("redacts credentials from logs", () => {
    expect(
      redactDatabaseUrl("postgres://user:pass@db.example.com:5432/app"),
    ).toBe("postgres://***:***@db.example.com:5432/app");
    expect(redactDatabaseUrl("not a url")).toBe("<invalid database url>");
  });
});
