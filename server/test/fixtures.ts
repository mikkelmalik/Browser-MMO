import type { Db } from '../src/db/db.js'

export interface Fixture {
  factionId: string
  crewId: string
  outpostId: string
  hqLocationId: string
  targetLocationId: string
}

interface FixtureOpts {
  fuelAmount?: number
  scrapAmount?: number
  scrapCapacity?: number
}

/**
 * A minimal world: an HQ town and a rich ruin one Route apart (30 min travel,
 * 10 Fuel per traversal), one faction with an HQ Outpost and an idle Crew of 5.
 * All stores are settled at `now`.
 */
export async function seedFixture(db: Db, now: Date, opts: FixtureOpts = {}): Promise<Fixture> {
  const user = await one<{ id: string }>(db,
    `insert into users (email, display_name) values ('mm@test.dk', 'MM') returning id`)
  const faction = await one<{ id: string }>(db,
    `insert into factions (name, owner_user_id) values ('Rust Vultures', $1) returning id`,
    [user.id])

  const hq = await one<{ id: string }>(db,
    `insert into locations (slug, name, kind, lat, lon, scrap_yield, fuel_yield, water_yield)
     values ('hq-town', 'HQ Town', 'town', 55.6, 12.5, 2, 0, 3) returning id`)
  const ruins = await one<{ id: string }>(db,
    `insert into locations (slug, name, kind, lat, lon, scrap_yield, fuel_yield, water_yield)
     values ('rich-ruins', 'Rich Ruins', 'city_ruins', 55.7, 12.6, 10, 4, 0) returning id`)

  await db.query(
    `insert into routes (location_a_id, location_b_id, distance_km, fuel_cost, travel_minutes)
     values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 100, 10, 30)`,
    [hq.id, ruins.id])

  const outpost = await one<{ id: string }>(db,
    `insert into outposts (faction_id, location_id, is_hq, survivors)
     values ($1, $2, true, 10) returning id`,
    [faction.id, hq.id])
  await db.query(`update locations set controlling_faction_id = $1 where id = $2`,
    [faction.id, hq.id])

  const stores: Array<[string, number, number, number]> = [
    ['scrap', opts.scrapAmount ?? 50, 2, opts.scrapCapacity ?? 500],
    ['fuel', opts.fuelAmount ?? 100, 0, 200],
    ['water', 200, -1, 300],
  ]
  for (const [resource, amount, rate, capacity] of stores) {
    await db.query(
      `insert into outpost_stores (outpost_id, resource, amount, rate_per_hour, capacity, settled_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [outpost.id, resource, amount, rate, capacity, now])
  }

  const crew = await one<{ id: string }>(db,
    `insert into crews (faction_id, name, size, location_id)
     values ($1, 'Road Dogs', 5, $2) returning id`,
    [faction.id, hq.id])

  return {
    factionId: faction.id,
    crewId: crew.id,
    outpostId: outpost.id,
    hqLocationId: hq.id,
    targetLocationId: ruins.id,
  }
}

export async function getStoreAmount(db: Db, outpostId: string, resource: string): Promise<number> {
  const row = await one<{ amount: number }>(db,
    `select amount::float8 as amount from outpost_stores where outpost_id = $1 and resource = $2`,
    [outpostId, resource])
  return row.amount
}

async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params)
  if (!res.rows[0]) throw new Error(`fixture query returned no rows: ${sql}`)
  return res.rows[0]
}
