// wanted.js — heat, stars, police response. Crimes raise heat (rate-capped);
// heat decays only after 8s with no crime AND no cop line-of-sight. Star
// levels requisition cops/cars from an off-screen ring, plus 5★ roadblocks.

import { WANTED, T, TILE, ECONOMY } from '../config.js';
import { dist, makeRng } from '../utils.js';
import { Cop } from '../entities/cop.js';
import { Vehicle } from '../entities/vehicle.js';
import { PoliceBrain } from './police.js';
import { CityMap } from '../world/citymap.js';

export class WantedSystem {
  constructor() {
    this.heat = 0;
    this.stars = 0;
    this.sinceCrime = Infinity;
    this.sinceSeen = Infinity;
    this.dropTimer = 0;           // hysteresis before a star is removed
    this.heatBudget = WANTED.HEAT_RATE_CAP; // refills 40/s
    this.reinforceTimer = 1;
    this.roadblockCooldown = 0;
    this.activeRoadblocks = [];
    this.survivalTimer = 0;
    this.rng = makeRng((Math.random() * 0xffffffff) >>> 0);
  }

  reportCrime(type, x, y, world) {
    let base = WANTED.CRIMES[type] || 0;
    if (!base) return;

    // gunfire only registers at 0★ if a cop is close enough to hear it
    if (type === 'GUNSHOT' && this.stars === 0) {
      const heard = world.entities.some(e => e.kind === 'cop' && e.alive && dist(e.x, e.y, x, y) < 300);
      if (!heard) return;
    }

    const gain = Math.min(base, this.heatBudget);
    if (gain <= 0) return;
    this.heatBudget -= gain;
    this.heat = Math.min(this.heat + gain, WANTED.STAR_THRESHOLDS[4] + 60);
    this.sinceCrime = 0;
  }

  // Called by any cop that currently has line of sight on the player.
  reportSighting() {
    this.sinceSeen = 0;
  }

  update(dt, world) {
    this.heatBudget = Math.min(this.heatBudget + WANTED.HEAT_RATE_CAP * dt, WANTED.HEAT_RATE_CAP);
    this.sinceCrime += dt;
    this.sinceSeen += dt;
    this.roadblockCooldown -= dt;

    // decay only while both silence conditions hold
    if (this.sinceCrime > WANTED.DECAY_QUIET_TIME && this.sinceSeen > WANTED.DECAY_QUIET_TIME) {
      this.heat = Math.max(0, this.heat - WANTED.HEAT_DECAY * dt);
    }

    this.#updateStars(dt);
    this.#maintainRoster(dt, world);
    this.#maybeRoadblock(world);
    this.#survivalBonus(dt, world);

    if (this.heat <= 0 && this.stars === 0) this.#standDown(world);
  }

  #updateStars(dt) {
    let target = 0;
    for (let i = 0; i < WANTED.STAR_THRESHOLDS.length; i++) {
      if (this.heat >= WANTED.STAR_THRESHOLDS[i]) target = i + 1;
    }
    if (target > this.stars) {
      this.stars = target;         // escalation is instant
      this.dropTimer = 0;
    } else if (target < this.stars) {
      this.dropTimer += dt;        // de-escalation needs 2s of stability
      if (this.dropTimer >= WANTED.STAR_HYSTERESIS) {
        this.stars = target;
        this.dropTimer = 0;
      }
    } else {
      this.dropTimer = 0;
    }
  }

  // "Is the decay stalled?" — the HUD blinks stars while decay is active.
  isDecaying() {
    return this.stars > 0
      && this.sinceCrime > WANTED.DECAY_QUIET_TIME
      && this.sinceSeen > WANTED.DECAY_QUIET_TIME;
  }

  #maintainRoster(dt, world) {
    this.reinforceTimer -= dt;
    if (this.reinforceTimer > 0 || this.stars === 0) return;
    this.reinforceTimer = this.stars >= 4 ? WANTED.REINFORCE_INTERVAL_HIGH : WANTED.REINFORCE_INTERVAL;

    const [wantFoot, wantCars] = WANTED.ROSTER[this.stars];
    let foot = 0, cars = 0;
    for (const e of world.entities) {
      if (e.kind === 'cop' && e.alive) foot++;
      else if (e.kind === 'vehicle' && e.driver && e.driver.police && !e.wrecked) cars++;
    }

    const p = world.player;
    if (foot < wantFoot) {
      const spot = world.map.randomSidewalkPointNear(this.rng, p.x, p.y, 600, 950)
        || world.map.randomRoadPointNear(this.rng, p.x, p.y, 600, 950);
      if (spot) {
        const cop = new Cop(spot.x, spot.y);
        cop.state = 'chase';
        cop.lastKnown = { x: p.x, y: p.y };
        world.addEntity(cop);
      }
    }
    if (cars < wantCars) this.#spawnPoliceCar(world, p, 700, 1050);
  }

  #spawnPoliceCar(world, p, rMin, rMax) {
    const spot = world.map.randomRoadPointNear(this.rng, p.x, p.y, rMin, rMax);
    if (!spot) return null;
    const lane = world.map.laneInfoAt(spot.x, spot.y);
    if (!lane || !lane.dir) return null;
    let x = spot.x, y = spot.y, angle;
    if (lane.axis === 'v') { x = lane.laneCenter; angle = lane.dir.y > 0 ? Math.PI / 2 : -Math.PI / 2; }
    else { y = lane.laneCenter; angle = lane.dir.x > 0 ? 0 : Math.PI; }
    for (const e of world.entities) {
      if (e.kind === 'vehicle' && dist(e.x, e.y, x, y) < 80) return null;
    }
    const v = new Vehicle(x, y, 'police');
    v.angle = angle;
    v.driver = new PoliceBrain();
    v.sirenOn = true;
    world.addEntity(v);
    return v;
  }

  // 5★ and fleeing by car → drop a roadblock on a crossing ahead.
  #maybeRoadblock(world) {
    if (this.stars < WANTED.ROADBLOCK_STARS || this.roadblockCooldown > 0) return;
    const p = world.player;
    if (!p.driving || p.vehicle.speed() < 100) return;

    this.activeRoadblocks = this.activeRoadblocks.filter(rb => rb.cars.some(c => !c.wrecked && !c.remove));
    if (this.activeRoadblocks.length >= WANTED.ROADBLOCK_MAX) return;

    // project ahead along travel direction, find the crossing there
    const sp = p.vehicle.speed();
    const dirX = p.vx / sp, dirY = p.vy / sp;
    const ahead = WANTED.ROADBLOCK_DIST[0] + this.rng() * (WANTED.ROADBLOCK_DIST[1] - WANTED.ROADBLOCK_DIST[0]);
    const ax = p.x + dirX * ahead, ay = p.y + dirY * ahead;
    const tx = Math.floor(ax / TILE), ty = Math.floor(ay / TILE);
    if (world.map.tileType(tx, ty) !== T.ROAD_CROSS) return; // try again next tick

    const bx = CityMap.bandStart(tx), by = CityMap.bandStart(ty);
    const cx = (bx + 2) * TILE, cy = (by + 2) * TILE; // crossing center
    const across = Math.abs(dirX) > Math.abs(dirY) ? Math.PI / 2 : 0; // cars parked across the player's path

    const cars = [];
    for (const side of [-1, 1]) {
      const off = 34;
      const vx = cx + (across === 0 ? side * off : 0);
      const vy = cy + (across !== 0 ? side * off : 0);
      const car = new Vehicle(vx, vy, 'police');
      car.angle = across;
      car.sirenOn = true;
      world.addEntity(car);
      cars.push(car);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const cop = new Cop(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60);
      cop.state = 'chase';
      cop.lastKnown = { x: p.x, y: p.y };
      world.addEntity(cop);
    }
    this.activeRoadblocks.push({ cars });
    this.roadblockCooldown = WANTED.ROADBLOCK_COOLDOWN;
  }

  #survivalBonus(dt, world) {
    if (this.stars >= 3) {
      this.survivalTimer += dt;
      if (this.survivalTimer >= ECONOMY.SURVIVAL_INTERVAL) {
        this.survivalTimer = 0;
        world.addMoney(ECONOMY.SURVIVAL_BONUS, world.player.x, world.player.y - 20);
        world.fx.floatText(world.player.x, world.player.y - 34, 'SURVIVAL BONUS', '#f2b134');
      }
    } else {
      this.survivalTimer = 0;
    }
  }

  // Heat gone: pursuing units melt away once off-screen.
  #standDown(world) {
    for (const e of world.entities) {
      if (e.kind === 'cop' && e.alive && e.state !== 'patrol') {
        if (dist(e.x, e.y, world.player.x, world.player.y) > 800) e.remove = true;
        else { e.state = 'patrol'; e.walkTarget = null; }
      } else if (e.kind === 'vehicle' && e.driver && e.driver.police) {
        e.sirenOn = false;
        if (dist(e.x, e.y, world.player.x, world.player.y) > 900) e.remove = true;
      }
    }
  }

  clear() {
    this.heat = 0;
    this.stars = 0;
    this.dropTimer = 0;
    this.sinceCrime = Infinity;
    this.sinceSeen = Infinity;
    this.survivalTimer = 0;
  }
}
