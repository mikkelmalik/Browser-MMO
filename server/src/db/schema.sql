-- Vertical-slice subset of docs/db-schema.md.
-- Idempotent: safe to run on every startup.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

create table if not exists factions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  owner_user_id     uuid unique references users(id),
  last_seen_at      timestamptz,
  surge_expires_at  timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists locations (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,
  name                    text not null,
  kind                    text not null,
  lat                     double precision not null,
  lon                     double precision not null,
  scrap_yield             numeric not null default 0,
  fuel_yield              numeric not null default 0,
  water_yield             numeric not null default 0,
  controlling_faction_id  uuid references factions(id)
);

create table if not exists routes (
  id              uuid primary key default gen_random_uuid(),
  location_a_id   uuid not null references locations(id),
  location_b_id   uuid not null references locations(id),
  distance_km     numeric not null,
  fuel_cost       numeric not null,
  travel_minutes  integer not null,
  check (location_a_id < location_b_id),
  unique (location_a_id, location_b_id)
);

create table if not exists outposts (
  id           uuid primary key default gen_random_uuid(),
  faction_id   uuid not null references factions(id),
  location_id  uuid not null unique references locations(id),
  is_hq        boolean not null default false,
  survivors    integer not null default 0,
  dormant_at   timestamptz,
  founded_at   timestamptz not null default now()
);

create unique index if not exists one_hq_per_faction on outposts (faction_id) where is_hq;

create table if not exists outpost_stores (
  outpost_id     uuid not null references outposts(id) on delete cascade,
  resource       text not null check (resource in ('scrap', 'fuel', 'water')),
  amount         numeric not null default 0,
  rate_per_hour  numeric not null default 0,
  capacity       numeric not null,
  settled_at     timestamptz not null default now(),
  primary key (outpost_id, resource)
);

create table if not exists crews (
  id           uuid primary key default gen_random_uuid(),
  faction_id   uuid not null references factions(id),
  name         text not null,
  size         integer not null check (size > 0),
  location_id  uuid not null references locations(id),
  status       text not null default 'idle' check (status in ('idle', 'on_mission')),
  created_at   timestamptz not null default now()
);

create table if not exists missions (
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
  outcome             jsonb
);

create index if not exists missions_active on missions (faction_id) where status = 'underway';

create table if not exists due_events (
  id            bigint generated always as identity primary key,
  due_at        timestamptz not null,
  kind          text not null check (kind in
                  ('mission_due', 'claim_window_close', 'siege_end', 'surge_expiry')),
  ref_id        uuid not null,
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists due_events_pending on due_events (due_at) where processed_at is null;

-- A Claim plants a flag on a Location and must survive its contest window.
create table if not exists claims (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id),
  claimant_faction_id   uuid not null references factions(id),
  mission_id            uuid not null references missions(id),
  opened_at             timestamptz not null default now(),
  closes_at             timestamptz not null,        -- window length: tuning knob
  status                text not null default 'open' check (status in
                          ('open', 'won', 'lost', 'withdrawn'))
);

create unique index if not exists one_open_claim_per_location on claims (location_id) where status = 'open';

create table if not exists claim_contests (
  claim_id    uuid not null references claims(id),
  faction_id  uuid not null references factions(id),
  mission_id  uuid not null references missions(id),
  primary key (claim_id, faction_id)
);

-- Reports: the generated after-action account of every resolved fight.
create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('contest', 'siege', 'raid')),
  location_id  uuid not null references locations(id),
  body         jsonb not null,
  created_at   timestamptz not null default now()
);

create table if not exists report_factions (
  report_id   uuid not null references reports(id),
  faction_id  uuid not null references factions(id),
  read_at     timestamptz,
  primary key (report_id, faction_id)
);
