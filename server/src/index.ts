import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { createDb } from './db/db.js'
import { buildApp } from './api/app.js'
import { seedWorldIfEmpty } from './world.js'

const dataDir = fileURLToPath(new URL('../data', import.meta.url))
const db = await createDb(dataDir)
const seeded = await seedWorldIfEmpty(db)

const app = await buildApp({ db, clock: () => new Date() })

// Throwaway map client (dev only — the API itself stays client-free).
await app.fastify.register(fastifyStatic, {
  root: fileURLToPath(new URL('../public', import.meta.url)),
})

const TICK_INTERVAL_MS = 1000
setInterval(() => {
  app.tickDue().catch((err) => app.fastify.log.error(err))
}, TICK_INTERVAL_MS)

const port = Number(process.env.PORT ?? 3000)
await app.fastify.listen({ port, host: '0.0.0.0' })
console.log(`wasteland server listening on :${port}${seeded ? ' (world seeded)' : ''}`)
