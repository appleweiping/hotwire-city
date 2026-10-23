// cop.js — police on foot: patrol → chase → shoot/arrest, with last-known-
// position investigation. Cops in pursuit are never distance-recycled
// (the wanted system only cleans up once heat returns to zero).

import { Entity } from './entity.js';
import { COP, PED, TILE, ECONOMY, AMMO_DROP } from '../config.js';
import { dist } from '../utils.js';
import { moveCircle } from '../systems/physics.js';
import { Pickup } from './pickup.js';

const DIRS = [ { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 } ];

export class Cop extends Entity {
  constructor(x, y) {
    super(x, y);
    this.kind = 'cop';
    this.radius = COP.RADIUS;
    this.hp = COP.HP;
    this.maxHp = COP.HP;
    this.state = 'patrol';       // patrol | chase | shoot | arrest | investigate
    this.dir = DIRS[Math.floor(Math.random() * 4)];
    this.walkTarget = null;
    this.lastKnown = null;       // last seen player position
    this.lostTimer = 0;
    this.sightTimer = Math.random() * 0.2; // stagger LOS raycasts across cops
    this.canSee = false;
    this.shootCooldown = 0;
    this.arrestTimer = 0;
    this.stuckTimer = 0;
    this.sidestep = 0;           // >0 → strafing around an obstacle
    this.sidestepDir = 1;
    this.knockTimer = 0;
    this.corpseTimer = 0;
  }

  update(dt, world) {
    if (this.state === 'dead') {
      this.corpseTimer -= dt;
      if (this.corpseTimer <= 0) this.remove = true;
      return;
    }
    if (this.knockTimer > 0) {
      this.knockTimer -= dt;
      this.vx = 0; this.vy = 0;
      return;
    }
    if (this.shootCooldown > 0) this.shootCooldown -= dt;

    const stars = world.wantedStars();
    if (stars === 0 && this.state !== 'patrol') {
      this.state = 'patrol';
      this.walkTarget = null;
    }

    if (this.state === 'patrol') {
      if (world.lodScale) {
        const lod = world.lodScale(this);
        if (lod === 0) return;
        dt *= lod;
      }
      this.#patrol(dt, world);
      if (stars >= 1) this.#lookForPlayer(dt, world, stars);
      return;
    }

    this.#lookForPlayer(dt, world, stars);

    switch (this.state) {
      case 'chase': this.#chase(dt, world, stars); break;
      case 'shoot': this.#shoot(dt, world, stars); break;
      case 'arrest': this.#arrest(dt, world); break;
      case 'investigate': this.#investigate(dt, world); break;
    }
  }

  // Throttled, staggered line-of-sight sensing. Feeds the wanted system's
  // "no cop can see you" decay condition via world.reportSighting.
  #lookForPlayer(dt, world, stars) {
    this.sightTimer -= dt;
    if (this.sightTimer > 0) return;
    this.sightTimer = 0.2;

    const p = world.player;
    const d = dist(this.x, this.y, p.x, p.y);
    this.canSee = d < COP.SIGHT_DIST && p.alive && !world.map.losBlocked(this.x, this.y, p.x, p.y);

    if (this.canSee) {
      this.lastKnown = { x: p.x, y: p.y };
      this.lostTimer = 0;
      world.reportSighting && world.reportSighting();
      if (stars >= 1 && (this.state === 'patrol' || this.state === 'investigate')) {
        this.state = 'chase';
      }
    } else if (this.state === 'chase' || this.state === 'shoot') {
      this.lostTimer += 0.2;
      if (this.lostTimer > COP.LOST_TARGET_TIME && dist(this.x, this.y, p.x, p.y) > COP.LOST_TARGET_DIST) {
        this.state = 'investigate';
        this.investigateSpin = 2;
      }
    }
  }

  #patrol(dt, world) {
    // slow sidewalk beat, same tile-marching as pedestrians
    if (!this.walkTarget) this.#pickPatrolTile(world.map);
    if (!this.walkTarget) return;
    const t = this.walkTarget;
    if (dist(this.x, this.y, t.x, t.y) < 3) { this.#pickPatrolTile(world.map); return; }
    const a = Math.atan2(t.y - this.y, t.x - this.x);
    this.angle = a;
    this.vx = Math.cos(a) * 50;
    this.vy = Math.sin(a) * 50;
    moveCircle(this, dt, world.map);
  }

  #pickPatrolTile(map) {
    const tx = Math.floor(this.x / TILE), ty = Math.floor(this.y / TILE);
    const options = [];
    for (const d of DIRS) {
      if (!map.isWalkableTile(tx + d.x, ty + d.y)) continue;
      const straight = d.x === this.dir.x && d.y === this.dir.y;
      options.push({ d, w: (straight ? 2.5 : 1) * (0.5 + Math.random()) });
    }
    if (!options.length) { this.walkTarget = null; return; }
    options.sort((a, b) => b.w - a.w);
    this.dir = options[0].d;
    this.walkTarget = { x: (tx + this.dir.x + 0.5) * TILE, y: (ty + this.dir.y + 0.5) * TILE };
  }

  #chase(dt, world, stars) {
    const p = world.player;
    const d = dist(this.x, this.y, p.x, p.y);

    // arrest window: close, player on foot and slow
    if (d < COP.ARREST_DIST + p.radius && !p.driving && p.speed() < COP.ARREST_MAX_PLAYER_SPEED && p.alive) {
      this.state = 'arrest';
      this.arrestTimer = COP.ARREST_TIME;
      return;
    }
    // gunfight range at 2★+ (never against a driving player — #shoot would
    // bounce straight back to chase and the two states would livelock)
    if (stars >= 2 && this.canSee && !p.driving && d < COP.SHOOT_RANGE_MAX && d > COP.ARREST_DIST * 2) {
      this.state = 'shoot';
      return;
    }

    const target = this.canSee ? p : (this.lastKnown || p);
    let a = Math.atan2(target.y - this.y, target.x - this.x);
    if (this.sidestep > 0) {
      this.sidestep -= dt;
      a += (Math.PI / 2) * this.sidestepDir;
    }

    this.angle = Math.atan2(p.y - this.y, p.x - this.x);
    this.vx = Math.cos(a) * COP.RUN_SPEED;
    this.vy = Math.sin(a) * COP.RUN_SPEED;
    const ox = this.x, oy = this.y;
    moveCircle(this, dt, world.map);

    // wall-hugging detection → strafe around the corner
    if (dist(ox, oy, this.x, this.y) < COP.RUN_SPEED * dt * 0.3) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5 && this.sidestep <= 0) {
        this.sidestep = 0.5;
        this.sidestepDir = Math.random() < 0.5 ? 1 : -1;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }

    if (!this.canSee && this.lastKnown && dist(this.x, this.y, this.lastKnown.x, this.lastKnown.y) < 12) {
      this.state = 'investigate';
      this.investigateSpin = 2;
    }
  }

  #shoot(dt, world, stars) {
    const p = world.player;
    const d = dist(this.x, this.y, p.x, p.y);
    this.angle = Math.atan2(p.y - this.y, p.x - this.x);
    this.vx = 0; this.vy = 0;

    if (!this.canSee || d > COP.SHOOT_RANGE_MAX || p.driving) { this.state = 'chase'; return; }
    if (d < COP.SHOOT_RANGE_MIN * 0.6) { this.state = 'chase'; return; } // too close — rush to arrest

    if (this.shootCooldown <= 0 && p.alive) {
      const rate = stars >= 4 ? COP.SMG_RATE : COP.PISTOL_RATE;
      this.shootCooldown = 1 / rate;
      const spread = 1 + (p.moving ? 1 : 0); // extra spread against a moving target
      const ox = this.x + Math.cos(this.angle) * (this.radius + 4);
      const oy = this.y + Math.sin(this.angle) * (this.radius + 4);
      world.copShoot(this, ox, oy, this.angle, spread);
    }
  }

  #arrest(dt, world) {
    const p = world.player;
    const d = dist(this.x, this.y, p.x, p.y);
    this.angle = Math.atan2(p.y - this.y, p.x - this.x);
    this.vx = 0; this.vy = 0;

    // conditions broken → back to the chase
    if (d > COP.ARREST_DIST + p.radius + 6 || p.driving || p.speed() > COP.ARREST_MAX_PLAYER_SPEED || !p.alive) {
      this.state = 'chase';
      return;
    }
    this.arrestTimer -= dt;
    if (this.arrestTimer <= 0) {
      world.onPlayerArrested && world.onPlayerArrested(this);
    }
  }

  #investigate(dt, world) {
    if (!this.lastKnown) { this.state = 'patrol'; return; }
    const d = dist(this.x, this.y, this.lastKnown.x, this.lastKnown.y);
    if (d > 12) {
      const a = Math.atan2(this.lastKnown.y - this.y, this.lastKnown.x - this.x);
      this.angle = a;
      this.vx = Math.cos(a) * COP.RUN_SPEED;
      this.vy = Math.sin(a) * COP.RUN_SPEED;
      moveCircle(this, dt, world.map);
      return;
    }
    // arrived: look around, then give up
    this.vx = 0; this.vy = 0;
    this.angle += dt * 3;
    this.investigateSpin -= dt;
    if (this.investigateSpin <= 0) {
      this.lastKnown = null;
      this.state = 'patrol';
      this.walkTarget = null;
    }
  }

  onRunOver(world, v, speed) {
    if (this.state === 'dead') return;
    const byPlayer = v.driver && v.driver.kind === 'player';
    if (speed >= PED.KILL_MIN_SPEED) {
      this.die(world, { kind: 'runover', by: v.driver });
    } else if (speed >= PED.KNOCKDOWN_MIN_SPEED && this.knockTimer <= 0) {
      this.knockTimer = 1.5;
      this.takeDamage(12, world, { kind: 'runover', by: v.driver });
      if (byPlayer && this.alive) world.reportCrime('COP_HURT', this.x, this.y);
      world.fx && world.fx.blood(this.x, this.y, Math.atan2(this.y - v.y, this.x - v.x));
      if (this.alive && this.state === 'patrol') this.state = 'chase';
    }
  }

  takeDamage(amount, world, source) {
    if (this.state === 'dead') return;
    const wasAlive = this.alive;
    super.takeDamage(amount, world, source);
    if (!wasAlive) return;
    const byPlayer = source && source.by &&
      (source.by.kind === 'player' || (source.by.driver && source.by.driver.kind === 'player'));
    if (this.alive) {
      if (byPlayer && source.kind === 'shot') world.reportCrime('COP_HURT', this.x, this.y);
      if (this.state === 'patrol') { this.state = 'chase'; this.lastKnown = { x: world.player.x, y: world.player.y }; }
    }
  }

  die(world, source) {
    if (this.state === 'dead') return;
    super.die(world, source);
    this.state = 'dead';
    this.solid = false;
    this.corpseTimer = PED.CORPSE_TIME + PED.CORPSE_FADE;
    this.vx = 0; this.vy = 0;

    if (!world) return;
    world.emit({ type: 'violence', x: this.x, y: this.y });
    world.addDecal && world.addDecal({ x: this.x, y: this.y, kind: 'blood', angle: Math.random() * Math.PI, size: 8 });

    // dead cops always drop ammo
    const drop = Math.random() < 0.5
      ? { weapon: 'pistol', amount: AMMO_DROP.pistol }
      : { weapon: 'smg', amount: AMMO_DROP.smg };
    world.addEntity(new Pickup(this.x + 6, this.y + 6, 'ammo', drop));

    const byPlayer = source && source.by &&
      (source.by.kind === 'player' || (source.by.driver && source.by.driver.kind === 'player'));
    if (byPlayer) {
      world.reportCrime('COP_KILL', this.x, this.y);
      world.addMoney(ECONOMY.COP_KILL, this.x, this.y);
    }
  }

  render(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.state === 'dead') {
      const alpha = Math.min(1, this.corpseTimer / PED.CORPSE_FADE);
      ctx.globalAlpha = alpha * 0.9;
      ctx.rotate(this.angle + Math.PI / 2);
      ctx.fillStyle = '#2c3e5c';
      ctx.beginPath();
      ctx.ellipse(0, 0, this.radius + 2, this.radius - 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(1.2, 2, this.radius, this.radius * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(this.angle);
    if (this.knockTimer > 0) ctx.scale(1.25, 0.75);
    // navy uniform
    ctx.fillStyle = '#2c3e5c';
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    // cap with badge stripe
    ctx.fillStyle = '#22304a';
    ctx.beginPath();
    ctx.arc(0.5, 0, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8b23c';
    ctx.fillRect(1.5, -1, 2.5, 2);
    // gun when engaged
    if (this.state === 'shoot' || this.state === 'chase') {
      ctx.fillStyle = '#26262c';
      ctx.fillRect(4, -1, 7, 2);
    }
    ctx.restore();
  }
}
