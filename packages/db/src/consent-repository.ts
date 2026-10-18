import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
}

export interface ConsentRecord {
  document: string;
  version: string;
  acceptedAt: Date;
}

interface ConsentRow extends Row {
  document: string;
  version: string;
  acceptedAt: Date | string;
}

const selection = sql`document, version, accepted_at as "acceptedAt"`;

function revive(row: ConsentRow): ConsentRecord {
  return {
    document: row.document,
    version: row.version,
    acceptedAt: new Date(row.acceptedAt),
  };
}

export function createConsentRepository(db: Database) {
  return {
    async listForUser(userId: string): Promise<ConsentRecord[]> {
      const result = await db.execute<ConsentRow>(
        sql`select ${selection}
              from user_consents
             where user_id = ${userId}
             order by accepted_at desc, document asc`,
      );
      return result.rows.map(revive);
    },

    async record(input: {
      userId: string;
      document: string;
      version: string;
      now: Date;
    }): Promise<ConsentRecord> {
      const result = await db.execute<ConsentRow>(
        sql`insert into user_consents (user_id, document, version, accepted_at)
            values (${input.userId}, ${input.document}, ${input.version}, ${input.now})
            on conflict (user_id, document, version)
            do update set accepted_at = excluded.accepted_at
            returning ${selection}`,
      );
      return revive(result.rows[0]!);
    },
  };
}
