// physics.js — movement integration and collision resolution:
// circle-vs-tile wall sliding, a rebuilt-per-tick spatial hash, and the
// entity-entity collision pass (car↔person, car↔car, person↔person).

import { T, TILE, WORLD_W, WORLD_H, PLAYER, PED, VEHICLE } from '../config.js';
import { clamp } from '../utils.js';

// Move a circular entity with wall sliding: integrate one axis, resolve
// penetration on that axis only, then the other. Produces natural sliding
// along building faces without any normal math.
export function moveCircle(e, dt, map) {
  e.x += e.vx * dt;
  resolveCircleAxis(e, map, 'x');
  e.y += e.vy * dt;
  resolveCircleAxis(e, map, 'y');

  e.x = clamp(e.x, e.radius, WORLD_W - e.radius);
  e.y = clamp(e.y, e.radius, WORLD_H - e.radius);
}

// Push a circle out of any solid tile it overlaps, along one axis.
export function resolveCircleAxis(e, map, axis) {
  const r = e.radius;
  const minTx = Math.floor((e.x - r) / TILE);
  const maxTx = Math.floor((e.x + r) / TILE);
  const minTy = Math.floor((e.y - r) / TILE);
  const maxTy = Math.floor((e.y + r) / TILE);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (map.tileType(tx, ty) !== T.BUILDING) continue;
      const rx = tx * TILE, ry = ty * TILE;
      // nearest point on tile AABB to circle center
      const nx = clamp(e.x, rx, rx + TILE);
      const ny = clamp(e.y, ry, ry + TILE);
      const dx = e.x - nx, dy = e.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;

      if (axis === 'x') {
        // push out horizontally toward the side the center is on
        if (e.x < rx + TILE / 2) e.x = rx - r;
        else e.x = rx + TILE + r;
      } else {
        if (e.y < ry + TILE / 2) e.y = ry - r;
        else e.y = ry + TILE + r;
      }
    }
  }
}

// Clamp how far an entity can be passively shoved in one tick, then make sure
// the shove didn't press it into a wall (anti "ironed into the building").
export function shoveCircle(e, dx, dy, maxPush, map) {
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > maxPush && d > 0) {
    dx = dx / d * maxPush;
    dy = dy / d * maxPush;
  }
  e.x += dx;
  resolveCircleAxis(e, map, 'x');
  e.y += dy;
  resolveCircleAxis(e, map, 'y');
}

// ---------------------------------------------------------------------------
// Spatial hash: rebuilt every tick (insertion is O(n) and rebuilding is far
// simpler than incremental moves). Cell size must be ≥ the largest entity
// diameter so a 3×3 neighbourhood always covers any overlap.

const CELL = 128;
const COLS = Math.ceil(WORLD_W / CELL);

export class SpatialHash {
  constructor() {
    this.cells = new Map(); // int key → Entity[]
  }

  rebuild(entities) {
    for (const arr of this.cells.values()) arr.length = 0; // reuse arrays, no GC churn
    for (const e of entities) {
      if (!e.solid) continue;
      const key = Math.floor(e.x / CELL) + Math.floor(e.y / CELL) * COLS;
      let arr = this.cells.get(key);
      if (!arr) { arr = []; this.cells.set(key, arr); }
      arr.push(e);
    }
  }

  // Collect entities whose centers fall in the 3×3 cells around (x, y),
  // then filter by true circle distance. Serves collisions AND AI senses.
  queryCircle(x, y, r, out = []) {
    out.length = 0;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const arr = this.cells.get(gx + gy * COLS);
        if (!arr) continue;
        for (const e of arr) {
          const dx = e.x - x, dy = e.y - y;
          if (dx * dx + dy * dy <= (r + e.radius) * (r + e.radius)) out.push(e);
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entity-entity collision pass. Vehicles are approximated as two circles
// (front + rear) so long cars collide believably without full OBB-vs-OBB SAT.

const _query = [];

export function carCircles(v) {
  const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
  const off = v.spec.w / 4;
  const r = v.spec.h / 2 + 2;
  return [
    { x: v.x + cos * off, y: v.y + sin * off, r },
    { x: v.x - cos * off, y: v.y - sin * off, r },
  ];
}

export function entityCollisionPass(hash, entities, world) {
  hash.rebuild(entities);

  for (const e of entities) {
    if (!e.solid) continue;

    if (e.kind === 'vehicle') {
      collideVehicle(hash, e, world);
    } else {
      collidePerson(hash, e, world);
    }
  }
}

function collideVehicle(hash, v, world) {
  hash.queryCircle(v.x, v.y, v.radius + 40, _query);
  for (const other of _query) {
    if (other === v || !other.solid) continue;
    if (other.id < v.id && other.kind === 'vehicle') continue; // each car pair once

    if (other.kind === 'vehicle') {
      collideCarCar(v, other, world);
    } else {
      collideCarPerson(v, other, world);
    }
  }
}

function collideCarCar(a, b, world) {
  const ca = carCircles(a), cb = carCircles(b);
  for (const p of ca) {
    for (const q of cb) {
      const dx = q.x - p.x, dy = q.y - p.y;
      const rr = p.r + q.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 === 0) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      const overlap = rr - d;

      // separate by inverse mass
      const ma = a.spec.mass, mb = b.spec.mass;
      const total = ma + mb;
      a.x -= nx * overlap * (mb / total);
      a.y -= ny * overlap * (mb / total);
      b.x += nx * overlap * (ma / total);
      b.y += ny * overlap * (ma / total);

      // relative normal speed → impulse + damage
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const relN = rvx * nx + rvy * ny;
      if (relN < 0) {
        const imp = -relN * (ma * mb) / total;
        a.vx -= nx * imp / ma * 0.9;
        a.vy -= ny * imp / ma * 0.9;
        b.vx += nx * imp / mb * 0.9;
        b.vy += ny * imp / mb * 0.9;

        const crashSpeed = -relN;
        if (crashSpeed > VEHICLE.WALL_DMG_MIN_SPEED) {
          const dmg = crashSpeed * VEHICLE.CAR_CAR_DMG_SCALE;
          a.takeDamage(dmg, world, { kind: 'crash', by: b });
          b.takeDamage(dmg, world, { kind: 'crash', by: a });
          world.onCarCrash && world.onCarCrash(a, crashSpeed, b);
        } else if (crashSpeed > 25) {
          world.fx && world.fx.sparks((p.x + q.x) / 2, (p.y + q.y) / 2);
        }
      }
      return; // one contact per pair per tick is plenty
    }
  }
}

function collideCarPerson(v, person, world) {
  for (const c of carCircles(v)) {
    const dx = person.x - c.x, dy = person.y - c.y;
    const rr = c.r + person.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) continue;

    const d = Math.sqrt(d2) || 0.001;
    const nx = dx / d, ny = dy / d;
    const overlap = rr - d;
    const carSpeed = v.speed();

    // shove the person out (clamped, then re-resolved against walls so they
    // can't be ironed into a building)
    const push = Math.min(overlap + carSpeed * 0.016, PLAYER.MAX_PASSIVE_PUSH);
    shoveCircle(person, nx * push, ny * push, PLAYER.MAX_PASSIVE_PUSH, world.map);

    world.onCarHitsPerson && world.onCarHitsPerson(v, person, carSpeed);
    return;
  }
}

function collidePerson(hash, p, world) {
  hash.queryCircle(p.x, p.y, p.radius + 8, _query);
  for (const other of _query) {
    if (other === p || !other.solid) continue;
    if (other.kind === 'vehicle') continue;      // handled from the car's side
    if (other.id < p.id) continue;               // each pair once

    const dx = other.x - p.x, dy = other.y - p.y;
    const rr = p.radius + other.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 === 0) continue;

    const d = Math.sqrt(d2);
    const overlap = (rr - d) / 2;
    const nx = dx / d, ny = dy / d;
    shoveCircle(p, -nx * overlap, -ny * overlap, PED.RADIUS, world.map);
    shoveCircle(other, nx * overlap, ny * overlap, PED.RADIUS, world.map);
  }
}
