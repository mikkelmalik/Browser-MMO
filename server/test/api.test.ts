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

  // exposeMagicLink lets the test read the link back instead of an email.
  app = await buildApp({ db, clock: () => now, exposeMagicLink: true })
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = app.fastify.server.address()
  if (typeof address === 'string' || !address) throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await app.fastify.close()
})

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function get(path: string, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, json: await res.json() }
}

/** Run the full magic-link flow and return a session token. */
async function login(email: string, displayName: string): Promise<string> {
  const link = await post('/auth/request-link', { email, displayName })
  expect(link.status).toBe(202)
  const verified = await post('/auth/verify', { token: link.json.token })
  expect(verified.status).toBe(200)
  return verified.json.sessionToken
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
  expect(map.status).toBe(200)
  expect(map.json.locations).toHaveLength(2)
  expect(map.json.routes).toHaveLength(1)
})

test('magic-link login: request → verify → /me, with no faction before founding', async () => {
  const link = await post('/auth/request-link', { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' })
  expect(link.status).toBe(202)
  expect(link.json.token).toBeTruthy()

  const verified = await post('/auth/verify', { token: link.json.token })
  expect(verified.status).toBe(200)
  const token = verified.json.sessionToken

  const me = await get('/me', token)
  expect(me.status).toBe(200)
  expect(me.json.user).toMatchObject({ displayName: 'Mikkel', email: 'mm@sharkgaming.dk' })
  expect(me.json.faction).toBeNull()
})

test('protected routes reject a missing or bad token with 401', async () => {
  expect((await get('/me')).status).toBe(401)
  expect((await post('/factions', { factionName: 'X', hqLocationSlug: 'ruined-copenhagen' })).status).toBe(401)
  expect((await post('/missions', { crewId: 'x', targetLocationSlug: 'kalundborg-refinery' }, 'garbage')).status).toBe(401)
})

test('the Bearer scheme is matched case-insensitively (RFC 7235)', async () => {
  const token = await login('mm@sharkgaming.dk', 'Mikkel')
  const res = await fetch(base + '/me', { headers: { authorization: `bearer ${token}` } })
  expect(res.status).toBe(200)
})

test('logout revokes the session server-side', async () => {
  const token = await login('mm@sharkgaming.dk', 'Mikkel')
  expect((await get('/me', token)).status).toBe(200)

  const out = await fetch(base + '/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  expect(out.status).toBe(204)

  // the bearer token is dead even though it hasn't expired
  expect((await get('/me', token)).status).toBe(401)
})

test('acting before founding a faction is a 409, not a spoofable factionId', async () => {
  const token = await login('mm@sharkgaming.dk', 'Mikkel')
  const dispatched = await post('/missions', { crewId: 'whatever', targetLocationSlug: 'kalundborg-refinery' }, token)
  expect(dispatched.status).toBe(409)
  expect(dispatched.json.error).toBe('no_faction')
})

test('the vertical slice: log in, found, dispatch a scavenge, resolve it, all visible live over WebSocket', async () => {
  const token = await login('mm@sharkgaming.dk', 'Mikkel')

  const founded = await post('/factions', { factionName: 'Rust Vultures', hqLocationSlug: 'ruined-copenhagen' }, token)
  expect(founded.status).toBe(201)
  const { crewId } = founded.json

  const before = await get('/me', token)
  expect(before.json.faction.outposts).toHaveLength(1)
  expect(before.json.faction.outposts[0].isHq).toBe(true)
  expect(before.json.faction.outposts[0].stores).toEqual({ scrap: 50, fuel: 100, water: 200 })
  expect(before.json.faction.crews).toEqual([
    expect.objectContaining({ id: crewId, status: 'idle', size: 5 }),
  ])

  const ws = await connectWs()

  const dispatched = await post('/missions', { crewId, targetLocationSlug: 'kalundborg-refinery' }, token)
  expect(dispatched.status).toBe(201)
  expect(dispatched.json.fuelSpent).toBe(20)

  const departMsg = await ws.waitFor('mission_dispatched')
  expect(departMsg.missionId).toBe(dispatched.json.missionId)

  // The crew is out — dispatching it again is a domain error
  const again = await post('/missions', { crewId, targetLocationSlug: 'kalundborg-refinery' }, token)
  expect(again.status).toBe(409)
  expect(again.json.error).toBe('crew_busy')

  // Time passes; the due-time queue resolves the mission
  now = new Date(dispatched.json.dueAt)
  await app.tickDue()

  const resolvedMsg = await ws.waitFor('mission_resolved')
  expect(resolvedMsg.haul).toEqual({ scrap: 1, fuel: 6, water: 0 })

  const after = await get('/me', token)
  expect(after.json.faction.outposts[0].stores).toEqual({ scrap: 55, fuel: 86, water: 204 })
  expect(after.json.faction.crews[0].status).toBe('idle')

  ws.close()
})

test('founding twice for the same user is rejected', async () => {
  const token = await login('mm@sharkgaming.dk', 'Mikkel')
  expect((await post('/factions', { factionName: 'First', hqLocationSlug: 'ruined-copenhagen' }, token)).status).toBe(201)
  const second = await post('/factions', { factionName: 'Second', hqLocationSlug: 'kalundborg-refinery' }, token)
  expect(second.status).toBe(409)
  expect(second.json.error).toBe('already_founded')
})

test('founding on an occupied Location is rejected', async () => {
  const a = await login('a@test.dk', 'A')
  const b = await login('b@test.dk', 'B')
  expect((await post('/factions', { factionName: 'First', hqLocationSlug: 'ruined-copenhagen' }, a)).status).toBe(201)
  const second = await post('/factions', { factionName: 'Second', hqLocationSlug: 'ruined-copenhagen' }, b)
  expect(second.status).toBe(409)
  expect(second.json.error).toBe('location_taken')
})
