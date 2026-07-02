# PGlite (embedded Postgres) for development and tests

The plan commits to PostgreSQL, but this machine has neither a Postgres install nor Docker. Rather than making infrastructure a prerequisite for contributing, the server runs on PGlite — Postgres 16 compiled to WASM, in-process, file-backed in dev and in-memory in tests. It executes the same SQL and DDL as a real server (partial indexes, transactions, `for update` all work), so nothing in the schema or queries is PGlite-specific.

## Consequences

- Tests spin up a fresh real-Postgres database per test in milliseconds with zero setup — no mocks, no fixtures drift.
- Deploying "for real" later means swapping `createDb()` in `server/src/db/db.ts` for a `pg` pool; the SQL is unchanged.
- PGlite is single-connection: fine for a friend-group server, but it means concurrency is serialized in dev. Row-locking (`for update`) is still written into the queries so the real-Postgres swap needs no query changes.
