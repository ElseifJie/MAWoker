import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "../../packages/auth/src/password.js";

export interface AdministratorInput {
  email: string;
  password: string;
  reset: boolean;
}

export interface AdministratorResult {
  id: string;
  created: boolean;
  passwordUpdated: boolean;
}

export interface DefaultQuota {
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
}

export async function ensureDefaultQuotaPolicy(
  pool: Pool,
  quota: DefaultQuota,
): Promise<void> {
  await pool.query(
    `insert into quota_policies
       (key, personal_agent_limit, concurrent_session_limit,
        daily_session_limit, monthly_token_limit)
     values ('default', $1, $2, $3, $4)
     on conflict (key) do nothing`,
    [
      quota.personalAgentLimit,
      quota.concurrentSessionLimit,
      quota.dailySessionLimit,
      quota.monthlyTokenLimit,
    ],
  );
}

export async function ensureAdministrator(
  pool: Pool,
  input: AdministratorInput,
): Promise<AdministratorResult> {
  const existing = await pool.query<{
    id: string;
    password_hash: string | null;
  }>("select id, password_hash from users where email = $1", [input.email]);

  if (existing.rowCount === 0) {
    const id = randomUUID();
    await pool.query(
      `insert into users (id, auth_subject, email, password_hash, role, status)
       values ($1, $2, $3, $4, 'admin', 'active')`,
      [
        id,
        `local:${input.email}`,
        input.email,
        await hashPassword(input.password),
      ],
    );
    return { id, created: true, passwordUpdated: true };
  }

  const user = existing.rows[0]!;
  // Existing accounts keep their password unless a rotation was requested or
  // they never had one.
  const passwordUpdated = input.reset || user.password_hash === null;
  await pool.query(
    `update users
        set password_hash = $2,
            role = 'admin',
            status = 'active',
            updated_at = now()
      where id = $1`,
    [
      user.id,
      passwordUpdated ? await hashPassword(input.password) : user.password_hash,
    ],
  );
  return { id: user.id, created: false, passwordUpdated };
}

export function readAdministratorInput(
  env: NodeJS.ProcessEnv,
): AdministratorInput | string {
  const email = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = env.ADMIN_PASSWORD ?? "";
  if (email.length === 0 || password.length === 0) {
    return "ADMIN_EMAIL and ADMIN_PASSWORD are required";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return `ADMIN_EMAIL is not a valid email address: ${email}`;
  }
  if (password.length < 8) {
    return "ADMIN_PASSWORD must be at least 8 characters";
  }
  return { email, password, reset: env.ADMIN_RESET === "1" };
}
