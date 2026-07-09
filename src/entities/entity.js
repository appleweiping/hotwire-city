// entity.js — flat base class for everything that lives in the world.
// Subclasses stay two levels deep max: Entity → Player/Vehicle/Pedestrian/Cop.

let nextId = 1;

export class Entity {
  constructor(x, y) {
    this.id = nextId++;
    this.kind = 'entity';
    this.x = x;
    this.y = y;
    this.prevX = x;        // reserved for future render interpolation
    this.prevY = y;
    this.angle = 0;        // facing, radians (0 = +x)
    this.vx = 0;
    this.vy = 0;
    this.radius = 8;
    this.hp = 1;
    this.maxHp = 1;
    this.alive = true;
    this.solid = true;     // participates in entity-entity collision
    this.static = false;   // never moves (wrecks)
  }

  speed() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }

  /* eslint-disable no-unused-vars */
  update(dt, world) {}
  render(ctx, world) {}
  /* eslint-enable no-unused-vars */

  // damage source kinds let scoring/wanted attribute blame correctly
  takeDamage(amount, world, source = null) {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(world, source);
    }
  }

  die(world, source) {
    this.alive = false;
  }
}
