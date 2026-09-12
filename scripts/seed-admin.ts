import pg from "pg";
import {
  ensureAdministrator,
  ensureDefaultQuotaPolicy,
  readAdministratorInput,
  readDefaultQuota,
} from "./lib/administrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const input = readAdministratorInput(process.env);
if (typeof input === "string") {
  console.error(input);
  process.exit(1);
}

const quota = readDefaultQuota(process.env);
if (typeof quota === "string") {
  console.error(quota);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await ensureDefaultQuotaPolicy(pool, quota);

  const result = await ensureAdministrator(pool, input);
  if (result.created) {
    console.log(`created administrator ${input.email}`);
  } else if (result.passwordUpdated) {
    console.log(`updated administrator ${input.email} (password set)`);
  } else {
    console.log(
      `administrator ${input.email} already exists; set ADMIN_RESET=1 to rotate the password`,
    );
  }
} catch (error) {
  console.error("administrator seed failed:", error);
  process.exit(1);
} finally {
  await pool.end();
}
