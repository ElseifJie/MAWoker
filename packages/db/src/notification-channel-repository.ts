import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
}

export interface NotificationChannelRow extends Row {
  id: string;
  ownerUserId: string;
  name: string;
  type: "webhook";
  url: string;
  enabled: boolean;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const selection = sql`id, owner_user_id as "ownerUserId", name, type, url,
  enabled, last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

function dates(row: NotificationChannelRow): NotificationChannelRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createNotificationChannelRepository(db: Database) {
  return {
    async create(input: {
      id: string;
      ownerUserId: string;
      name: string;
      url: string;
      now: Date;
    }): Promise<NotificationChannelRow | undefined> {
      const result = await db.execute<NotificationChannelRow>(
        sql`insert into notification_channels
              (id, owner_user_id, name, type, url, enabled,
               created_at, updated_at)
            values (
              ${input.id}, ${input.ownerUserId}, ${input.name}, 'webhook',
              ${input.url}, true, ${input.now}, ${input.now}
            )
            on conflict (owner_user_id, name) do nothing
            returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async listOwned(ownerUserId: string): Promise<NotificationChannelRow[]> {
      const result = await db.execute<NotificationChannelRow>(
        sql`select ${selection} from notification_channels
             where owner_user_id = ${ownerUserId}
             order by created_at desc, id desc`,
      );
      return result.rows.map(dates);
    },

    async listEnabled(ownerUserId: string): Promise<NotificationChannelRow[]> {
      const result = await db.execute<NotificationChannelRow>(
        sql`select ${selection} from notification_channels
             where owner_user_id = ${ownerUserId} and enabled
             order by created_at desc, id desc`,
      );
      return result.rows.map(dates);
    },

    async setEnabled(input: {
      ownerUserId: string;
      id: string;
      enabled: boolean;
      now: Date;
    }): Promise<NotificationChannelRow | undefined> {
      const result = await db.execute<NotificationChannelRow>(
        sql`update notification_channels
               set enabled = ${input.enabled}, updated_at = ${input.now}
             where owner_user_id = ${input.ownerUserId} and id = ${input.id}
             returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async updateError(input: {
      ownerUserId: string;
      id: string;
      errorCode: string | null;
      now: Date;
    }): Promise<void> {
      await db.execute(
        sql`update notification_channels
               set last_error_code = ${input.errorCode}, updated_at = ${input.now}
             where owner_user_id = ${input.ownerUserId} and id = ${input.id}`,
      );
    },

    async delete(ownerUserId: string, id: string): Promise<boolean> {
      const result = await db.execute<{ id: string }>(
        sql`delete from notification_channels
             where owner_user_id = ${ownerUserId} and id = ${id}
             returning id`,
      );
      return result.rows.length > 0;
    },
  };
}
