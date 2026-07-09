// input.js — keyboard + mouse state with per-tick edge detection.
// Game code queries semantic actions, never physical key codes.

const KEYMAP = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  handbrake: ['Space'],
  interact: ['KeyE', 'Enter'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  cycleWeapon: ['KeyQ'],
  pause: ['Escape', 'KeyP'],
  mute: ['KeyM'],
  any: [], // special: matches any key (used by the menu)
};

class Input {
  constructor() {
    this.held = new Set();
    this.pressedThisTick = new Set();
    this.anyPressed = false;
    // Mouse position in *client* pixels; main.js converts to logical coords.
    this.mouseClientX = 0;
    this.mouseClientY = 0;
    this.mouseLogicalX = 640;
    this.mouseLogicalY = 360;
    this.mouseDown = false;
    this.mouseClicked = false; // edge, cleared per tick
  }

  attach(canvas) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.held.add(e.code);
      this.pressedThisTick.add(e.code);
      this.anyPressed = true;
      // Keep the browser from scrolling / triggering shortcuts on game keys
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => {
      // alt-tab safety: no stuck movement keys or auto-fire
      this.held.clear();
      this.mouseDown = false;
      this.mouseClicked = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      this.mouseClientX = e.clientX;
      this.mouseClientY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      // note: mouse does NOT set anyPressed — "press any key" means keyboard,
      // so a held trigger can't unpause the game and instantly fire
      if (e.button === 0) { this.mouseDown = true; this.mouseClicked = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(action) {
    const keys = KEYMAP[action];
    for (let i = 0; i < keys.length; i++) if (this.held.has(keys[i])) return true;
    return false;
  }

  wasPressed(action) {
    if (action === 'any') return this.anyPressed;
    const keys = KEYMAP[action];
    for (let i = 0; i < keys.length; i++) if (this.pressedThisTick.has(keys[i])) return true;
    return false;
  }

  // Movement as a normalized vector (walking) or per-axis (driving)
  moveVector() {
    let x = 0, y = 0;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('up')) y -= 1;
    if (this.isDown('down')) y += 1;
    if (x !== 0 && y !== 0) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  // Called by game.js at the END of each fixed tick so every edge event
  // is consumed by exactly one simulation step.
  endTick() {
    this.pressedThisTick.clear();
    this.mouseClicked = false;
    this.anyPressed = false;
  }
}

export const input = new Input();
