// renderer.js — render pipeline: letterbox viewport, camera transform,
// layered world drawing, then screen-space overlays.
// Milestone 1 draws a placeholder ground; the chunked city map replaces it next.

import { VIEW_W, VIEW_H, WORLD_W, WORLD_H, COLORS } from './config.js';

export class Renderer {
  constructor(ctx, viewport) {
    this.ctx = ctx;
    this.viewport = viewport; // { scale, offX, offY, dpr } maintained by main.js
  }

  render(game) {
    const ctx = this.ctx;
    const vp = this.viewport;
    const canvas = ctx.canvas;

    // 1) letterbox bars fill the whole backing store
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.letterbox;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2) logical space: translate to letterbox origin, scale to fit
    const s = vp.scale * vp.dpr;
    ctx.setTransform(s, 0, 0, s, vp.offX * vp.dpr, vp.offY * vp.dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip(); // world never bleeds into the bars

    // 3) world space: camera translate
    const cam = game.camera;
    ctx.save();
    ctx.translate(Math.round(VIEW_W / 2 - cam.x), Math.round(VIEW_H / 2 - cam.y));

    this.renderGround(ctx, game);

    // entity layer
    for (let i = 0; i < game.entities.length; i++) {
      game.entities[i].render(ctx, game);
    }

    ctx.restore(); // back to logical space

    // 4) screen-space overlay for the current top-level state (menus etc.)
    game.state.renderOverlay(ctx);

    ctx.restore(); // drop the clip
  }

  // Placeholder ground until the city map lands: flat color + soft grid so
  // camera movement is visible.
  renderGround(ctx, game) {
    ctx.fillStyle = '#565a5e';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const step = 128;
    const view = game.camera.getVisibleRect(step);
    const x0 = Math.max(0, Math.floor(view.x / step) * step);
    const x1 = Math.min(WORLD_W, view.x + view.w);
    const y0 = Math.max(0, Math.floor(view.y / step) * step);
    const y1 = Math.min(WORLD_H, view.y + view.h);
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }
}
