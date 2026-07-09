// vehicle.js — top-down car physics ("heading + velocity decomposition" model),
// wall collision via OBB sample points, and flat-vector rendering per type.
//
// The whole drift feel lives in one number: lateral velocity decays as
// exp(-grip*dt). Handbrake temporarily swaps in a much lower grip.

import { Entity } from './entity.js';
import { VEHICLE, VEHICLE_TYPES, TILE, T, FX } from '../config.js';
import { clamp, normAngle } from '../utils.js';
import { input } from '../input.js';

export class Vehicle extends Entity {
  constructor(x, y, type = 'sedan', color = null) {
    super(x, y);
    this.kind = 'vehicle';
    this.type = type;
    this.spec = VEHICLE_TYPES[type];
    this.hp = this.spec.hp;
    this.maxHp = this.spec.hp;
    this.radius = Math.max(this.spec.w, this.spec.h) / 2; // broad-phase circle
    this.color = color || randomCarColor(type);
    this.driver = null;          // Player or an AI pedestrian/cop
    this.controls = { throttle: 0, steer: 0, handbrake: false };
    this.fireFuse = -1;          // >=0 → burning, counts down to explosion
    this.wrecked = false;
    this.wreckTimer = 0;
    this.sirenOn = false;        // police lightbar (wanted system toggles it)
    this.lastImpactSpeed = 0;    // set by wall/car collisions, consumed by fx
  }

  fwdSpeed() {
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    return this.vx * cos + this.vy * sin;
  }

  update(dt, world) {
    if (this.wrecked) {
      this.wreckTimer -= dt;
      if (this.wreckTimer <= 0) this.remove = true;
      return;
    }
    if (this.fireFuse >= 0) {
      this.fireFuse -= dt;
      if (this.fireFuse <= 0) world.explodeVehicle && world.explodeVehicle(this);
    }

    // Driver input: the player reads the keyboard; AI writes this.controls.
    if (this.driver && this.driver.kind === 'player') {
      if (this.driver.exitRequested) {
        // committed to exiting: auto-brake to walking-out speed
        this.controls.throttle = -1;
        this.controls.steer = 0;
        this.controls.handbrake = false;
      } else {
        this.controls.throttle = (input.isDown('up') ? 1 : 0) + (input.isDown('down') ? -1 : 0);
        this.controls.steer = (input.isDown('right') ? 1 : 0) + (input.isDown('left') ? -1 : 0);
        this.controls.handbrake = input.isDown('handbrake');
      }
    } else if (this.driver && this.driver.kind === 'ai') {
      if (world.lodSkip && world.lodSkip(this)) return; // off-screen traffic thinks less
      this.driver.drive(this, dt, world);
    } else if (!this.driver) {
      // parked / abandoned: roll to a stop
      this.controls.throttle = 0;
      this.controls.steer = 0;
      this.controls.handbrake = false;
      // cold parked car: skip physics entirely (big win with 45+ parked cars)
      if (this.speed() < 1 && this.fireFuse < 0 && this.hp / this.maxHp > VEHICLE.SMOKE_HP) return;
    }

    this.#integrate(dt, world);
    this.#collideTiles(world);
    this.#damageEffects(dt, world);
  }

  // grey smoke below 60% hp, black smoke + flames + fuse below 30%
  #damageEffects(dt, world) {
    const frac = this.hp / this.maxHp;
    if (frac <= VEHICLE.FIRE_HP && this.fireFuse < 0 && this.alive) {
      this.fireFuse = VEHICLE.FIRE_FUSE;
    }
    if (frac > VEHICLE.SMOKE_HP || !world.fx) return;
    this.smokeTimer = (this.smokeTimer || 0) - dt;
    if (this.smokeTimer > 0) return;
    this.smokeTimer = 0.15;
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    const ex = this.x + cos * this.spec.w * 0.3;
    const ey = this.y + sin * this.spec.w * 0.3;
    world.fx.smoke(ex, ey, frac <= VEHICLE.FIRE_HP);
    if (this.fireFuse >= 0) world.fx.fire(ex, ey);
  }

  #integrate(dt, world) {
    const spec = this.spec;
    const offroad = world.map.isOffroadAt(this.x, this.y);
    const vMax = spec.vMax * (offroad ? VEHICLE.OFFROAD_VMAX_SCALE : 1);

    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    let fwd = this.vx * cos + this.vy * sin;        // forward speed (signed)
    let lat = -this.vx * sin + this.vy * cos;        // lateral speed

    const t = this.controls.throttle;
    if (t > 0) {
      fwd += spec.accel * Math.max(0, 1 - Math.abs(fwd) / vMax) * dt;
    } else if (t < 0) {
      if (fwd > 10) fwd -= spec.brake * dt;          // braking
      else fwd = Math.max(fwd - spec.accel * 0.6 * dt, -spec.revMax); // reversing
    } else {
      const c = spec.coast * dt;
      fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), c);
    }

    // steering effectiveness: dead at standstill, dulled near top speed
    const steerEff = Math.min(Math.abs(fwd) / 40, 1) * (1 - 0.4 * Math.abs(fwd) / spec.vMax);
    if (this.controls.steer !== 0 && fwd !== 0) {
      this.angle = normAngle(this.angle + this.controls.steer * spec.steer * steerEff * Math.sign(fwd) * dt);
    }

    // lateral grip — the drift model
    let grip = this.controls.handbrake ? spec.gripHand : spec.grip;
    if (offroad) grip *= VEHICLE.OFFROAD_GRIP_SCALE;
    lat *= Math.exp(-grip * dt);

    const nCos = Math.cos(this.angle), nSin = Math.sin(this.angle);
    this.vx = nCos * fwd - nSin * lat;
    this.vy = nSin * fwd + nCos * lat;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // heavy drift leaves skid marks
    if (Math.abs(lat) > 60 && world.addDecal) {
      world.addDecal({ x: this.x - nCos * 10, y: this.y - nSin * 10, kind: 'skid', angle: this.angle, size: 8 });
    }
  }

  // OBB vs solid tiles: sample 8 boundary points; on hit, push out along the
  // shallowest axis and reflect that velocity component.
  #collideTiles(world) {
    const map = world.map;
    const hw = this.spec.w / 2, hh = this.spec.h / 2;
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);

    let pushX = 0, pushY = 0, hit = false;
    for (const [lx, ly] of SAMPLE_POINTS) {
      const px = this.x + cos * lx * hw - sin * ly * hh;
      const py = this.y + sin * lx * hw + cos * ly * hh;
      const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
      const tt = map.tileType(tx, ty);
      if (tt !== T.BUILDING && tt !== T.WATER) continue; // water acts as a guard rail for cars

      // penetration of this point into the tile AABB, along both axes
      const tileX = tx * TILE, tileY = ty * TILE;
      const dxLeft = px - tileX, dxRight = tileX + TILE - px;
      const dyTop = py - tileY, dyBottom = tileY + TILE - py;
      const minX = Math.min(dxLeft, dxRight);
      const minY = Math.min(dyTop, dyBottom);
      hit = true;
      if (minX < minY) {
        const p = dxLeft < dxRight ? -dxLeft : dxRight;
        if (Math.abs(p) > Math.abs(pushX)) pushX = p;
      } else {
        const p = dyTop < dyBottom ? -dyTop : dyBottom;
        if (Math.abs(p) > Math.abs(pushY)) pushY = p;
      }
    }

    if (!hit) return;

    this.x += pushX;
    this.y += pushY;

    // reflect velocity on the push axis, keep most of the tangent
    let impact = 0;
    if (Math.abs(pushX) > Math.abs(pushY)) {
      impact = Math.abs(this.vx);
      this.vx = -this.vx * VEHICLE.WALL_RESTITUTION;
      this.vy *= VEHICLE.WALL_TANGENT_KEEP;
    } else {
      impact = Math.abs(this.vy);
      this.vy = -this.vy * VEHICLE.WALL_RESTITUTION;
      this.vx *= VEHICLE.WALL_TANGENT_KEEP;
    }

    if (impact > VEHICLE.WALL_DMG_MIN_SPEED) {
      this.lastImpactSpeed = impact;
      this.takeDamage(impact * VEHICLE.WALL_DMG_SCALE, world, { kind: 'wall' });
      world.onCarCrash && world.onCarCrash(this, impact);
    }
  }

  die(world, source) {
    // hp exhausted → explode now, even if the fire fuse was still burning
    if (this.wrecked) return;
    if (world && world.explodeVehicle) world.explodeVehicle(this, source);
    else this.becomeWreck();
  }

  becomeWreck() {
    this.wrecked = true;
    this.alive = false;
    this.fireFuse = -1;
    this.sirenOn = false;
    this.wreckTimer = VEHICLE.WRECK_LIFETIME;
    this.vx = 0; this.vy = 0;
    if (this.driver) this.driver = null;
  }

  render(ctx, game) {
    const w = this.spec.w, h = this.spec.h;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-w / 2 + 2, -h / 2 + 3, w, h);

    if (this.wrecked) {
      ctx.fillStyle = '#2b2a28';
      roundRect(ctx, -w / 2, -h / 2, w, h, 4);
      ctx.fill();
      ctx.fillStyle = '#3a3835';
      roundRect(ctx, -w / 2 + 4, -h / 2 + 3, w - 12, h - 6, 3);
      ctx.fill();
      ctx.restore();
      return;
    }

    const dmg = 1 - this.hp / this.maxHp;

    // body
    ctx.fillStyle = this.color;
    roundRect(ctx, -w / 2, -h / 2, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (this.type === 'truck') {
      // cargo box behind the cab
      ctx.fillStyle = '#c9c4b8';
      ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w * 0.62, h - 4);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w * 0.62, h - 4);
      // cab windshield
      ctx.fillStyle = '#aacbe0';
      ctx.fillRect(w * 0.22, -h / 2 + 3, w * 0.12, h - 6);
    } else {
      // cabin
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      roundRect(ctx, -w * 0.28, -h / 2 + 2.5, w * 0.5, h - 5, 3);
      ctx.fill();
      // windshield (front) + rear window
      ctx.fillStyle = '#aacbe0';
      ctx.fillRect(w * 0.14, -h / 2 + 3, w * 0.09, h - 6);
      ctx.fillRect(-w * 0.24, -h / 2 + 3.5, w * 0.07, h - 7);
    }

    // headlights / taillights
    ctx.fillStyle = '#f5edb8';
    ctx.fillRect(w / 2 - 3, -h / 2 + 2, 2.5, 4);
    ctx.fillRect(w / 2 - 3, h / 2 - 6, 2.5, 4);
    ctx.fillStyle = '#b33a2e';
    ctx.fillRect(-w / 2 + 1, -h / 2 + 2, 2, 3.5);
    ctx.fillRect(-w / 2 + 1, h / 2 - 5.5, 2, 3.5);

    if (this.type === 'police') {
      // white doors + roof lightbar
      ctx.fillStyle = '#e8e6e0';
      ctx.fillRect(-w * 0.05, -h / 2 + 2, w * 0.22, h - 4);
      const flash = this.sirenOn && Math.floor(performance.now() / 125) % 2 === 0;
      ctx.fillStyle = flash ? '#e04438' : '#8a2c24';
      ctx.fillRect(-w * 0.1, -h / 2 + 4, 6, 5);
      ctx.fillStyle = !flash && this.sirenOn ? '#3f7de0' : '#28457e';
      ctx.fillRect(-w * 0.1, h / 2 - 9, 6, 5);
    }

    // damage: darkening + dents
    if (dmg > 0.25) {
      ctx.fillStyle = `rgba(30,28,26,${dmg * 0.35})`;
      roundRect(ctx, -w / 2, -h / 2, w, h, 5);
      ctx.fill();
    }

    ctx.restore();
  }
}

// Local-space sample points on the OBB boundary: corners + edge midpoints
const SAMPLE_POINTS = [
  [-1, -1], [1, -1], [1, 1], [-1, 1],   // corners
  [1, 0], [-1, 0], [0, -1], [0, 1],     // edge midpoints
];

const CIVILIAN_COLORS = ['#b8433a', '#3a6db8', '#c2b23c', '#5a9648', '#8956b0', '#c07838', '#4aa8a0', '#94989e', '#d6d2c8', '#41454c'];
function randomCarColor(type) {
  if (type === 'police') return '#22242a';
  return CIVILIAN_COLORS[Math.floor(Math.random() * CIVILIAN_COLORS.length)];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
