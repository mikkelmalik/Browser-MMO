import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDb, type Db } from '../src/db/db.js'
import { buildApp } from '../src/api/app.js'

const NOW = new Date('2026-07-03T12:00:00Z')

let db: Db
let now: Date
let app: Awaited<ReturnType<typeof buildApp>>
let base: string

beforeEach(async () => {
  db = await createDb()
  now = NOW
  // A two-location world: HQ candidate and a refinery one Route apart.
  await db.query(
    `insert into locations (slug, name, kind, lat, lon, scrap_yield, fuel_yield, water_yield) values
     ('ruined-copenhagen', 'Ruined Copenhagen', 'city_ruins', 55.68, 12.57, 2, 0, 3),
     ('kalundborg-refinery', 'Kalundborg Refinery', 'refinery', 55.68, 11.09, 1, 6, 0)`)
  await db.query(
    `insert into routes (location_a_id, location_b_id, distance_km, fuel_cost, travel_minutes)
     select least(a.id, b.id), greatest(a.id, b.id), 100, 10, 30
     from locations a, locations b
     where a.slug = 'ruined-copenhagen' and b.slug = 'kalundborg-refinery'`)

  app = await buildApp({ db, clock: () => now })
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = app.fastify.server.address()
  if (typeof address === 'string' || !address) throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await app.fastify.close()
})

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function get(path: string): Promise<any> {
  const res = await fetch(base + path)
  expect(res.status).toBe(200)
  return res.json()
}

function connectWs(): Promise<{ received: any[]; waitFor: (type: string) => Promise<any>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const received: any[] = []
    ws.addEventListener('message', (event) => received.push(JSON.parse(String(event.data))))
    ws.addEventListener('open', () =>
      resolve({
        received,
        close: () => ws.close(),
        waitFor: async (type: string) => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const found = received.find((m) => m.type === type)
            if (found) return found
            await new Promise((r) => setTimeout(r, 20))
          }
          throw new Error(`no '${type}' message arrived; got: ${JSON.stringify(received)}`)
        },
      }),
    )
    ws.addEventListener('error', reject)
  })
}

test('GET /map returns the world graph', async () => {
  const map = await get('/map')
  expect(map.locations).toHaveLength(2)
  expect(map.locations.map((l: any) => l.slug).sort()).toEqual([
    'kalundborg-refinery',
    'ruined-copenhagen',
  ])
  expect(map.routes).toHaveLength(1)
})

test('the vertical slice: found a faction, dispatch a scavenge, resolve it, all visible live over WebSocket', async () => {
  // Found a Faction with its HQ at Ruined Copenhagen
  const founded = await post('/factions', {
    email: 'mm@sharkgaming.dk',
    displayName: 'Mikkel',
    factionName: 'Rust Vultures',
    hqLocationSlug: 'ruined-copenhagen',
  })
  expect(founded.status).toBe(201)
  const { factionId, crewId } = founded.json

  // Starting state: stores at starting amounts, one idle crew
  const before = await get(`/factions/${factionId}`)
  expect(before.outposts).toHaveLength(1)
  expect(before.outposts[0].isHq).toBe(true)
  expect(before.outposts[0].stores).toEqual({ scrap: 50, fuel: 100, water: 200 })
  expect(before.crews).toEqual([
    expect.objectContaining({ id: crewId, status: 'idle', size: 5 }),
  ])

  const ws = await connectWs()

  // Dispatch the crew to scavenge the refinery
  const dispatched = await post('/missions', {
    factionId,
    crewId,
    targetLocationSlug: 'kalundborg-refinery',
  })
  expect(dispatched.status).toBe(201)
  expect(dispatched.json.fuelSpent).toBe(20)

  const departMsg = await ws.waitFor('mission_dispatched')
  expect(departMsg.missionId).toBe(dispatched.json.missionId)
  expect(departMsg.factionId).toBe(factionId)

  // The crew is out — dispatching it again is a domain error
  const again = await post('/missions', {
    factionId,
    crewId,
    targetLocationSlug: 'kalundborg-refinery',
  })
  expect(again.status).toBe(409)
  expect(again.json.error).toBe('crew_busy')

  // Time passes; the due-time queue resolves the mission
  now = new Date(dispatched.json.dueAt)
  await app.tickDue()

  const resolvedMsg = await ws.waitFor('mission_resolved')
  expect(resolvedMsg.missionId).toBe(dispatched.json.missionId)
  // haul = yield × 1h dwell × size 5 × factor 0.2
  expect(resolvedMsg.haul).toEqual({ scrap: 1, fuel: 6, water: 0 })

  // Settled + hauled: scrap 50+2/h×2h+1 = 55, fuel 100−20+6 = 86, water 200+2/h×2h = 204
  const after = await get(`/factions/${factionId}`)
  expect(after.outposts[0].stores).toEqual({ scrap: 55, fuel: 86, water: 204 })
  expect(after.crews[0].status).toBe('idle')

  ws.close()
})

test('founding on an occupied Location is rejected', async () => {
  const first = await post('/factions', {
    email: 'a@test.dk',
    displayName: 'A',
    factionName: 'First',
    hqLocationSlug: 'ruined-copenhagen',
  })
  expect(first.status).toBe(201)

  const second = await post('/factions', {
    email: 'b@test.dk',
    displayName: 'B',
    factionName: 'Second',
    hqLocationSlug: 'ruined-copenhagen',
  })
  expect(second.status).toBe(409)
  expect(second.json.error).toBe('location_taken')
})
