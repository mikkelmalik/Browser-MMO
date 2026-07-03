import type { Db } from '../db/db.js'
import type { Transaction } from '@electric-sql/pglite'
import { computeDormantAt, settleStore, type StoreState } from './settlement.js'
import { createMission, preflightDispatch, MINUTE_MS, type DispatchArgs } from './dispatch.js'

// Tuning knobs (plan open question #3)
export const SCAVENGE_DWELL_MINUTES = 60
export const SCAVENGE_FACTOR = 0.2

export interface DispatchResult {
  missionId: string
  dueAt: Date
  fuelSpent: number
}

export interface ScavengeResolution {
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

export async function dispatchScavenge(db: Db, args: DispatchArgs, now: Date): Promise<DispatchResult> {
  return db.transaction(async (tx) => {
    const pre = await preflightDispatch(tx, args, now)
    const dueAt = new Date(now.getTime() + (2 * pre.route.travelMinutes + SCAVENGE_DWELL_MINUTES) * MINUTE_MS)
    const missionId = await createMission(tx, {
      kind: 'scavenge',
      crewId: pre.crew.id,
      factionId: args.factionId,
      originOutpostId: pre.outpost.id,
      targetLocationId: args.targetLocationId,
      dueAt,
    }, now)
    return { missionId, dueAt, fuelSpent: pre.fuelSpent }
  })
}

export interface MissionRow {
  id: string
  crew_id: string
  faction_id: string
  kind: string
  origin_outpost_id: string
  target_location_id: string
  status: string
}

/** The crew is back: compute the haul, settle every store, deposit with cap clamping. */
export async function resolveScavengeDue(
  tx: Transaction,
  mission: MissionRow,
  now: Date,
): Promise<ScavengeResolution> {
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
