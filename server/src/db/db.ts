import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type Db = PGlite

const schemaSql = readFileSync(
  fileURLToPath(new URL('./schema.sql', import.meta.url)),
  'utf8',
)

/**
 * Open a database and apply the schema. With no dataDir the database is
 * in-memory (tests); with a dataDir it persists to disk (dev). Production
 * swaps this for a real Postgres pool — same SQL throughout (ADR-0003).
 */
export async function createDb(dataDir?: string): Promise<Db> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite()
  await db.exec(schemaSql)
  return db
}
