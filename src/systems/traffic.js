// traffic.js — the brain that drives civilian cars: lane following via a
// look-ahead point, random turns at intersections, forward obstacle probing,
// and stuck-recovery. Writes vehicle.controls; the car's physics does the rest.

import { TRAFFIC, TILE, T } from '../config.js';
import { clamp, angleDiff } from '../utils.js';
import { CityMap } from '../world/citymap.js';

const _probe = [];

export class TrafficBrain {
  constructor() {
    this.kind = 'ai';
    this.crossPlan = null;       // {dir, laneCenter, axis} chosen when entering a crossing
    this.blockedTime = 0;
    this.retries = 0;
    this.reverseTime = 0;
    this.gaveUp = false;
  }

  drive(v, dt, world) {
    if (this.gaveUp) { v.controls.throttle = 0; return; }

    // stuck-recovery reverse maneuver
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.controls.throttle = -1;
      v.controls.steer = 0;
      if (this.reverseTime <= 0) this.crossPlan = null; // re-decide after backing up
      return;
    }

    const map = world.map;
    const tileHere = map.tileAtWorld(v.x, v.y);
    let dir, laneCenter, axis;

    if (tileHere === T.ROAD_CROSS) {
      if (!this.crossPlan) this.crossPlan = this.#planCrossing(v, map);
      ({ dir, laneCenter, axis } = this.crossPlan);
    } else {
      this.crossPlan = null;
      const lane = map.laneInfoAt(v.x, v.y);
      if (lane && lane.dir) {
        ({ dir, laneCenter, axis } = lane);
      } else {
        // shoved off the road (or spawned oddly): head back to the nearest road
        this.#steerTowardRoad(v, map);
        return;
      }
    }

    // look-ahead target on the lane centerline
    let tx, ty;
    if (axis === 'v') {
      tx = laneCenter;
      ty = v.y + dir.y * TRAFFIC.LOOKAHEAD;
    } else {
      tx = v.x + dir.x * TRAFFIC.LOOKAHEAD;
      ty = laneCenter;
    }
    const desired = Math.atan2(ty - v.y, tx - v.x);
    v.controls.steer = clamp(angleDiff(v.angle, desired) * TRAFFIC.STEER_GAIN, -1, 1);

    // obstacle probe: two circles ahead of the bumper
    const targetSpeed = this.#probeSpeed(v, world);
    const fwd = v.fwdSpeed();
    v.controls.throttle = fwd < targetSpeed - 5 ? 1 : fwd > targetSpeed + 10 ? -0.6 : 0;
    v.controls.handbrake = false;

    // stuck detection
    if (targetSpeed > 20 && Math.abs(fwd) < 5) {
      this.blockedTime += dt;
      if (this.blockedTime > TRAFFIC.BLOCKED_TIMEOUT) {
        this.blockedTime = 0;
        const visible = world.camera
          ? Math.abs(v.x - world.camera.x) < 740 && Math.abs(v.y - world.camera.y) < 460
          : true;
        if (!visible) { v.remove = true; return; }
        if (this.retries < TRAFFIC.MAX_RETRIES) {
          this.retries++;
          this.reverseTime = TRAFFIC.REVERSE_RETRY_DIST / 60; // ≈ time to back up
        } else {
          this.gaveUp = true; // engine off; now scenery (and an obstacle)
        }
      }
    } else if (this.blockedTime > 0) {
      this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
    }
  }

  // 50% straight / 25% left / 25% right (invalid exits culled, no U-turns
  // unless it is the only option). Returns the plan for crossing the box.
  #planCrossing(v, map) {
    const tx = Math.floor(v.x / TILE), ty = Math.floor(v.y / TILE);
    const bx = CityMap.bandStart(tx), by = CityMap.bandStart(ty);

    const heading = this.#cardinal(v.angle);
    const options = [];
    for (const d of [ { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 } ]) {
      if (d.x === -heading.x && d.y === -heading.y) continue; // no U-turn
      // is there road just beyond the 4×4 crossing box in this direction?
      const exX = d.x !== 0 ? (d.x > 0 ? bx + 4 : bx - 1) : tx;
      const exY = d.y !== 0 ? (d.y > 0 ? by + 4 : by - 1) : ty;
      const t = map.tileType(exX, exY);
      if (t !== T.ROAD_H && t !== T.ROAD_V && t !== T.ROAD_CROSS) continue;
      const straight = d.x === heading.x && d.y === heading.y;
      options.push({ d, weight: straight ? 2 : 1 });
    }

    let pick;
    if (!options.length) {
      pick = { x: -heading.x, y: -heading.y }; // dead end: U-turn allowed
    } else {
      let total = 0;
      for (const o of options) total += o.weight;
      let roll = Math.random() * total;
      pick = options[options.length - 1].d;
      for (const o of options) { roll -= o.weight; if (roll <= 0) { pick = o.d; break; } }
    }

    // right-hand lane center for the chosen exit direction
    if (pick.x !== 0) {
      return { dir: pick, axis: 'h', laneCenter: (pick.x > 0 ? by + 3 : by + 1) * TILE };
    }
    return { dir: pick, axis: 'v', laneCenter: (pick.y > 0 ? bx + 1 : bx + 3) * TILE };
  }

  #cardinal(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    if (Math.abs(c) > Math.abs(s)) return { x: Math.sign(c) || 1, y: 0 };
    return { x: 0, y: Math.sign(s) || 1 };
  }

  #steerTowardRoad(v, map) {
    // crude: creep forward slowly; wall collisions + steering noise free most cars
    v.controls.throttle = 0.3;
    v.controls.steer = Math.random() < 0.5 ? -0.4 : 0.4;
  }

  // Desired speed after checking for obstacles ahead of the bumper.
  #probeSpeed(v, world) {
    const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
    const nose = v.spec.w / 2;
    let nearest = Infinity;

    for (const distAhead of [nose + 28, nose + 62]) {
      const px = v.x + cos * distAhead, py = v.y + sin * distAhead;
      world.queryCircle(px, py, TRAFFIC.PROBE_W / 2 + 6, _probe);
      for (const e of _probe) {
        if (e === v || (e.kind === 'pedestrian' && !e.alive)) continue;
        if (e === v.driver) continue;
        const dx = e.x - v.x, dy = e.y - v.y;
        const ahead = dx * cos + dy * sin;                 // longitudinal distance
        const lateral = Math.abs(-dx * sin + dy * cos);
        if (ahead < nose || ahead > TRAFFIC.PROBE_LEN + nose) continue;
        if (lateral > TRAFFIC.PROBE_W / 2 + e.radius * 0.5) continue;
        nearest = Math.min(nearest, ahead - nose);
      }
    }

    if (nearest === Infinity) return TRAFFIC.CRUISE_SPEED;
    return TRAFFIC.CRUISE_SPEED * clamp(
      (nearest - TRAFFIC.STOP_DIST) / (TRAFFIC.PROBE_LEN - TRAFFIC.STOP_DIST), 0, 1);
  }
}
