# Lazy accrual + due-time queue instead of a global tick

The plan called for "a tick/event system" to advance world state, but we deliberately chose **not** to run a global tick. Continuous state (Scrap/Fuel/Water accrual) is computed on read from a last-updated timestamp and a rate — idle Outposts cost nothing and accrual math is exact rather than tick-granular. Discrete happenings (Mission completion, Contest-window close, Siege end, Surge expiry) are rows with a due-at time, processed by a small scheduler when due.

## Considered Options

- **Global tick every N minutes** — simpler mental model and easy to debug, but does work proportional to world size even when nothing changes, and caps accrual granularity at the tick rate.
- **Coarse daily/hourly turns** — fights the "check in a few times a day" cadence and the real-time WebSocket layer.
- **Full event sourcing** — great audit trail, too heavyweight for v1.

## Consequences

- Any code that reads a resource balance must go through the accrual computation (read-time settlement); raw column values are stale by design.
- Rate changes (upgrades, Dormant state, Surge) must settle accrued resources at the moment the rate changes, then update the timestamp and rate.
- There is no "tick number" in the domain — anything that needs ordering uses timestamps and the due-time queue.
