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
docs/       working plans and design specs
specs/      product requirements, design and task breakdown
scripts/    operational scripts (admin seed, data reset, healthchecks)
tests/      unit, integration and end-to-end tests
```

## Security

- Secrets are read only from `.env` (git-ignored). `.env.example` contains placeholders — never commit
  real credentials.
- The session event stream is redacted, whitelisted and truncated before it reaches the browser, and is
  visible only to the session owner.
- Test fixtures under `tests/fixtures` are synthetic: identifiers, URLs, credentials and message text
  are fabricated, with fake credential-shaped strings retained as bait for the redaction tests.

## License

[MIT](./LICENSE)
