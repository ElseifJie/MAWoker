import type {
  AuthSessionRecord,
  AuthStore,
  AuthUser,
  AuthUserWithPassword,
} from "@pwa/auth";
import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface QueryResult<T extends Row> {
  rows: T[];
}

interface DatabaseClient {
  execute<T extends Row = Row>(query: SQL): PromiseLike<QueryResult<T>>;
}

async function first<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T | undefined> {
  const result = await database.execute<T>(query);
  return result.rows[0];
}

export function createAuthStore(database: unknown): AuthStore {
  const db = database as DatabaseClient;

  return {
    async findUserByEmail(
      email: string,
    ): Promise<AuthUserWithPassword | undefined> {
      const user = await first<AuthUserWithPassword & Row>(
        db,
        sql`select id,
                   auth_subject as "authSubject",
                   email,
                   password_hash as "passwordHash",
                   role,
                   status
              from users
             where email = ${email}
             limit 1`,
      );
      return user ?? undefined;
    },

    async createSession(session: AuthSessionRecord): Promise<void> {
      await db.execute(
        sql`insert into auth_sessions
              (id, user_id, token_hash, expires_at, revoked_at, created_at)
            values
              (${session.id}, ${session.userId}, ${session.tokenHash},
               ${session.expiresAt}, ${session.revokedAt}, ${session.createdAt})`,
      );
    },

    async findSessionByTokenHash(tokenHash: string, now: Date) {
      const row = await first<
        Row &
          AuthSessionRecord &
          AuthUser & {
            sessionId: string;
            sessionUserId: string;
            createdAt: Date;
          }
      >(
        db,
        sql`select s.id as "sessionId",
                   s.user_id as "sessionUserId",
                   s.token_hash as "tokenHash",
                   s.expires_at as "expiresAt",
                   s.revoked_at as "revokedAt",
                   s.created_at as "createdAt",
                   u.id,
                   u.auth_subject as "authSubject",
                   u.email,
                   u.role,
                   u.status
              from auth_sessions s
              join users u on u.id = s.user_id
             where s.token_hash = ${tokenHash}
               and s.revoked_at is null
               and s.expires_at > ${now}
             limit 1`,
      );
      if (!row) {
        return undefined;
      }
      return {
        session: {
          id: row.sessionId,
          userId: row.sessionUserId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          createdAt: row.createdAt,
        },
        user: {
          id: row.id,
          authSubject: row.authSubject,
          email: row.email,
          role: row.role,
          status: row.status,
        },
      };
    },

    async extendSession(
      tokenHash: string,
      expiresAt: Date,
      now: Date,
    ): Promise<boolean> {
      const updated = await first<{ id: string }>(
        db,
        sql`update auth_sessions s
               set expires_at = ${expiresAt}
              from users u
             where s.token_hash = ${tokenHash}
               and s.user_id = u.id
               and s.revoked_at is null
               and s.expires_at > ${now}
               and u.status = 'active'
             returning s.id`,
      );
      return updated !== undefined;
    },

    async revokeSessionByTokenHash(
      tokenHash: string,
      revokedAt: Date,
    ): Promise<void> {
      await db.execute(
        sql`update auth_sessions
               set revoked_at = ${revokedAt}
             where token_hash = ${tokenHash}
               and revoked_at is null`,
      );
    },
  };
}
