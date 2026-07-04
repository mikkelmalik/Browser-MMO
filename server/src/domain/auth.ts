import { randomBytes } from 'node:crypto'
import type { Db } from '../db/db.js'
import { DomainError } from './errors.js'

// Tuning knobs: a login link is short-lived; sessions are long because this is
// a check-in-once-a-day game and re-authing constantly would be hostile.
export const LOGIN_TOKEN_TTL_MINUTES = 15
export const SESSION_TTL_HOURS = 24 * 30

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/** A urlsafe, high-entropy opaque token for both login links and sessions. */
const newToken = () => randomBytes(32).toString('base64url')

const normalizeEmail = (email: string) => email.trim().toLowerCase()

export interface LoginLink {
  token: string
  userId: string
  isNewUser: boolean
  expiresAt: Date
}

export interface RequestArgs {
  email: string
  /** Required only when the email is unknown (first-time signup). */
  displayName?: string
}

/**
 * Begin a magic-link login: resolve (or create) the user for this email and
 * mint a single-use login token. The caller delivers the link; this module
 * never sends email itself (ADR-0004 — delivery is a swappable port).
 */
export async function requestLoginLink(db: Db, args: RequestArgs, now: Date): Promise<LoginLink> {
  const email = normalizeEmail(args.email)
  return db.transaction(async (tx) => {
    let user = (await tx.query<{ id: string }>(
      `select id from users where email = $1`, [email])).rows[0]
    const isNewUser = !user
    if (!user) {
      const displayName = args.displayName?.trim()
      if (!displayName) {
        throw new DomainError('display_name_required', 'a display name is required to sign up', 400)
      }
      user = (await tx.query<{ id: string }>(
        `insert into users (email, display_name) values ($1, $2) returning id`,
        [email, displayName])).rows[0]!
    }

    const token = newToken()
    const expiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * MINUTE_MS)
    await tx.query(
      `insert into login_tokens (token, user_id, created_at, expires_at) values ($1, $2, $3, $4)`,
      [token, user.id, now, expiresAt])

    return { token, userId: user.id, isNewUser, expiresAt }
  })
}

export interface Session {
  token: string
  userId: string
  expiresAt: Date
}

/**
 * Consume a login token and open a session. Single-use and expiry are enforced
 * inside one transaction so a token can never mint two sessions.
 */
export async function verifyLoginToken(db: Db, loginToken: string, now: Date): Promise<Session> {
  return db.transaction(async (tx) => {
    const row = (await tx.query<{ user_id: string; expires_at: Date; consumed_at: Date | null }>(
      `select user_id, expires_at, consumed_at from login_tokens where token = $1 for update`,
      [loginToken])).rows[0]
    if (!row || row.consumed_at || new Date(row.expires_at) <= now) {
      throw new DomainError('invalid_login_token', 'this login link is invalid or has expired', 401)
    }
    await tx.query(`update login_tokens set consumed_at = $1 where token = $2`, [now, loginToken])

    const token = newToken()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * HOUR_MS)
    await tx.query(
      `insert into sessions (token, user_id, created_at, expires_at, last_seen_at) values ($1, $2, $3, $4, $3)`,
      [token, row.user_id, now, expiresAt])

    return { token, userId: row.user_id, expiresAt }
  })
}

export interface AuthedUser {
  userId: string
  /** The user's Faction, or null if they haven't founded one yet. */
  factionId: string | null
}

/** Revoke a session (sign-out). Idempotent: an unknown token is a no-op. */
export async function revokeSession(db: Db, sessionToken: string): Promise<void> {
  await db.query(`delete from sessions where token = $1`, [sessionToken])
}

/** Resolve a bearer session token to its user and Faction, or reject. */
export async function authenticate(db: Db, sessionToken: string, now: Date): Promise<AuthedUser> {
  const session = (await db.query<{ user_id: string; expires_at: Date }>(
    `select user_id, expires_at from sessions where token = $1`, [sessionToken])).rows[0]
  if (!session || new Date(session.expires_at) <= now) {
    throw new DomainError('unauthenticated', 'not signed in', 401)
  }
  await db.query(`update sessions set last_seen_at = $1 where token = $2`, [now, sessionToken])

  const faction = (await db.query<{ id: string }>(
    `select id from factions where owner_user_id = $1`, [session.user_id])).rows[0]
  return { userId: session.user_id, factionId: faction?.id ?? null }
}
