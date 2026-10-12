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
  transaction<T>(
    work: (transaction: DatabaseClient) => PromiseLike<T>,
  ): PromiseLike<T>;
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
                   status,
                   auth_epoch as "authEpoch"
              from users
             where email = ${email}
             limit 1`,
      );
      return user ?? undefined;
    },

    async createSession(session: AuthSessionRecord): Promise<void> {
      await db.execute(
        sql`insert into auth_sessions
              (id, user_id, token_hash, expires_at, revoked_at, created_at,
               issued_epoch)
            values
              (${session.id}, ${session.userId}, ${session.tokenHash},
               ${session.expiresAt}, ${session.revokedAt}, ${session.createdAt},
               ${session.issuedEpoch})`,
      );
    },

    async issueVerifiedSession(input: {
      userId: string;
      expectedPasswordHash: string;
      session: Omit<AuthSessionRecord, "issuedEpoch">;
    }) {
      // One transaction: the user row is locked and re-verified (status and
      // the exact password hash the caller checked) before the session is
      // inserted, so a disable or password rotation that lands between the
      // password check and issuance cannot leak a valid session. The session
      // is stamped with the epoch read under the same lock.
      const issued = await db.transaction(async (transaction) => {
        const user = await first<
          AuthUserWithPassword & { authEpoch: number } & Row
        >(
          transaction,
          sql`select id,
                     auth_subject as "authSubject",
                     email,
                     password_hash as "passwordHash",
                     role,
                     status,
                     auth_epoch as "authEpoch"
                from users
               where id = ${input.userId}
                 for update`,
        );
        if (
          !user ||
          user.status !== "active" ||
          user.passwordHash !== input.expectedPasswordHash
        ) {
          return undefined;
        }
        await transaction.execute(
          sql`insert into auth_sessions
                (id, user_id, token_hash, expires_at, revoked_at, created_at,
                 issued_epoch)
              values
                (${input.session.id}, ${input.session.userId},
                 ${input.session.tokenHash}, ${input.session.expiresAt},
                 ${input.session.revokedAt}, ${input.session.createdAt},
                 ${user.authEpoch})`,
        );
        const session: AuthSessionRecord = {
          ...input.session,
          issuedEpoch: user.authEpoch,
        };
        const publicUser: AuthUser = {
          id: user.id,
          authSubject: user.authSubject,
          email: user.email,
          role: user.role,
          status: user.status,
          authEpoch: user.authEpoch,
        };
        return { session, user: publicUser };
      });
      return issued ?? undefined;
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
                   s.issued_epoch as "issuedEpoch",
                   u.id,
                   u.auth_subject as "authSubject",
                   u.email,
                   u.role,
                   u.status,
                   u.auth_epoch as "authEpoch"
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
          // The driver may hand timestamps back as strings.
          expiresAt: new Date(row.expiresAt),
          revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
          createdAt: new Date(row.createdAt),
          issuedEpoch: Number(row.issuedEpoch ?? 0),
        },
        user: {
          id: row.id,
          authSubject: row.authSubject,
          email: row.email,
          role: row.role,
          status: row.status,
          authEpoch: Number(row.authEpoch ?? 0),
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
