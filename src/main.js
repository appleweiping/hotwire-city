// main.js — entry point: canvas setup, letterbox viewport math, touch gate,
// input attachment, and game boot.

import { VIEW_W, VIEW_H } from './config.js';
import { input } from './input.js';
import { Game } from './game.js';

// Touch-only devices get a friendly notice instead of an unplayable game.
const touchOnly = window.matchMedia('(pointer: coarse)').matches
  && !window.matchMedia('(any-pointer: fine)').matches;

if (touchOnly) {
  document.body.classList.add('touch-only');
} else {
  boot();
}

function boot() {
  const canvas = document.getElementById('game');
  const viewport = { scale: 1, offX: 0, offY: 0, dpr: 1 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';

    // Aspect-fit: the 1280×720 logical viewport scales uniformly, letterboxed.
    viewport.scale = Math.min(cw / VIEW_W, ch / VIEW_H);
    viewport.offX = (cw - VIEW_W * viewport.scale) / 2;
    viewport.offY = (ch - VIEW_H * viewport.scale) / 2;
    viewport.dpr = dpr;
  }
  window.addEventListener('resize', resize);
  resize();

  input.attach(canvas);

  const game = new Game(canvas, viewport);

  // Keep the logical mouse position current every frame (client → logical).
  function trackMouse() {
    input.mouseLogicalX = (input.mouseClientX - viewport.offX) / viewport.scale;
    input.mouseLogicalY = (input.mouseClientY - viewport.offY) / viewport.scale;
    requestAnimationFrame(trackMouse);
  }
  requestAnimationFrame(trackMouse);

  // Auto-pause when the tab goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.stateName === 'playing') game.setState('paused');
  });

  game.start();

  // Expose for debugging / automated smoke tests (not part of the public API).
  window.__game = game;
}
