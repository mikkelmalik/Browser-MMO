import type { Db } from '../db/db.js'
import type { Transaction } from '@electric-sql/pglite'
import { resolveScavengeDue, type MissionRow, type ScavengeResolution } from './scavenge.js'
import {
  resolveClaimArrival,
  resolveClaimWindowClose,
  resolveContestArrival,
  type ClaimContested,
  type ClaimFailed,
  type ClaimOpened,
  type ClaimResolved,
  type ContestFailed,
  type Rng,
} from './claims.js'

/** Everything the scheduler can emit; each is broadcast verbatim over the WebSocket. */
export type GameEvent =
  | ScavengeResolution
  | ClaimOpened
  | ClaimFailed
  | ClaimContested
  | ContestFailed
  | ClaimResolved

/**
 * The scheduler's single entry point (ADR-0001): resolve every pending
 * due event whose time has come. Each event resolves in its own transaction
 * and is idempotent — an event is claimed by marking it processed inside the
 * same transaction that applies its effects.
 */
export async function processDueEvents(db: Db, now: Date, rng: Rng = Math.random): Promise<GameEvent[]> {
  const events = (await db.query<{ id: string; kind: string; ref_id: string }>(
    `select id, kind, ref_id from due_events
     where processed_at is null and due_at <= $1
     order by due_at, id`,
    [now])).rows

  const results: GameEvent[] = []
  for (const event of events) {
    const result = await db.transaction(async (tx) => {
      const claimed = (await tx.query(
        `update due_events set processed_at = $1 where id = $2 and processed_at is null returning id`,
        [now, event.id])).rows[0]
      if (!claimed) return null
      switch (event.kind) {
        case 'mission_due':
          return resolveMissionDue(tx, event.ref_id, now)
        case 'claim_window_close':
          return resolveClaimWindowClose(tx, event.ref_id, now, rng)
        default:
          return null // other kinds arrive with later features
      }
    })
    if (result) results.push(result)
  }
  return results
}

async function resolveMissionDue(tx: Transaction, missionId: string, now: Date): Promise<GameEvent | null> {
  const mission = (await tx.query<MissionRow>(
    `select id, crew_id, faction_id, kind, origin_outpost_id, target_location_id, status
     from missions where id = $1 for update`,
    [missionId])).rows[0]
  if (!mission || mission.status !== 'underway') return null

  switch (mission.kind) {
    case 'scavenge':
      return resolveScavengeDue(tx, mission, now)
    case 'claim':
      return resolveClaimArrival(tx, mission, now)
    case 'contest':
      return resolveContestArrival(tx, mission, now)
    default:
      return null
  }
}
