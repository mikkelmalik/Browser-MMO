# Database Schema Draft

PostgreSQL schema derived from the decisions in [game-project-plan.md](./game-project-plan.md) and the vocabulary in [CONTEXT.md](../CONTEXT.md). Table and column names use the canonical glossary terms.

Status: **draft** — shapes are decided, numeric tuning values (caps, rates, durations) are placeholders per open question #3 in the plan.

## Conventions

- `uuid` primary keys (`gen_random_uuid()`), `timestamptz` everywhere, all times UTC.
- Resource quantities are `numeric` — lazy accrual produces fractional amounts.
- Every game-state mutation happens in a transaction that re-validates preconditions (authoritative server); `CHECK`/`UNIQUE` constraints below are the last line of defense, not the only one.
- Per ADR-0001: no global tick. Stored amounts are **settled values** valid at `settled_at`; readers compute the live value. Discrete resolutions go through `due_events`.

## Identity & Factions

```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- A Faction is any territory-holding power. owner_user_id NULL = NPC Faction
-- (the server makes its decisions). One player controls exactly one Faction.
create table factions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  owner_user_id     uuid unique references users(id),
  last_seen_at      timestamptz,                 -- drives Surge eligibility (players only)
  surge_expires_at  timestamptz,                 -- non-null while a Surge is active
  created_at        timestamptz not null default now()
);
```

## Map: Locations & Routes

```sql
-- Named real-world places; nodes of the map graph.
create table locations (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,        -- 'ruined-aarhus'
  name                    text not null,               -- 'Ruined Aarhus'
  kind                    text not null,               -- 'city_ruins' | 'refinery' | 'reservoir' | ...
  lat                     double precision not null,
  lon                     double precision not null,
  -- Inherent yields (base units/hour). Location yields × Outpost upgrades = production.
  scrap_yield             numeric not null default 0,
  fuel_yield              numeric not null default 0,
  water_yield             numeric not null default 0,
  controlling_faction_id  uuid references factions(id) -- null = unclaimed wasteland
);

-- Road connections; undirected edges. All movement is along Routes.
create table routes (
  id              uuid primary key default gen_random_uuid(),
  location_a_id   uuid not null references locations(id),
  location_b_id   uuid not null references locations(id),
  distance_km     numeric not null,
  fuel_cost       numeric not null,       -- Fuel burned per Crew traversal
  travel_minutes  integer not null,
  check (location_a_id < location_b_id),  -- canonical ordering; one row per edge
  unique (location_a_id, location_b_id)
);
```

## Outposts & Stores

```sql
create table outposts (
  id           uuid primary key default gen_random_uuid(),
  faction_id   uuid not null references factions(id),
  location_id  uuid not null unique references locations(id),  -- at most one Outpost per Location
  is_hq        boolean not null default false,
  survivors    integer not null default 0,
  -- Dormancy (ADR-0001 settlement): the projected instant Water hits zero given
  -- current rates. Accrual for ALL resources is clamped at this instant when
  -- settling. Recomputed on every rate or amount change; null = never runs dry.
  dormant_at   timestamptz,
  founded_at   timestamptz not null default now()
);

create unique index one_hq_per_faction on outposts (faction_id) where is_hq;

-- Per-Outpost resource stores (see ADR-0002: no faction-wide wallet).
-- amount is the settled value as of settled_at; live value =
--   clamp(amount + rate_per_hour * hours_since(settled_at, capped at dormant_at), 0, capacity)
create table outpost_stores (
  outpost_id     uuid not null references outposts(id) on delete cascade,
  resource       text not null check (resource in ('scrap', 'fuel', 'water')),
  amount         numeric not null default 0,
  rate_per_hour  numeric not null default 0,   -- net rate; negative allowed (Water upkeep)
  capacity       numeric not null,             -- storage cap (catch-up mechanic)
  settled_at     timestamptz not null default now(),
  primary key (outpost_id, resource)
);

-- Buildings multiply the Location's inherent yields and set storage capacity.
create table outpost_buildings (
  outpost_id  uuid not null references outposts(id) on delete cascade,
  building    text not null,                   -- 'scrap_yard' | 'fuel_still' | 'water_tank' | ...
  level       integer not null default 1 check (level >= 1),
  primary key (outpost_id, building)
);
```

Survivors are an integer population on the Outpost, not a store row — they don't accrue continuously and are never fractional.

## Crews & Missions

```sql
create table crews (
  id           uuid primary key default gen_random_uuid(),
  faction_id   uuid not null references factions(id),
  name         text not null,
  size         integer not null check (size > 0),   -- Survivors assigned to the Crew
  location_id  uuid not null references locations(id),
  status       text not null default 'idle' check (status in ('idle', 'on_mission')),
  created_at   timestamptz not null default now()
  -- vehicles/equipment: later content (open question #4); power is computed, not stored
);

create table missions (
  id                  uuid primary key default gen_random_uuid(),
  crew_id             uuid not null references crews(id),
  faction_id          uuid not null references factions(id),
  kind                text not null check (kind in
                        ('scavenge', 'claim', 'contest', 'raid', 'siege', 'break_siege', 'escort')),
  origin_outpost_id   uuid not null references outposts(id),
  target_location_id  uuid not null references locations(id),
  status              text not null default 'underway' check (status in
                        ('underway', 'completed', 'failed', 'cancelled')),
  departed_at         timestamptz not null default now(),
  due_at              timestamptz not null,
  resolved_at         timestamptz,
  outcome             jsonb                          -- what happened: haul, casualties, ...
);

create index missions_active on missions (faction_id) where status = 'underway';
```

Dispatch preconditions (validated in the dispatch transaction, not by constraints): the Crew is `idle`, it is at the origin Outpost's Location, a Route path to the target exists, and the origin's Fuel store settles to ≥ the path's total `fuel_cost`.

## Due-Time Queue (ADR-0001)

```sql
-- The only scheduler in the system: poll rows where processed_at is null and
-- due_at <= now(), resolve each in its own transaction, mark processed.
create table due_events (
  id            bigint generated always as identity primary key,
  due_at        timestamptz not null,
  kind          text not null check (kind in
                  ('mission_due', 'claim_window_close', 'siege_end', 'surge_expiry')),
  ref_id        uuid not null,                       -- missions.id / claims.id / sieges.id / factions.id
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index due_events_pending on due_events (due_at) where processed_at is null;
```

## Conflict: Claims, Sieges, Reports

```sql
-- A Claim plants a flag on a Location and must survive its contest window.
create table claims (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id),
  claimant_faction_id   uuid not null references factions(id),
  mission_id            uuid not null references missions(id),
  opened_at             timestamptz not null default now(),
  closes_at             timestamptz not null,        -- window length: tuning knob
  status                text not null default 'open' check (status in
                          ('open', 'won', 'lost', 'withdrawn'))
);

create unique index one_open_claim_per_location on claims (location_id) where status = 'open';

create table claim_contests (
  claim_id    uuid not null references claims(id),
  faction_id  uuid not null references factions(id),
  mission_id  uuid not null references missions(id),
  primary key (claim_id, faction_id)
);

-- A Siege is multi-day and publicly visible; the defender and ANY other
-- Faction can send Crews to break it (informal aid — no alliance tables).
create table sieges (
  id                    uuid primary key default gen_random_uuid(),
  outpost_id            uuid not null references outposts(id),
  attacker_faction_id   uuid not null references factions(id),
  started_at            timestamptz not null default now(),
  ends_at               timestamptz not null,        -- ~72h: tuning knob
  status                text not null default 'underway' check (status in
                          ('underway', 'captured', 'broken', 'abandoned'))
);

create unique index one_active_siege_per_outpost on sieges (outpost_id) where status = 'underway';

create table siege_forces (
  siege_id    uuid not null references sieges(id),
  mission_id  uuid not null references missions(id),
  faction_id  uuid not null references factions(id),
  side        text not null check (side in ('attacker', 'defender')),
  primary key (siege_id, mission_id)
);

-- Reports: the generated after-action account of every resolved fight.
create table reports (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('contest', 'siege', 'raid')),
  location_id  uuid not null references locations(id),
  body         jsonb not null,   -- sides, powers, modifiers, the bounded roll, outcome, narrative beats
  created_at   timestamptz not null default now()
);

create table report_factions (
  report_id   uuid not null references reports(id),
  faction_id  uuid not null references factions(id),
  read_at     timestamptz,
  primary key (report_id, faction_id)
);
```

Siege protections that are rules, not constraints: an Outpost with `is_hq` can never be the target of a `siege` or `raid` mission, and Raids never touch `survivors`, buildings, or ownership — enforced in mission validation and resolution code.

## Invariants the application must uphold

1. **Read-time settlement**: never read `outpost_stores.amount` raw; always settle (clamped at `dormant_at`, floored at 0, capped at `capacity`).
2. **Settle before every rate change**: upgrades, dormancy entry/exit, Surge start/end must settle amounts first, then change the rate, then recompute `dormant_at`.
3. **Every timed thing has exactly one pending `due_events` row**; resolution is idempotent (re-processing a processed event is a no-op).
4. **Control transfers are single transactions**: claim win → update `locations.controlling_faction_id`; siege capture → move the `outposts` row's `faction_id`; both emit Reports and WebSocket pushes atomically with the mutation.
5. **Concurrent dispatch safety**: dispatching locks the Crew row and the origin's Fuel store row (`select … for update`) so two clicks can't double-spend.

## Vertical slice subset

The Scavenge Mission slice needs only: `users`, `factions`, `locations`, `routes`, `outposts`, `outpost_stores`, `crews`, `missions`, `due_events`. Everything under "Conflict" ships later; nothing in the slice tables needs rework to add it.

## Deliberately not modeled (yet)

- **Alliances/treaties** — cooperation is informal by decision; there is no relationship table.
- **Vehicles & equipment** — crew power is `size`-based until content details (plan open question #4) are designed; add child tables then.
- **Seasons/leaderboards** — world permanence is explicitly deferred (plan open question #1).
- **NPC decision-making** — NPC Factions are ordinary `factions` rows; whatever drives their decisions writes through the same tables and validations as players.
