# Magic-link login and server-side bearer sessions

Until now the API trusted a `factionId` supplied in the request body: any client could act as any Faction. That is acceptable for a vertical slice but not for a shared server a friend group actually logs into. We add identity.

## Decision

- **Login is passwordless magic links.** `POST /auth/request-link {email, displayName?}` resolves (or, on first sight with a display name, creates) the user and mints a single-use, 15-minute `login_tokens` row. The link is emailed; opening it hits `POST /auth/verify {token}`, which consumes the token and opens a session. No passwords to store, reset, or leak — the right weight for this audience.
- **Sessions are opaque server-side bearer tokens**, stored in a `sessions` table (token → user, with expiry and `last_seen_at`), sent as `Authorization: Bearer <token>`. Not cookies (React Native, the real client, handles bearer headers far more cleanly), and not JWTs (a table is revocable, needs no signing keys, and fits the authoritative-server pillar — the same reasoning as ADR-0003 favouring real SQL over cleverness). Sessions are long-lived (30 days) because a check-in-once-a-day game must not force re-auth constantly.
- **The server derives the Faction from the session, never from the body.** `factionId` is gone from every request; `POST /missions` and `POST /factions` act as the authenticated user's one Faction (`factions.owner_user_id`, already unique). `GET /me` returns the caller's user and Faction snapshot and is the client's sole "who am I".
- **Email delivery is a swappable port.** `buildApp` takes a `sendMagicLink` dependency; dev logs the link (and, behind an explicit `exposeMagicLink` flag, returns it in the response so the throwaway client can offer a one-click shortcut). Production injects a real mailer. Same pattern as swapping PGlite for Postgres (ADR-0003): the mechanism is real from day one, only delivery is wired later.

## Consequences

- The action-spoofing hole is closed: you can only command the Faction your session owns; acting before founding is a clean 409, and a missing/expired token is a 401.
- Login tokens are single-use and expire; sessions are revocable by deleting the row — no crypto to rotate.
- **The WebSocket (`/ws`) remains an unauthenticated read-only firehose** of world events; clients filter by `factionId`. It grants no authority (all writes are authenticated REST), but it does broadcast other Factions' haul amounts and movements. Tightening that — authenticating the socket, or scoping broadcasts — is deliberately out of scope here and left as a follow-up.
- `exposeMagicLink` must never be enabled in production; it exists so dev and tests can read the link without a mailer.
