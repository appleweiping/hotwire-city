# HOTWIRE CITY

**A zero-dependency top-down open-city crime game inspired by classic GTA.**
Steal cars, outrun the cops, keep the meter climbing.

**[▶ Play it in your browser](https://appleweiping.github.io/hotwire-city/)** — no install, no build, desktop keyboard + mouse.

[中文说明 / Chinese README](README.zh-CN.md)

![Downtown chase](docs/screenshots/chase.png)

## What is this?

A love letter to the top-down era of Grand Theft Auto (GTA 1/2), built as an
exercise in radical minimalism:

- **Zero dependencies.** No engine, no framework, no npm, no build step.
  Plain ES modules + Canvas 2D.
- **Zero assets.** Every sprite is procedural vector drawing; every sound is
  synthesized live with the Web Audio API. The repository contains no images
  and no audio files.
- **One deterministic city.** 92×92 tiles generated from a fixed seed —
  every player walks the same streets.

## The loop

Wander a living city with pedestrians and traffic. Steal a car (`E`). Cause
trouble. Watch the wanted stars climb — patrol cops, then cruisers, then
rammers, then roadblocks. Break line of sight and lay low to shake the heat,
or embrace it: **surviving at 3★+ pays $100 every 30 seconds**. Death costs
30% of your cash, arrest costs 20% and your guns. There is no game over —
your best run is the score.

## Controls

| Key | On foot | Driving |
|---|---|---|
| `W A S D` | Move (free angle) | Throttle / steer / brake–reverse |
| Mouse | Aim (click to shoot) | — |
| `Shift` | Sprint | — |
| `Space` | — | Handbrake (drift!) |
| `E` / `Enter` | Enter / steal car | Exit |
| `1 / 2 / 3` or `Q` | Select / cycle weapon | — |
| `M` | Mute | Mute |
| `Esc` / `P` | Pause | Pause |

## Run it locally

Browsers block ES modules on `file://`, so serve the folder with any static
server:

```bash
git clone https://github.com/appleweiping/hotwire-city.git
cd hotwire-city
python -m http.server 8000
# open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, …). There is
nothing to install and nothing to build.

## How it works

~4,000 lines of vanilla JavaScript. The interesting parts:

- **Fixed 60 Hz timestep** with an accumulator — identical physics on a
  144 Hz monitor and a struggling laptop.
- **Fixed 1280×720 logical viewport**, letterbox-scaled to the window, so
  every player sees exactly the same world (and spawn rings stay off-screen).
- **The map is the spatial index**: tiles live in a `Uint8Array`; wall
  collision, line-of-sight (tile DDA) and lane directions are all O(1) reads.
- **Drift in one parameter**: car velocity splits into forward/lateral;
  lateral decays as `exp(−grip·dt)`. The handbrake just lowers `grip`.
- **Hitscan combat** — no bullet entities, just rays and one-frame tracers.
- **Chunked ground cache**: the static city pre-renders into 512 px offscreen
  canvases; blood and skid marks are painted permanently into those chunks
  for zero per-frame cost.
- **A heat-based wanted system** with a gain cap (40/s), LOS-gated decay and
  pursuit units exempt from despawning — the cops you earned stay earned.

Full mechanics and tuning tables: [docs/DESIGN.md](docs/DESIGN.md).

## Screenshots

| | |
|---|---|
| ![Title](docs/screenshots/menu.png) | ![Wanted](docs/screenshots/wanted.png) |

## Roadmap

- Touch controls (currently desktop-only; phones get a friendly notice)
- Day/night cycle with headlights
- Mission generator (deliveries, chases, hits)
- Render interpolation for 120 Hz+ displays

## License

[MIT](LICENSE). Not affiliated with Rockstar Games or Take-Two Interactive;
"GTA" is referenced only as genre inspiration.
