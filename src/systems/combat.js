// combat.js — hitscan weapons. No bullet entities: a shot is an instant
// DDA ray against buildings plus segment-vs-circle tests against entities,
// rendered as a one-frame tracer. Melee is a short arc check.

import { WEAPONS } from '../config.js';
import { segCircleHit, angleDiff, dist } from '../utils.js';
import { carCircles } from './physics.js';

// Returns what was hit: {kind:'entity'|'wall'|'none', entity?, x, y}
export function fireHitscan(world, shooter, ox, oy, aimAngle, weaponName, spreadScale = 1) {
  const w = WEAPONS[weaponName];

  if (w.melee) return meleeSwing(world, shooter, ox, oy, aimAngle, w);

  const angle = aimAngle + (Math.random() - 0.5) * 2 * w.spread * spreadScale;
  const wallDist = world.map.raycastSolid(ox, oy, angle, w.range);
  const maxDist = Math.min(wallDist, w.range);
  const ex = ox + Math.cos(angle) * maxDist;
  const ey = oy + Math.sin(angle) * maxDist;

  // nearest entity hit along the segment
  let best = null, bestT = Infinity;
  for (const e of world.entities) {
    if (!isShootable(e, shooter)) continue;
    if (e.kind === 'vehicle') {
      for (const c of carCircles(e)) {
        const t = segCircleHit(ox, oy, ex, ey, c.x, c.y, c.r);
        if (t >= 0 && t < bestT) { bestT = t; best = e; }
      }
    } else {
      const t = segCircleHit(ox, oy, ex, ey, e.x, e.y, e.radius);
      if (t >= 0 && t < bestT) { bestT = t; best = e; }
    }
  }

  let hx = ex, hy = ey;
  if (best) {
    hx = ox + (ex - ox) * bestT;
    hy = oy + (ey - oy) * bestT;
  }

  const fx = world.fx;
  if (fx) {
    fx.muzzle(ox + Math.cos(aimAngle) * 6, oy + Math.sin(aimAngle) * 6, aimAngle);
    fx.tracer(ox, oy, hx, hy);
  }

  world.emit({ type: 'gunshot', x: ox, y: oy, radius: 250, source: shooter });

  if (best) {
    hitEntity(world, best, shooter, w.dmg, angle, hx, hy);
    return { kind: 'entity', entity: best, x: hx, y: hy };
  }
  if (maxDist === wallDist && fx) fx.sparks(hx, hy);
  return { kind: maxDist === wallDist ? 'wall' : 'none', x: hx, y: hy };
}

function meleeSwing(world, shooter, ox, oy, aimAngle, w) {
  let best = null, bestD = Infinity;
  for (const e of world.entities) {
    if (!isShootable(e, shooter)) continue;
    const d = dist(ox, oy, e.x, e.y) - e.radius;
    if (d > w.range) continue;
    const toward = Math.atan2(e.y - oy, e.x - ox);
    if (Math.abs(angleDiff(aimAngle, toward)) > Math.PI / 4 && d > 4) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best && best.kind !== 'vehicle') { // fists don't dent cars
    hitEntity(world, best, shooter, w.dmg, aimAngle, best.x, best.y);
    return { kind: 'entity', entity: best, x: best.x, y: best.y };
  }
  return { kind: 'none', x: ox, y: oy };
}

function isShootable(e, shooter) {
  if (e === shooter || !e.alive || !e.solid) return false;
  if (e.kind === 'player' && e.driving) return false; // the car absorbs it
  if (shooter.vehicle && e === shooter.vehicle) return false;
  return e.kind === 'player' || e.kind === 'pedestrian' || e.kind === 'cop' || e.kind === 'vehicle';
}

function hitEntity(world, e, shooter, dmg, angle, hx, hy) {
  if (world.fx) {
    if (e.kind === 'vehicle') world.fx.sparks(hx, hy);
    else world.fx.blood(hx, hy, angle);
  }
  if (e.kind !== 'vehicle' && world.addDecal && Math.random() < 0.5) {
    world.addDecal({ x: e.x, y: e.y, kind: 'blood', angle: Math.random() * Math.PI, size: 4 + Math.random() * 3 });
  }
  e.takeDamage(dmg, world, { kind: 'shot', by: shooter });
}
