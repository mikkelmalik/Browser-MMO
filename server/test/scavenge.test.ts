import { beforeEach, describe, expect, test } from 'vitest'
import { createDb, type Db } from '../src/db/db.js'
import {
  DomainError,
  dispatchScavenge,
  processDueEvents,
} from '../src/domain/scavenge.js'
import { getStoreAmount, seedFixture, type Fixture } from './fixtures.js'

const NOW = new Date('2026-07-03T12:00:00Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)

let db: Db

beforeEach(async () => {
  db = await createDb()
})

describe('dispatchScavenge', () => {
  test('creates the mission, spends round-trip Fuel, marks crew on_mission, queues a due event', async () => {
    const fx = await seedFixture(db, NOW)

    const result = await dispatchScavenge(db, {
      factionId: fx.factionId,
      crewId: fx.crewId,
      targetLocationId: fx.targetLocationId,
    }, NOW)

    // round trip: 2 × 10 fuel; duration: 2 × 30 min travel + 60 min dwell
    expect(result.fuelSpent).toBe(20)
    expect(result.dueAt).toEqual(minutes(120))
    expect(await getStoreAmount(db, fx.outpostId, 'fuel')).toBe(80)

    const mission = (await db.query<{ status: string; due_at: Date }>(
      `select status, due_at from missions where id = $1`, [result.missionId])).rows[0]
    expect(mission?.status).toBe('underway')
    expect(new Date(mission!.due_at)).toEqual(minutes(120))

    const crew = (await db.query<{ status: string }>(
      `select status from crews where id = $1`, [fx.crewId])).rows[0]
    expect(crew?.status).toBe('on_mission')

    const pending = (await db.query<{ n: number }>(
      `select count(*)::int as n from due_events where processed_at is null and kind = 'mission_due'`)).rows[0]
    expect(pending?.n).toBe(1)
  })

  test('rejects when the origin Outpost cannot afford the Fuel — and changes nothing', async () => {
    const fx = await seedFixture(db, NOW, { fuelAmount: 5 })

    await expect(
      dispatchScavenge(db, {
        factionId: fx.factionId,
        crewId: fx.crewId,
        targetLocationId: fx.targetLocationId,
      }, NOW),
    ).rejects.toMatchObject({ code: 'insufficient_fuel' })

    expect(await getStoreAmount(db, fx.outpostId, 'fuel')).toBe(5)
    const missions = (await db.query<{ n: number }>(`select count(*)::int as n from missions`)).rows[0]
    expect(missions?.n).toBe(0)
    const crew = (await db.query<{ status: string }>(
      `select status from crews where id = $1`, [fx.crewId])).rows[0]
    expect(crew?.status).toBe('idle')
  })

  test('rejects a crew that is already on a mission', async () => {
    const fx = await seedFixture(db, NOW)
    const args = { factionId: fx.factionId, crewId: fx.crewId, targetLocationId: fx.targetLocationId }
    await dispatchScavenge(db, args, NOW)

    await expect(dispatchScavenge(db, args, NOW)).rejects.toMatchObject({ code: 'crew_busy' })
  })

  test('rejects a target with no Route from the crew’s Location', async () => {
    const fx = await seedFixture(db, NOW)
    const farCity = (await db.query<{ id: string }>(
      `insert into locations (slug, name, kind, lat, lon) values ('far-city', 'Far City', 'city_ruins', 60, 20) returning id`)).rows[0]!

    await expect(
      dispatchScavenge(db, {
        factionId: fx.factionId,
        crewId: fx.crewId,
        targetLocationId: farCity.id,
      }, NOW),
    ).rejects.toMatchObject({ code: 'no_route' })
  })
})

describe('processDueEvents', () => {
  async function dispatched(fx: Fixture) {
    return dispatchScavenge(db, {
      factionId: fx.factionId,
      crewId: fx.crewId,
      targetLocationId: fx.targetLocationId,
    }, NOW)
  }

  test('does nothing before the mission is due', async () => {
    const fx = await seedFixture(db, NOW)
    await dispatched(fx)

    const resolutions = await processDueEvents(db, minutes(119))

    expect(resolutions).toEqual([])
    const mission = (await db.query<{ status: string }>(`select status from missions`)).rows[0]
    expect(mission?.status).toBe('underway')
  })

  test('resolves a due mission: haul deposited (settled first), crew idle, mission completed', async () => {
    const fx = await seedFixture(db, NOW)
    const { missionId } = await dispatched(fx)

    const resolutions = await processDueEvents(db, minutes(120))

    // haul = yield × 1h dwell × size 5 × factor 0.2 = yield × 1
    expect(resolutions).toEqual([
      {
        type: 'mission_resolved',
        missionId,
        factionId: fx.factionId,
        crewId: fx.crewId,
        haul: { scrap: 10, fuel: 4, water: 0 },
      },
    ])

    // scrap: 50 settled +2/h for 2h = 54, +10 haul = 64
    expect(await getStoreAmount(db, fx.outpostId, 'scrap')).toBe(64)
    // fuel: 80 after dispatch, rate 0, +4 haul = 84
    expect(await getStoreAmount(db, fx.outpostId, 'fuel')).toBe(84)
    // water: 200 −1/h for 2h = 198, no haul
    expect(await getStoreAmount(db, fx.outpostId, 'water')).toBe(198)

    const mission = (await db.query<{ status: string; outcome: { haul: Record<string, number> } }>(
      `select status, outcome from missions where id = $1`, [missionId])).rows[0]
    expect(mission?.status).toBe('completed')
    expect(mission?.outcome.haul).toEqual({ scrap: 10, fuel: 4, water: 0 })

    const crew = (await db.query<{ status: string; location_id: string }>(
      `select status, location_id from crews where id = $1`, [fx.crewId])).rows[0]
    expect(crew?.status).toBe('idle')
    expect(crew?.location_id).toBe(fx.hqLocationId)
  })

  test('deposits clamp at storage capacity (the catch-up cap)', async () => {
    const fx = await seedFixture(db, NOW, { scrapAmount: 495, scrapCapacity: 500 })
    await dispatched(fx)

    await processDueEvents(db, minutes(120))

    expect(await getStoreAmount(db, fx.outpostId, 'scrap')).toBe(500)
  })

  test('is idempotent: a second sweep resolves nothing', async () => {
    const fx = await seedFixture(db, NOW)
    await dispatched(fx)

    await processDueEvents(db, minutes(120))
    const again = await processDueEvents(db, minutes(121))

    expect(again).toEqual([])
    expect(await getStoreAmount(db, fx.outpostId, 'scrap')).toBe(64)
  })
})
