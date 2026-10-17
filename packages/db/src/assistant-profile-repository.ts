import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface AssistantProfileRecord extends Row {
  ownerUserId: string;
  defaultAgentId: string | null;
  displayName: string;
  persona: string;
  preferences: Record<string, unknown>;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistantAgentSummary extends Row {
  id: string;
  name: string;
  modelId: string;
  status: string;
  arkAgentId: string;
}

const profileSelection = sql`owner_user_id as "ownerUserId",
  default_agent_id as "defaultAgentId", display_name as "displayName",
  persona, preferences, revision,
  created_at as "createdAt", updated_at as "updatedAt"`;

const agentSelection = sql`id, name, model_id as "modelId",
  status, ark_agent_id as "arkAgentId"`;

function normalizeProfile(row: AssistantProfileRecord): AssistantProfileRecord {
  const preferences =
    typeof row.preferences === "string"
      ? (JSON.parse(row.preferences) as Record<string, unknown>)
      : row.preferences;
  return {
    ...row,
    preferences: preferences ?? {},
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createAssistantProfileRepository(db: Database) {
  async function find(
    ownerUserId: string,
  ): Promise<AssistantProfileRecord | undefined> {
    const result = await db.execute<AssistantProfileRecord>(
      sql`select ${profileSelection}
            from assistant_profiles
           where owner_user_id = ${ownerUserId}
           limit 1`,
    );
    const row = result.rows[0];
    return row ? normalizeProfile(row) : undefined;
  }

  return {
    find,

    async ensure(ownerUserId: string): Promise<AssistantProfileRecord> {
      await db.execute(
        sql`insert into assistant_profiles (owner_user_id)
            values (${ownerUserId})
            on conflict (owner_user_id) do nothing`,
      );
      const profile = await find(ownerUserId);
      if (!profile) throw new Error("Assistant profile could not be created");
      return profile;
    },

    async findDefaultAgent(
      ownerUserId: string,
    ): Promise<AssistantAgentSummary | undefined> {
      const result = await db.execute<AssistantAgentSummary>(
        sql`select ${agentSelection}
              from personal_agents
             where owner_user_id = ${ownerUserId}
               and is_auto_default = true
             order by created_at
             limit 1`,
      );
      return result.rows[0];
    },

    async findAgent(
      ownerUserId: string,
      agentId: string,
    ): Promise<AssistantAgentSummary | undefined> {
      const result = await db.execute<AssistantAgentSummary>(
        sql`select ${agentSelection}
              from personal_agents
             where owner_user_id = ${ownerUserId}
               and id = ${agentId}
             limit 1`,
      );
      return result.rows[0];
    },

    async attachDefault(
      ownerUserId: string,
      agentId: string,
    ): Promise<AssistantProfileRecord | undefined> {
      const now = new Date();
      const result = await db.execute<AssistantProfileRecord>(
        sql`update assistant_profiles
               set default_agent_id = ${agentId},
                   revision = revision + 1,
                   updated_at = ${now}::timestamptz
             where owner_user_id = ${ownerUserId}
               and default_agent_id is null
               and exists(
                 select 1 from personal_agents
                  where id = ${agentId} and owner_user_id = ${ownerUserId}
               )
             returning ${profileSelection}`,
      );
      const row = result.rows[0];
      return row ? normalizeProfile(row) : undefined;
    },

    async update(
      ownerUserId: string,
      input: {
        displayName?: string;
        persona?: string;
        preferences?: Record<string, unknown>;
        expectedRevision?: number;
      },
    ): Promise<AssistantProfileRecord | undefined> {
      const now = new Date();
      const expected = input.expectedRevision ?? null;
      const result = await db.execute<AssistantProfileRecord>(
        sql`update assistant_profiles
               set display_name = coalesce(${input.displayName ?? null}, display_name),
                   persona = coalesce(${input.persona ?? null}, persona),
                   preferences = coalesce(
                     ${input.preferences === undefined ? null : JSON.stringify(input.preferences)}::jsonb,
                     preferences
                   ),
                   revision = revision + 1,
                   updated_at = ${now}::timestamptz
             where owner_user_id = ${ownerUserId}
               and (${expected}::integer is null or revision = ${expected})
             returning ${profileSelection}`,
      );
      const row = result.rows[0];
      return row ? normalizeProfile(row) : undefined;
    },
  };
}
