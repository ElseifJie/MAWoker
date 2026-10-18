# Event ingestor cutover

Status: prepared 2026-10-18. The production default is still `upstream`; this
runbook is the operator checklist for moving SSE reads to the persisted log.

## Current defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| `SESSION_EVENT_INGESTOR_ENABLED` | `false` | The worker does not claim session consumers |
| `SESSION_EVENT_SOURCE` | `upstream` | Each SSE connection reads the Ark runtime |
| `SESSION_EVENT_INGESTOR_LEASE_MS` | `30000` | Consumer lease duration |
| `SESSION_EVENT_INGESTOR_BUDGET_MS` | `5000` | Per-run upstream read budget |
| `SESSION_EVENT_INGESTOR_BATCH_SIZE` | `2` | Concurrent sessions per run |

Local reads require the ingestor to be enabled; otherwise no new rows reach
`session_events` and the page would stall.

## 1. Shadow

1. Deploy the worker with `SESSION_EVENT_INGESTOR_ENABLED=true` and keep
   `SESSION_EVENT_SOURCE=upstream`.
2. Open one real session in two browser tabs.
3. Confirm the admin **系统状态** page:
   - 事件消费者 is at least 1;
   - 过期租约 stays 0 (or is explained by a worker restart);
   - 最后消费 advances while the session runs;
   - 最久未消费 stays inside the expected idle window.
4. Compare the local projection with the upstream page: the same turn, tool and
   artifact events appear once, in the same order, with no duplicate turn rows.
5. Let the shadow run through at least one full task, one reconnect, and one
   worker restart.

Shadow does not change what users read. It only writes projections.

## 2. Local reads on one staging session

1. Set `SESSION_EVENT_SOURCE=local` for the staging API (keep the ingestor on).
2. Open a session with an existing event history and a live turn.
3. Verify:
   - the historical timeline renders from `GET /api/v1/sessions/:id/events`;
   - a new event appears without a page reload;
   - closing and reopening the stream resumes from `Last-Event-ID` with no gap;
   - a second tab does not create a second upstream stream (check the Ark
     session/usage side).
4. If the page stalls, immediately set `SESSION_EVENT_SOURCE=upstream`; the
   ingestor can stay enabled while you investigate.

## 3. Production cutover

1. Flip `SESSION_EVENT_SOURCE=local` for the API deployment.
2. Watch the admin system page for 30 minutes:
   - 事件消费者 > 0 for active sessions;
   - 过期租约 does not grow;
   - 最后消费 / 最久未消费 stay bounded;
   - no spike in failed or unknown Runs.
3. Keep the ingestor enabled. Do not delete `session_events` or consumer rows.

## Rollback

- Set `SESSION_EVENT_SOURCE=upstream` and restart the API. No data migration is
  required; the local projection remains available for the next attempt.
- The ingestor may remain enabled during rollback; it only writes.
- Do not clear leases or event rows as part of a rollback.

## Reconciliation queries

Run against the application database while investigating:

```sql
-- Consumers and lease health
select count(*) as consumers,
       count(*) filter (where lease_until <= now()) as expired,
       max(last_consumed_at) as last_consumed,
       min(last_consumed_at) as oldest_consumed
  from session_event_consumers;

-- Local event totals per session
select session_id, count(*) as events, max(local_sequence) as last_sequence
  from session_events
 group by session_id
 order by last_sequence desc
 limit 20;

-- Duplicate upstream event ids (should return no rows)
select session_id, upstream_event_id, count(*)
  from session_events
 group by session_id, upstream_event_id
having count(*) > 1;

-- Sessions with a consumer but no recent consumption
select session_id, owner_user_id, last_event_id, last_consumed_at
  from session_event_consumers
 where last_consumed_at is null
    or last_consumed_at < now() - interval '10 minutes';
```

## Exit criteria

- Shadow ran for at least 24 hours with no unexplained lag and no duplicate
  upstream reads.
- A staging session passed replay, live append, reconnect, and two-tab checks.
- The admin page has thresholds (expired leases > 0 or lag > 10 minutes) and an
  owner who can act on them.
- The rollback switch has been exercised once.
