// game.js — the orchestrator: fixed-timestep loop, top-level state machine,
// world context assembly, and per-tick system ordering.
//
// Fixed update order (see docs/DESIGN.md §14):
//   input → physics → collision → damage/crime → queue events →
//   AI consumes last tick's events → spawn/recycle → render

import { STEP, MAX_FRAME_DELTA, VIEW_W, VIEW_H, COLORS, TILE, TRAFFIC_MIX, VEHICLE, PLAYER, FX, ECONOMY, SAVE_KEY } from './config.js';
import { input } from './input.js';
import { makeRng, rngWeighted, dist } from './utils.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { CityMap } from './world/citymap.js';
import { Player } from './entities/player.js';
import { Vehicle } from './entities/vehicle.js';
import { Pedestrian } from './entities/pedestrian.js';
import { Pickup } from './entities/pickup.js';
import { Fx } from './systems/fx.js';
import { SpatialHash, entityCollisionPass } from './systems/physics.js';
import { fireHitscan } from './systems/combat.js';
import { Spawner } from './systems/spawner.js';
import { WantedSystem } from './systems/wanted.js';
import { Hud } from './ui/hud.js';
import { GameAudio } from './audio.js';

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
    this.fx = new Fx();
    this.hash = new SpatialHash();
    this.spawner = new Spawner();
    this.wanted = new WantedSystem();
    this.hud = new Hud(this.map);
    this.audio = new GameAudio();
    this.money = 0;
    this.maxCash = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      this.maxCash = saved.maxCash || 0;
    } catch { /* fresh start */ }

    // contextual first-time hints, each shown at most twice
    this.hintState = { steal: 0, stealActive: false, wanted: 0, death: 0 };
    this.timedHint = null;       // {text, until}
    this.currentHint = null;
    this.explosionQueue = [];    // {v, delay} — chained blasts resolve over time
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
      wasted: new EndedState(this, 'WASTED'),
      busted: new EndedState(this, 'BUSTED'),
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
    this.#spawnPickups();
    this.wanted = new WantedSystem();
    this.money = 0;
    this.camera.snapTo(this.player.x, this.player.y);
    this.time = 0;
    this.tick = 0;
  }

  #spawnPickups() {
    const rng = makeRng(4242);
    // street cash scattered on sidewalks (respawning)
    let placed = 0, attempts = 200;
    while (placed < 20 && attempts-- > 0) {
      const t = this.map.sidewalks[Math.floor(rng() * this.map.sidewalks.length)];
      this.entities.push(new Pickup((t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE, 'cash',
        { amount: 25, respawns: true }));
      placed++;
    }
    // first-aid outside the hospital
    const h = this.map.hospitalDoor;
    this.entities.push(new Pickup(h.x + 40, h.y, 'health', { amount: 25, respawns: true }));
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
      v.persistent = true; // world furniture — never recycled by the spawner
      this.entities.push(v);
      placed.push({ x, y });
    }
  }

  // The world context handed to every entity/system update. Entities never
  // import game.js — everything they may touch is threaded through here.
  buildWorldContext() {
    const ctx = {
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
      fx: this.fx,
      queryCircle: (x, y, r, out) => this.hash.queryCircle(x, y, r, out),
      audio: this.audio,
      explodeVehicle: (v) => this.queueExplosion(v),
      onCarCrash: (v, impact) => {
        if (this.player && this.player.vehicle === v) {
          this.fx.addTrauma(FX.TRAUMA_CRASH * Math.min(1, impact / 250));
        }
        // only audible crashes near the camera
        if (Math.abs(v.x - this.camera.x) < 800 && Math.abs(v.y - this.camera.y) < 600) {
          this.audio.crash(Math.min(1, impact / 250));
        }
      },
      onCarHitsPerson: (v, person, speed) => this.handleRunOver(ctx, v, person, speed),
      tick: this.tick,
      lodSkip: (e) => this.lodSkip(e),
      wantedStars: () => this.wanted.stars,
      reportSighting: () => this.wanted.reportSighting(),
      addMoney: (n, x, y) => this.addMoney(n, x, y),
      onPlayerDeath: () => { if (this.stateName === 'playing') this.setState('wasted'); },
      onPlayerBusted: () => { if (this.stateName === 'playing') this.setState('busted'); },
    };
    ctx.reportCrime = (type, x, y) => this.wanted.reportCrime(type, x, y, ctx);
    ctx.copShoot = (cop, ox, oy, angle, spreadScale) =>
      fireHitscan(ctx, cop, ox, oy, angle, 'copPistol', spreadScale);
    ctx.shoot = (shooter, ox, oy, angle, weapon, spreadScale) =>
      fireHitscan(ctx, shooter, ox, oy, angle, weapon, spreadScale);
    // Jacking a driven car throws its driver onto the street in a panic.
    ctx.onCarJacked = (v, by) => {
      const wasAi = v.driver && v.driver.kind === 'ai';
      v.driver = null;
      if (wasAi) {
        const sin = Math.sin(v.angle), cos = Math.cos(v.angle);
        const off = v.spec.h / 2 + 12;
        let px = v.x + sin * off, py = v.y - cos * off;      // far-side door
        if (this.map.isSolidAt(px, py) || this.map.isWaterAt(px, py)) {
          px = v.x - sin * off; py = v.y + cos * off;
        }
        const ped = new Pedestrian(px, py);
        ped.panic(by ? by.x : v.x, by ? by.y : v.y);
        this.entities.push(ped);
      }
      if (by && by.kind === 'player') {
        ctx.reportCrime('CARJACK', v.x, v.y);
        ctx.addMoney(5, v.x, v.y);
      }
    };
    return ctx;
  }

  // Off-screen AI entities only think every 4th tick.
  lodSkip(e) {
    const dx = Math.abs(e.x - this.camera.x), dy = Math.abs(e.y - this.camera.y);
    if (dx < VIEW_W / 2 + 100 && dy < VIEW_H / 2 + 100) return false;
    return (this.tick + e.id) % 4 !== 0;
  }

  queueExplosion(v) {
    if (v.wrecked || this.explosionQueue.some(q => q.v === v)) return;
    // chained blasts (triggered while another explosion resolves) are delayed
    const delay = this.resolvingExplosion ? VEHICLE.CHAIN_EXPLOSION_DELAY : 0;
    this.explosionQueue.push({ v, delay });
  }

  processExplosions(ctx, dt) {
    let resolved = 0;
    for (let i = this.explosionQueue.length - 1; i >= 0; i--) {
      const q = this.explosionQueue[i];
      q.delay -= dt;
      if (q.delay > 0 || resolved >= VEHICLE.MAX_EXPLOSIONS_PER_TICK) continue;
      this.explosionQueue.splice(i, 1);
      if (q.v.wrecked) continue;
      resolved++;
      this.#explode(ctx, q.v);
    }
  }

  #explode(ctx, v) {
    this.resolvingExplosion = true;
    const x = v.x, y = v.y;
    const byPlayer = v.lastHitByPlayer;
    v.becomeWreck();
    this.fx.explosion(x, y);
    this.audio.explosion();
    this.renderer.addDecal({ x, y, kind: 'scorch', size: 34 });

    if (byPlayer) {
      const police = v.type === 'police';
      this.addMoney(police ? ECONOMY.POLICE_CAR_DESTROY : ECONOMY.CAR_DESTROY, x, y - 12);
      if (police) ctx.reportCrime('COP_KILL', x, y); // blowing up a cruiser is a heavy crime
    }

    for (const e of [...this.entities]) {
      if (e === v || !e.alive) continue;
      const d = dist(x, y, e.x, e.y);
      if (d > VEHICLE.EXPLOSION_RADIUS + e.radius) continue;
      if (e.kind === 'player' && e.driving && e.vehicle !== v) {
        e.vehicle.takeDamage(VEHICLE.EXPLOSION_DMG, ctx, { kind: 'explosion' });
      } else {
        e.takeDamage(VEHICLE.EXPLOSION_DMG, ctx, { kind: 'explosion' });
      }
    }
    this.resolvingExplosion = false;
  }

  // A car met a person. The person-side reaction depends on who they are.
  handleRunOver(ctx, v, person, speed) {
    if (person.kind === 'player') {
      if (speed >= PLAYER.CAR_HIT_MIN_SPEED && person.invulnTimer <= 0 && person.knockdownTimer <= 0) {
        person.takeDamage((speed - PLAYER.CAR_HIT_MIN_SPEED) * PLAYER.CAR_HIT_DMG_SCALE, ctx, { kind: 'runover', by: v });
        person.knockdownTimer = PLAYER.KNOCKDOWN_TIME;
        person.invulnTimer = PLAYER.HIT_INVULN_TIME;
        this.fx.blood(person.x, person.y, Math.atan2(person.y - v.y, person.x - v.x));
        this.fx.addTrauma(FX.TRAUMA_RUNOVER);
      }
    } else if (person.onRunOver) {
      person.onRunOver(ctx, v, speed); // pedestrians (m5) and cops (m6)
    }
  }

  start() {
    const frame = (now) => {
      let delta = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;

      this.accumulator += delta;
      while (this.accumulator >= STEP) {
        this.updateMouseWorld();
        if (input.wasPressed('mute')) {
          this.audio.toggleMute();
          this.saveGame();
        }
        this.state.update(STEP);
        input.endTick();
        this.accumulator -= STEP;
      }

      this.audio.update(this);
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

    entityCollisionPass(this.hash, this.entities, world);
    this.processExplosions(world, dt);
    this.wanted.update(dt, world);
    this.spawner.update(dt, world);
    this.fx.update(dt);

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

    this.#updateHints(dt);

    this.camera.follow(this.player, dt, this.player.driving);
    this.time += dt;
    this.tick++;
  }

  addMoney(n, x, y) {
    this.money = Math.max(0, this.money + n);
    if (this.money > this.maxCash) {
      this.maxCash = this.money;
      this.saveGame();
    }
    if (n > 0 && x !== undefined) this.fx.floatText(x, y, `+$${n}`, '#7fc95c');
  }

  saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ maxCash: this.maxCash, muted: this.audio.muted }));
    } catch { /* storage unavailable — shrug */ }
  }

  // Contextual first-time hints (each shown at most twice, then retired)
  #updateHints(dt) {
    const h = this.hintState;
    const p = this.player;

    if (this.timedHint) {
      if (this.time > this.timedHint.until) this.timedHint = null;
      else { this.currentHint = this.timedHint.text; return; }
    }

    // first wanted star tip
    if (this.wanted.stars > 0 && h.wanted < 2 && !this.wantedHintArmed) {
      this.wantedHintArmed = true;
      h.wanted++;
      this.timedHint = { text: 'Break line of sight and lay low to lose the cops', until: this.time + 4 };
      return;
    }
    if (this.wanted.stars === 0) this.wantedHintArmed = false;

    // steal-a-car prompt
    if (p && p.alive && !p.driving && p.nearbyVehicle && h.steal < 2) {
      const jack = p.nearbyVehicle.driver ? 'STEAL CAR' : 'ENTER CAR';
      this.currentHint = `E — ${jack}`;
      h.stealActive = true;
      return;
    }
    if (h.stealActive) { h.stealActive = false; h.steal++; }

    this.currentHint = null;
  }

  showDeathHint() {
    if (this.hintState.death >= 2) return;
    this.hintState.death++;
    this.timedHint = { text: 'You lost some cash — the city keeps score', until: this.time + 4 };
  }

  respawnPlayer(door) {
    const p = this.player;
    if (p.vehicle) { p.vehicle.driver = null; p.vehicle = null; }
    p.alive = true;
    p.solid = true;
    p.hp = p.maxHp;
    p.knockdownTimer = 0;
    p.enteringTimer = 0;
    p.pendingVehicle = null;
    p.exitRequested = false;
    p.invulnTimer = PLAYER.RESPAWN_INVULN_TIME;
    const d = door || this.map.hospitalDoor;
    p.x = d.x; p.y = d.y;
    p.vx = 0; p.vy = 0;
    this.wanted.clear();
    this.camera.snapTo(p.x, p.y);
  }

  getShakeOffset() {
    return this.fx.getShakeOffset();
  }

  renderWorldFx(ctx) {
    this.fx.render(ctx);
  }

  renderHud(ctx) {
    if (this.stateName === 'menu') return;
    this.hud.render(ctx, this);
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
      this.game.audio.unlock(); // browsers require a user gesture for audio
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
    ctx.fillText('HOTWIRE CITY', VIEW_W / 2, VIEW_H / 2 - 70);

    ctx.fillStyle = COLORS.hudDim;
    ctx.font = '600 15px "Segoe UI", sans-serif';
    ctx.fillText('Steal cars. Outrun the law. Keep the meter climbing.', VIEW_W / 2, VIEW_H / 2 - 34);

    if (this.game.maxCash > 0) {
      ctx.fillStyle = COLORS.good;
      ctx.font = '700 17px "Segoe UI", sans-serif';
      ctx.fillText(`BEST  $${Math.round(this.game.maxCash).toLocaleString('en-US')}`, VIEW_W / 2, VIEW_H / 2 - 4);
    }

    ctx.fillStyle = COLORS.hudText;
    ctx.font = '400 20px "Segoe UI", sans-serif';
    const blink = Math.floor(performance.now() / 600) % 2 === 0;
    if (blink) ctx.fillText('Press any key to start', VIEW_W / 2, VIEW_H / 2 + 40);

    ctx.fillStyle = COLORS.hudDim;
    ctx.font = '400 14px "Segoe UI", sans-serif';
    const lines = [
      'WASD — move / drive     E — enter or steal a car     Mouse — aim, click to shoot',
      'Shift — sprint     Space — handbrake     1/2/3 or Q — weapons     M — mute     Esc — pause',
    ];
    lines.forEach((l, i) => ctx.fillText(l, VIEW_W / 2, VIEW_H / 2 + 92 + i * 24));
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

// Shared death-cam state for WASTED (killed) and BUSTED (arrested): the world
// keeps simulating for a couple of seconds, a penalty is applied, then the
// player respawns at the hospital or police station.
class EndedState {
  constructor(game, label) { this.game = game; this.label = label; }
  enter() {
    this.timer = 2.2;
    const g = this.game;
    const busted = this.label === 'BUSTED';
    const pct = busted ? ECONOMY.BUST_PENALTY_PCT : ECONOMY.DEATH_PENALTY_PCT;
    const min = busted ? ECONOMY.BUST_PENALTY_MIN : ECONOMY.DEATH_PENALTY_MIN;
    this.penalty = Math.min(g.money, Math.max(Math.round(g.money * pct), min));
    g.money -= this.penalty;
    if (busted) {
      // weapons confiscated
      g.player.ammo.pistol = 0;
      g.player.ammo.smg = 0;
      g.player.weapon = 'fist';
      g.player.vx = 0; g.player.vy = 0;
    }
  }
  exit() {}
  update(dt) {
    this.timer -= dt;
    this.game.simulate(dt); // the city doesn't stop for you
    if (this.timer <= 0 && (input.wasPressed('any') || this.timer < -2.5)) {
      const door = this.label === 'BUSTED' ? this.game.map.policeDoor : this.game.map.hospitalDoor;
      this.game.respawnPlayer(door);
      this.game.showDeathHint();
      this.game.setState('playing');
    }
  }
  renderOverlay(ctx) {
    ctx.fillStyle = 'rgba(8,8,10,0.5)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.label === 'BUSTED' ? '#7da7e0' : COLORS.danger;
    ctx.font = '900 88px "Segoe UI", sans-serif';
    ctx.fillText(this.label, VIEW_W / 2, VIEW_H / 2 - 10);
    if (this.penalty > 0) {
      ctx.fillStyle = COLORS.hudText;
      ctx.font = '400 22px "Segoe UI", sans-serif';
      ctx.fillText(`-$${this.penalty.toLocaleString('en-US')}${this.label === 'BUSTED' ? '  ·  weapons confiscated' : ''}`,
        VIEW_W / 2, VIEW_H / 2 + 40);
    }
    if (this.timer <= 0) {
      ctx.fillStyle = COLORS.hudDim;
      ctx.font = '400 15px "Segoe UI", sans-serif';
      ctx.fillText('Press any key', VIEW_W / 2, VIEW_H / 2 + 84);
    }
    ctx.textAlign = 'left';
  }
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
