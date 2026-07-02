# Resources are stored per-Outpost, not in a faction-wide wallet

A reasonable default for a management game is one resource pool per player. We deliberately store Scrap/Fuel/Water per Outpost instead, because three decided rules already require it: Raids skim *an Outpost's* stored resources, storage caps (the catch-up mechanic) are per store, and Dormancy is a per-Outpost state driven by that Outpost's Water. A faction-wide wallet would make all three rules incoherent.

## Consequences

- Moving resources between Outposts is a gameplay action (escort/convoy Missions), not a bookkeeping detail — logistics and convoy ambushes become content, which fits the theme.
- Missions spend Fuel from their origin Outpost's store, so *where* a Crew is based matters.
- UI must aggregate stores for "how rich am I overall" views; the database never stores a faction total.
