# MAWork (`personal-work-agent`)

A multi-tenant web AI coworker built on [Volcengine Ark Managed Agents](https://www.volcengine.com/product/ark).
It runs delegated tasks end-to-end and returns finished work — documents, spreadsheets, decks and other
artifacts — rather than only replying with chat.

Each user gets an isolated workspace: sessions are bound to an Agent, streamed live over SSE, and can
produce downloadable artifacts. Administrators manage the platform Agents, per-user default Agents and
quotas.

## Architecture

| Unit                  | Responsibility                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify HTTP + SSE service: auth, sessions, inputs, artifacts, admin, static SPA hosting |
| `apps/web`            | React + Vite single-page app (session timeline, artifacts, agent management, admin)      |
| `apps/worker`         | Background jobs: deletion sagas, event/usage reconciliation, quota interrupts, cleanup   |
| `packages/contracts`  | Shared DTOs, event types, validation schemas and redaction rules                         |
| `packages/config`     | Typed environment configuration and startup validation                                   |
| `packages/db`         | Drizzle schema, migrations and repositories (PostgreSQL)                                 |
| `packages/domain`     | Agent / Session / File / Quota business rules                                            |
| `packages/ark-client` | Ark Managed Agents API client (`HttpArkGateway`, plus an in-memory stub for tests)       |
| `packages/auth`       | Managed-identity adapter interface and app-session service                               |
| `packages/storage`    | TOS (S3-compatible) artifact storage client                                              |

Sessions and events are authoritative on Ark; MAWork keeps a local projection for fast reads and stores
only what it must (identifiers, ownership, status, quotas, audit).

## Documentation

- [Documentation index](docs/README.md)
- [Architecture diagrams](docs/assets/diagrams/README.md)
- [Backup and restore](docs/runbooks/backup-restore.md)
- [Event ingestor cutover](docs/runbooks/event-ingestor-cutover.md)
- [Shell and panel parity checklist](docs/ui/harness-parity.md)

## Stage A reliability

The browser submits the first message with session creation (`submissionId`, `content`,
`uploadIds`, and optional `temporary`) and receives a durable `202` receipt. Follow-up messages
use the same submission ID protocol. The Worker creates the remote session and delivers the
accepted local intent; opening an SSE connection is not required to start work. Unknown upstream
outcomes remain fenced for reconciliation and are never automatically resent.

The Worker also repairs persisted history and records completed turns, copies available results
to the user's Drive, and creates deduplicated task notifications. Text results become available
after a short visibility grace period; undeclared late files are checked through the retry window.
Known but unavailable files remain pending, then show a recoverable synchronization failure.
The task page includes a recovery action, and the sidebar shows unread task notifications.

Apply migrations before deploying the updated API and Worker:

```bash
npm run build
npm run db:check
npm run db:migrate
```

Migrations `0028` and `0029` add history checkpoints, scan generations and stable local event
sequences; legacy events are marked for verification. Migration `0030` adds `session_turns`,
`user_notifications` and delivery scheduling. These are additive changes; do not remove the
tables to roll back. Migration `0028` also backfills persisted sequence maxima: if an earlier
unreleased version of it has already been applied, coordinate a corrective migration instead
of editing the applied migration in place.

Start with an isolated test deployment and a small batch:

| Setting                                                      | Default  | Effect                                        |
| ------------------------------------------------------------ | -------- | --------------------------------------------- |
| `SESSION_SUBMISSION_ADMISSION_ENABLED`                       | `true`   | Admit new durable task/message submissions    |
| `FILE_REUSE_ADMISSION_ENABLED`                               | `true`   | Admit new existing-file material preparations |
| `SESSION_HISTORY_ENABLED`                                    | `true`   | Periodic background event repair              |
| `SESSION_DELIVERY_ENABLED`                                   | `true`   | Background turn discovery and result copying  |
| `SESSION_HISTORY_BATCH_SIZE` / `SESSION_DELIVERY_BATCH_SIZE` | `2`      | Sessions selected per poll                    |
| `SESSION_HISTORY_COOLDOWN_MS`                                | `60000`  | Base history retry delay                      |
| `SESSION_HISTORY_TIMEOUT_MS` / `SESSION_DELIVERY_TIMEOUT_MS` | `30000`  | External work budget                          |
| `SESSION_ARTIFACT_RETRY_WINDOW_MS`                           | `300000` | Automatic late-file reconciliation window     |
| `SESSION_ARTIFACT_EMPTY_GRACE_MS`                            | `30000`  | Grace before text-only completion             |

These are independent deployment switches. Admission gates only reject new requests:
paused durable intake returns retryable `503 SUBMISSION_ADMISSION_PAUSED`, while exact known
submission IDs still replay their existing receipt (changed content still conflicts). Paused
reuse returns retryable `503 FILE_REUSE_ADMISSION_PAUSED` before reserving or reading bytes.
Existing file reads/deletes and already accepted submission reconciliation continue. Legacy
requests without submission IDs retain their existing behavior; close their ingress route too
if an operational rollback must stop all task/message intake. API configuration changes need
an API restart/redeploy; keep the current Worker running to drain accepted durable jobs.

Initial gray rollout uses an isolated deployment restricted to named test users through
existing ingress/auth provisioning; application per-user allowlists are not required.

1. Provision a separate test deployment and dedicated storage/database resources. Record the
   named test users; configure existing ingress access rules and auth provisioning so only
   those accounts can enter. Verify a non-test account cannot access it before enabling intake.
2. Apply additive migrations once and record the version. Begin with both admission gates
   disabled. Check health and retained receipt/history/file reads for the named accounts.
3. Enable `SESSION_SUBMISSION_ADMISSION_ENABLED` for stage A, keeping B reuse disabled.
   Verify new-task/follow-up acceptance, exact replay, offline history and a delivered round.
4. Enable `FILE_REUSE_ADMISSION_ENABLED` for stage B. Verify own-file reuse, source deletion
   with another task still referencing its bytes, cancellation, and delayed copy cleanup.
5. For rollback, disable the affected admission gate and redeploy the API first. Keep Worker
   delivery/reconciliation active to drain accepted jobs. If result copying must pause, disable
   `SESSION_DELIVERY_ENABLED`; to freeze both history/result discovery also disable
   `SESSION_HISTORY_ENABLED`. Preserve receipts, reservations and migrations. Record remaining
   queued/unknown receipts and resolve unknown outcomes with upstream evidence, without resend.
6. Record request/submission IDs, migration/deployment version and acceptance results before
   expanding ingress access beyond named testers. Real-cloud Ark receipt visibility/idempotency,
   offline reconciliation, TOS/reference cleanup and UI acceptance are **pending**; local tests
   do not establish those acceptance results.

Turning delivery off freezes retry
attempt consumption; resuming extends the file retry deadline. Turning history off disables
its periodic processor, while enabled delivery discovery and explicit exports can still
reconcile history. To freeze both background paths, set both switches to `false`. An export
whose fresh history could not be persisted returns `409 EVENT_HISTORY_REPAIR_PENDING`;
retry after repair rather than treating the existing partial data as complete.

For an unknown message outcome, an administrator with `USER_MANAGE` can request a read-only
upstream evidence check through
`POST /api/v1/admin/users/:userId/submissions/:submissionId/reconcile`, with JSON body
`{"sessionId":"<local-session-uuid>"}`. Use the request/submission identifiers shown on the task.
This action only accepts a recorded matching upstream receipt; it cannot force acceptance or
trigger a resend. Preserve unresolved receipts and quota reservations when evidence is absent.
When reverting to an older submission implementation, stop accepting new submissions first
and drain or freeze pending delivery jobs; never run browser and Worker first-message delivery
for the same task simultaneously.

Local regression fixtures do not prove upstream idempotency or real cloud file visibility.
File attribution uses creation timestamps, session input exclusions and the next observed
user-message boundary. Past turns do not refresh files that may have been edited later;
Ark's current inventory cannot recover an overwritten historical version. Files with no
reachable TOS location remain recoverable failures. The next stages still cover pagination,
full notification/usage UX, resource limits and visual refinements.

PostgreSQL contention tests create and remove their own schemas. Point them at a disposable
database, then run `TEST_POSTGRES_URL=<test-url> npm run test:postgres`; the script runs the ten
real-PostgreSQL suites serially and refuses to start without the URL. UI verification here uses
component interactions and build checks; real cloud and browser layout acceptance are separate.

## Stage B workspace and file reuse

The personal workspace now opens with 新任务, 历史任务 and 我的文件. Assistant and memory
configuration remain under Settings, and existing assistant links redirect to their new location.
Task execution and connection status are separate; an ordinary idle observation does not imply
completion. Reading older messages preserves the scroll position and offers a latest-message action.

Materials retain their original display names while upstream filenames and mount paths use safe
names. Each task accepts at most 20 materials, 20 MiB per material and 100 MiB in total. Browser
uploads use at most three concurrent requests and support cancellation. Server checks remain
authoritative; user-wide storage, bandwidth and aggregate concurrency controls belong to Stage C.

An existing result can be selected as a new task's material. The server checks ownership, pins the
Drive/object version in a durable input reference, reads private bytes and uploads a separate Ark
input. Deleting the source task does not remove a surviving reference. Retired object versions
remain protected until references end, then their cleanup jobs resume. Failed preparation leaves
durable cleanup accounting. Interrupted create responses can replay the same submission and actual
input IDs after reload; editing an attempted request allocates a new submission ID.

Apply additive migration `0031_bumpy_lady_vermin.sql` before running the updated API/Worker:

```bash
npm run build
npm run db:check
npm run db:migrate
```

It adds `session_inputs.reused_object_key` and indexes for Drive/key references. Keep these fields
and the cleanup jobs when reverting application code. Migration validation uses disposable
databases; applying the migration to a deployment is a separate operator step.

The “使用个人记忆” switch maps to `temporary`; disabling it skips personal memory mounts and
subsequent extraction sources while keeping the conversation. Memory settings show categories
and explicit sources, distinguish automatic organization from assistant-native reads/writes,
and retain revision checks and maintenance locks. “保护” limits background organization only.

HTML and converted Office previews use `/preview-frame`, a blank document with its own CSP.
The sandbox omits scripts, external resources and forms; inline preview styles do not loosen the
main application's CSP. Keep `/preview-frame` routed to the API when deploying behind a proxy.
The Vite development proxy already includes that route.

XLSX preview is read-only and bounded to 200 ZIP entries, 10 MiB expanded data, 10 worksheets,
200 rows and 50 columns per worksheet, 10,000 cells overall and 1,000,000 text characters.
Formula cells display a placeholder and external workbook relationships are not loaded.
Unsupported or oversized documents remain downloadable. Preview reads enforce actual byte
limits, abort on close and revoke object URLs. Office parser work already in progress may finish
after close; it cannot update the closed viewer.

Running-task attachments use the approved “摘要与材料创建后续任务” flow. The user confirms
the summary and selected material before sending; it does not copy the full remote environment.
Interactive HTML is not enabled without a separate environment free of main-site credentials.
Real cloud attachment behavior, browser CSP rendering and visual layout/zoom acceptance still
require isolated cloud or user verification. This stage uses non-visual automated checks.

## BtoC capabilities

The current product adds the following customer-facing flows on top of the Stage A/B workspace:

- **Invite-only onboarding.** Administrators create one-time invite links; invitees set a password
  at `/invite?code=…`. Only hashed codes are stored, and invite create/revoke/accept are audited.
- **Account controls.** Settings exposes active login devices with “sign out other devices”, a
  full owner-scoped JSON export, self-service account deletion (password + `DELETE`
  confirmation; the account is anonymized, sessions are revoked, and connector/memory rows are
  removed), and versioned privacy/terms acceptance with retention guidance.
- **Automations.** Daily/weekly/once reminders and scheduled tasks. Reminders create deduplicated
  in-app notifications; tasks run with the user's current default Agent. Optional webhook channels
  deliver Feishu text or generic JSON payloads.
- **Connectors.** Owner-scoped remote MCP servers with HTTPS/SSRF validation. Active servers are
  serialized into personal Agent `mcp_servers` and `mcp_toolset` entries (always-ask) on create or
  update.
- **PWA and cross-browser sync.** Installable manifest/service worker, install prompt, and a
  per-browser account cursor that polls `/sync/changes` and refreshes session lists.
- **Operations.** Admin system status (queue/Run/reminder backlog, event-ingestor leases and lag),
  prompt-injection-safe audit views, and `db:backup` / `db:restore` scripts with credential-redacted
  logs.

Known gaps are tracked in the implementation plan and checkpoint appendices (git-ignored):

- The production shell now runs on `WorkspaceFrame` with a narrow drawer and resizable rails.
  Split/floating panels and a full artifact-list panel are still pending.
- The event ingestor shadow/local switch is code-complete but defaults to upstream; the operator
  checklist lives in `docs/runbooks/event-ingestor-cutover.md`.
- Ark Vault, OAuth, and the live Feishu read/write loop are not implemented; MCP registration and
  Agent tool binding are.
- Account deletion is an anonymizing soft delete. TOS/Ark physical purge and retention policy are
  still pending.
- Everything above is covered by PGlite/local tests. Real Ark cloud runs, managed PostgreSQL
  contention tests, backup-restore drills, and visual acceptance remain operator work.

## Requirements

- **Node.js >= 22.12** (the repo uses npm workspaces)
- **PostgreSQL**, running and reachable — the schema is managed with Drizzle migrations under
  `packages/db/migrations`

## Getting started

Follow the five steps in order. Steps 1, 2 and 3 each have a failure mode that is easy to hit on a
fresh clone; the notes below explain what to do if you do.

### 1. Start PostgreSQL and create the database

Pick the option that matches how you installed PostgreSQL.

**macOS (Homebrew)**

```bash
brew install postgresql@17
brew services start postgresql@17
createdb personal_work_agent
```

Homebrew's `initdb` runs as your macOS account and `pg_hba.conf` trusts local connections, so the
superuser is your login name and no password is sent. Confirm both before moving on:

```bash
psql -d postgres -c "SELECT current_user;"   # prints your macOS username
```

**Docker**

```bash
docker run -d --name mawork-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=personal_work_agent \
  -p 5432:5432 postgres:17
```

**Linux (apt / dnf)**

The `postgres` OS account owns the cluster, so create the database as that user and give the role a
password you can put in the URL:

```bash
sudo -u postgres createdb personal_work_agent
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Then set `DATABASE_URL` to match what you started above. The template ships
`postgres://user:password@localhost:5432/...`, which connects as a role named `user`. That role does
not exist on a fresh cluster, and the first migrate fails with `role "user" does not exist` — so
replace it with your real role, and omit the password when your cluster trusts local connections:

| Setup             | `DATABASE_URL`                                                        |
| ----------------- | --------------------------------------------------------------------- |
| Homebrew (macOS)  | `postgres://<your-macos-username>@localhost:5432/personal_work_agent` |
| Docker            | `postgres://postgres:postgres@localhost:5432/personal_work_agent`     |
| Linux (peer user) | `postgres://postgres:postgres@localhost:5432/personal_work_agent`     |

The other variables are listed in `.env.example` with their meanings. Three groups are worth calling
out:

- **Administrator seed values** — uncomment the block at the bottom of `.env` and fill it in. These are
  read by `npm run admin:seed`, not by the server:

  ```
  ADMIN_EMAIL=you@example.com
  ADMIN_PASSWORD=<at least 8 characters>
  # ADMIN_RESET=1
  ```

- **Ark and TOS placeholders** — the server boots with the `your-*` placeholders, but any call that
  talks to Volcengine fails until you replace `ARK_API_KEY`, `ARK_ENVIRONMENT_ID` and the `TOS_*`
  values with real credentials. `TOS_SESSION_TOKEN` must be either a real temporary token or the
  entire line deleted: leaving it present but empty fails startup validation.

- **`OIDC_*`** — reserved for a future hosted identity provider. Sign-in does not use them, so the
  placeholders can stay as-is.

### 3. Install, build, migrate

```bash
npm install
npm run build
npm run db:migrate
```

`npm run build` is not optional here. `db:migrate` executes the **compiled**
`packages/db/dist/migrate.js` and has no prebuild hook, so on a fresh clone it fails with
`Cannot find module '/…/packages/db/dist/migrate.js'` until the TypeScript is compiled.
`npm run build -w @pwa/db` is enough if you would rather not build every workspace.

### 4. Create the administrator

```bash
npm run admin:seed
```

This creates the account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` and seeds the default row in
`quota_policies`, which the runtime reads for per-user limits. The four limits come from
`PERSONAL_AGENT_LIMIT`, `CONCURRENT_SESSION_LIMIT`, `SESSION_DAILY_LIMIT` and `MONTHLY_TOKEN_LIMIT`;
the row is upserted, so re-running with different values updates it. Pass `ADMIN_RESET=1` to rotate an
existing administrator's password.

### 5. Run it

```bash
npm run dev                 # api + web + worker in watch mode
```

- Web app: <http://localhost:5173>
- API: <http://localhost:3000> — `GET /health` returns `{"status":"ok"}`

Sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you seeded in step 4. To confirm the database setup
independently, check that migrations landed:

```bash
psql -d personal_work_agent -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';"   -- 17
```

## Common scripts

| Script                                            | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                                     | Run api, web and worker in watch mode                                    |
| `npm run build`                                   | Build all workspaces                                                     |
| `npm run typecheck`                               | Type-check every workspace (`tsc -b`)                                    |
| `npm run lint`                                    | ESLint                                                                   |
| `npm run format:check`                            | Prettier check                                                           |
| `npm test`                                        | Unit + integration tests (Vitest)                                        |
| `npm run test:e2e`                                | Playwright end-to-end tests                                              |
| `npm run test:acceptance`                         | End-to-end acceptance scenarios                                          |
| `npm run db:generate` / `db:migrate` / `db:check` | Drizzle migration workflow                                               |
| `npm run db:backup`                               | Timestamped `pg_dump` backup; see `docs/runbooks/backup-restore.md`      |
| `npm run db:restore`                              | Guarded `pg_restore`; requires `RESTORE_CONFIRM=restore` and `--yes`     |
| `npm run admin:seed`                              | Create or repair the administrator from `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| `npm run data:reset`                              | **Destructive:** truncates all user-owned data; see the warning below    |
| `npm run verify`                                  | The full gate: format + lint + typecheck + test + build                  |

### `npm run data:reset`

This truncates every user-owned table — sessions, inputs, artifacts, usage, audit history, personal
Agents, default-Agent assignments and quota overrides — and restarts identity sequences. Platform Agent
configuration is preserved and re-pointed at the newly seeded administrator, because the Ark managed
agents it references live outside this database. It is a development convenience, not a setup step:
step 4 already seeds the administrator and the default quota policy.

## Project layout

```text
apps/       api, web, worker
packages/   ark-client, auth, config, contracts, db, domain, storage
docs/       local archive of past plans and design docs (git-ignored)
scripts/    operational scripts (admin seed, data reset, healthchecks)
tests/      unit, integration and end-to-end tests
```

## Security

- Secrets are read only from `.env` (git-ignored). `.env.example` contains placeholders — never commit
  real credentials.
- The session event stream is redacted, whitelisted and truncated before it reaches the browser, and is
  visible only to the session owner.
- Webhook channel URLs are encrypted at rest with AES-256-GCM when
  `CREDENTIAL_ENCRYPTION_KEY` (base64, 32 bytes) is configured; production should set it.
- Test fixtures under `tests/fixtures` are synthetic: identifiers, URLs, credentials and message text
  are fabricated, with fake credential-shaped strings retained as bait for the redaction tests.

## License

[MIT](./LICENSE)
