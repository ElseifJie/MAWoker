import pg from "pg";
import {
  ensureAdministrator,
  ensureDefaultQuotaPolicy,
  readAdministratorInput,
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

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await ensureDefaultQuotaPolicy(pool, {
    personalAgentLimit: 10,
    concurrentSessionLimit: 2,
    dailySessionLimit: 25,
    monthlyTokenLimit: 1_000_000,
  });

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
