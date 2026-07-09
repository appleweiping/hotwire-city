// police.js — the brain driving police cars: predictive pursuit, ramming at
// 3★+, and pulling over to deploy foot cops when the player is on foot.

import { COP, TRAFFIC } from '../config.js';
import { clamp, angleDiff, dist } from '../utils.js';
import { Cop } from '../entities/cop.js';

const _probe = [];

export class PoliceBrain {
  constructor() {
    this.kind = 'ai';
    this.police = true;
    this.deployed = false;
    this.blockedTime = 0;
    this.reverseTime = 0;
  }

  drive(v, dt, world) {
    const p = world.player;
    const stars = world.wantedStars();
    v.sirenOn = stars > 0;

    if (stars === 0) { // stand down: idle at the curb
      v.controls.throttle = 0;
      v.controls.steer = 0;
      return;
    }

    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.controls.throttle = -1;
      v.controls.steer = 0;
      return;
    }

    const d = dist(v.x, v.y, p.x, p.y);

    // player on foot → pull over nearby and unload two officers
    if (!p.driving) {
      if (d < COP.CAR_STOP_DIST) {
        v.controls.throttle = v.fwdSpeed() > 15 ? -1 : 0;
        v.controls.steer = 0;
        v.controls.handbrake = v.fwdSpeed() > 60;
        if (!this.deployed && v.fwdSpeed() < 25) this.#deployCops(v, world);
        return;
      }
      this.deployed = false; // player broke away — rearm the deployment
    }

    // predictive pursuit point
    const tx = p.x + p.vx * COP.PREDICT_TIME;
    const ty = p.y + p.vy * COP.PREDICT_TIME;
    const desired = Math.atan2(ty - v.y, tx - v.x);
    const diff = angleDiff(v.angle, desired);
    v.controls.steer = clamp(diff * 2.5, -1, 1);
    // handbrake flick for hairpin corrections at speed
    v.controls.handbrake = Math.abs(diff) > 1.9 && Math.abs(v.fwdSpeed()) > 140;

    const ramming = stars >= COP.RAM_STARS && p.driving;
    let target = ramming ? v.spec.vMax : this.#probeSpeed(v, world, p);
    if (!ramming && p.driving && d < 90) target = Math.min(target, p.vehicle.speed() * 0.9 + 30);
    const fwd = v.fwdSpeed();
    v.controls.throttle = fwd < target - 5 ? 1 : fwd > target + 15 ? -0.5 : 0.3;

    // stuck recovery
    if (Math.abs(fwd) < 5 && d > 60) {
      this.blockedTime += dt;
      if (this.blockedTime > 1.2) {
        this.blockedTime = 0;
        this.reverseTime = 0.5;
      }
    } else {
      this.blockedTime = 0;
    }
  }

  #deployCops(v, world) {
    this.deployed = true;
    const sin = Math.sin(v.angle), cos = Math.cos(v.angle);
    const off = v.spec.h / 2 + 10;
    for (const side of [1, -1]) {
      const x = v.x + sin * off * side;
      const y = v.y - cos * off * side;
      if (world.map.isSolidAt(x, y) || world.map.isWaterAt(x, y)) continue;
      const cop = new Cop(x, y);
      cop.state = 'chase';
      cop.lastKnown = { x: world.player.x, y: world.player.y };
      world.addEntity(cop);
    }
  }

  // Modest obstacle care below ram stars (they still drive hot)
  #probeSpeed(v, world, p) {
    const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
    const nose = v.spec.w / 2;
    let nearest = Infinity;
    const px = v.x + cos * (nose + 50), py = v.y + sin * (nose + 50);
    world.queryCircle(px, py, 20, _probe);
    for (const e of _probe) {
      if (e === v || e === p || (p.vehicle && e === p.vehicle)) continue;
      if (e.kind === 'pedestrian' && !e.alive) continue;
      const dx = e.x - v.x, dy = e.y - v.y;
      const ahead = dx * cos + dy * sin;
      if (ahead < nose || ahead > TRAFFIC.PROBE_LEN + nose) continue;
      if (Math.abs(-dx * sin + dy * cos) > 16 + e.radius * 0.5) continue;
      nearest = Math.min(nearest, ahead - nose);
    }
    if (nearest === Infinity) return v.spec.vMax * 0.9;
    return v.spec.vMax * 0.9 * clamp((nearest - 20) / 70, 0, 1);
  }
}
