import { beforeEach, describe, expect, test } from 'vitest'
import { createDb, type Db } from '../src/db/db.js'
import { dispatchClaim, dispatchContest, CLAIM_WINDOW_HOURS } from '../src/domain/claims.js'
import { processDueEvents } from '../src/domain/events.js'
import { foundFaction } from '../src/domain/founding.js'
import { getStoreAmount, seedFixture, seedRival, type Fixture, type RivalFixture } from './fixtures.js'

const NOW = new Date('2026-07-03T12:00:00Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)
const WINDOW_MINUTES = CLAIM_WINDOW_HOURS * 60

// rng()*2−1 maps 1 → best luck (+15%), 0 → worst (−15%). Sides roll in order:
// claimant first, then contestants in arrival order.
const rngSequence = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]!
}

let db: Db
let fx: Fixture
let rival: RivalFixture

beforeEach(async () => {
  db = await createDb()
  fx = await seedFixture(db, NOW)
  rival = await seedRival(db, NOW)
})

const claimArgs = () => ({ factionId: fx.factionId, crewId: fx.crewId, targetLocationId: fx.targetLocationId })
const contestArgs = () => ({ factionId: rival.factionId, crewId: rival.crewId, targetLocationId: fx.targetLocationId })

/** Dispatch at NOW (30 min travel) and open the claim on arrival. */
async function openClaim() {
  const dispatched = await dispatchClaim(db, claimArgs(), NOW)
  const [opened] = await processDueEvents(db, minutes(30))
  return { dispatched, opened: opened as Extract<typeof opened, { type: 'claim_opened' }> }
}

describe('dispatchClaim', () => {
  test('spends round-trip Fuel and queues arrival at one-way travel time', async () => {
    const result = await dispatchClaim(db, claimArgs(), NOW)

    expect(result.fuelSpent).toBe(20)
    expect(result.arrivesAt).toEqual(minutes(30))
    expect(await getStoreAmount(db, fx.outpostId, 'fuel')).toBe(80)

    const mission = (await db.query<{ kind: string; status: string }>(
      `select kind, status from missions where id = $1`, [result.missionId])).rows[0]
    expect(mission).toMatchObject({ kind: 'claim', status: 'underway' })
  })

  test('rejects a controlled Location', async () => {
    await expect(
      dispatchClaim(db, { ...claimArgs(), targetLocationId: rival.campLocationId }, NOW),
    ).rejects.toMatchObject({ code: 'location_taken' })
  })

  test('rejects a Location that already has an open claim', async () => {
    await openClaim()
    await expect(dispatchClaim(db, contestArgs(), minutes(40)))
      .rejects.toMatchObject({ code: 'claim_already_open' })
  })
})

describe('claim arrival', () => {
  test('plants the flag: claim opens, window close is queued, mission stays underway', async () => {
    const { dispatched, opened } = await openClaim()

    expect(opened).toMatchObject({
      type: 'claim_opened',
      missionId: dispatched.missionId,
      claimantFactionId: fx.factionId,
      locationSlug: 'rich-ruins',
      closesAt: minutes(30 + WINDOW_MINUTES).toISOString(),
    })

    const claim = (await db.query<{ status: string; closes_at: Date }>(
      `select status, closes_at from claims where id = $1`, [opened.claimId])).rows[0]
    expect(claim?.status).toBe('open')

    const mission = (await db.query<{ status: string }>(
      `select status from missions where id = $1`, [dispatched.missionId])).rows[0]
    expect(mission?.status).toBe('underway')

    const pending = (await db.query<{ n: number }>(
      `select count(*)::int as n from due_events where processed_at is null and kind = 'claim_window_close'`)).rows[0]
    expect(pending?.n).toBe(1)
  })

  test('fails when the Location got taken while the crew was on the road', async () => {
    const { missionId } = await dispatchClaim(db, claimArgs(), NOW)
    await db.query(`update locations set controlling_faction_id = $1 where id = $2`,
      [rival.factionId, fx.targetLocationId])

    const [event] = await processDueEvents(db, minutes(30))

    expect(event).toMatchObject({ type: 'claim_failed', missionId, reason: 'location_taken' })
    const mission = (await db.query<{ status: string }>(
      `select status from missions where id = $1`, [missionId])).rows[0]
    expect(mission?.status).toBe('failed')
    const crew = (await db.query<{ status: string }>(
      `select status from crews where id = $1`, [fx.crewId])).rows[0]
    expect(crew?.status).toBe('idle')
  })
})

describe('uncontested window close', () => {
  test('control transfers, no Report (no fight), crew comes home', async () => {
    const { opened } = await openClaim()

    const [resolved] = await processDueEvents(db, minutes(30 + WINDOW_MINUTES))

    expect(resolved).toMatchObject({
      type: 'claim_resolved',
      claimId: opened.claimId,
      won: true,
      contested: false,
      winnerFactionId: fx.factionId,
      reportId: null,
    })

    const location = (await db.query<{ controlling_faction_id: string }>(
      `select controlling_faction_id from locations where id = $1`, [fx.targetLocationId])).rows[0]
    expect(location?.controlling_faction_id).toBe(fx.factionId)

    const claim = (await db.query<{ status: string }>(
      `select status from claims where id = $1`, [opened.claimId])).rows[0]
    expect(claim?.status).toBe('won')

    const crew = (await db.query<{ status: string }>(
      `select status from crews where id = $1`, [fx.crewId])).rows[0]
    expect(crew?.status).toBe('idle')

    const reports = (await db.query<{ n: number }>(`select count(*)::int as n from reports`)).rows[0]
    expect(reports?.n).toBe(0)
  })

  test('is idempotent: a second sweep resolves nothing', async () => {
    await openClaim()
    await processDueEvents(db, minutes(30 + WINDOW_MINUTES))
    expect(await processDueEvents(db, minutes(31 + WINDOW_MINUTES))).toEqual([])
  })
})

describe('dispatchContest', () => {
  test('rejects when there is no open claim yet (crew still on the road)', async () => {
    await dispatchClaim(db, claimArgs(), NOW)
    await expect(dispatchContest(db, contestArgs(), minutes(10)))
      .rejects.toMatchObject({ code: 'no_open_claim' })
  })

  test('rejects contesting your own claim', async () => {
    await openClaim()
    // give the claimant a second idle crew so the check under test is reached
    const crew2 = (await db.query<{ id: string }>(
      `insert into crews (faction_id, name, size, location_id) values ($1, 'Backup', 3, $2) returning id`,
      [fx.factionId, fx.hqLocationId])).rows[0]!
    await expect(
      dispatchContest(db, { factionId: fx.factionId, crewId: crew2.id, targetLocationId: fx.targetLocationId }, minutes(40)),
    ).rejects.toMatchObject({ code: 'own_claim' })
  })

  test('rejects when the crew cannot arrive before the window closes', async () => {
    await openClaim()
    await expect(dispatchContest(db, contestArgs(), minutes(30 + WINDOW_MINUTES - 10)))
      .rejects.toMatchObject({ code: 'window_closes_first' })
  })

  test('arrival joins the showdown; a second crew from the same faction fails at arrival', async () => {
    const { opened } = await openClaim()
    const contest = await dispatchContest(db, contestArgs(), minutes(40))

    const [contested] = await processDueEvents(db, minutes(60))
    expect(contested).toMatchObject({
      type: 'claim_contested',
      claimId: opened.claimId,
      missionId: contest.missionId,
      contestantFactionId: rival.factionId,
    })

    // duplicate contest by the same faction, dispatched after the first arrived
    await expect(dispatchContest(db, contestArgs(), minutes(70)))
      .rejects.toMatchObject({ code: 'already_contesting' })
  })
})

describe('contested window close', () => {
  async function contestedClaim() {
    const { opened } = await openClaim()
    const contest = await dispatchContest(db, contestArgs(), minutes(40))
    await processDueEvents(db, minutes(60))
    return { opened, contest }
  }

  test('claimant wins with the better roll: control transfers, Report for both sides', async () => {
    const { opened, contest } = await contestedClaim()

    // claimant: 5 × 1.15 = 5.75; contestant: 4 × 0.85 = 3.4
    const [resolved] = await processDueEvents(db, minutes(30 + WINDOW_MINUTES), rngSequence(1, 0))

    expect(resolved).toMatchObject({
      type: 'claim_resolved',
      claimId: opened.claimId,
      won: true,
      contested: true,
      winnerFactionId: fx.factionId,
    })
    expect((resolved as { reportId: string | null }).reportId).toBeTruthy()

    const location = (await db.query<{ controlling_faction_id: string }>(
      `select controlling_faction_id from locations where id = $1`, [fx.targetLocationId])).rows[0]
    expect(location?.controlling_faction_id).toBe(fx.factionId)

    const contestMission = (await db.query<{ status: string }>(
      `select status from missions where id = $1`, [contest.missionId])).rows[0]
    expect(contestMission?.status).toBe('failed')

    const readers = (await db.query<{ n: number }>(
      `select count(*)::int as n from report_factions`)).rows[0]
    expect(readers?.n).toBe(2)
  })

  test('contestant wins with the better roll: claim lost, Location stays unclaimed', async () => {
    const { opened, contest } = await contestedClaim()

    // claimant: 5 × 0.85 = 4.25; contestant: 4 × 1.15 = 4.6
    const [resolved] = await processDueEvents(db, minutes(30 + WINDOW_MINUTES), rngSequence(0, 1))

    expect(resolved).toMatchObject({
      type: 'claim_resolved',
      won: false,
      contested: true,
      winnerFactionId: rival.factionId,
    })

    const location = (await db.query<{ controlling_faction_id: string | null }>(
      `select controlling_faction_id from locations where id = $1`, [fx.targetLocationId])).rows[0]
    expect(location?.controlling_faction_id).toBeNull()

    const claim = (await db.query<{ status: string }>(
      `select status from claims where id = $1`, [opened.claimId])).rows[0]
    expect(claim?.status).toBe('lost')

    const contestMission = (await db.query<{ status: string }>(
      `select status from missions where id = $1`, [contest.missionId])).rows[0]
    expect(contestMission?.status).toBe('completed')

    const crews = (await db.query<{ n: number }>(
      `select count(*)::int as n from crews where status = 'idle'`)).rows[0]
    expect(crews?.n).toBe(2) // both crews home
  })
})

describe('founding vs open claims', () => {
  test('cannot found an HQ on a Location with an open claim', async () => {
    await openClaim()
    await expect(
      foundFaction(db, {
        email: 'late@test.no',
        displayName: 'Latecomer',
        factionName: 'Late Boys',
        hqLocationSlug: 'rich-ruins',
      }, minutes(40)),
    ).rejects.toMatchObject({ code: 'claim_already_open' })
  })
})
