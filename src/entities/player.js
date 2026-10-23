// player.js — the player: on-foot movement, mouse facing, vehicle state, combat.
// Vehicle & combat behaviour arrive in later milestones; structure is final.

import { Entity } from './entity.js';
import { PLAYER, T, VEHICLE, WEAPONS, WEAPON_ORDER } from '../config.js';
import { input } from '../input.js';
import { clamp, dist } from '../utils.js';
import { moveCircle } from '../systems/physics.js';

export class Player extends Entity {
  constructor(x, y) {
    super(x, y);
    this.kind = 'player';
    this.radius = PLAYER.RADIUS;
    this.hp = PLAYER.MAX_HP;
    this.maxHp = PLAYER.MAX_HP;
    this.vehicle = null;         // Vehicle instance while driving
    this.enteringTimer = 0;      // >0 while the enter animation locks input
    this.pendingVehicle = null;  // vehicle being entered
    this.exitRequested = false;  // E pressed at speed → auto-brake then exit
    this.nearbyVehicle = null;   // for the contextual "E — STEAL CAR" hint
    this.knockdownTimer = 0;
    this.invulnTimer = 0;
    this.weapon = 'fist';
    this.ammo = { pistol: WEAPONS.pistol.ammo, smg: WEAPONS.smg.ammo };
    this.shootCooldown = 0;
    this.damageFlash = 0;
    this.moving = false;
  }

  get driving() { return this.vehicle !== null; }

  update(dt, world) {
    if (!this.alive) { this.vx = 0; this.vy = 0; return; } // death cam
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.shootCooldown > 0) this.shootCooldown -= dt;
    if (this.damageFlash > 0) this.damageFlash -= dt;

    // mid enter-animation: frozen and out of the collision world
    if (this.enteringTimer > 0) {
      this.enteringTimer -= dt;
      if (this.enteringTimer <= 0 && this.pendingVehicle) this.#finishEntering(world);
      return;
    }

    if (this.knockdownTimer > 0) {
      this.knockdownTimer -= dt;
      this.vx = 0; this.vy = 0;
      this.moving = false;
      return;
    }

    if (this.driving) { this.#updateDriving(world); return; }

    // death cam / cutscene: stand still, no interactions
    if (world.inputLocked) {
      this.vx = 0; this.vy = 0;
      this.moving = false;
      return;
    }

    // --- on-foot movement ---
    const move = input.moveVector();
    const speed = input.isDown('sprint') ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;
    this.vx = move.x * speed;
    this.vy = move.y * speed;
    this.moving = move.x !== 0 || move.y !== 0;

    // Face the mouse (aim decoupled from movement)
    const m = world.mouseWorld;
    this.angle = Math.atan2(m.y - this.y, m.x - this.x);

    moveCircle(this, dt, world.map); // integrate with wall sliding

    // --- vehicle interaction ---
    this.nearbyVehicle = this.#findNearestVehicle(world);
    if (this.nearbyVehicle && input.wasPressed('interact')) {
      this.#beginEntering(world, this.nearbyVehicle);
      return;
    }

    this.#updateWeapons(world);

    // rivers are not for swimming
    if (world.map.isWaterAt(this.x, this.y)) {
      this.invulnTimer = 0;
      this.takeDamage(9999, world, { kind: 'drown' });
    }
  }

  #updateWeapons(world) {
    if (input.wasPressed('weapon1')) this.selectWeapon('fist');
    if (input.wasPressed('weapon2')) this.selectWeapon('pistol');
    if (input.wasPressed('weapon3')) this.selectWeapon('smg');
    if (input.wasPressed('cycleWeapon')) this.cycleWeapon();

    const w = WEAPONS[this.weapon];
    const wantFire = w.auto ? input.mouseDown : input.mouseClicked;
    if (!wantFire || this.shootCooldown > 0) return;
    if (!w.melee && this.ammo[this.weapon] <= 0) return;

    this.shootCooldown = 1 / w.rate;
    const ox = this.x + Math.cos(this.angle) * (this.radius + 4);
    const oy = this.y + Math.sin(this.angle) * (this.radius + 4);
    world.shoot(this, ox, oy, this.angle, this.weapon, this.moving ? 1.8 : 1);
    if (!w.melee) {
      this.ammo[this.weapon]--;
      world.fx.addTrauma(0.06);
      world.reportCrime('GUNSHOT', this.x, this.y);
    }
  }

  #updateDriving(world) {
    const v = this.vehicle;
    // ride along (camera + damage checks use player position/velocity)
    this.x = v.x; this.y = v.y;
    this.vx = v.vx; this.vy = v.vy;
    this.angle = v.angle;

    if (v.wrecked) { this.#tryExit(world) || this.#forceExit(world); return; }
    if (world.inputLocked) { this.exitRequested = false; return; }

    if (input.wasPressed('interact')) {
      if (this.exitRequested) this.exitRequested = false;           // second E cancels
      else if (Math.abs(v.fwdSpeed()) <= VEHICLE.EXIT_MAX_SPEED) this.#tryExit(world);
      else this.exitRequested = true; // vehicle auto-brakes while this is set
    }
    if (this.exitRequested && Math.abs(v.fwdSpeed()) <= VEHICLE.EXIT_MAX_SPEED) {
      // boxed in? release the latch so the player regains the wheel
      if (!this.#tryExit(world)) this.exitRequested = false;
    }
  }

  #findNearestVehicle(world) {
    let best = null, bestD = Infinity;
    for (const e of world.entities) {
      if (e.kind !== 'vehicle' || e.wrecked) continue;
      const d = dist(this.x, this.y, e.x, e.y) - e.radius * 0.5;
      if (d < bestD && d <= VEHICLE.ENTER_DIST) { bestD = d; best = e; }
    }
    return best;
  }

  #beginEntering(world, v) {
    const occupied = v.driver && v.driver !== this;
    if (occupied && v.speed() > VEHICLE.JACK_MAX_SPEED) return; // can't jack at speed
    this.pendingVehicle = v;
    if (occupied) v.heldForJack = true;  // its driver brakes while being pulled out
    this.enteringTimer = occupied ? VEHICLE.ENTER_TIME_JACK : VEHICLE.ENTER_TIME_EMPTY;
    this.solid = false;          // fully out of the collision world during the animation
    this.vx = 0; this.vy = 0;
    this.moving = false;
    this.nearbyVehicle = null;
  }

  #finishEntering(world) {
    const v = this.pendingVehicle;
    this.pendingVehicle = null;
    if (v) v.heldForJack = false;
    // re-validate: the car may have wrecked, sped up, or driven away mid-animation
    const stillThere = v && !v.wrecked
      && dist(this.x, this.y, v.x, v.y) <= VEHICLE.ENTER_DIST + v.radius
      && (!v.driver || v.driver === this || v.speed() <= VEHICLE.JACK_MAX_SPEED);
    if (!stillThere) { this.solid = true; return; }
    if (v.driver && v.driver !== this) {
      world.onCarJacked && world.onCarJacked(v, this); // ejects driver, reports crime
    }
    v.driver = this;
    this.vehicle = v;
    this.exitRequested = false;
  }

  // Exit spots tried in order: left, right, rear, front — first one that is
  // free of walls, water and other vehicles wins.
  #tryExit(world) {
    const v = this.vehicle;
    const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
    const side = v.spec.h / 2 + 12, ends = v.spec.w / 2 + 14;
    const candidates = [
      [sin * side, -cos * side],
      [-sin * side, cos * side],
      [-cos * ends, -sin * ends],
      [cos * ends, sin * ends],
    ];
    for (const [ox, oy] of candidates) {
      const px = v.x + ox, py = v.y + oy;
      if (!this.#spotFree(world, px, py)) continue;
      this.x = px; this.y = py;
      this.vx = 0; this.vy = 0;
      v.driver = null;
      this.vehicle = null;
      this.exitRequested = false;
      this.solid = true;
      return true;
    }
    return false; // boxed in — stay in the car
  }

  #spotFree(world, px, py) {
    const r = this.radius;
    const map = world.map;
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const t = map.tileAtWorld(px + dx, py + dy);
      if (t === T.BUILDING || t === T.WATER) return false;
    }
    for (const e of world.entities) {
      if (e.kind !== 'vehicle' || e === this.vehicle) continue;
      if (dist(px, py, e.x, e.y) < r + e.radius) return false;
    }
    return true;
  }

  // Last resort when the car is destroyed and every standard exit is blocked:
  // spiral outward until a safe spot is found (never into a wall or the river).
  #forceExit(world) {
    const v = this.vehicle;
    let px = v.x, py = v.y - v.spec.h / 2 - 14; // default if the scan fails
    outer:
    for (let r = 20; r <= 140; r += 24) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const cx = v.x + Math.cos(a) * r, cy = v.y + Math.sin(a) * r;
        if (this.#spotFree(world, cx, cy)) { px = cx; py = cy; break outer; }
      }
    }
    this.x = px; this.y = py;
    this.vx = 0; this.vy = 0;
    v.driver = null;
    this.vehicle = null;
    this.exitRequested = false;
    this.solid = true;
  }

  render(ctx) {
    if (this.driving) return;
    if (!this.alive) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.angle + Math.PI / 2);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#3d6bb3';
      ctx.beginPath();
      ctx.ellipse(0, 0, this.radius + 2, this.radius - 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8c39e';
      ctx.beginPath();
      ctx.arc(0, -this.radius - 1, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
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

  takeDamage(amount, world, source) {
    if (!this.alive || this.invulnTimer > 0) return;
    this.damageFlash = 0.3; // HUD red vignette reads this
    if (world && world.audio) world.audio.hurt();
    super.takeDamage(amount, world, source);
  }

  die(world, source) {
    super.die(world, source);
    if (world && world.onPlayerDeath) world.onPlayerDeath(source);
  }
}
