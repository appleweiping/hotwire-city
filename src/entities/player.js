// player.js — the player: on-foot movement, mouse facing, vehicle state, combat.
// Vehicle & combat behaviour arrive in later milestones; structure is final.

import { Entity } from './entity.js';
import { PLAYER, WEAPONS, WEAPON_ORDER } from '../config.js';
import { input } from '../input.js';
import { clamp } from '../utils.js';

export class Player extends Entity {
  constructor(x, y) {
    super(x, y);
    this.kind = 'player';
    this.radius = PLAYER.RADIUS;
    this.hp = PLAYER.MAX_HP;
    this.maxHp = PLAYER.MAX_HP;
    this.vehicle = null;         // Vehicle instance while driving
    this.enteringTimer = 0;      // >0 while enter/exit animation locks input
    this.knockdownTimer = 0;
    this.invulnTimer = 0;
    this.weapon = 'fist';
    this.ammo = { pistol: WEAPONS.pistol.ammo, smg: WEAPONS.smg.ammo };
    this.shootCooldown = 0;
    this.moving = false;
  }

  get driving() { return this.vehicle !== null; }

  update(dt, world) {
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.shootCooldown > 0) this.shootCooldown -= dt;

    if (this.knockdownTimer > 0) {
      this.knockdownTimer -= dt;
      this.vx = 0; this.vy = 0;
      this.moving = false;
      return;
    }

    if (this.driving) return; // vehicle drives; player rides along (milestone 3)

    // --- on-foot movement ---
    const move = input.moveVector();
    const speed = input.isDown('sprint') ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;
    this.vx = move.x * speed;
    this.vy = move.y * speed;
    this.moving = move.x !== 0 || move.y !== 0;

    // Face the mouse (aim decoupled from movement)
    const m = world.mouseWorld;
    this.angle = Math.atan2(m.y - this.y, m.x - this.x);

    // Position integration + wall sliding handled by physics system (milestone 2)
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  render(ctx) {
    if (this.driving) return;
    const knocked = this.knockdownTimer > 0;

    ctx.save();
    ctx.translate(this.x, this.y);

    // soft shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(1.5, 2.5, this.radius, this.radius * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(this.angle);
    if (knocked) ctx.scale(1.25, 0.75); // squashed while knocked down

    // body
    ctx.fillStyle = this.invulnTimer > 0 && (Math.floor(this.invulnTimer * 10) % 2 === 0)
      ? 'rgba(240,240,255,0.6)'   // blink while invulnerable
      : '#e0e4ee';
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    // jacket
    ctx.fillStyle = '#3d6bb3';
    ctx.beginPath();
    ctx.arc(0, 0, this.radius - 2, 0, Math.PI * 2);
    ctx.fill();
    // head
    ctx.fillStyle = '#e8c39e';
    ctx.beginPath();
    ctx.arc(1, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // weapon hint: small barrel when armed
    if (!knocked && this.weapon !== 'fist') {
      ctx.fillStyle = '#26262c';
      ctx.fillRect(3, -1.25, 9, 2.5);
    }
    ctx.restore();
  }

  cycleWeapon() {
    // Only cycle through weapons with ammo (fist always available)
    const owned = WEAPON_ORDER.filter(w => w === 'fist' || this.ammo[w] > 0);
    const idx = owned.indexOf(this.weapon);
    this.weapon = owned[(idx + 1) % owned.length];
  }

  selectWeapon(name) {
    if (name === 'fist' || this.ammo[name] > 0) this.weapon = name;
  }

  heal(amount) {
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
  }
}
