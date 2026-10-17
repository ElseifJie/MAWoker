import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface InviteCodeRow extends Row {
  id: string;
  codeHash: string;
  email: string;
  createdBy: string;
  usedByUserId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InviteAcceptResult =
  | { kind: "accepted"; userId: string; email: string; inviteId: string }
  | { kind: "invalid" }
  | { kind: "email_conflict" };

const selection = sql`id, code_hash as "codeHash", email,
  created_by as "createdBy", used_by_user_id as "usedByUserId",
  expires_at as "expiresAt", used_at as "usedAt", revoked_at as "revokedAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

function dates(row: InviteCodeRow): InviteCodeRow {
  return {
    ...row,
    expiresAt: new Date(row.expiresAt),
    usedAt: row.usedAt ? new Date(row.usedAt) : null,
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createInviteRepository(db: Database) {
  return {
    async create(input: {
      id: string;
      codeHash: string;
      email: string;
      createdBy: string;
      expiresAt: Date;
      now: Date;
    }): Promise<InviteCodeRow> {
      const result = await db.execute<InviteCodeRow>(
        sql`insert into invite_codes
              (id, code_hash, email, created_by, expires_at, created_at, updated_at)
            values (
              ${input.id}, ${input.codeHash}, ${input.email}, ${input.createdBy},
              ${input.expiresAt}, ${input.now}, ${input.now}
            )
            returning ${selection}`,
      );
      return dates(result.rows[0]!);
    },

    async list(limit: number): Promise<InviteCodeRow[]> {
      const bounded = Math.max(1, Math.min(limit, 100));
      const result = await db.execute<InviteCodeRow>(
        sql`select ${selection}
              from invite_codes
             order by created_at desc, id desc
             limit ${bounded}`,
      );
      return result.rows.map(dates);
    },

    async revoke(id: string, now: Date): Promise<InviteCodeRow | undefined> {
      const result = await db.execute<InviteCodeRow>(
        sql`update invite_codes
               set revoked_at = ${now}, updated_at = ${now}
             where id = ${id}
               and used_at is null
               and revoked_at is null
             returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async accept(input: {
      codeHash: string;
      passwordHash: string;
      userId: string;
      now: Date;
    }): Promise<InviteAcceptResult> {
      return db.transaction(
        async (transaction): Promise<InviteAcceptResult> => {
          const invited = await transaction.execute<InviteCodeRow>(
            sql`select ${selection}
                from invite_codes
               where code_hash = ${input.codeHash}
               for update`,
          );
          const row = invited.rows[0];
          if (
            !row ||
            row.usedAt !== null ||
            row.revokedAt !== null ||
            new Date(row.expiresAt).getTime() <= input.now.getTime()
          ) {
            return { kind: "invalid" };
          }
          const existing = await transaction.execute<{ id: string }>(
            sql`select id from users where email = ${row.email} limit 1`,
          );
          if (existing.rows.length > 0) return { kind: "email_conflict" };

          const created = await transaction.execute<{ id: string }>(
            sql`insert into users
                (id, auth_subject, email, password_hash, role, status,
                 created_at, updated_at)
              values (
                ${input.userId}, ${`local:${row.email}`}, ${row.email},
                ${input.passwordHash}, 'user', 'active', ${input.now}, ${input.now}
              )
              on conflict (email) do nothing
              returning id`,
          );
          const user = created.rows[0];
          if (!user) return { kind: "email_conflict" };
          await transaction.execute(
            sql`update invite_codes
                 set used_at = ${input.now},
                     used_by_user_id = ${user.id},
                     updated_at = ${input.now}
               where id = ${row.id}`,
          );
          return {
            kind: "accepted",
            userId: user.id,
            email: row.email,
            inviteId: row.id,
          };
        },
      );
    },
  };
}
