// fx.js — juice: pooled particles, bullet tracers, screen shake (trauma model),
// and floating score text. Everything here is cosmetic and budget-capped.

import { FX } from '../config.js';
import { clamp } from '../utils.js';

export class Fx {
  constructor() {
    // fixed-size particle pool: dead slots are recycled, never reallocated
    this.pool = new Array(FX.PARTICLE_CAP);
    for (let i = 0; i < this.pool.length; i++) {
      this.pool[i] = { alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', drag: 0 };
    }
    this.cursor = 0;
    this.tracers = [];    // {x0,y0,x1,y1,life}
    this.flashes = [];    // muzzle flashes {x,y,angle,life}
    this.floaters = [];   // floating text {x,y,text,color,life} (world space)
    this.trauma = 0;
  }

  addTrauma(amount) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  getShakeOffset() {
    if (this.trauma <= 0.001) return { x: 0, y: 0 };
    const amp = this.trauma * this.trauma * FX.SHAKE_MAX;
    return { x: (Math.random() * 2 - 1) * amp, y: (Math.random() * 2 - 1) * amp };
  }

  #spawn(x, y, vx, vy, life, size, color, drag = 3) {
    // overwrite the oldest slot if the pool is exhausted
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.alive = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life;
    p.size = size; p.color = color; p.drag = drag;
  }

  burst(x, y, { count, angle = 0, cone = Math.PI * 2, speed, life, size, color, drag = 3 }) {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * cone;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.#spawn(x, y, Math.cos(a) * s, Math.sin(a) * s,
        life * (0.6 + Math.random() * 0.4), size * (0.7 + Math.random() * 0.6), color, drag);
    }
  }

  // --- canned effects ---

  blood(x, y, angle) {
    this.burst(x, y, { count: 10, angle, cone: 1.1, speed: 120, life: 0.4, size: 2.2, color: '#8c1d1d' });
  }

  sparks(x, y) {
    this.burst(x, y, { count: 5, speed: 160, life: 0.2, size: 1.8, color: '#f5d76e', drag: 6 });
  }

  smoke(x, y, dark = false) {
    this.burst(x, y, {
      count: 1, speed: 18, life: 1.1, size: 5,
      color: dark ? 'rgba(40,38,36,0.7)' : 'rgba(150,150,150,0.55)', drag: 1,
    });
  }

  fire(x, y) {
    this.burst(x, y, { count: 2, angle: -Math.PI / 2, cone: 0.8, speed: 40, life: 0.5, size: 4, color: '#e8762e', drag: 1 });
  }

  explosion(x, y) {
    this.burst(x, y, { count: 20, speed: 260, life: 0.55, size: 4, color: '#e8762e', drag: 4 });
    this.burst(x, y, { count: 12, speed: 120, life: 1.2, size: 6, color: 'rgba(50,46,42,0.8)', drag: 2 });
    this.flashes.push({ x, y, angle: 0, life: 0.09, big: true });
    this.addTrauma(FX.TRAUMA_EXPLOSION);
  }

  muzzle(x, y, angle) {
    this.flashes.push({ x, y, angle, life: 0.05, big: false });
  }

  tracer(x0, y0, x1, y1) {
    this.tracers.push({ x0, y0, x1, y1, life: 0.07 });
  }

  floatText(x, y, text, color = '#7fc95c') {
    this.floaters.push({ x, y, text, color, life: 1.1 });
  }

  update(dt) {
    this.trauma = Math.max(0, this.trauma - FX.TRAUMA_DECAY * dt);
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      if ((this.tracers[i].life -= dt) <= 0) this.tracers.splice(i, 1);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if ((this.flashes[i].life -= dt) <= 0) this.flashes.splice(i, 1);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.y -= 26 * dt;
      if ((f.life -= dt) <= 0) this.floaters.splice(i, 1);
    }
  }

  // drawn inside the world transform, above entities
  render(ctx) {
    for (const t of this.tracers) {
      ctx.strokeStyle = 'rgba(245,235,170,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x1, t.y1);
      ctx.stroke();
    }
    for (const f of this.flashes) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      ctx.fillStyle = 'rgba(255,240,180,0.9)';
      if (f.big) {
        ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, -3); ctx.lineTo(10, 0); ctx.lineTo(0, 3);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    for (const p of this.pool) {
      if (!p.alive) continue;
      ctx.globalAlpha = Math.min(1, p.life / p.maxLife + 0.2);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const f of this.floaters) {
      ctx.font = '700 13px "Segoe UI", sans-serif';
      ctx.fillStyle = f.color;
      ctx.globalAlpha = Math.min(1, f.life);
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}
