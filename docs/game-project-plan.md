# Multiplayer Management Game — Project Plan

## Overview

A persistent, asynchronous multiplayer management game for a small friend group. Inspired by classic browser-based management games (e.g. football manager sims) where players check in periodically rather than playing long sessions. Progress accrues over real time; missing a day should not cause catastrophic losses.

**Core feel:** slow-burn strategy, social, low-pressure. Check in once a day (or a few times), make meaningful decisions, watch the world evolve.

---

## Decided So Far

> Canonical vocabulary for all terms below lives in [`CONTEXT.md`](../CONTEXT.md) at the repo root.

### Theme & world (decided 2026-07-03)
- **Post-apocalyptic version of the real world**, Mad Max-styled. Lore direction (to be developed further): the AIs — robot powers named after AI labs (Anthropic, OpenAI, …) — plus weakened remnant governments (America, China, …) exist as NPC powers; more factions can emerge over time.
- **Playable map at launch: Scandinavia** ("the Region"). The rest of the world is inaccessible wasteland, openable later as content.
- **Map model: node graph of real places.** Named real-world Locations (ruined cities, ports, plants) are nodes connected by road Routes. All movement is along Routes; territory control = controlling a Location.

### Player & faction model (decided 2026-07-03)
- A player controls a **Faction**. "Faction" means any territory-holding power — **NPC powers are the same entity type**, with the server making their decisions. New NPC Factions can be introduced by inserting data, not building new systems.
- Factions hold **Outposts** at Locations. Every player starts with a single **HQ** Outpost and expands from there.
- **HQ placement is free choice**: any unclaimed Location in the Region (the friend group coordinates socially; scatter is self-correcting).
- The **HQ can never be besieged, captured, or raided** — a Faction cannot be eliminated.
- NPC Factions hold most of the map at start: expansion is PvE before it is PvP, and the wasteland feels hostile rather than empty.

### Resources & progression (decided 2026-07-03)
- Four resources, four jobs: **Scrap** (build/craft currency), **Fuel** (action currency — every Crew movement burns it), **Water** (upkeep consumed by Survivors), **Survivors** (population/capacity).
- **Production = Location yields × Outpost upgrades.** Locations are inherently specialized (refinery → Fuel, reservoir → Water, city ruins → Scrap), so specific Locations are worth fighting over.
- **Upkeep failure is stagnation, not loss**: at zero Water an Outpost goes **Dormant** — production and crew actions halt, nothing is ever lost to absence.
- **Catch-up: storage caps + return Surge.** Resources accrue while away only up to storage caps; returning after 3+ days grants a temporary Surge (boosted production, faster Missions).

### Session loop (decided 2026-07-03)
- **Crew dispatch loop.** A Faction has a handful of Crews; a session = read what happened, dispatch each Crew on a Mission (scavenge, claim, escort, raid, siege), queue a build upgrade. Missions take real-world hours; Crews idle safely when the player is away.

### Conflict rules (decided 2026-07-03)
- **Claims use a contest window**: a Claim plants a flag that must hold for a fixed window (~24h); rivals can Contest during it; the server resolves deterministically at window close. Nobody has to be online at the right moment.
- **Outposts are capturable — but only via slow Sieges** (~72h, publicly visible), during which the defender **and any other Faction** can send Crews to break the siege. A daily check-in is always enough time to respond; defense is a designed co-op moment.
- **Raids** are fast strikes that skim a capped share of stored resources — never Survivors, buildings, or the Outpost itself.
- **Combat resolution: stats + bounded luck + Report.** Power = crew size, vehicles, equipment, modifiers (terrain, defenses, aid); bounded randomness (~±15%); every fight generates an after-action Report (the football-manager match report analog).
- **Cooperation is informal** — no alliance system, treaties, or reputation mechanics. Any Faction can aid any other; politics live in the group chat.

### Multiplayer model
- **Mixed cooperative + competitive.**
- Competitive elements: challenge friends for resources/tools, claim territory, leaderboards/rivalry.
- Cooperative elements: joint missions when players share an area, seasonal/timed events where players team up against shared threats.
- Cooperative moments are designed to be natural social gathering points ("we teamed up for the winter event").

### World model
- **True shared, persistent world.** Actions ripple outward and are visible to everyone — not parallel isolated saves with sync points.
- Server is the single source of truth for all state.
- Requires robust server-side validation and conflict resolution (e.g. two players claiming the same territory at once — need clear rules: first-come, bidding, contest, etc.).

### Platform / tech stack (leaning)
- **React Native** for shared logic across web + mobile (iOS + Android).
- Graphics via **React Native Skia** or **Expo graphics APIs** — sufficient for 2D management-style visuals; no heavy game engine (Unity/Unreal) needed.
- **Backend:** PostgreSQL as primary datastore, proper API layer, **WebSockets** for real-time sync.
- Architecture is effectively a **lite MMO backend**: authoritative server, thin clients, transactional state updates.

### Graphics approach
- Design the game system first; layer graphics in afterward where they fit.
- Start simple (geometric shapes / minimal pixel art), commission or build richer assets once the core loop is proven.
- Note: asset/animation *files* must be created via design tools (Aseprite, Blender, etc.) or an artist — not generated by Claude.

---

## Open Design Questions (to resolve next)

### 1. World permanence (explicitly deferred 2026-07-03)
Persistent-forever vs. seasonal structure vs. wipes. Deliberately deferred until the vertical slice shows how fast the map saturates with real players. Revisit before public "launch" to the friend group — players need to know what's permanent before they invest.

### 2. Theme lore
Mad Max Scandinavia is locked; the faction lore (AI powers, remnant governments, others) is a sketch the owner will develop further.

### 3. Numeric balance
All rules are decided shape-wise but not tuned: contest window length, siege duration, raid skim cap, storage caps, Surge size/duration, combat variance band, accrual rates, Fuel costs per Route.

### 4. Content details
Starter Location yields, NPC Faction garrison strengths and behavior, seasonal event design (the Horde?), crew composition/vehicle/equipment progression.

---

## Suggested Architecture Pillars (for Claude Code)

- **Authoritative server**: all game actions validated server-side; clients never trusted with state.
- **Persistence layer**: PostgreSQL schema for world state, players, territories, resources, events.
- **Real-time layer**: WebSocket connections for pushing world changes to connected clients.
- **API layer**: REST or RPC for standard actions; WebSocket for live updates.
- **Time model — lazy accrual + due-time queue** (see ADR-0001): continuous accrual is computed on read from timestamps and rates (no global tick); discrete happenings (Mission completion, Contest close, Siege end, Surge expiry) are due-at rows processed by a scheduler.
- **Client (React Native)**: renders world state, submits actions, subscribes to live updates.

---

## Immediate Next Steps

1. ~~Pick a theme/setting~~ — done: Mad Max Scandinavia (2026-07-03).
2. ~~Define the core resource loop~~ — done: Scrap/Fuel/Water/Survivors, Location yields × upgrades (2026-07-03).
3. ~~Define the per-session decision set~~ — done: crew dispatch loop (2026-07-03).
4. ~~Specify conflict resolution and catch-up rules~~ — done: contest windows, slow sieges, dormancy, Surge (2026-07-03).
5. ~~Draft the database schema~~ — done: [db-schema.md](./db-schema.md) (2026-07-03; shapes decided, numeric values are tuning knobs).
6. ~~Build the vertical slice~~ — done: `server/` (2026-07-03). Scavenge Mission end to end: found a Faction (HQ + stores + crew), dispatch a Crew along a Route, lazy accrual + due-time queue resolution (ADR-0001), haul deposited with cap clamping, WebSocket push of dispatch/resolution. 20 tests green. Runs on PGlite — real Postgres semantics, zero infra (ADR-0003).
7. ~~Minimal map client~~ — done: `server/public/index.html` (2026-07-03), a throwaway single-file web page served by the dev server. SVG map of the Region, found a Faction by clicking a Location, dispatch Scavenge Missions, live WebSocket updates (dispatch/resolution/rival foundings), read-time-settled stores. Explicitly disposable — the real client is still React Native (decision unchanged).
8. ~~Claim + contest window~~ — done: the first multiplayer rule (2026-07-03). A Claim Mission plants the flag on arrival and opens a 24h contest window (tuning knob); rival Factions can Contest until the window closes; the close resolves as one transaction — crew-size power × bounded ±15% luck, ties to the flag holder, control transfer, and an after-action Report for every side. Founding and claiming both respect open claims. Map client can claim/contest and shows open windows live.
9. Next candidates: auth (the API currently trusts `factionId` in the request body); Outpost founding at claimed Locations (control currently grants no yield without an Outpost); Raids or Sieges (the remaining conflict verbs).
