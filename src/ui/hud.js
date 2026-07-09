// hud.js — screen-space overlay: minimap (pre-rendered base + live blips),
// wanted stars (pop on gain, blink while decaying), health bar, cash,
// weapon/ammo, contextual hints and the damage vignette.

import { T, TILE, MAP_W, MAP_H, VIEW_W, VIEW_H, COLORS, WEAPONS } from '../config.js';
import { clamp } from '../utils.js';

const MM_SIZE = 150;            // on-screen minimap square
const MM_SCALE = 2;             // px per tile in the base image
const MM_ZOOM = 2;              // magnification when blitting

export class Hud {
  constructor(map) {
    this.map = map;
    this.base = this.#bakeMinimapBase(map);
    this.prevStars = 0;
    this.popUntil = 0;           // wall-clock end of the star pop animation
    this.cashShown = null;       // cached formatted string
    this.cashText = '$0';
  }

  #bakeMinimapBase(map) {
    const c = document.createElement('canvas');
    c.width = MAP_W * MM_SCALE;
    c.height = MAP_H * MM_SCALE;
    const ctx = c.getContext('2d');
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = map.tileType(tx, ty);
        ctx.fillStyle =
          t === T.WATER ? '#27455c'
          : t === T.BUILDING ? '#33343a'
          : t === T.GRASS ? '#3d5a38'
          : t === T.SIDEWALK ? '#55565c'
          : '#8e8f94'; // roads pop bright
        ctx.fillRect(tx * MM_SCALE, ty * MM_SCALE, MM_SCALE, MM_SCALE);
      }
    }
    // landmarks
    for (const b of map.buildings) {
      if (b.kind === 'building') continue;
      ctx.fillStyle = b.kind === 'hospital' ? '#d05450' : '#4d7fc0';
      ctx.fillRect(b.tx * MM_SCALE, b.ty * MM_SCALE, b.tw * MM_SCALE, b.th * MM_SCALE);
    }
    return c;
  }

  render(ctx, game) {
    const p = game.player;
    if (!p) return;

    this.#vignette(ctx, p);
    this.#cash(ctx, game);
    this.#stars(ctx, game);
    this.#healthAndWeapon(ctx, p);
    this.#minimap(ctx, game, p);
    this.#hint(ctx, game);
  }

  #vignette(ctx, p) {
    const flash = Math.max(0, p.damageFlash || 0);
    const lowHp = p.alive && p.hp < 25
      ? 0.12 + Math.sin(performance.now() / 280) * 0.04
      : 0;
    const a = Math.min(0.5, flash * 1.2 + lowHp);
    if (a <= 0.01) return;
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.42, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.75);
    g.addColorStop(0, 'rgba(180,20,20,0)');
    g.addColorStop(1, `rgba(180,20,20,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  #cash(ctx, game) {
    if (this.cashShown !== game.money) {
      this.cashShown = game.money;
      this.cashText = '$' + Math.round(game.money).toLocaleString('en-US');
    }
    ctx.font = '700 26px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(this.cashText, 22, 40);
    ctx.fillStyle = COLORS.good;
    ctx.fillText(this.cashText, 20, 38);
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.fillStyle = COLORS.hudDim;
    ctx.fillText(`BEST $${Math.round(game.maxCash).toLocaleString('en-US')}`, 21, 56);
  }

  #stars(ctx, game) {
    const stars = game.wanted.stars;
    const now = performance.now();
    if (stars > this.prevStars) this.popUntil = now + 300;
    this.prevStars = stars;
    // wall-clock animation — render-frame decrements would run 2-4× fast on
    // high-refresh displays
    const popT = Math.max(0, this.popUntil - now) / 1000;

    const decayBlink = game.wanted.isDecaying() && Math.floor(now / 250) % 2 === 0;
    const size = 17;
    for (let i = 0; i < 5; i++) {
      const filled = i < stars;
      const x = VIEW_W - 24 - (4 - i) * (size + 8) - size / 2;
      const y = 34;
      const pop = filled && i === stars - 1 && popT > 0 ? 1 + popT * 1.6 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pop, pop);
      drawStar(ctx, 0, 0, 5, size / 2, size / 4.4);
      if (filled && !(decayBlink)) {
        ctx.fillStyle = COLORS.star;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (filled) {
        ctx.strokeStyle = COLORS.star; // blinking outline while decaying
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.strokeStyle = COLORS.starEmpty;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  #healthAndWeapon(ctx, p) {
    const x = 20, y = VIEW_H - 34, w = 130, h = 11;
    // weapon + ammo line
    const wp = WEAPONS[p.weapon];
    const ammo = wp.melee ? '' : `  ${p.ammo[p.weapon]}`;
    ctx.font = '700 14px "Segoe UI", sans-serif';
    ctx.fillStyle = COLORS.hudText;
    ctx.fillText(`${wp.name}${ammo}`, x, y - 8);

    // hp bar
    const frac = clamp(p.hp / p.maxHp, 0, 1);
    const blink = frac < 0.3 && Math.floor(performance.now() / 300) % 2 === 0;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = blink ? '#7d2018' : '#4a4a52';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = blink ? '#ff6a55' : COLORS.danger;
    ctx.fillRect(x, y, w * frac, h);
  }

  #minimap(ctx, game, p) {
    const x = VIEW_W - MM_SIZE - 18, y = VIEW_H - MM_SIZE - 18;

    // frame
    ctx.fillStyle = COLORS.minimapBg;
    ctx.fillRect(x - 4, y - 4, MM_SIZE + 8, MM_SIZE + 8);

    // window into the pre-rendered base, centred on the player
    const winSize = MM_SIZE / MM_ZOOM;                 // base px shown
    const px = (p.x / TILE) * MM_SCALE;
    const py = (p.y / TILE) * MM_SCALE;
    const sx = clamp(px - winSize / 2, 0, this.base.width - winSize);
    const sy = clamp(py - winSize / 2, 0, this.base.height - winSize);
    ctx.drawImage(this.base, sx, sy, winSize, winSize, x, y, MM_SIZE, MM_SIZE);

    const toMap = (wx, wy) => ({
      x: x + ((wx / TILE) * MM_SCALE - sx) * MM_ZOOM,
      y: y + ((wy / TILE) * MM_SCALE - sy) * MM_ZOOM,
    });
    const inside = (q) => q.x >= x + 2 && q.x <= x + MM_SIZE - 2 && q.y >= y + 2 && q.y <= y + MM_SIZE - 2;

    // police blips
    for (const e of game.entities) {
      if (e.kind === 'cop' && e.alive) {
        const q = toMap(e.x, e.y);
        if (!inside(q)) continue;
        ctx.fillStyle = '#5f9be8';
        ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      } else if (e.kind === 'vehicle' && e.driver && e.driver.police && !e.wrecked) {
        const q = toMap(e.x, e.y);
        if (!inside(q)) continue;
        ctx.fillStyle = '#7fb2f5';
        ctx.fillRect(q.x - 2.5, q.y - 2.5, 5, 5);
      }
    }

    // player triangle with heading
    const c = toMap(p.x, p.y);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  #hint(ctx, game) {
    const hint = game.currentHint;
    if (!hint) return;
    ctx.font = '600 16px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    const w = ctx.measureText(hint).width + 28;
    const x = VIEW_W / 2, y = VIEW_H - 64;
    ctx.fillStyle = 'rgba(10,10,14,0.65)';
    ctx.fillRect(x - w / 2, y - 20, w, 30);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(hint, x, y);
    ctx.textAlign = 'left';
  }
}

function drawStar(ctx, cx, cy, points, outer, inner) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
