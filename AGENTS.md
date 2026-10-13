# Working preferences

- For UI-related changes, do not verify with screenshots or browser-based visual checks. Finish the change, run the relevant non-visual tests, then report back — the user will verify the UI themselves.
- The user manages the dev servers (`npm run dev`) manually. Never leave the app running: if a task requires starting it, stop every related process (api, web, worker, concurrently, tsx watch) and verify ports 3000/3001/5173 are freed before reporting back.

## Execution and verification

These project preferences take precedence over generic skill workflows that add repeated testing or review loops. Preserve required correctness and security checks.

1. Work in small, coherent batches with explicit scope and acceptance criteria. Cover critical integration risks early: the real UI entry point (including StrictMode), unmount/late responses, ownership, idempotency, deletion and transaction races.
2. During implementation, run tests for the affected behavior and dependencies. UI copy/style changes need relevant non-visual component and Web checks; backend changes need affected domain/API/database checks. Changes to transactions, leases or reference protection require isolated real PostgreSQL verification, not mocks alone. Shared contracts, schema, authentication and dependency changes warrant broader coverage. Documentation-only edits need formatting and diff inspection, not runtime suites.
3. Review each batch once. After fixes, re-review the reported findings and fix-induced regressions; keep unrelated unchanged code outside that review. Finish module and integration reviews before freezing the source for the final full gate.
4. Aim for one final full-suite run per completed integration batch. Repeat or broaden verification only for new changes, failures, environment changes or unresolved risks; state the reason. A branch switch or fast-forward to the identical tested tree does not require another full run.
5. Record commands, coverage, results, skipped checks and the tested commit or file/dependency hashes in a concise checkpoint. Reuse passing evidence only while the relevant source, dependencies and test environment remain unchanged. Resume from the checkpoint after interruptions rather than restarting completed work.
6. Run heavy database tests serially or with low concurrency. Schedule typechecking/builds separately from heavy tests when they compete for resources; parallelize independent lightweight checks where useful.
7. Keep authorized delegation and review context bounded: avoid concurrent edits to shared files, provide focused requirements/diffs/interfaces and existing evidence, and avoid repeated whole-project reads by every agent. Save stable checkpoints to reduce recovery work after quota interruptions.
