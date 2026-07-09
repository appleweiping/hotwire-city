// audio.js — zero-asset procedural sound: oscillators, filtered noise and
// gain envelopes. The AudioContext unlocks on the first user gesture (the
// menu keypress). M toggles mute; the preference persists in localStorage.

import { SAVE_KEY } from './config.js';

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.engine = null;         // persistent engine voice while driving
    this.siren = null;          // persistent two-tone siren voice
    this.noiseBuf = null;
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      this.muted = !!saved.muted;
    } catch { /* fresh start */ }
  }

  // Must be called from a user-gesture code path.
  unlock() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.ctx.resume();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);

    // shared 1s white-noise buffer
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.#buildEngine();
    this.#buildSiren();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  // --- one-shot helpers ---

  #env(peak, decay, dest = this.master) {
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    g.connect(dest);
    return g;
  }

  #noise(peak, decay, filterFreq, filterType = 'lowpass') {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const g = this.#env(peak, decay);
    src.connect(filter).connect(g);
    src.start();
    src.stop(this.ctx.currentTime + decay + 0.05);
  }

  #tone(type, f0, f1, peak, decay) {
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + decay);
    const g = this.#env(peak, decay);
    o.connect(g);
    o.start();
    o.stop(t + decay + 0.05);
  }

  // --- public one-shots (all safe to call before unlock) ---

  shoot(weapon) {
    if (!this.ctx) return;
    if (weapon === 'fist') { this.#noise(0.12, 0.08, 500, 'bandpass'); return; }
    if (weapon === 'smg') {
      this.#noise(0.16, 0.07, 2400, 'highpass');
      this.#tone('square', 500, 120, 0.1, 0.06);
    } else { // pistol & cop pistol
      this.#noise(0.22, 0.1, 1800, 'highpass');
      this.#tone('square', 750, 140, 0.14, 0.09);
    }
  }

  explosion() {
    if (!this.ctx) return;
    this.#noise(0.6, 0.7, 400);
    this.#tone('sine', 120, 30, 0.5, 0.6);
  }

  crash(strength = 1) {
    if (!this.ctx) return;
    this.#noise(0.25 * strength, 0.18, 900);
    this.#tone('square', 180, 60, 0.08 * strength, 0.12);
  }

  pickup() {
    if (!this.ctx) return;
    this.#tone('sine', 660, 660, 0.12, 0.07);
    setTimeout(() => this.ctx && this.#tone('sine', 990, 990, 0.12, 0.09), 70);
  }

  hurt() {
    if (!this.ctx) return;
    this.#noise(0.18, 0.12, 700, 'bandpass');
  }

  // --- persistent voices ---

  #buildEngine() {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 60;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    o.connect(filter).connect(g).connect(this.master);
    o.start();
    this.engine = { osc: o, gain: g, filter };
  }

  #buildSiren() {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 660;
    const lfo = this.ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 1.6;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 110;                     // 660 ± 110 Hz two-tone
    lfo.connect(lfoGain).connect(o.frequency);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(this.master);
    o.start();
    lfo.start();
    this.siren = { gain: g };
  }

  // Called every render frame with live game state.
  update(game) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;

    // persistent voices are silent outside active play (pause, menus, death cam)
    const active = game.stateName === 'playing';

    // engine follows the player's car
    const p = game.player;
    const driving = active && p && p.driving && p.vehicle && !p.vehicle.wrecked;
    const eg = this.engine.gain.gain;
    if (driving) {
      const speed = p.vehicle.speed();
      this.engine.osc.frequency.setTargetAtTime(55 + speed * 0.45, t, 0.08);
      this.engine.filter.frequency.setTargetAtTime(300 + speed * 3, t, 0.1);
      eg.setTargetAtTime(0.05 + Math.min(speed / 340, 1) * 0.06, t, 0.1);
    } else {
      eg.setTargetAtTime(0, t, 0.15);
    }

    // siren audible when any lit-up police car is near
    let sirenNear = false;
    if (p && active) {
      for (const e of game.entities) {
        if (e.kind === 'vehicle' && e.sirenOn && !e.wrecked) {
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy < 700 * 700) { sirenNear = true; break; }
        }
      }
    }
    this.siren.gain.gain.setTargetAtTime(sirenNear ? 0.045 : 0, t, 0.25);
  }
}
