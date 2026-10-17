import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

/**
 * Anonymizes the account immediately and removes connector secrets and memory.
 * Task/usage/audit rows stay for accounting; the disabled owner can no longer
 * authenticate or read them.
 */
export function createAccountDeletionRepository(db: Database) {
  return {
    async deleteOwnAccount(userId: string, now: Date): Promise<boolean> {
      return db.transaction(async (transaction) => {
        const user = await transaction.execute<{ id: string }>(
          sql`select id from users
               where id = ${userId} and account_deleted_at is null
               for update`,
        );
        if (user.rows.length === 0) return false;
        await transaction.execute(
          sql`update users
                 set status = 'disabled',
                     email = ${`deleted+${userId}@invalid.local`},
                     auth_subject = ${`deleted:${userId}`},
                     password_hash = null,
                     auth_epoch = auth_epoch + 1,
                     account_deleted_at = ${now},
                     updated_at = ${now}
               where id = ${userId}`,
        );
        await transaction.execute(
          sql`update auth_sessions
                 set revoked_at = ${now}
               where user_id = ${userId} and revoked_at is null`,
        );
        await transaction.execute(
          sql`update automations
                 set enabled = false, revision = revision + 1, updated_at = ${now}
               where owner_user_id = ${userId}`,
        );
        await transaction.execute(
          sql`update automation_occurrences
                 set status = 'canceled', updated_at = ${now}
               where owner_user_id = ${userId} and status = 'pending'`,
        );
        await transaction.execute(
          sql`update sessions
                 set archived_at = coalesce(archived_at, ${now}),
                     updated_at = ${now}
               where owner_user_id = ${userId}`,
        );
        await transaction.execute(
          sql`delete from notification_channels where owner_user_id = ${userId}`,
        );
        await transaction.execute(
          sql`delete from mcp_servers where owner_user_id = ${userId}`,
        );
        await transaction.execute(
          sql`delete from user_memory_stores where user_id = ${userId}`,
        );
        return true;
      });
    },
  };
}
