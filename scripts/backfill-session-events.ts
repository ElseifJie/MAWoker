import pg from "pg";
import { HttpArkGateway } from "@pwa/ark-client";
import { isPublicSessionEvent } from "@pwa/domain";
import { normalizeArkEvent } from "@pwa/contracts";

/**
 * One-time warm-up for the local Session event log.
 *
 * Reopening a Session reads its events from `session_events` instead of
 * replaying the whole history from Ark, but a Session that has never been
 * opened since the log existed has nothing stored yet. This copies each such
 * Session's history once, so the first click is instant rather than paying the
 * replay that the log was introduced to avoid.
 *
 * Safe to run repeatedly: it skips Sessions already marked backfilled and
 * inserts with `on conflict do nothing`.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const apiKey = process.env.ARK_API_KEY;
if (!apiKey) {
  console.error("ARK_API_KEY is required");
  process.exit(1);
}

const batchSize = 100;
const pool = new pg.Pool({ connectionString: databaseUrl });
const ark = new HttpArkGateway({
  baseUrl: process.env.ARK_API_BASE_URL ?? "https://ark.cn-beijing.volces.com",
  apiKey,
  timeoutMs: Number(process.env.ARK_REQUEST_TIMEOUT_MS ?? 30_000),
  maxAttempts: Number(process.env.ARK_MAX_ATTEMPTS ?? 3),
  baseDelayMs: Number(process.env.ARK_RETRY_BASE_DELAY_MS ?? 250),
  maxDelayMs: Number(process.env.ARK_RETRY_MAX_DELAY_MS ?? 5_000),
});

async function storeEvents(
  sessionId: string,
  events: ReturnType<typeof normalizeArkEvent>[],
): Promise<void> {
  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize);
    const values: unknown[] = [sessionId];
    const rows = batch.map((event) => {
      const base = values.length;
      values.push(
        event.id,
        event.sourceType,
        event.type,
        new Date(event.createdAt),
        JSON.stringify(event.payload),
      );
      return `($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::timestamptz, $${base + 5}::jsonb)`;
    });
    await pool.query(
      `insert into session_events
         (session_id, event_id, source_type, type, occurred_at, payload)
       select $1::uuid, batch.event_id, batch.source_type, batch.type,
              batch.occurred_at, batch.payload
         from (values ${rows.join(", ")})
           as batch(event_id, source_type, type, occurred_at, payload)
       on conflict (session_id, event_id) do nothing`,
      values,
    );
  }
}

try {
  const pending = await pool.query<{
    id: string;
    ark_session_id: string;
    title: string;
  }>(
    `select session.id, session.ark_session_id, session.title
       from sessions session
       left join session_event_cursors cursor on cursor.session_id = session.id
      where session.deletion_state = 'none'
        and session.ark_session_id not like 'pending:%'
        and cursor.history_backfilled_at is null
      order by session.updated_at desc`,
  );
  console.log(`${pending.rowCount} Session(s) need their history cached`);

  let cached = 0;
  let events = 0;
  for (const session of pending.rows) {
    try {
      const history = await ark.listEvents(session.ark_session_id, {
        correlationId: `backfill:${session.id}`,
      });
      history.sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      const projected = history
        .filter((source) => isPublicSessionEvent(source.type))
        .map((source) => normalizeArkEvent(source));
      await storeEvents(session.id, projected);
      const now = new Date();
      await pool.query(
        `insert into session_event_cursors (session_id, history_backfilled_at)
         values ($1, $2)
         on conflict (session_id) do update
           set history_backfilled_at = excluded.history_backfilled_at,
               updated_at = now()`,
        [session.id, now],
      );
      cached += 1;
      events += projected.length;
      console.log(
        `  cached ${projected.length} event(s) for ${session.id} (${session.title || "untitled"})`,
      );
    } catch (error) {
      console.error(`  failed for ${session.id}:`, error);
    }
  }

  console.log(`cached ${events} event(s) across ${cached} Session(s)`);
} catch (error) {
  console.error("event log backfill failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
