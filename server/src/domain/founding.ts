import type { Db } from '../db/db.js'
import { computeDormantAt } from './settlement.js'
import { DomainError } from './scavenge.js'

// Tuning knobs (plan open question #3)
export const STARTING = {
  survivors: 10,
  crewSize: 5,
  waterPerSurvivorHour: 0.1,
  stores: {
    scrap: { amount: 50, capacity: 500 },
    fuel: { amount: 100, capacity: 200 },
    water: { amount: 200, capacity: 300 },
  },
} as const

export interface FoundArgs {
  email: string
  displayName: string
  factionName: string
  hqLocationSlug: string
}

export interface FoundResult {
  userId: string
  factionId: string
  hqOutpostId: string
  crewId: string
}

/**
 * Found a new player Faction: HQ Outpost at a free Location of the player's
 * choosing (decided: free choice anywhere unclaimed), starter stores whose
 * rates derive from the Location's yields, and one starter Crew.
 */
export async function foundFaction(db: Db, args: FoundArgs, now: Date): Promise<FoundResult> {
  return db.transaction(async (tx) => {
    const location = (await tx.query<{
      id: string
      controlling_faction_id: string | null
      scrap_yield: number
      fuel_yield: number
      water_yield: number
    }>(
      `select id, controlling_faction_id, scrap_yield::float8 as scrap_yield,
              fuel_yield::float8 as fuel_yield, water_yield::float8 as water_yield
       from locations where slug = $1 for update`,
      [args.hqLocationSlug])).rows[0]
    if (!location) throw new DomainError('location_not_found', `no location '${args.hqLocationSlug}'`)
    if (location.controlling_faction_id) {
      throw new DomainError('location_taken', 'that location is already controlled')
    }

    const user = (await tx.query<{ id: string }>(
      `insert into users (email, display_name) values ($1, $2) returning id`,
      [args.email, args.displayName])).rows[0]!
    const faction = (await tx.query<{ id: string }>(
      `insert into factions (name, owner_user_id, last_seen_at) values ($1, $2, $3) returning id`,
      [args.factionName, user.id, now])).rows[0]!
    const outpost = (await tx.query<{ id: string }>(
      `insert into outposts (faction_id, location_id, is_hq, survivors, founded_at)
       values ($1, $2, true, $3, $4) returning id`,
      [faction.id, location.id, STARTING.survivors, now])).rows[0]!

    const rates: Record<'scrap' | 'fuel' | 'water', number> = {
      scrap: location.scrap_yield,
      fuel: location.fuel_yield,
      water: location.water_yield - STARTING.survivors * STARTING.waterPerSurvivorHour,
    }
    for (const resource of ['scrap', 'fuel', 'water'] as const) {
      const { amount, capacity } = STARTING.stores[resource]
      await tx.query(
        `insert into outpost_stores (outpost_id, resource, amount, rate_per_hour, capacity, settled_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [outpost.id, resource, amount, rates[resource], capacity, now])
    }
    const dormantAt = computeDormantAt({
      amount: STARTING.stores.water.amount,
      ratePerHour: rates.water,
      capacity: STARTING.stores.water.capacity,
      settledAt: now,
    })
    await tx.query(`update outposts set dormant_at = $1 where id = $2`, [dormantAt, outpost.id])

    const crew = (await tx.query<{ id: string }>(
      `insert into crews (faction_id, name, size, location_id) values ($1, $2, $3, $4) returning id`,
      [faction.id, 'First Crew', STARTING.crewSize, location.id])).rows[0]!

    await tx.query(`update locations set controlling_faction_id = $1 where id = $2`,
      [faction.id, location.id])

    return { userId: user.id, factionId: faction.id, hqOutpostId: outpost.id, crewId: crew.id }
  })
}
