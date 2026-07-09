// game.js — the orchestrator: fixed-timestep loop, top-level state machine,
// world context assembly, and per-tick system ordering.
//
// Fixed update order (see docs/DESIGN.md §14):
//   input → physics → collision → damage/crime → queue events →
//   AI consumes last tick's events → spawn/recycle → render

import { STEP, MAX_FRAME_DELTA, VIEW_W, VIEW_H, COLORS, TILE, TRAFFIC_MIX } from './config.js';
import { input } from './input.js';
import { makeRng, rngWeighted } from './utils.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { CityMap } from './world/citymap.js';
import { Player } from './entities/player.js';
import { Vehicle } from './entities/vehicle.js';

export class Game {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.viewport = viewport;
    this.renderer = new Renderer(this.ctx, viewport);
    this.camera = new Camera();
    this.map = new CityMap();          // deterministic: one city, forever
    this.renderer.setMap(this.map);

    this.entities = [];
    this.player = null;
    this.time = 0;               // total simulated seconds
    this.tick = 0;

    // Event bus: events emitted during a tick are consumed by AI *next* tick,
    // so cops can never react to a gunshot in the same frame it happens.
    this.eventsThisTick = [];
    this.eventsLastTick = [];

    this.mouseWorld = { x: 0, y: 0 };

    this.states = {
      menu: new MenuState(this),
      playing: new PlayingState(this),
      paused: new PausedState(this),
    };
    this.state = null;
    this.setState('menu');

    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  setState(name) {
    if (this.state) this.state.exit();
    this.state = this.states[name];
    this.stateName = name;
    this.state.enter();
  }

  startRun() {
    this.entities.length = 0;
    const s = this.map.playerSpawn;
    this.player = new Player(s.x, s.y);
    this.entities.push(this.player);
    this.#spawnParkedCars();
    this.camera.snapTo(this.player.x, this.player.y);
    this.time = 0;
    this.tick = 0;
  }

  // Empty cars parked along the curb all over the city — always something to steal.
  #spawnParkedCars() {
    const rng = makeRng(777);
    const placed = [];
    let attempts = 400;
    while (attempts-- > 0 && placed.length < 45) {
      const rt = this.map.roadTiles[Math.floor(rng() * this.map.roadTiles.length)];
      const wx = (rt.tx + 0.5) * TILE, wy = (rt.ty + 0.5) * TILE;
      const lane = this.map.laneInfoAt(wx, wy);
      if (!lane || !lane.dir) continue;

      // hug the curb side of the lane, aligned with traffic direction
      let x, y, angle;
      if (lane.axis === 'v') {
        x = lane.laneCenter + (lane.dir.y > 0 ? -20 : 20);
        y = wy;
        angle = lane.dir.y > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        x = wx;
        y = lane.laneCenter + (lane.dir.x > 0 ? 20 : -20);
        angle = lane.dir.x > 0 ? 0 : Math.PI;
      }

      if (placed.some(p => (p.x - x) ** 2 + (p.y - y) ** 2 < 90 * 90)) continue;
      // one free sports car near spawn would be too kind — plain traffic mix
      const type = rngWeighted(rng, TRAFFIC_MIX);
      const v = new Vehicle(x, y, type);
      v.angle = angle;
      this.entities.push(v);
      placed.push({ x, y });
    }
  }

  // The world context handed to every entity/system update. Entities never
  // import game.js — everything they may touch is threaded through here.
  buildWorldContext() {
    return {
      map: this.map,
      camera: this.camera,
      player: this.player,
      entities: this.entities,
      mouseWorld: this.mouseWorld,
      time: this.time,
      events: this.eventsLastTick,
      emit: (evt) => this.eventsThisTick.push(evt),
      addEntity: (e) => this.entities.push(e),
      addDecal: (d) => this.renderer.addDecal(d),
      // stubs fleshed out by later systems (combat, wanted, spawner)
      onCarJacked: (v, by) => { v.driver = null; },
      onCarCrash: (v, impact) => {},
      explodeVehicle: (v, source) => { v.becomeWreck(); },
    };
  }

  start() {
    const frame = (now) => {
      let delta = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;

      this.accumulator += delta;
      while (this.accumulator >= STEP) {
        this.updateMouseWorld();
        this.state.update(STEP);
        input.endTick();
        this.accumulator -= STEP;
      }

      this.renderer.render(this);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  updateMouseWorld() {
    const w = this.camera.logicalToWorld(input.mouseLogicalX, input.mouseLogicalY);
    this.mouseWorld.x = w.x;
    this.mouseWorld.y = w.y;
  }

  // One fixed simulation step of the live world
  simulate(dt) {
    const world = this.buildWorldContext();

    for (let i = 0; i < this.entities.length; i++) {
      this.entities[i].update(dt, world);
    }

    // swap-remove dead-and-expired entities (corpses linger via their own timers)
    for (let i = this.entities.length - 1; i >= 0; i--) {
      if (this.entities[i].remove) {
        const last = this.entities.length - 1;
        this.entities[i] = this.entities[last];
        this.entities.pop();
      }
    }

    // player updates before their vehicle in the entity array — re-sync so the
    // camera and damage checks see this tick's true position, not last tick's
    if (this.player && this.player.driving) {
      const v = this.player.vehicle;
      this.player.x = v.x; this.player.y = v.y;
      this.player.vx = v.vx; this.player.vy = v.vy;
    }

    // rotate event buffers: this tick's emissions become next tick's inputs
    const tmp = this.eventsLastTick;
    this.eventsLastTick = this.eventsThisTick;
    this.eventsThisTick = tmp;
    this.eventsThisTick.length = 0;

    this.camera.follow(this.player, dt, this.player.driving);
    this.time += dt;
    this.tick++;
  }
}

// ---------------------------------------------------------------------------
// Top-level states — plain objects with enter/update/exit + renderOverlay(ctx)
// (renderOverlay draws in *logical* screen space, applied by the renderer).

class MenuState {
  constructor(game) { this.game = game; }
  enter() {}
  exit() {}
  update(dt) {
    if (input.wasPressed('any')) {
      this.game.startRun();
      this.game.setState('playing');
    }
  }
  renderOverlay(ctx) {
    ctx.fillStyle = 'rgba(13,13,17,0.6)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.accent;
    ctx.font = '700 64px "Segoe UI", sans-serif';
    ctx.fillText('HOTWIRE CITY', VIEW_W / 2, VIEW_H / 2 - 60);

    ctx.fillStyle = COLORS.hudText;
    ctx.font = '400 20px "Segoe UI", sans-serif';
    ctx.fillText('Press any key to start', VIEW_W / 2, VIEW_H / 2 + 10);

    ctx.fillStyle = COLORS.hudDim;
    ctx.font = '400 14px "Segoe UI", sans-serif';
    const lines = [
      'WASD — move / drive     E — enter or steal a car     Mouse — aim, click to shoot',
      'Shift — sprint     Space — handbrake     1/2/3 or Q — weapons     M — mute     Esc — pause',
    ];
    lines.forEach((l, i) => ctx.fillText(l, VIEW_W / 2, VIEW_H / 2 + 70 + i * 24));
    ctx.textAlign = 'left';
  }
}

class PlayingState {
  constructor(game) { this.game = game; }
  enter() {}
  exit() {}
  update(dt) {
    if (input.wasPressed('pause')) {
      this.game.setState('paused');
      return;
    }
    this.game.simulate(dt);
  }
  renderOverlay(ctx) {}
}

class PausedState {
  constructor(game) { this.game = game; }
  enter() {}
  exit() {}
  update(dt) {
    if (input.wasPressed('pause') || input.wasPressed('any')) {
      this.game.setState('playing');
    }
  }
  renderOverlay(ctx) {
    ctx.fillStyle = 'rgba(13,13,17,0.55)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.hudText;
    ctx.font = '700 40px "Segoe UI", sans-serif';
    ctx.fillText('PAUSED', VIEW_W / 2, VIEW_H / 2);
    ctx.font = '400 16px "Segoe UI", sans-serif';
    ctx.fillStyle = COLORS.hudDim;
    ctx.fillText('Press any key to resume', VIEW_W / 2, VIEW_H / 2 + 36);
    ctx.textAlign = 'left';
  }
}
