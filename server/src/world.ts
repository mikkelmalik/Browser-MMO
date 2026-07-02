import type { Db } from './db/db.js'

// Launch world: post-apocalyptic Scandinavia as a node graph of real places.
// Yields are tuning knobs (plan open question #3/#4).
//                slug                    name                     kind          lat     lon    scrap fuel water
const LOCATIONS: Array<[string, string, string, number, number, number, number, number]> = [
  ['ruined-copenhagen', 'Ruined Copenhagen', 'city_ruins', 55.68, 12.57, 8, 1, 2],
  ['ruined-aarhus', 'Ruined Aarhus', 'city_ruins', 56.16, 10.20, 6, 1, 2],
  ['fredericia-refinery', 'Fredericia Refinery', 'refinery', 55.57, 9.75, 1, 8, 0],
  ['skagen-port', 'Skagen Port', 'port', 57.72, 10.58, 4, 3, 1],
  ['ruined-gothenburg', 'Ruined Gothenburg', 'city_ruins', 57.71, 11.97, 7, 1, 2],
  ['vaenern-reservoir', 'Vänern Reservoir', 'reservoir', 58.90, 13.20, 0, 0, 10],
  ['ruined-oslo', 'Ruined Oslo', 'city_ruins', 59.91, 10.75, 7, 1, 3],
  ['ruined-stockholm', 'Ruined Stockholm', 'city_ruins', 59.33, 18.07, 8, 1, 2],
  ['kiruna-mine', 'Kiruna Mine', 'mine', 67.86, 20.23, 12, 0, 0],
  ['mongstad-refinery', 'Mongstad Refinery', 'refinery', 60.81, 5.03, 1, 10, 0],
]

const ROUTES: Array<[string, string, number]> = [
  ['ruined-copenhagen', 'ruined-aarhus', 300],
  ['ruined-aarhus', 'fredericia-refinery', 100],
  ['ruined-aarhus', 'skagen-port', 200],
  ['ruined-copenhagen', 'ruined-gothenburg', 300],
  ['skagen-port', 'ruined-gothenburg', 150],
  ['ruined-gothenburg', 'vaenern-reservoir', 120],
  ['ruined-gothenburg', 'ruined-oslo', 300],
  ['vaenern-reservoir', 'ruined-stockholm', 300],
  ['ruined-oslo', 'mongstad-refinery', 450],
  ['ruined-stockholm', 'kiruna-mine', 900],
]

const FUEL_PER_KM = 1 / 20
const MINUTES_PER_KM = 0.5

export async function seedWorldIfEmpty(db: Db): Promise<boolean> {
  const count = (await db.query<{ n: number }>(`select count(*)::int as n from locations`)).rows[0]!
  if (count.n > 0) return false

  for (const [slug, name, kind, lat, lon, scrap, fuel, water] of LOCATIONS) {
    await db.query(
      `insert into locations (slug, name, kind, lat, lon, scrap_yield, fuel_yield, water_yield)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [slug, name, kind, lat, lon, scrap, fuel, water])
  }
  for (const [a, b, km] of ROUTES) {
    await db.query(
      `insert into routes (location_a_id, location_b_id, distance_km, fuel_cost, travel_minutes)
       select least(la.id, lb.id), greatest(la.id, lb.id), $3, $4, $5
       from locations la, locations lb where la.slug = $1 and lb.slug = $2`,
      [a, b, km, km * FUEL_PER_KM, Math.round(km * MINUTES_PER_KM)])
  }
  return true
}
