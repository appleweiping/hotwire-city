// camera.js — follows a target through the world, provides world<->logical transforms.
// Logical viewport is always VIEW_W×VIEW_H; letterbox scaling lives in main.js/renderer.

import { VIEW_W, VIEW_H, WORLD_W, WORLD_H } from './config.js';
import { clamp, expFactor, lerp } from './utils.js';

const FOLLOW_RATE = 5;        // exponential follow speed
const DRIVE_LOOKAHEAD = 0.45; // seconds of velocity to look ahead while driving

export class Camera {
  constructor() {
    this.x = WORLD_W / 2;
    this.y = WORLD_H / 2;
  }

  snapTo(x, y) {
    this.x = x;
    this.y = y;
    this.#clamp();
  }

  // target: {x, y, vx?, vy?}; lookAhead true while driving
  follow(target, dt, lookAhead = false) {
    let tx = target.x, ty = target.y;
    if (lookAhead) {
      tx += (target.vx || 0) * DRIVE_LOOKAHEAD;
      ty += (target.vy || 0) * DRIVE_LOOKAHEAD;
    }
    const f = expFactor(FOLLOW_RATE, dt);
    this.x = lerp(this.x, tx, f);
    this.y = lerp(this.y, ty, f);
    this.#clamp();
  }

  #clamp() {
    this.x = clamp(this.x, VIEW_W / 2, WORLD_W - VIEW_W / 2);
    this.y = clamp(this.y, VIEW_H / 2, WORLD_H - VIEW_H / 2);
  }

  // World rect currently visible (for culling and chunk selection)
  getVisibleRect(margin = 0) {
    return {
      x: this.x - VIEW_W / 2 - margin,
      y: this.y - VIEW_H / 2 - margin,
      w: VIEW_W + margin * 2,
      h: VIEW_H + margin * 2,
    };
  }

  worldToLogical(wx, wy) {
    return { x: wx - this.x + VIEW_W / 2, y: wy - this.y + VIEW_H / 2 };
  }

  logicalToWorld(lx, ly) {
    return { x: lx + this.x - VIEW_W / 2, y: ly + this.y - VIEW_H / 2 };
  }
}
