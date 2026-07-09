# HOTWIRE CITY — Design & Tuning Reference

This document is the implementation-level design spec: every gameplay number,
state machine, and the coupling rules that keep the systems honest. All values
live in [`src/config.js`](../src/config.js) — this file explains *why*.

Units: **pixels, seconds, radians**. Screen space is y-down; angle 0 = +x,
clockwise positive. Simulation runs at a fixed **60 Hz** timestep driven by
`requestAnimationFrame` with an accumulator (frame delta clamped to 250 ms so
a background tab can't cause a spiral of death).

---

## 1. City

- Map: **92×92 tiles × 32 px = 2944×2944 px**. Why 92: the layout
  `water(2) + ring road(4) + n × (block 8 + road 4) + water(2)` only closes
  symmetrically when `8 + 12n = size` → n = 7.
- Tile types: `ROAD_H / ROAD_V / ROAD_CROSS / SIDEWALK / BUILDING / GRASS / WATER`.
  Only `BUILDING` is solid. `WATER` kills people instantly; **for cars it acts
  as a guard rail** (deviation from the original spec's "car sinks" — instant
  car destruction at the map edge punished exploration too hard).
- Road bands are 4 tiles wide, right-hand traffic, one lane each way. Lane
  centerlines sit ±32 px from the band center and are **derived from tile
  coordinates** (`CityMap.laneInfoAt`) — there is no separate road graph.
- Blocks are 8×8: a 1-tile sidewalk ring + 6×6 interior. Interiors are split
  recursively into 1–4 buildings (each ≥2 tiles a side, 1-tile alleys); 15%
  of blocks become parks. Landmarks: one hospital (death respawn) and one
  police station (arrest respawn), each stamped over a fixed central block.
- Generation is seeded (`mulberry32`, seed 1337): every player visits the
  same city.

## 2. Player

| Param | Value |
|---|---|
| Walk / sprint | 110 / 170 px/s |
| Collision radius | 7 px (circle, axis-separated wall slide) |
| HP | 100 (no regen; hospital first-aid +25, respawns 15 s) |
| Hit by car | speed ≥ 80 → dmg `(v−80)×0.35`, knockdown 0.8 s, invuln 0.5 s |
| Water | instant death |

Aim is mouse-decoupled from movement (backpedal shooting works). While
driving, weapons are disabled — the car *is* the weapon.

## 3. Vehicles

Model: velocity is decomposed into forward and lateral components each tick.
Forward gets throttle/brake/coast; **lateral decays as `exp(−grip·dt)` — grip
is the entire drift model**. Handbrake swaps grip for a much lower value.
Steering effectiveness: `min(|v|/40, 1) × (1 − 0.4·|v|/vMax)` — dead at a
standstill, dulled near top speed.

| | Sedan | Sports | Police | Truck |
|---|---|---|---|---|
| accel px/s² | 180 | 260 | 220 | 100 |
| vMax | 260 | 340 | 300 | 200 |
| steer rad/s | 2.6 | 3.0 | 2.8 | 1.8 |
| grip / handbrake | 8 / 2.2 | 6.5 / 2.0 | 8.5 / 2.4 | 9 / 3.0 |
| body | 40×20 | 42×18 | 42×20 | 56×26 |
| HP / mass | 100 / 1.0 | 80 / 0.9 | 120 / 1.1 | 200 / 2.2 |

- Off-road (sidewalk/grass): vMax ×0.6, grip ×0.8.
- Wall collision: 8 OBB sample points vs solid tiles; push out on the
  shallowest axis, normal restitution 0.3, tangent keep 0.7. Impacts < 60 px/s
  are free (sparks only); above, damage = impact ×0.15.
- Car-vs-car: two-circle approximation per car, impulse split by mass ratio
  (trucks win), damage = relative normal speed ×0.12.
- Damage states: <60% HP grey smoke → <30% black smoke + flames + **10 s fuse**
  → explosion (radius 60, damage 80). Chained blasts resolve through a delayed
  queue (0.2 s, max 2 per tick) so a parking lot never detonates in one frame.
  Reaching 0 HP explodes immediately, even mid-fuse.
- Enter/steal (E, ≤48 px): empty car 0.3 s, occupied car 0.5 s (blocked above
  60 px/s). Jacked drivers flee on foot. Exit auto-brakes to ≤30 px/s, then
  tries four spots (left/right/rear/front) that must be clear of walls, water
  and other cars.

## 4. Pedestrians (cap 24)

`WALK → FLEE → (DEAD)`, plus a 1.5 s knockdown. Wander marches tile-center to
tile-center along sidewalks (70%-ish straight bias, rare road crossings,
U-turns only at dead ends). Panic sources: gunshot r250, violence r200,
scream r100 (fleeing peds re-broadcast every 2 s; panic time caps at 20 s).
Flee: 140 px/s away from the threat ±30° jitter, retargeted every 0.8 s.
Car contact: ≥90 px/s kills, ≥40 knocks down. Corpses are **non-solid**
(traffic doesn't brake for them), fade after 15 s, leave permanent blood
decals baked into the ground chunks.

## 5. Traffic (cap 12)

Same physics as the player's car, driven by inputs: proportional steering
toward a point 64 px ahead on the lane centerline; at crossings pick
straight 50% / left 25% / right 25% (invalid exits culled, no U-turns).
Forward probe (~90×24 px) linearly brakes to a stop 25 px behind obstacles.
Stuck >5 s: recycle if off-screen, otherwise reverse-and-retry twice, then
give up (engine off — becomes scenery). AI cars killing pedestrians is not
the player's crime.

## 6. Wanted system

Internal float `heat`; stars are just thresholds `[10, 30, 60, 100, 150]`
with a 2 s drop hysteresis (gains are instant).

| Crime | Heat |
|---|---|
| Knock down / kill a pedestrian | +5 / +15 |
| Gunshot (at 0★ only if a cop hears it within 300 px) | +10 |
| Carjack / police car jack | +10 / +20 |
| Hurt a cop | +20 |
| Kill a cop / blow up a police car | +40 |

**Heat gain is capped at 40/s** — mowing through a crowd cannot jump you to
5★ in one frame. Decay (4/s) runs only after **8 s with no crime AND no
police line-of-sight** — foot cops and cruisers both count as eyes
(tile-DDA rays, throttled and staggered per unit).
The HUD blinks the stars while decay is live — that's the "keep hiding, it's
working" signal.

Response roster per star `[foot, cars]`: 1★ [2,0] · 2★ [3,1] · 3★ [4,3] ·
4★ [6,4] · 5★ [8,6]; reinforcements every 4 s (3 s at 4★+), spawned in an
off-screen ring. **Cops in pursuit are exempt from distance recycling** —
you cannot farm heat decay by outrunning the spawn radius; cleanup happens
only when heat hits zero. At 5★, fleeing by car spawns crossing roadblocks
(2 cruisers + 4 officers, max 2 active, 12 s cooldown).

Cop state machine: `PATROL → CHASE → SHOOT / ARREST → INVESTIGATE`. Arrest:
within 24 px, player on foot and slower than 40 px/s, held 1.2 s. Shooting
starts at 2★ (pistol 8 dmg @1.2/s, ±6° + ±6° vs moving targets; 4★+ fires
at 4/s). Police cars pursue with 0.5 s velocity prediction, ram at 3★+, and
pull over to deploy two officers when the player is on foot.

## 7. Death & arrest (arcade rules)

- **WASTED**: −30% cash (min $150) → hospital respawn.
- **BUSTED**: −20% cash (min $100) + weapons confiscated → police station.
- Both: 2 s death cam while the world keeps running, heat cleared, 2 s
  invulnerability. No game over — cash is the score; the best run persists
  in localStorage.

## 8. Combat

Hitscan only — no bullet entities. A shot is a tile-DDA ray against
buildings plus segment-vs-circle tests against entities (cars use their two
collision circles), rendered as a one-frame tracer.

| | Fist | Pistol | SMG |
|---|---|---|---|
| Damage | 10 | 15 | 8 |
| Rate | 2/s | 4/s semi | 10/s auto |
| Range | 24 (90° arc) | 450 | 350 |
| Spread | — | ±1.5° | ±4° |

Moving multiplies player spread ×1.8. No magazines — one ammo pool per gun.
Dead cops always drop ammo (pistol 20 / SMG 30, 50/50).

## 9. Economy (single currency = score)

Kill ped +10 · kill cop +50 · destroy car +40 · destroy police car +100 ·
carjack +5 · street cash +25 (20 spots, respawn 60 s) ·
**survival bonus +100 per 30 s alive at 3★+** — the core loop rewards
staying in trouble, not avoiding it.

## 10. Juice

- Screen shake: trauma ∈ [0,1], amplitude = `trauma² × 12 px`, decay 1.5/s.
  Shake applies **only to the world layer** — never to the HUD, the minimap,
  or the mouse→world mapping.
- Particle pool of 400 (oldest-slot recycling): blood, sparks, smoke, fire,
  explosions. Tracers/flashes/floaters in tiny side lists.
- Permanent decals (blood, skids, scorch) are painted directly into the
  ground chunk canvases: zero per-frame cost, replayed from a 500-entry list
  when chunks rebake on resize.

## 11. Coupling rules (the "don't break these" list)

1. Fixed update order: input → entity updates → collision pass → explosions →
   wanted → spawner → fx → event buffer rotation.
2. Events emitted during tick N are consumed in tick N+1 — cops can never
   react to a gunshot in the same frame it happens.
3. The player is fully non-solid during the enter-vehicle animation and while
   driving (the car is their collision proxy).
4. Passive shoves are clamped to 12 px/tick and re-resolved against walls —
   cars cannot iron people into buildings.
5. Corpses are non-solid; wrecks stay solid (usable as cover/roadblocks).
   These are opposite on purpose — don't share a flag.
6. Off-screen AI thinks every 4th tick (LOD); pursuit logic still guarantees
   chasing cops converge because they're never recycled while heat > 0.
7. The spatial hash is rebuilt from scratch every tick; cell size 128 px must
   stay ≥ the largest entity diameter (truck: 56 px) for 3×3 coverage.

## 12. Known deviations from the original spec

- Map is 92×92 (not 96×96) — see §1 for the arithmetic.
- Water is a guard rail for cars instead of destroying them.
- Cop pistol range 380 (not 450) — playtests felt unfair at full range.
- No renderer interpolation between fixed steps (60 Hz ≈ display rate);
  entities keep `prevX/prevY` fields so it can be added cheaply.
