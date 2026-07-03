# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project State

The core design is decided (see `docs/game-project-plan.md`, the decision log) and the **vertical slice is built**: a server in `server/` implementing the Scavenge Mission end to end. The canonical domain vocabulary is `CONTEXT.md` at the repo root — use its terms in all code and docs. Architectural decisions live in `docs/adr/`; read them before changing how time, storage, or persistence work.

## Commands

All run from `server/`:

- `npm test` — full test suite (Vitest; each test gets a fresh in-memory PGlite database, no infra needed)
- `npm run typecheck` — TypeScript, no emit
- `npm run dev` — start the dev server on port 3000 (file-backed DB in `server/data/`, auto-seeds the world)
- `npm run seed` — seed the world standalone

There is no lint setup yet.

## What Is Being Built

A persistent, asynchronous multiplayer management game (browser MMO) for a small friend group — slow-burn strategy where players check in once a day or so, progress accrues over real time, and **missing a day is not punishing** (the load-bearing design pillar).

Key decisions (details and dates in the project plan; vocabulary in `CONTEXT.md`):

- **Setting:** post-apocalyptic Mad Max-styled real-world Scandinavia, modeled as a node graph of real Locations connected by road Routes. NPC powers (AI factions, remnant governments) are ordinary Factions the server plays.
- **Core loop:** crew dispatch — Missions take real-world hours; resources (Scrap/Fuel/Water/Survivors) accrue per-Outpost from Location yields × upgrades.
- **Conflict:** claims resolve via contest windows; Outposts are capturable only through slow (~72h) public Sieges that anyone can help break; the HQ is untouchable; running dry causes Dormancy (stagnation), never loss.
- **Shared persistent world** — server is the single source of truth; clients are never trusted with state.
- **Gameplay before graphics** — asset/animation files must be produced with design tools or an artist, not generated.
- **Client (not started):** React Native (web + iOS + Android) with React Native Skia / Expo graphics — no game engine.

Still open (do not assume): world permanence (seasons vs. eternal — explicitly deferred), faction lore, all numeric tuning values, content details (see "Open Design Questions" in the plan).

## Architecture Pillars

- **Authoritative server:** every game action is validated server-side inside a transaction; competing actions resolve by explicit deterministic rules.
- **Time model (ADR-0001):** NO global tick. Continuous accrual is computed on read (`settleStore`); discrete happenings are `due_events` rows processed by a scheduler. Never read store amounts raw; always settle. Settle before every rate change.
- **Per-Outpost stores (ADR-0002):** resources live on Outposts, not in a faction wallet.
- **Database (ADR-0003):** PGlite (embedded Postgres) for dev/tests; production swaps in a real Postgres pool with the same SQL.
- **Real-time layer:** WebSockets push world changes; standard actions go through the REST API.

## Repository Layout

- `docs/game-project-plan.md` — the project plan and decision log; keep it updated as decisions are made.
- `CONTEXT.md` — the domain glossary (ubiquitous language); `docs/adr/` — architecture decision records.
- `docs/db-schema.md` — full schema draft; `server/src/db/schema.sql` — the vertical-slice subset actually applied.
- `server/` — the game server (TypeScript, Fastify, PGlite): `src/domain/` pure game rules and transactional operations, `src/api/` HTTP + WebSocket layer, `src/world.ts` seed data, `test/` Vitest suites, `public/` a throwaway single-file map client served by the dev server (disposable; the real client will be React Native).
- `.claude/skills/` and `.agents/skills/` — installed agent skills (mirrored copies, mostly from `mattpocock/skills`), pinned by `skills-lock.json` at the repo root. Don't hand-edit these; they are managed by the skills installer.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `mikkelmalik/Browser-MMO`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
