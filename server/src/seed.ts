// Standalone seed script: `npm run seed`
import { fileURLToPath } from 'node:url'
import { createDb } from './db/db.js'
import { seedWorldIfEmpty } from './world.js'

const dataDir = fileURLToPath(new URL('../data', import.meta.url))
const db = await createDb(dataDir)
const seeded = await seedWorldIfEmpty(db)
console.log(seeded ? 'world seeded' : 'world already seeded — nothing to do')
await db.close()
