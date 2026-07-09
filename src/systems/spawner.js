// spawner.js — population control: keeps pedestrians and traffic alive in an
// annulus around the player (spawn off-screen, recycle when far), enforcing
// hard entity budgets. Cops are requisitioned separately by the wanted system.

import { PED, TRAFFIC, TRAFFIC_MIX, TILE } from '../config.js';
import { makeRng, rngWeighted, dist } from '../utils.js';
import { Pedestrian } from '../entities/pedestrian.js';
import { Vehicle } from '../entities/vehicle.js';
import { TrafficBrain } from './traffic.js';

export class Spawner {
  constructor() {
    this.rng = makeRng((Math.random() * 0xffffffff) >>> 0); // variety per session
    this.checkTimer = 0;
  }

  update(dt, world) {
    this.checkTimer -= dt;
    if (this.checkTimer > 0) return;
    this.checkTimer = 0.5;

    const p = world.player;
    if (!p) return;

    this.#recycle(world, p);

    let peds = 0, cars = 0;
    for (const e of world.entities) {
      if (e.kind === 'pedestrian' && e.alive) peds++;
      else if (e.kind === 'vehicle' && e.driver && e.driver.kind === 'ai') cars++;
    }

    // high wanted levels trim the ped budget first (global entity budget)
    const stars = world.wantedStars ? world.wantedStars() : 0;
    const pedCap = stars >= 4 ? Math.floor(PED.CAP * 0.6) : PED.CAP;

    if (peds < pedCap) this.#spawnPed(world, p);
    if (cars < TRAFFIC.CAP) this.#spawnCar(world, p);
  }

  #recycle(world, p) {
    for (const e of world.entities) {
      if (e.kind === 'pedestrian') {
        if (dist(e.x, e.y, p.x, p.y) > PED.DESPAWN_DIST) e.remove = true;
      } else if (e.kind === 'vehicle' && !e.persistent && e !== p.vehicle) {
        // AI traffic and abandoned (jacked) cars recycle far away; the 45
        // seeded parked cars are permanent world furniture
        if (dist(e.x, e.y, p.x, p.y) > TRAFFIC.DESPAWN_DIST) e.remove = true;
      }
    }
  }

  #spawnPed(world, p) {
    const spot = world.map.randomSidewalkPointNear(this.rng, p.x, p.y, PED.SPAWN_RING[0], PED.SPAWN_RING[1]);
    if (!spot) return;
    world.addEntity(new Pedestrian(spot.x, spot.y));
  }

  #spawnCar(world, p) {
    const spot = world.map.randomRoadPointNear(this.rng, p.x, p.y, TRAFFIC.SPAWN_RING[0], TRAFFIC.SPAWN_RING[1]);
    if (!spot) return;
    const lane = world.map.laneInfoAt(spot.x, spot.y);
    if (!lane || !lane.dir) return;

    // snap onto the lane centerline, aligned with legal flow
    let x = spot.x, y = spot.y, angle;
    if (lane.axis === 'v') { x = lane.laneCenter; angle = lane.dir.y > 0 ? Math.PI / 2 : -Math.PI / 2; }
    else { y = lane.laneCenter; angle = lane.dir.x > 0 ? 0 : Math.PI; }

    // don't spawn into another car
    for (const e of world.entities) {
      if (e.kind === 'vehicle' && dist(e.x, e.y, x, y) < 90) return;
    }

    const v = new Vehicle(x, y, rngWeighted(this.rng, TRAFFIC_MIX));
    v.angle = angle;
    v.vx = Math.cos(angle) * TRAFFIC.CRUISE_SPEED * 0.6;
    v.vy = Math.sin(angle) * TRAFFIC.CRUISE_SPEED * 0.6;
    v.driver = new TrafficBrain();
    world.addEntity(v);
  }
}
