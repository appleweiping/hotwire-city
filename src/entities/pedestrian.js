// pedestrian.js — city dwellers: tile-to-tile sidewalk wandering, panic
// propagation, knockdowns, corpses. State machine: WALK → FLEE → (DEAD).

import { Entity } from './entity.js';
import { PED, T, TILE, ECONOMY } from '../config.js';
import { dist } from '../utils.js';
import { moveCircle } from '../systems/physics.js';

const DIRS = [ { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 } ];

const SHIRTS = ['#b05252', '#5271b0', '#52b077', '#b09b52', '#8a52b0', '#b0526e', '#52a7b0', '#7d8288', '#4b5320', '#c77f4f'];
const SKINS = ['#e8c39e', '#d9a878', '#a8764a', '#7a5233'];

export class Pedestrian extends Entity {
  constructor(x, y) {
    super(x, y);
    this.kind = 'pedestrian';
    this.radius = PED.RADIUS;
    this.hp = PED.HP;
    this.maxHp = PED.HP;
    this.state = 'walk';         // walk | flee | knocked | dead
    this.dir = DIRS[Math.floor(Math.random() * 4)];
    this.walkTarget = null;
    this.threat = null;          // {x, y} being fled from
    this.panicTimer = 0;         // remaining flee time
    this.fleeRetarget = 0;       // re-aim throttle
    this.screamTimer = 0;        // panic re-broadcast throttle
    this.knockTimer = 0;
    this.corpseTimer = 0;
    this.shirt = SHIRTS[Math.floor(Math.random() * SHIRTS.length)];
    this.skin = SKINS[Math.floor(Math.random() * SKINS.length)];
  }

  update(dt, world) {
    if (this.state === 'dead') {
      this.corpseTimer -= dt;
      if (this.corpseTimer <= 0) this.remove = true;
      return;
    }

    if (world.lodSkip && world.lodSkip(this)) return;

    this.#listen(world);

    switch (this.state) {
      case 'knocked':
        this.knockTimer -= dt;
        this.vx = 0; this.vy = 0;
        if (this.knockTimer <= 0) this.state = 'flee';
        break;
      case 'flee':
        this.#flee(dt, world);
        break;
      default:
        this.#wander(dt, world);
    }
  }

  // React to last tick's world events (gunshots, violence, screams)
  #listen(world) {
    for (const ev of world.events) {
      let r = 0;
      if (ev.type === 'gunshot') r = PED.PANIC_GUNSHOT_R;
      else if (ev.type === 'violence') r = PED.PANIC_VIOLENCE_R;
      else if (ev.type === 'scream') r = PED.PANIC_SCREAM_R;
      else continue;
      if (dist(this.x, this.y, ev.x, ev.y) > r) continue;
      this.panic(ev.x, ev.y);
    }
  }

  panic(tx, ty) {
    if (this.state === 'dead') return;
    this.threat = { x: tx, y: ty };
    // panic extends but never past a hard cap (no infinite scream loops)
    this.panicTimer = Math.min(this.panicTimer + PED.FLEE_CALM_TIME, 20);
    if (this.state === 'walk') this.state = 'flee';
  }

  #flee(dt, world) {
    this.panicTimer -= dt;
    const farFromThreat = !this.threat || dist(this.x, this.y, this.threat.x, this.threat.y) > PED.FLEE_ESCAPE_DIST;
    if (this.panicTimer <= 0 || (farFromThreat && this.panicTimer < PED.FLEE_CALM_TIME / 2)) {
      this.state = 'walk';
      this.walkTarget = null;
      this.threat = null;
      return;
    }

    this.fleeRetarget -= dt;
    if (this.fleeRetarget <= 0) {
      this.fleeRetarget = 0.8;
      const away = this.threat
        ? Math.atan2(this.y - this.threat.y, this.x - this.threat.x)
        : Math.random() * Math.PI * 2;
      this.fleeAngle = away + (Math.random() - 0.5) * (Math.PI / 3);
    }

    // fleeing spreads fear
    this.screamTimer -= dt;
    if (this.screamTimer <= 0) {
      this.screamTimer = PED.PANIC_SCREAM_INTERVAL;
      world.emit({ type: 'scream', x: this.x, y: this.y });
    }

    this.angle = this.fleeAngle;
    this.vx = Math.cos(this.fleeAngle) * PED.FLEE_SPEED;
    this.vy = Math.sin(this.fleeAngle) * PED.FLEE_SPEED;
    moveCircle(this, dt, world.map);

    if (world.map.isWaterAt(this.x, this.y)) this.die(world, { kind: 'drown' });
  }

  // Tile-center-to-tile-center marching along sidewalks, with rare road
  // crossings and grass shortcuts. Keeps crowds on pavements and looking alive.
  #wander(dt, world) {
    if (!this.walkTarget) this.#pickNextTile(world.map);
    if (!this.walkTarget) return; // truly boxed in — idle

    const t = this.walkTarget;
    const d = dist(this.x, this.y, t.x, t.y);
    if (d < 3) {
      this.#pickNextTile(world.map);
      return;
    }

    const a = Math.atan2(t.y - this.y, t.x - this.x);
    this.angle = a;
    this.vx = Math.cos(a) * PED.WALK_SPEED;
    this.vy = Math.sin(a) * PED.WALK_SPEED;
    moveCircle(this, dt, world.map);
  }

  #pickNextTile(map) {
    const tx = Math.floor(this.x / TILE), ty = Math.floor(this.y / TILE);
    const here = map.tileType(tx, ty);

    // committed to crossing a road: keep going straight until pavement
    if (isRoad(here)) {
      const nx = tx + this.dir.x, ny = ty + this.dir.y;
      const nt = map.tileType(nx, ny);
      if (nt !== T.BUILDING && nt !== T.WATER) {
        this.walkTarget = tileCenter(nx, ny);
        return;
      }
    }

    let best = null, bestScore = 0;
    for (const d of DIRS) {
      const nt = map.tileType(tx + d.x, ty + d.y);
      let score = nt === T.SIDEWALK ? 1.0 : nt === T.GRASS ? 0.35 : isRoad(nt) ? 0.08 : 0;
      if (score === 0) continue;
      if (d === this.dir || (d.x === this.dir.x && d.y === this.dir.y)) score *= 2.3; // prefer straight
      if (d.x === -this.dir.x && d.y === -this.dir.y) score *= 0.1;                    // avoid U-turns
      score *= 0.5 + Math.random();
      if (score > bestScore) { bestScore = score; best = d; }
    }

    if (!best) { // dead end — turn around
      best = { x: -this.dir.x, y: -this.dir.y };
      const nt = map.tileType(tx + best.x, ty + best.y);
      if (nt === T.BUILDING || nt === T.WATER) { this.walkTarget = null; return; }
    }

    this.dir = best;
    this.walkTarget = tileCenter(tx + best.x, ty + best.y);
  }

  // Called by the physics pass when a car makes contact.
  onRunOver(world, v, speed) {
    if (this.state === 'dead') return;
    if (speed >= PED.KILL_MIN_SPEED) {
      this.die(world, { kind: 'runover', by: v.driver });
    } else if (speed >= PED.KNOCKDOWN_MIN_SPEED && this.state !== 'knocked') {
      this.state = 'knocked';
      this.knockTimer = 1.5;
      this.takeDamage(12, world, { kind: 'runover', by: v.driver });
      this.panic(v.x, v.y);
      if (v.driver && v.driver.kind === 'player') world.reportCrime('PED_HIT', this.x, this.y);
      world.fx && world.fx.blood(this.x, this.y, Math.atan2(this.y - v.y, this.x - v.x));
    }
  }

  takeDamage(amount, world, source) {
    if (this.state === 'dead') return;
    super.takeDamage(amount, world, source);
    if (this.alive && source && source.kind === 'shot') {
      this.panic(source.by ? source.by.x : this.x, source.by ? source.by.y : this.y);
    }
  }

  die(world, source) {
    if (this.state === 'dead') return;
    super.die(world, source);
    this.state = 'dead';
    this.solid = false;          // traffic does not brake for the departed
    this.corpseTimer = PED.CORPSE_TIME + PED.CORPSE_FADE;
    this.vx = 0; this.vy = 0;

    if (world) {
      world.emit({ type: 'violence', x: this.x, y: this.y });
      world.addDecal && world.addDecal({ x: this.x, y: this.y, kind: 'blood', angle: Math.random() * Math.PI, size: 7 + Math.random() * 4 });
      const byPlayer = source && source.by &&
        (source.by.kind === 'player' || (source.by.driver && source.by.driver.kind === 'player'));
      if (byPlayer) {
        world.reportCrime('PED_KILL', this.x, this.y);
        world.addMoney(ECONOMY.PED_KILL, this.x, this.y);
      }
    }
  }

  render(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.state === 'dead') {
      const alpha = Math.min(1, this.corpseTimer / PED.CORPSE_FADE);
      ctx.globalAlpha = alpha * 0.9;
      ctx.rotate(this.angle + Math.PI / 2);
      ctx.fillStyle = this.shirt;
      ctx.beginPath();
      ctx.ellipse(0, 0, this.radius + 2, this.radius - 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.skin;
      ctx.beginPath();
      ctx.arc(0, -this.radius - 1, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(1.2, 2, this.radius, this.radius * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(this.angle);
    if (this.state === 'knocked') ctx.scale(1.25, 0.75);
    ctx.fillStyle = this.shirt;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.skin;
    ctx.beginPath();
    ctx.arc(1, 0, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

const isRoad = (t) => t === T.ROAD_H || t === T.ROAD_V || t === T.ROAD_CROSS;
const tileCenter = (tx, ty) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
