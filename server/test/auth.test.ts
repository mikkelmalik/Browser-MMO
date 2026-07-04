import { beforeEach, describe, expect, test } from 'vitest'
import { createDb, type Db } from '../src/db/db.js'
import {
  authenticate,
  requestLoginLink,
  revokeSession,
  verifyLoginToken,
  LOGIN_TOKEN_TTL_MINUTES,
  SESSION_TTL_HOURS,
} from '../src/domain/auth.js'
import { foundFaction } from '../src/domain/founding.js'

const NOW = new Date('2026-07-03T12:00:00Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000)

let db: Db

beforeEach(async () => {
  db = await createDb()
})

describe('requestLoginLink', () => {
  test('creates a new user + a single-use token that expires in the TTL', async () => {
    const link = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)

    expect(link.isNewUser).toBe(true)
    expect(link.token).toMatch(/^[\w-]{20,}$/) // urlsafe, non-trivial length
    expect(link.expiresAt).toEqual(minutes(LOGIN_TOKEN_TTL_MINUTES))

    const user = (await db.query<{ display_name: string }>(
      `select display_name from users where id = $1`, [link.userId])).rows[0]
    expect(user?.display_name).toBe('Mikkel')

    const stored = (await db.query<{ n: number }>(
      `select count(*)::int as n from login_tokens where user_id = $1 and consumed_at is null`,
      [link.userId])).rows[0]
    expect(stored?.n).toBe(1)
  })

  test('reuses the existing user for a known email — no displayName needed', async () => {
    const first = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)
    const second = await requestLoginLink(db, { email: 'mm@sharkgaming.dk' }, minutes(1))

    expect(second.isNewUser).toBe(false)
    expect(second.userId).toBe(first.userId)
    expect(second.token).not.toBe(first.token)
  })

  test('normalizes the email so case/whitespace never forks the account', async () => {
    const first = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)
    const second = await requestLoginLink(db, { email: '  MM@Sharkgaming.DK ' }, minutes(1))
    expect(second.userId).toBe(first.userId)
  })

  test('refuses to create an unknown user without a displayName', async () => {
    await expect(requestLoginLink(db, { email: 'stranger@test.dk' }, NOW))
      .rejects.toMatchObject({ code: 'display_name_required' })
  })
})

describe('verifyLoginToken', () => {
  test('consumes a valid token and returns a session with the session TTL', async () => {
    const link = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)

    const session = await verifyLoginToken(db, link.token, minutes(2))

    expect(session.userId).toBe(link.userId)
    expect(session.token).toMatch(/^[\w-]{20,}$/)
    expect(session.expiresAt).toEqual(new Date(minutes(2).getTime() + SESSION_TTL_HOURS * 3_600_000))

    const consumed = (await db.query<{ consumed_at: Date | null }>(
      `select consumed_at from login_tokens where token = $1`, [link.token])).rows[0]
    expect(consumed?.consumed_at).not.toBeNull()
  })

  test('rejects an unknown token', async () => {
    await expect(verifyLoginToken(db, 'nope', NOW)).rejects.toMatchObject({ code: 'invalid_login_token' })
  })

  test('rejects an expired token', async () => {
    const link = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)
    await expect(verifyLoginToken(db, link.token, minutes(LOGIN_TOKEN_TTL_MINUTES + 1)))
      .rejects.toMatchObject({ code: 'invalid_login_token' })
  })

  test('is single-use: a consumed token cannot be verified again', async () => {
    const link = await requestLoginLink(db, { email: 'mm@sharkgaming.dk', displayName: 'Mikkel' }, NOW)
    await verifyLoginToken(db, link.token, minutes(1))
    await expect(verifyLoginToken(db, link.token, minutes(2)))
      .rejects.toMatchObject({ code: 'invalid_login_token' })
  })
})

describe('authenticate', () => {
  async function login(email: string, displayName: string) {
    const link = await requestLoginLink(db, { email, displayName }, NOW)
    return verifyLoginToken(db, link.token, minutes(1))
  }

  test('resolves a session to its user with no faction before founding', async () => {
    const session = await login('mm@sharkgaming.dk', 'Mikkel')
    const authed = await authenticate(db, session.token, minutes(2))
    expect(authed).toEqual({ userId: session.userId, factionId: null })
  })

  test('returns the founded faction for the user', async () => {
    const session = await login('mm@sharkgaming.dk', 'Mikkel')
    const loc = (await db.query<{ id: string }>(
      `insert into locations (slug, name, kind, lat, lon, scrap_yield, fuel_yield, water_yield)
       values ('hq', 'HQ', 'town', 55, 12, 2, 0, 3) returning id`)).rows[0]!
    const founded = await foundFaction(db, {
      userId: session.userId, factionName: 'Rust Barons', hqLocationSlug: 'hq',
    }, minutes(2))

    const authed = await authenticate(db, session.token, minutes(3))
    expect(authed).toEqual({ userId: session.userId, factionId: founded.factionId })
    expect(loc.id).toBeTruthy()
  })

  test('rejects an unknown session', async () => {
    await expect(authenticate(db, 'nope', NOW)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test('rejects an expired session', async () => {
    const session = await login('mm@sharkgaming.dk', 'Mikkel')
    await expect(authenticate(db, session.token, hours(SESSION_TTL_HOURS + 1)))
      .rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test('a revoked session no longer authenticates', async () => {
    const session = await login('mm@sharkgaming.dk', 'Mikkel')
    await revokeSession(db, session.token)
    await expect(authenticate(db, session.token, minutes(2)))
      .rejects.toMatchObject({ code: 'unauthenticated' })
  })
})
