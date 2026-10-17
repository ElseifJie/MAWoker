import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pgRestoreArgs, redactDatabaseUrl } from "./lib/db-backup.js";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    yes: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "allow-production": { type: "boolean", default: false },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!values.file || !existsSync(values.file)) {
  console.error("--file must point to an existing dump");
  process.exit(1);
}
if (
  process.env.NODE_ENV === "production" &&
  !values["allow-production"] &&
  !values["dry-run"]
) {
  console.error("refusing production restore without --allow-production");
  process.exit(1);
}
if (!values["dry-run"]) {
  if (!values.yes || process.env.RESTORE_CONFIRM !== "restore") {
    console.error(
      "destructive restore requires --yes and RESTORE_CONFIRM=restore",
    );
    process.exit(1);
  }
}

const args = pgRestoreArgs(databaseUrl, values.file);
if (values["dry-run"]) {
  console.log(
    `pg_restore ${args
      .map((arg) => {
        if (arg === values.file) return arg;
        if (arg === databaseUrl) return redactDatabaseUrl(databaseUrl);
        return JSON.stringify(arg);
      })
      .join(" ")}`,
  );
  process.exit(0);
}
console.log(`restoring ${values.file} into ${redactDatabaseUrl(databaseUrl)}`);
const result = spawnSync("pg_restore", args, { stdio: "inherit" });
if (result.error) {
  console.error(`pg_restore failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
