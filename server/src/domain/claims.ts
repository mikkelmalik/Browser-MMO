import type { Db } from '../db/db.js'
import type { Transaction } from '@electric-sql/pglite'
import { DomainError } from './errors.js'
import { createMission, preflightDispatch, MINUTE_MS, type DispatchArgs } from './dispatch.js'
import type { MissionRow } from './scavenge.js'

// Tuning knobs (plan open question #3): window length ~24h, luck band ±15%.
export const CLAIM_WINDOW_HOURS = 24
export const COMBAT_LUCK_BAND = 0.15

export type Rng = () => number

export interface ClaimDispatchResult {
  missionId: string
  arrivesAt: Date
  fuelSpent: number
}

export interface ClaimOpened {
  type: 'claim_opened'
  claimId: string
  missionId: string
  claimantFactionId: string
  locationSlug: string
  closesAt: string
}

export interface ClaimFailed {
  type: 'claim_failed'
  missionId: string
  factionId: string
  locationSlug: string
  reason: string
}

export interface ClaimContested {
  type: 'claim_contested'
  claimId: string
  missionId: string
  contestantFactionId: string
  locationSlug: string
}

export interface ContestFailed {
  type: 'contest_failed'
  missionId: string
  factionId: string
  locationSlug: string
  reason: string
}

export interface ClaimResolved {
  type: 'claim_resolved'
  claimId: string
  locationSlug: string
  claimantFactionId: string
  winnerFactionId: string
  won: boolean
  contested: boolean
  reportId: string | null
}

/**
 * Dispatch a Claim Mission: the Crew travels to an unclaimed Location and
 * plants the flag on arrival; the contest window opens then, not at dispatch.
 */
export async function dispatchClaim(db: Db, args: DispatchArgs, now: Date): Promise<ClaimDispatchResult> {
  return db.transaction(async (tx) => {
    // Lock the Location row so two competing dispatch/found transactions serialize.
    const location = (await tx.query<{ id: string; controlling_faction_id: string | null }>(
      `select id, controlling_faction_id from locations where id = $1 for update`,
      [args.targetLocationId])).rows[0]
    if (!location) throw new DomainError('location_not_found', 'no such location')
    if (location.controlling_faction_id) {
      throw new DomainError('location_taken', 'that location is already controlled')
    }
    const openClaim = (await tx.query(
      `select id from claims where location_id = $1 and status = 'open'`,
      [args.targetLocationId])).rows[0]
    if (openClaim) {
      throw new DomainError('claim_already_open', 'a claim is already open on that location — contest it instead')
    }

    const pre = await preflightDispatch(tx, args, now)
    const arrivesAt = new Date(now.getTime() + pre.route.travelMinutes * MINUTE_MS)
    const missionId = await createMission(tx, {
      kind: 'claim',
      crewId: pre.crew.id,
      factionId: args.factionId,
      originOutpostId: pre.outpost.id,
      targetLocationId: args.targetLocationId,
      dueAt: arrivesAt,
    }, now)
    return { missionId, arrivesAt, fuelSpent: pre.fuelSpent }
  })
}

/**
 * Dispatch a Contest Mission against the open Claim on a Location. The Crew
 * must be able to arrive before the window closes.
 */
export async function dispatchContest(db: Db, args: DispatchArgs, now: Date): Promise<ClaimDispatchResult> {
  return db.transaction(async (tx) => {
    const claim = (await tx.query<{ id: string; claimant_faction_id: string; closes_at: Date }>(
      `select id, claimant_faction_id, closes_at from claims
       where location_id = $1 and status = 'open' for update`,
      [args.targetLocationId])).rows[0]
    if (!claim) throw new DomainError('no_open_claim', 'there is no open claim on that location')
    if (claim.claimant_faction_id === args.factionId) {
      throw new DomainError('own_claim', 'you cannot contest your own claim')
    }
    const already = (await tx.query(
      `select 1 from claim_contests where claim_id = $1 and faction_id = $2`,
      [claim.id, args.factionId])).rows[0]
    if (already) throw new DomainError('already_contesting', 'your faction is already contesting this claim')

    const pre = await preflightDispatch(tx, args, now)
    const arrivesAt = new Date(now.getTime() + pre.route.travelMinutes * MINUTE_MS)
    if (arrivesAt >= new Date(claim.closes_at)) {
      throw new DomainError('window_closes_first', 'the contest window closes before your crew could arrive')
    }
    const missionId = await createMission(tx, {
      kind: 'contest',
      crewId: pre.crew.id,
      factionId: args.factionId,
      originOutpostId: pre.outpost.id,
      targetLocationId: args.targetLocationId,
      dueAt: arrivesAt,
    }, now)
    return { missionId, arrivesAt, fuelSpent: pre.fuelSpent }
  })
}

/** Claim Crew arrival: plant the flag and open the contest window. */
export async function resolveClaimArrival(
  tx: Transaction,
  mission: MissionRow,
  now: Date,
): Promise<ClaimOpened | ClaimFailed> {
  const location = (await tx.query<{ id: string; slug: string; controlling_faction_id: string | null }>(
    `select id, slug, controlling_faction_id from locations where id = $1 for update`,
    [mission.target_location_id])).rows[0]!

  // The world may have moved while the crew was on the road.
  const blockedBy = location.controlling_faction_id
    ? 'location_taken'
    : (await tx.query(`select 1 from claims where location_id = $1 and status = 'open'`,
        [location.id])).rows[0] ? 'claim_already_open' : null
  if (blockedBy) {
    await tx.query(
      `update missions set status = 'failed', resolved_at = $1, outcome = $2 where id = $3`,
      [now, JSON.stringify({ failed: blockedBy }), mission.id])
    await tx.query(`update crews set status = 'idle' where id = $1`, [mission.crew_id])
    return {
      type: 'claim_failed',
      missionId: mission.id,
      factionId: mission.faction_id,
      locationSlug: location.slug,
      reason: blockedBy,
    }
  }

  const closesAt = new Date(now.getTime() + CLAIM_WINDOW_HOURS * 60 * MINUTE_MS)
  const claim = (await tx.query<{ id: string }>(
    `insert into claims (location_id, claimant_faction_id, mission_id, opened_at, closes_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [location.id, mission.faction_id, mission.id, now, closesAt])).rows[0]!
  await tx.query(`update missions set due_at = $1 where id = $2`, [closesAt, mission.id])
  await tx.query(
    `insert into due_events (due_at, kind, ref_id, created_at) values ($1, 'claim_window_close', $2, $3)`,
    [closesAt, claim.id, now])

  return {
    type: 'claim_opened',
    claimId: claim.id,
    missionId: mission.id,
    claimantFactionId: mission.faction_id,
    locationSlug: location.slug,
    closesAt: closesAt.toISOString(),
  }
}

/** Contest Crew arrival: join the showdown at the flag. */
export async function resolveContestArrival(
  tx: Transaction,
  mission: MissionRow,
  now: Date,
): Promise<ClaimContested | ContestFailed> {
  const location = (await tx.query<{ slug: string }>(
    `select slug from locations where id = $1`, [mission.target_location_id])).rows[0]!
  const claim = (await tx.query<{ id: string }>(
    `select id from claims where location_id = $1 and status = 'open' for update`,
    [mission.target_location_id])).rows[0]

  // A second Crew from an already-contesting Faction adds nothing: one
  // contest per Faction per Claim (the claim_contests primary key).
  const joined = claim ? (await tx.query<{ claim_id: string }>(
    `insert into claim_contests (claim_id, faction_id, mission_id) values ($1, $2, $3)
     on conflict do nothing returning claim_id`,
    [claim.id, mission.faction_id, mission.id])).rows[0] : null

  if (!claim || !joined) {
    const reason = claim ? 'already_contesting' : 'no_open_claim'
    await tx.query(
      `update missions set status = 'failed', resolved_at = $1, outcome = $2 where id = $3`,
      [now, JSON.stringify({ failed: reason }), mission.id])
    await tx.query(`update crews set status = 'idle' where id = $1`, [mission.crew_id])
    return {
      type: 'contest_failed',
      missionId: mission.id,
      factionId: mission.faction_id,
      locationSlug: location.slug,
      reason,
    }
  }

  const claimRow = (await tx.query<{ closes_at: Date }>(
    `select closes_at from claims where id = $1`, [claim.id])).rows[0]!
  await tx.query(`update missions set due_at = $1 where id = $2`, [claimRow.closes_at, mission.id])

  return {
    type: 'claim_contested',
    claimId: claim.id,
    missionId: mission.id,
    contestantFactionId: mission.faction_id,
    locationSlug: location.slug,
  }
}

interface Side {
  factionId: string
  role: 'claimant' | 'contestant'
  missionId: string
  crewId: string
  crewSize: number
  luck: number
  power: number
}

/**
 * Window close: the deterministic showdown (db-schema invariant #4 — control
 * transfer, Report, and mission completion are one transaction). Power =
 * crew size × bounded luck (±15%); ties go to the flag holder.
 */
export async function resolveClaimWindowClose(
  tx: Transaction,
  claimId: string,
  now: Date,
  rng: Rng,
): Promise<ClaimResolved | null> {
  const claim = (await tx.query<{
    id: string
    location_id: string
    claimant_faction_id: string
    mission_id: string
    status: string
  }>(
    `select id, location_id, claimant_faction_id, mission_id, status
     from claims where id = $1 for update`,
    [claimId])).rows[0]
  if (!claim || claim.status !== 'open') return null

  const location = (await tx.query<{ slug: string; controlling_faction_id: string | null }>(
    `select slug, controlling_faction_id from locations where id = $1 for update`,
    [claim.location_id])).rows[0]!

  const claimantCrew = (await tx.query<{ crew_id: string; size: number }>(
    `select m.crew_id, c.size from missions m join crews c on c.id = m.crew_id where m.id = $1`,
    [claim.mission_id])).rows[0]!
  const contestants = (await tx.query<{ faction_id: string; mission_id: string; crew_id: string; size: number }>(
    `select cc.faction_id, cc.mission_id, m.crew_id, c.size
     from claim_contests cc
     join missions m on m.id = cc.mission_id
     join crews c on c.id = m.crew_id
     where cc.claim_id = $1`,
    [claim.id])).rows

  const roll = () => (rng() * 2 - 1) * COMBAT_LUCK_BAND
  const sides: Side[] = [
    {
      factionId: claim.claimant_faction_id,
      role: 'claimant',
      missionId: claim.mission_id,
      crewId: claimantCrew.crew_id,
      crewSize: claimantCrew.size,
      luck: 0,
      power: 0,
    },
    ...contestants.map((row): Side => ({
      factionId: row.faction_id,
      role: 'contestant',
      missionId: row.mission_id,
      crewId: row.crew_id,
      crewSize: row.size,
      luck: 0,
      power: 0,
    })),
  ]

  const contested = contestants.length > 0
  let winner = sides[0]!
  let reportId: string | null = null

  if (contested) {
    for (const side of sides) {
      side.luck = roll()
      side.power = side.crewSize * (1 + side.luck)
    }
    // Highest power wins; the flag holder wins ties.
    winner = sides.reduce((best, side) => (side.power > best.power ? side : best), sides[0]!)

    const report = (await tx.query<{ id: string }>(
      `insert into reports (kind, location_id, body, created_at) values ('contest', $1, $2, $3) returning id`,
      [claim.location_id, JSON.stringify({
        claimId: claim.id,
        locationSlug: location.slug,
        sides: sides.map(({ factionId, role, crewSize, luck, power }) =>
          ({ factionId, role, crewSize, luck, power })),
        winnerFactionId: winner.factionId,
        outcome: winner.role === 'claimant' ? 'claim_won' : 'claim_lost',
      }), now])).rows[0]!
    reportId = report.id
    for (const side of sides) {
      await tx.query(
        `insert into report_factions (report_id, faction_id) values ($1, $2) on conflict do nothing`,
        [reportId, side.factionId])
    }
  }

  const won = winner.role === 'claimant' && !location.controlling_faction_id
  await tx.query(`update claims set status = $1 where id = $2`, [won ? 'won' : 'lost', claim.id])
  if (won) {
    await tx.query(`update locations set controlling_faction_id = $1 where id = $2`,
      [claim.claimant_faction_id, claim.location_id])
  }

  for (const side of sides) {
    const succeeded = side.factionId === winner.factionId && (side.role === 'claimant' ? won : true)
    await tx.query(
      `update missions set status = $1, resolved_at = $2, outcome = $3 where id = $4`,
      [succeeded ? 'completed' : 'failed', now,
       JSON.stringify({ claim: won ? 'won' : 'lost', reportId }), side.missionId])
    await tx.query(`update crews set status = 'idle' where id = $1`, [side.crewId])
  }

  return {
    type: 'claim_resolved',
    claimId: claim.id,
    locationSlug: location.slug,
    claimantFactionId: claim.claimant_faction_id,
    winnerFactionId: winner.factionId,
    won,
    contested,
    reportId,
  }
}
