import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { z, ZodError } from 'zod'
import type { Db } from '../db/db.js'
import { DomainError } from '../domain/errors.js'
import { dispatchScavenge } from '../domain/scavenge.js'
import { dispatchClaim, dispatchContest, type Rng } from '../domain/claims.js'
import { processDueEvents } from '../domain/events.js'
import { foundFaction } from '../domain/founding.js'
import { settleStore } from '../domain/settlement.js'

export interface AppDeps {
  db: Db
  clock: () => Date
  /** Combat luck source; injectable for tests. */
  rng?: Rng
}

export interface App {
  fastify: FastifyInstance
  /** Process all due events and broadcast the resolutions. */
  tickDue: () => Promise<void>
}

const FoundBody = z.object({
  email: z.string().min(3),
  displayName: z.string().min(1),
  factionName: z.string().min(1),
  hqLocationSlug: z.string().min(1),
})

const MissionBody = z.object({
  factionId: z.string().min(1),
  crewId: z.string().min(1),
  targetLocationSlug: z.string().min(1),
  kind: z.enum(['scavenge', 'claim', 'contest']).default('scavenge'),
})

export async function buildApp({ db, clock, rng = Math.random }: AppDeps): Promise<App> {
  const fastify = Fastify()
  await fastify.register(websocket)

  const sockets = new Set<{ readyState: number; send: (data: string) => void }>()
  const broadcast = (message: Record<string, unknown>) => {
    const data = JSON.stringify(message)
    for (const socket of sockets) {
      if (socket.readyState === 1 /* OPEN */) socket.send(data)
    }
  }

  fastify.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      const status = err.code.endsWith('_not_found') ? 404 : 409
      return reply.status(status).send({ error: err.code, message: err.message })
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_body', message: err.message })
    }
    fastify.log.error(err)
    return reply.status(500).send({ error: 'internal' })
  })

  fastify.post('/factions', async (req, reply) => {
    const body = FoundBody.parse(req.body)
    const result = await foundFaction(db, body, clock())
    broadcast({ type: 'faction_founded', factionId: result.factionId, hqLocationSlug: body.hqLocationSlug })
    return reply.status(201).send(result)
  })

  fastify.post('/missions', async (req, reply) => {
    const body = MissionBody.parse(req.body)
    const target = (await db.query<{ id: string }>(
      `select id from locations where slug = $1`, [body.targetLocationSlug])).rows[0]
    if (!target) throw new DomainError('location_not_found', `no location '${body.targetLocationSlug}'`)

    const args = { factionId: body.factionId, crewId: body.crewId, targetLocationId: target.id }
    const now = clock()
    const result = body.kind === 'claim' ? await dispatchClaim(db, args, now)
      : body.kind === 'contest' ? await dispatchContest(db, args, now)
      : await dispatchScavenge(db, args, now)
    const dueAt = 'dueAt' in result ? result.dueAt : result.arrivesAt

    broadcast({
      type: 'mission_dispatched',
      kind: body.kind,
      missionId: result.missionId,
      factionId: body.factionId,
      crewId: body.crewId,
      targetLocationSlug: body.targetLocationSlug,
      dueAt: dueAt.toISOString(),
    })
    return reply.status(201).send({
      missionId: result.missionId,
      dueAt: dueAt.toISOString(),
      fuelSpent: result.fuelSpent,
    })
  })

  fastify.get('/claims', async () => {
    const claims = (await db.query(
      `select cl.id, l.slug as location_slug, cl.claimant_faction_id, f.name as claimant_name,
              cl.opened_at, cl.closes_at,
              coalesce(json_agg(cc.faction_id) filter (where cc.faction_id is not null), '[]') as contesting_faction_ids
       from claims cl
       join locations l on l.id = cl.location_id
       join factions f on f.id = cl.claimant_faction_id
       left join claim_contests cc on cc.claim_id = cl.id
       where cl.status = 'open'
       group by cl.id, l.slug, cl.claimant_faction_id, f.name, cl.opened_at, cl.closes_at
       order by cl.closes_at`)).rows
    return { claims }
  })

  fastify.get('/map', async () => {
    const locations = (await db.query(
      `select id, slug, name, kind, lat, lon,
              scrap_yield::float8 as scrap_yield, fuel_yield::float8 as fuel_yield,
              water_yield::float8 as water_yield, controlling_faction_id
       from locations order by slug`)).rows
    const routes = (await db.query(
      `select id, location_a_id, location_b_id, distance_km::float8 as distance_km,
              fuel_cost::float8 as fuel_cost, travel_minutes
       from routes`)).rows
    return { locations, routes }
  })

  fastify.get('/factions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const now = clock()

    const faction = (await db.query<{ id: string; name: string }>(
      `select id, name from factions where id = $1`, [id])).rows[0]
    if (!faction) throw new DomainError('faction_not_found', 'no such faction')

    const outpostRows = (await db.query<{
      id: string
      is_hq: boolean
      survivors: number
      dormant_at: Date | null
      slug: string
    }>(
      `select o.id, o.is_hq, o.survivors, o.dormant_at, l.slug
       from outposts o join locations l on l.id = o.location_id
       where o.faction_id = $1`, [id])).rows

    const outposts = []
    for (const outpost of outpostRows) {
      const storeRows = (await db.query<{
        resource: string
        amount: number
        rate_per_hour: number
        capacity: number
        settled_at: Date
      }>(
        `select resource, amount::float8 as amount, rate_per_hour::float8 as rate_per_hour,
                capacity::float8 as capacity, settled_at
         from outpost_stores where outpost_id = $1`, [outpost.id])).rows
      const stores: Record<string, number> = {}
      for (const row of storeRows) {
        // Read-time settlement (ADR-0001): live value, no write needed
        stores[row.resource] = settleStore(
          {
            amount: row.amount,
            ratePerHour: row.rate_per_hour,
            capacity: row.capacity,
            settledAt: new Date(row.settled_at),
          },
          now,
          outpost.dormant_at ? new Date(outpost.dormant_at) : null,
        ).amount
      }
      outposts.push({
        id: outpost.id,
        locationSlug: outpost.slug,
        isHq: outpost.is_hq,
        survivors: outpost.survivors,
        dormantAt: outpost.dormant_at,
        stores,
      })
    }

    const crews = (await db.query(
      `select id, name, size, status, location_id from crews where faction_id = $1 order by created_at`,
      [id])).rows
    const missions = (await db.query(
      `select id, crew_id, kind, status, target_location_id, departed_at, due_at
       from missions where faction_id = $1 and status = 'underway'`, [id])).rows

    const reports = (await db.query(
      `select r.id, r.kind, r.body, r.created_at, rf.read_at
       from report_factions rf join reports r on r.id = rf.report_id
       where rf.faction_id = $1
       order by r.created_at desc limit 20`, [id])).rows

    return reply.send({ faction, outposts, crews, missions, reports })
  })

  const tickDue = async () => {
    const events = await processDueEvents(db, clock(), rng)
    for (const event of events) broadcast({ ...event })
  }

  return { fastify, tickDue }
}
