// pickup.js — floating collectibles: ammo drops, street cash, hospital health.
// Non-solid; the player vacuums them up by proximity.

import { Entity } from './entity.js';
import { PICKUP_RADIUS, ECONOMY } from '../config.js';
import { dist } from '../utils.js';

export class Pickup extends Entity {
  // type: 'ammo' → data {weapon, amount} | 'cash' → data {amount, respawns}
  //       'health' → data {amount, respawns}
  constructor(x, y, type, data) {
    super(x, y);
    this.kind = 'pickup';
    this.type = type;
    this.data = data;
    this.solid = false;
    this.radius = 8;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.respawnTimer = 0;      // >0 → collected, waiting to reappear
    this.lifetime = type === 'ammo' ? 30 : Infinity; // drops evaporate eventually
  }

  update(dt, world) {
    this.bobPhase += dt * 3;

    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      return;
    }
    if (this.lifetime !== Infinity && (this.lifetime -= dt) <= 0) { this.remove = true; return; }

    const p = world.player;
    if (!p || !p.alive || p.driving) return;
    if (dist(this.x, this.y, p.x, p.y) > PICKUP_RADIUS + p.radius) return;

    this.#collect(world, p);
  }

  #collect(world, p) {
    if (this.type === 'ammo') {
      p.ammo[this.data.weapon] += this.data.amount;
      world.fx.floatText(this.x, this.y - 10, `+${this.data.amount} ${this.data.weapon.toUpperCase()}`, '#c9d4f0');
      this.remove = true;
    } else if (this.type === 'cash') {
      world.addMoney(this.data.amount, this.x, this.y - 10);
      if (this.data.respawns) this.respawnTimer = ECONOMY.CASH_RESPAWN_TIME;
      else this.remove = true;
    } else if (this.type === 'health') {
      if (p.hp >= p.maxHp) return; // don't waste it
      p.heal(this.data.amount);
      world.fx.floatText(this.x, this.y - 10, `+${this.data.amount} HP`, '#7fc95c');
      if (this.data.respawns) this.respawnTimer = ECONOMY.HEALTH_RESPAWN_TIME;
      else this.remove = true;
    }
  }

  render(ctx) {
    if (this.respawnTimer > 0) return;
    const bob = Math.sin(this.bobPhase) * 1.5;
    ctx.save();
    ctx.translate(this.x, this.y + bob);

    if (this.type === 'ammo') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(-6, 4 - bob, 12, 3);
      ctx.fillStyle = '#3d4148';
      ctx.fillRect(-6, -4, 12, 8);
      ctx.fillStyle = '#d8b23c';
      ctx.fillRect(-4, -2, 8, 4);
    } else if (this.type === 'cash') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(-6, 5 - bob, 12, 3);
      ctx.fillStyle = '#3f7d46';
      ctx.fillRect(-7, -4, 14, 8);
      ctx.fillStyle = '#8fce96';
      ctx.font = '700 8px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('$', 0, 3);
      ctx.textAlign = 'left';
    } else if (this.type === 'health') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(0, 6 - bob, 6, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8e6e0';
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c85450';
      ctx.fillRect(-1.5, -4.5, 3, 9);
      ctx.fillRect(-4.5, -1.5, 9, 3);
    }
    ctx.restore();
  }
}
