// physics.js — movement integration and collision resolution.
// Milestone 2: circle-vs-tile with axis-separated wall sliding.
// Later: spatial hash + entity-entity pass + vehicle OBB resolution.

import { T, TILE, WORLD_W, WORLD_H } from '../config.js';
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
