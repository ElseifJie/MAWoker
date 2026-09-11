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
- **PostgreSQL** — schema is managed with Drizzle migrations under `packages/db/migrations`

## Getting started

```bash
cp .env.example .env        # then fill in the required values
npm install
npm run db:migrate
npm run dev                 # starts api + web + worker together
```

`ARK_API_KEY`, the TOS credentials and `DATABASE_URL` are required; see `.env.example` for every
variable and its meaning.

## Common scripts

| Script                                            | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `npm run dev`                                     | Run api, web and worker in watch mode                   |
| `npm run build`                                   | Build all workspaces                                    |
| `npm run typecheck`                               | Type-check every workspace (`tsc -b`)                   |
| `npm run lint`                                    | ESLint                                                  |
| `npm run format:check`                            | Prettier check                                          |
| `npm test`                                        | Unit + integration tests (Vitest)                       |
| `npm run test:e2e`                                | Playwright end-to-end tests                             |
| `npm run test:acceptance`                         | End-to-end acceptance scenarios                         |
| `npm run db:generate` / `db:migrate` / `db:check` | Drizzle migration workflow                              |
| `npm run verify`                                  | The full gate: format + lint + typecheck + test + build |

## Project layout

```text
apps/       api, web, worker
packages/   ark-client, auth, config, contracts, db, domain, storage
specs/      product requirements, design and task breakdown
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
