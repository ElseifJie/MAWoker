import { mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  backupFilePath,
  pgDumpArgs,
  redactDatabaseUrl,
} from "./lib/db-backup.js";

const { values } = parseArgs({
  options: {
    "out-dir": { type: "string", default: "backups" },
    label: { type: "string", default: "manual" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const file = backupFilePath(
  values["out-dir"] ?? "backups",
  new Date(),
  values.label,
);
const args = pgDumpArgs(databaseUrl, file);
if (values["dry-run"]) {
  console.log(
    `pg_dump ${args
      .slice(0, -1)
      .map((arg) => (arg === file ? arg : JSON.stringify(arg)))
      .join(" ")} ${redactDatabaseUrl(databaseUrl)}`,
  );
  process.exit(0);
}

mkdirSync(values["out-dir"] ?? "backups", { recursive: true });
const result = spawnSync("pg_dump", args, { stdio: "inherit" });
if (result.error) {
  console.error(`pg_dump failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`pg_dump exited with ${result.status}`);
  process.exit(result.status ?? 1);
}
const size = statSync(file).size;
console.log(`backup written: ${file} (${size} bytes)`);
