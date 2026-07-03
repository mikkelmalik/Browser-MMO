# Browser MMO — Wasteland Scandinavia

A persistent, asynchronous multiplayer management game for a small friend group, set in a post-apocalyptic (Mad Max-styled) copy of real-world Scandinavia. One shared world; the server is the single source of truth.

## Language

**Faction**:
Any territory-holding power in the world — player-controlled or NPC. Holds Outposts, fields Crews, and fights by the same rules regardless of who plays it. One player controls exactly one Faction.
_Avoid_: clan, guild, tribe, player-state

**NPC Faction**:
A Faction whose decisions the server makes — e.g. the AI powers or remnant governments. Mechanically identical to a player Faction; new ones can emerge over time.
_Avoid_: gang (as entity type), mob, AI faction, bot

**Outpost**:
A fixed settlement a Faction holds on the map. A Faction can hold several.
_Avoid_: base, settlement, compound, colony

**The Region**:
The playable map at launch — post-apocalyptic Scandinavia. The rest of the world is inaccessible wasteland for now.
_Avoid_: world map, zone

**Location**:
A named real-world place (ruined city, town, port, plant) that exists as a node on the map graph. Outposts are founded at Locations; territory control means controlling a Location.
_Avoid_: node, tile, cell, point of interest

**Route**:
A road connection between two Locations. All movement happens along Routes.
_Avoid_: edge, path, link

## Resources

**Scrap**:
The build-and-craft currency. Spent on construction, upgrades, and equipment.
_Avoid_: materials, metal, junk, money

**Fuel**:
The action currency. Every crew movement along a Route burns Fuel; no Fuel, no operations.
_Avoid_: gas, energy, action points

**Water**:
The upkeep resource. Survivors consume Water over time.
_Avoid_: food, supplies, rations

**Survivors**:
Population — the people of a Faction. Capacity for work, crews, and growth.
_Avoid_: workers, units, citizens, pop

**Dormant**:
The state an Outpost enters at zero Water: production and crew actions halt, but nothing is lost. Absence costs opportunity, never assets.
_Avoid_: starving, dying, decaying

## Actions

**Crew**:
A dispatchable unit of a Faction — people and vehicles. Crews carry out Missions and idle safely when the player is away.
_Avoid_: squad, party, army, convoy, unit

**Mission**:
An order given to a Crew (scavenge, claim, escort, raid, …) that takes real-world hours to resolve. The core verb of a play session.
_Avoid_: task, action, order, job, quest

**Claim**:
A Mission that plants a Faction's flag on a Location and must hold it for a fixed contest window before control transfers.
_Avoid_: capture, take, occupy

**Contest**:
Sending a Crew against an open Claim during its window. At window close the server resolves the showdown deterministically.
_Avoid_: challenge (reserved), dispute, counter-claim

**Raid**:
A fast strike Mission against a rival Outpost that skims stored resources. Never takes Survivors, buildings, or the Outpost itself.
_Avoid_: attack, pillage, loot

**Siege**:
A multi-day, publicly visible Mission to capture a rival Outpost. The defender and any aiding Faction can send Crews to break it before it completes.
_Avoid_: assault, takeover, invasion

**HQ**:
A Faction's home Outpost. Cannot be besieged, captured, or raided — a Faction can never be eliminated.
_Avoid_: capital, main base, home settlement

**Surge**:
A temporary boost (faster production and Missions) granted to a Faction returning after several days away. The catch-up mechanic.
_Avoid_: catch-up bonus, comeback buff, boost

**Report**:
The generated after-action account of a resolved fight (Contest, Siege, or Raid) — what each side brought and how it played out.
_Avoid_: battle log, combat log, match report
