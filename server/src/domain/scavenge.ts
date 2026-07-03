import type { Db } from '../db/db.js'
import type { Transaction } from '@electric-sql/pglite'
import { computeDormantAt, settleStore, type StoreState } from './settlement.js'

export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

// Tuning knobs (plan open question #3)
export const SCAVENGE_DWELL_MINUTES = 60
export const SCAVENGE_FACTOR = 0.2

export interface DispatchArgs {
  factionId: string
  crewId: string
  targetLocationId: string
}

export interface DispatchResult {
  missionId: string
  dueAt: Date
  fuelSpent: number
}

export interface Resolution {
  type: 'mission_resolved'
  missionId: string
  factionId: string
  crewId: string
  haul: Record<string, number>
}

interface StoreRow {
  resource: string
  amount: number
  rate_per_hour: number
  capacity: number
  settled_at: Date
}

const MINUTE_MS = 60_000

export async function dispatchScavenge(db: Db, args: DispatchArgs, now: Date): Promise<DispatchResult> {
  return db.transaction(async (tx) => {
    const crew = (await tx.query<{ id: string; status: string; location_id: string }>(
      `select id, status, location_id from crews where id = $1 and faction_id = $2 for update`,
      [args.crewId, args.factionId])).rows[0]
    if (!crew) throw new DomainError('crew_not_found', 'no such crew in this faction')
    if (crew.status !== 'idle') throw new DomainError('crew_busy', 'crew is already on a mission')

    const outpost = (await tx.query<{ id: string; dormant_at: Date | null }>(
      `select id, dormant_at from outposts where location_id = $1 and faction_id = $2`,
      [crew.location_id, args.factionId])).rows[0]
    if (!outpost) throw new DomainError('crew_not_at_outpost', 'crew must be at one of your outposts')

    const route = (await tx.query<{ fuel_cost: number; travel_minutes: number }>(
      `select fuel_cost::float8 as fuel_cost, travel_minutes from routes
       where location_a_id = least($1::uuid, $2::uuid)
         and location_b_id = greatest($1::uuid, $2::uuid)`,
      [crew.location_id, args.targetLocationId])).rows[0]
    if (!route) throw new DomainError('no_route', 'no route to the target location')

    const fuelSpent = 2 * route.fuel_cost // round trip
    const fuel = await settledStore(tx, outpost.id, 'fuel', now, outpost.dormant_at)
    if (fuel.amount < fuelSpent) {
      throw new DomainError('insufficient_fuel', `need ${fuelSpent} fuel, have ${fuel.amount}`)
    }
    await tx.query(
      `update outpost_stores set amount = $1, settled_at = $2 where outpost_id = $3 and resource = 'fuel'`,
      [fuel.amount - fuelSpent, now, outpost.id])

    const dueAt = new Date(now.getTime() + (2 * route.travel_minutes + SCAVENGE_DWELL_MINUTES) * MINUTE_MS)
    const mission = (await tx.query<{ id: string }>(
      `insert into missions (crew_id, faction_id, kind, origin_outpost_id, target_location_id, departed_at, due_at)
       values ($1, $2, 'scavenge', $3, $4, $5, $6) returning id`,
      [crew.id, args.factionId, outpost.id, args.targetLocationId, now, dueAt])).rows[0]!

    await tx.query(`update crews set status = 'on_mission' where id = $1`, [crew.id])
    await tx.query(
      `insert into due_events (due_at, kind, ref_id, created_at) values ($1, 'mission_due', $2, $3)`,
      [dueAt, mission.id, now])

    return { missionId: mission.id, dueAt, fuelSpent }
  })
}

/**
 * The scheduler's single entry point (ADR-0001): resolve every pending
 * due event whose time has come. Each event resolves in its own transaction
 * and is idempotent — an event is claimed by marking it processed inside the
 * same transaction that applies its effects.
 */
export async function processDueEvents(db: Db, now: Date): Promise<Resolution[]> {
  const events = (await db.query<{ id: string; kind: string; ref_id: string }>(
    `select id, kind, ref_id from due_events
     where processed_at is null and due_at <= $1
     order by due_at, id`,
    [now])).rows

  const resolutions: Resolution[] = []
  for (const event of events) {
    const resolution = await db.transaction(async (tx) => {
      const claimed = (await tx.query(
        `update due_events set processed_at = $1 where id = $2 and processed_at is null returning id`,
        [now, event.id])).rows[0]
      if (!claimed) return null
      if (event.kind !== 'mission_due') return null // other kinds arrive with later features
      return resolveMissionDue(tx, event.ref_id, now)
    })
    if (resolution) resolutions.push(resolution)
  }
  return resolutions
}

async function resolveMissionDue(tx: Transaction, missionId: string, now: Date): Promise<Resolution | null> {
  const mission = (await tx.query<{
    id: string
    crew_id: string
    faction_id: string
    origin_outpost_id: string
    target_location_id: string
    status: string
  }>(
    `select id, crew_id, faction_id, origin_outpost_id, target_location_id, status
     from missions where id = $1 for update`,
    [missionId])).rows[0]
  if (!mission || mission.status !== 'underway') return null

  const crew = (await tx.query<{ size: number }>(
    `select size from crews where id = $1`, [mission.crew_id])).rows[0]!
  const target = (await tx.query<{ scrap_yield: number; fuel_yield: number; water_yield: number }>(
    `select scrap_yield::float8 as scrap_yield, fuel_yield::float8 as fuel_yield, water_yield::float8 as water_yield
     from locations where id = $1`,
    [mission.target_location_id])).rows[0]!

  const dwellHours = SCAVENGE_DWELL_MINUTES / 60
  const haulFor = (yieldPerHour: number) => yieldPerHour * dwellHours * crew.size * SCAVENGE_FACTOR
  const haul: Record<string, number> = {
    scrap: haulFor(target.scrap_yield),
    fuel: haulFor(target.fuel_yield),
    water: haulFor(target.water_yield),
  }

  const outpost = (await tx.query<{ id: string; dormant_at: Date | null }>(
    `select id, dormant_at from outposts where id = $1 for update`,
    [mission.origin_outpost_id])).rows[0]!

  // Settle every store to now (clamped by dormancy), then deposit the haul.
  let waterState: StoreState | null = null
  const stores = (await tx.query<StoreRow>(
    `select resource, amount::float8 as amount, rate_per_hour::float8 as rate_per_hour,
            capacity::float8 as capacity, settled_at
     from outpost_stores where outpost_id = $1 for update`,
    [outpost.id])).rows
  for (const row of stores) {
    const settled = settleStore(
      {
        amount: row.amount,
        ratePerHour: row.rate_per_hour,
        capacity: row.capacity,
        settledAt: new Date(row.settled_at),
      },
      now,
      outpost.dormant_at ? new Date(outpost.dormant_at) : null,
    )
    const amount = Math.min(settled.capacity, settled.amount + (haul[row.resource] ?? 0))
    await tx.query(
      `update outpost_stores set amount = $1, settled_at = $2 where outpost_id = $3 and resource = $4`,
      [amount, now, outpost.id, row.resource])
    if (row.resource === 'water') waterState = { ...settled, amount, settledAt: now }
  }

  // Water changed, so the dormancy projection changes (ADR-0001 invariant #2).
  if (waterState) {
    await tx.query(`update outposts set dormant_at = $1 where id = $2`,
      [computeDormantAt(waterState), outpost.id])
  }

  await tx.query(
    `update missions set status = 'completed', resolved_at = $1, outcome = $2 where id = $3`,
    [now, JSON.stringify({ haul }), mission.id])
  await tx.query(`update crews set status = 'idle' where id = $1`, [mission.crew_id])

  return {
    type: 'mission_resolved',
    missionId: mission.id,
    factionId: mission.faction_id,
    crewId: mission.crew_id,
    haul,
  }
}

async function settledStore(
  tx: Transaction,
  outpostId: string,
  resource: string,
  now: Date,
  dormantAt: Date | null,
): Promise<StoreState> {
  const row = (await tx.query<StoreRow>(
    `select resource, amount::float8 as amount, rate_per_hour::float8 as rate_per_hour,
            capacity::float8 as capacity, settled_at
     from outpost_stores where outpost_id = $1 and resource = $2 for update`,
    [outpostId, resource])).rows[0]
  if (!row) throw new DomainError('store_missing', `outpost has no ${resource} store`)
  return settleStore(
    {
      amount: row.amount,
      ratePerHour: row.rate_per_hour,
      capacity: row.capacity,
      settledAt: new Date(row.settled_at),
    },
    now,
    dormantAt ? new Date(dormantAt) : null,
  )
}
