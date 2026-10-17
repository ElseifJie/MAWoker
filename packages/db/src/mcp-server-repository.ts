import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
}

export interface McpServerRow extends Row {
  id: string;
  ownerUserId: string;
  name: string;
  url: string;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

const selection = sql`id, owner_user_id as "ownerUserId", name, url, status,
  created_at as "createdAt", updated_at as "updatedAt"`;

function dates(row: McpServerRow): McpServerRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createMcpServerRepository(db: Database) {
  return {
    async create(input: {
      id: string;
      ownerUserId: string;
      name: string;
      url: string;
      now: Date;
    }): Promise<McpServerRow | undefined> {
      const result = await db.execute<McpServerRow>(
        sql`insert into mcp_servers
              (id, owner_user_id, name, url, status, created_at, updated_at)
            values (
              ${input.id}, ${input.ownerUserId}, ${input.name}, ${input.url},
              'active', ${input.now}, ${input.now}
            )
            on conflict (owner_user_id, name) do nothing
            returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async listOwned(ownerUserId: string): Promise<McpServerRow[]> {
      const result = await db.execute<McpServerRow>(
        sql`select ${selection} from mcp_servers
             where owner_user_id = ${ownerUserId}
             order by created_at desc, id desc`,
      );
      return result.rows.map(dates);
    },

    async setStatus(input: {
      ownerUserId: string;
      id: string;
      status: "active" | "disabled";
      now: Date;
    }): Promise<McpServerRow | undefined> {
      const result = await db.execute<McpServerRow>(
        sql`update mcp_servers
               set status = ${input.status}, updated_at = ${input.now}
             where owner_user_id = ${input.ownerUserId} and id = ${input.id}
             returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async delete(ownerUserId: string, id: string): Promise<boolean> {
      const result = await db.execute<{ id: string }>(
        sql`delete from mcp_servers
             where owner_user_id = ${ownerUserId} and id = ${id}
             returning id`,
      );
      return result.rows.length > 0;
    },
  };
}
