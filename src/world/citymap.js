// citymap.js — procedural city: tile grid, buildings, parks, landmarks,
// and every spatial query the rest of the game needs.
//
// Layout (92×92 tiles): 2-tile water ring, 4-tile perimeter ring road,
// then a 7×7 grid of 8-tile blocks separated by 4-tile road bands.
// Right-hand traffic; lane centerlines sit ±32px from each band's center.

import { T, TILE, MAP_W, MAP_H, CITY, MAP_SEED, PALETTE } from '../config.js';
import { makeRng, rngInt, rngPick } from '../utils.js';

const ROAD_START = 2;                 // first road tile after the water ring
const PERIOD = CITY.BLOCK_PERIOD;     // 12
const LANES = CITY.ROAD_LANES;        // 4

const isRoadCoord = (t) => t >= ROAD_START && t <= MAP_W - 3 && (t - ROAD_START) % PERIOD < LANES;

export class CityMap {
  constructor(seed = MAP_SEED) {
    this.w = MAP_W;
    this.h = MAP_H;
    this.tiles = new Uint8Array(this.w * this.h);
    this.buildings = [];   // {tx, ty, tw, th, color, kind:'building'|'hospital'|'police', details:[]}
    this.trees = [];       // {x, y, r} world px, decorative only
    this.sidewalks = [];   // tile coords, for spawn/pickup placement
    this.roadTiles = [];   // tile coords of plain road (not cross), for traffic spawns

    const rng = makeRng(seed);
    this.#classifyTiles();
    this.#buildBlocks(rng);
    this.#collectSpawnTiles();
    this.#placeLandmarks();
  }

  // ---- generation ---------------------------------------------------------

  #classifyTiles() {
    for (let ty = 0; ty < this.h; ty++) {
      for (let tx = 0; tx < this.w; tx++) {
        let t;
        if (tx < 2 || ty < 2 || tx >= this.w - 2 || ty >= this.h - 2) {
          t = T.WATER;
        } else {
          const rx = isRoadCoord(tx), ry = isRoadCoord(ty);
          if (rx && ry) t = T.ROAD_CROSS;
          else if (rx) t = T.ROAD_V;
          else if (ry) t = T.ROAD_H;
          else t = T.SIDEWALK; // provisional; block interiors are refined below
        }
        this.tiles[ty * this.w + tx] = t;
      }
    }
  }

  #buildBlocks(rng) {
    // Block origins: first block starts after the perimeter road band.
    for (let by = ROAD_START + LANES; by + 8 <= this.h - 2; by += PERIOD) {
      for (let bx = ROAD_START + LANES; bx + 8 <= this.w - 2; bx += PERIOD) {
        this.#fillBlock(rng, bx, by);
      }
    }
  }

  // A block is 8×8: 1-tile sidewalk ring + 6×6 interior.
  #fillBlock(rng, bx, by) {
    const park = rng() < CITY.PARK_CHANCE;
    const ix = bx + 1, iy = by + 1, is = 6; // interior origin/size

    if (park) {
      for (let y = iy; y < iy + is; y++)
        for (let x = ix; x < ix + is; x++)
          this.tiles[y * this.w + x] = T.GRASS;
      const treeCount = rngInt(rng, 4, 8);
      for (let i = 0; i < treeCount; i++) {
        this.trees.push({
          x: (ix + rng() * is) * TILE,
          y: (iy + rng() * is) * TILE,
          r: 8 + rng() * 6,
        });
      }
      return;
    }

    // Recursive binary split of the interior into 1–4 building footprints.
    const rects = [];
    const split = (x, y, w, h, depth) => {
      const canSplitW = w >= 5, canSplitH = h >= 5;
      if (depth >= 2 || (!canSplitW && !canSplitH) || rng() < 0.3) {
        rects.push({ x, y, w, h });
        return;
      }
      if (canSplitW && (!canSplitH || w >= h)) {
        const cut = rngInt(rng, 2, w - 3); // both sides ≥2 wide, 1-tile alley
        split(x, y, cut, h, depth + 1);
        split(x + cut + 1, y, w - cut - 1, h, depth + 1);
      } else {
        const cut = rngInt(rng, 2, h - 3);
        split(x, y, w, cut, depth + 1);
        split(x, y + cut + 1, w, h - cut - 1, depth + 1);
      }
    };
    split(ix, iy, is, is, 0);

    // Interior defaults to grass (alleys/courtyards), buildings stamp over it.
    for (let y = iy; y < iy + is; y++)
      for (let x = ix; x < ix + is; x++)
        this.tiles[y * this.w + x] = T.GRASS;

    for (const r of rects) {
      // Occasionally inset one axis for variety
      if (r.w > 2 && rng() < 0.3) r.w -= 1;
      if (r.h > 2 && rng() < 0.3) r.h -= 1;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++)
          this.tiles[y * this.w + x] = T.BUILDING;

      const details = [];
      const detailCount = rngInt(rng, 0, 3);
      for (let i = 0; i < detailCount; i++) {
        details.push({
          kind: rngPick(rng, ['ac', 'skylight', 'vent']),
          fx: 0.15 + rng() * 0.6,  // fractional position on the roof
          fy: 0.15 + rng() * 0.6,
        });
      }
      this.buildings.push({
        tx: r.x, ty: r.y, tw: r.w, th: r.h,
        color: rngPick(rng, PALETTE.buildings),
        kind: 'building',
        details,
      });
    }

    // A few trees in leftover courtyard grass
    for (let y = iy; y < iy + is; y++)
      for (let x = ix; x < ix + is; x++)
        if (this.tiles[y * this.w + x] === T.GRASS && rng() < 0.12)
          this.trees.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, r: 7 + rng() * 4 });
  }

  // Hospital and police station: overwrite two fixed central-ish blocks with
  // a single landmark building each. Doors face south onto the sidewalk.
  #placeLandmarks() {
    const blockOrigin = (i, j) => ({ bx: ROAD_START + LANES + i * PERIOD, by: ROAD_START + LANES + j * PERIOD });

    const stamp = (i, j, kind, color) => {
      const { bx, by } = blockOrigin(i, j);
      const ix = bx + 1, iy = by + 1, is = 6;
      // Clear any generated content in this block interior
      this.buildings = this.buildings.filter(b => !(b.tx >= ix && b.tx < ix + is && b.ty >= iy && b.ty < iy + is));
      this.trees = this.trees.filter(t => {
        const tx = t.x / TILE, ty = t.y / TILE;
        return !(tx >= ix && tx < ix + is && ty >= iy && ty < iy + is);
      });
      for (let y = iy; y < iy + is; y++)
        for (let x = ix; x < ix + is; x++)
          this.tiles[y * this.w + x] = T.BUILDING;
      this.buildings.push({ tx: ix, ty: iy, tw: is, th: is, color, kind, details: [] });
      // Door point: middle of the south sidewalk ring
      return { x: (ix + is / 2) * TILE, y: (iy + is + 0.5) * TILE };
    };

    this.hospitalDoor = stamp(2, 3, 'hospital', PALETTE.hospital);
    this.policeDoor = stamp(4, 3, 'police', PALETTE.police);

    // Player spawn: sidewalk south of the center block (3,3)
    const c = blockOrigin(3, 3);
    this.playerSpawn = { x: (c.bx + 4) * TILE, y: (c.by + 7.5) * TILE };
  }

  #collectSpawnTiles() {
    for (let ty = 2; ty < this.h - 2; ty++) {
      for (let tx = 2; tx < this.w - 2; tx++) {
        const t = this.tiles[ty * this.w + tx];
        if (t === T.SIDEWALK) this.sidewalks.push({ tx, ty });
        else if (t === T.ROAD_H || t === T.ROAD_V) this.roadTiles.push({ tx, ty });
      }
    }
  }

  // ---- queries ------------------------------------------------------------

  tileType(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return T.WATER;
    return this.tiles[ty * this.w + tx];
  }

  tileAtWorld(wx, wy) {
    return this.tileType(Math.floor(wx / TILE), Math.floor(wy / TILE));
  }

  isSolidAt(wx, wy) {
    return this.tileAtWorld(wx, wy) === T.BUILDING;
  }

  isWaterAt(wx, wy) {
    return this.tileAtWorld(wx, wy) === T.WATER;
  }

  isRoadAt(wx, wy) {
    const t = this.tileAtWorld(wx, wy);
    return t === T.ROAD_H || t === T.ROAD_V || t === T.ROAD_CROSS;
  }

  // Walkable for pedestrians (not solid, not water)
  isWalkableTile(tx, ty) {
    const t = this.tileType(tx, ty);
    return t !== T.BUILDING && t !== T.WATER;
  }

  // Off-road surface slows cars down
  isOffroadAt(wx, wy) {
    const t = this.tileAtWorld(wx, wy);
    return t === T.SIDEWALK || t === T.GRASS;
  }

  // Which road band does this tile coordinate sit in? Returns band start tile.
  static bandStart(t) {
    return t - ((t - ROAD_START) % PERIOD);
  }

  // Lane info for traffic AI. Given a world position on a road, returns the
  // legal driving direction and the lane centerline coordinate.
  // Right-hand traffic:
  //   vertical band  → west half drives +y (south), east half drives -y (north)
  //   horizontal band→ north half drives -x (west), south half drives +x (east)
  laneInfoAt(wx, wy) {
    const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
    const t = this.tileType(tx, ty);
    if (t === T.ROAD_V) {
      const b = CityMap.bandStart(tx);
      const westHalf = tx < b + 2;
      return {
        dir: westHalf ? { x: 0, y: 1 } : { x: 0, y: -1 },
        laneCenter: westHalf ? (b + 1) * TILE : (b + 3) * TILE, // x coordinate
        axis: 'v',
      };
    }
    if (t === T.ROAD_H) {
      const b = CityMap.bandStart(ty);
      const northHalf = ty < b + 2;
      return {
        dir: northHalf ? { x: -1, y: 0 } : { x: 1, y: 0 },
        laneCenter: northHalf ? (b + 1) * TILE : (b + 3) * TILE, // y coordinate
        axis: 'h',
      };
    }
    if (t === T.ROAD_CROSS) return { dir: null, laneCenter: 0, axis: 'x' };
    return null;
  }

  // Random plain-road tile inside a world-space annulus around (cx, cy).
  randomRoadPointNear(rng, cx, cy, rMin, rMax, tries = 24) {
    for (let i = 0; i < tries; i++) {
      const p = this.roadTiles[Math.floor(rng() * this.roadTiles.length)];
      const wx = (p.tx + 0.5) * TILE, wy = (p.ty + 0.5) * TILE;
      const d2 = (wx - cx) ** 2 + (wy - cy) ** 2;
      if (d2 >= rMin * rMin && d2 <= rMax * rMax) return { x: wx, y: wy };
    }
    return null;
  }

  randomSidewalkPointNear(rng, cx, cy, rMin, rMax, tries = 24) {
    for (let i = 0; i < tries; i++) {
      const p = this.sidewalks[Math.floor(rng() * this.sidewalks.length)];
      const wx = (p.tx + 0.5) * TILE, wy = (p.ty + 0.5) * TILE;
      const d2 = (wx - cx) ** 2 + (wy - cy) ** 2;
      if (d2 >= rMin * rMin && d2 <= rMax * rMax) return { x: wx, y: wy };
    }
    return null;
  }

  // Tile-grid DDA raycast: does the segment hit a BUILDING tile?
  // Used for line-of-sight checks. Returns true if blocked.
  losBlocked(x0, y0, x1, y1) {
    let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
    const tx1 = Math.floor(x1 / TILE), ty1 = Math.floor(y1 / TILE);
    const dx = x1 - x0, dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
    let tMaxX = dx !== 0
      ? ((dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx))
      : Infinity;
    let tMaxY = dy !== 0
      ? ((dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy))
      : Infinity;

    for (let guard = 0; guard < 256; guard++) {
      if (this.tileType(tx, ty) === T.BUILDING) return true;
      if (tx === tx1 && ty === ty1) return false;
      if (tMaxX < tMaxY) { tMaxX += tDeltaX; tx += stepX; }
      else { tMaxY += tDeltaY; ty += stepY; }
    }
    return true; // overly long ray — treat as blocked
  }

  // First building hit along a ray (for hitscan). Returns distance or Infinity.
  raycastSolid(x0, y0, angle, maxDist) {
    const step = TILE / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let d = 0; d <= maxDist; d += step) {
      if (this.isSolidAt(x0 + cos * d, y0 + sin * d)) {
        // refine backwards for a tighter hit point
        for (let dd = d - step; dd < d; dd += 4) {
          if (this.isSolidAt(x0 + cos * dd, y0 + sin * dd)) return Math.max(0, dd);
        }
        return d;
      }
    }
    return Infinity;
  }
}
