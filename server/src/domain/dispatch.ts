import type { Transaction } from '@electric-sql/pglite'
import { DomainError } from './errors.js'
import { settleStore, type StoreState } from './settlement.js'

export const MINUTE_MS = 60_000

export interface DispatchArgs {
  factionId: string
  crewId: string
  targetLocationId: string
}

export interface Preflight {
  crew: { id: string; size: number; locationId: string }
  outpost: { id: string; dormantAt: Date | null }
  route: { fuelCost: number; travelMinutes: number }
  fuelSpent: number
}

interface StoreRow {
  resource: string
  amount: number
  rate_per_hour: number
  capacity: number
  settled_at: Date
}

/**
 * The dispatch preconditions every Mission kind shares (db-schema invariant #5):
 * lock the Crew (idle, in this Faction, at one of its Outposts), find the Route
 * to the target, then settle and deduct round-trip Fuel from the origin's store.
 */
export async function preflightDispatch(tx: Transaction, args: DispatchArgs, now: Date): Promise<Preflight> {
  const crew = (await tx.query<{ id: string; size: number; status: string; location_id: string }>(
    `select id, size, status, location_id from crews where id = $1 and faction_id = $2 for update`,
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

  return {
    crew: { id: crew.id, size: crew.size, locationId: crew.location_id },
    outpost: { id: outpost.id, dormantAt: outpost.dormant_at },
    route: { fuelCost: route.fuel_cost, travelMinutes: route.travel_minutes },
    fuelSpent,
  }
}

/** Insert the mission + its due event and mark the Crew away (ADR-0001 invariant #3). */
export async function createMission(
  tx: Transaction,
  args: {
    kind: 'scavenge' | 'claim' | 'contest'
    crewId: string
    factionId: string
    originOutpostId: string
    targetLocationId: string
    dueAt: Date
  },
  now: Date,
): Promise<string> {
  const mission = (await tx.query<{ id: string }>(
    `insert into missions (crew_id, faction_id, kind, origin_outpost_id, target_location_id, departed_at, due_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [args.crewId, args.factionId, args.kind, args.originOutpostId, args.targetLocationId, now, args.dueAt])).rows[0]!
  await tx.query(`update crews set status = 'on_mission' where id = $1`, [args.crewId])
  await tx.query(
    `insert into due_events (due_at, kind, ref_id, created_at) values ($1, 'mission_due', $2, $3)`,
    [args.dueAt, mission.id, now])
  return mission.id
}

export async function settledStore(
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
