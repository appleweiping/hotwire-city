// renderer.js — render pipeline: letterbox viewport, camera transform,
// chunked static ground cache, layered world drawing, screen-space overlays.

import { T, TILE, VIEW_W, VIEW_H, MAP_W, MAP_H, COLORS, PALETTE, CITY } from './config.js';
import { clamp } from './utils.js';
import { CityMap } from './world/citymap.js';

const CHUNK_TILES = 16;               // 16×16 tiles = 512×512 world px per chunk
const CHUNK_PX = CHUNK_TILES * TILE;

// Deterministic per-tile hash for stable decorative noise across rebakes.
const tileHash = (tx, ty) => ((tx * 7349 + ty * 9151) % 1024) / 1024;

export class Renderer {
  constructor(ctx, viewport) {
    this.ctx = ctx;
    this.viewport = viewport;         // { scale, offX, offY, dpr } maintained by main.js
    this.map = null;
    this.chunks = new Map();          // "cx,cy" → canvas
    this.bakeScale = 1;
    this.decals = [];                 // {x,y,kind,angle,size,color} replayed on rebake
    this.decalCap = 500;
  }

  setMap(map) {
    this.map = map;
    this.chunks.clear();
  }

  // Permanent ground marks (blood, skids) are baked straight into the chunk
  // canvases — zero per-frame cost. A capped list replays them on rebake.
  addDecal(decal) {
    if (this.decals.length >= this.decalCap) this.decals.shift();
    this.decals.push(decal);
    const canvas = this.chunks.get(this.#chunkKey(decal.x, decal.y));
    if (canvas) this.#paintDecal(canvas.getContext('2d'), decal, true);
  }

  #chunkKey(wx, wy) {
    return Math.floor(wx / CHUNK_PX) + ',' + Math.floor(wy / CHUNK_PX);
  }

  render(game) {
    const ctx = this.ctx;
    const vp = this.viewport;
    const canvas = ctx.canvas;

    // Rebake chunks if the effective scale changed materially (resize)
    const wanted = clamp(Math.round(vp.scale * vp.dpr * 4) / 4, 0.5, 2.5);
    if (wanted !== this.bakeScale) {
      this.bakeScale = wanted;
      this.chunks.clear();
    }

    // 1) letterbox bars
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.letterbox;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2) logical space + clip
    const s = vp.scale * vp.dpr;
    ctx.setTransform(s, 0, 0, s, vp.offX * vp.dpr, vp.offY * vp.dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();

    // 3) world space (camera + screen shake later)
    const cam = game.camera;
    const shake = game.getShakeOffset ? game.getShakeOffset() : { x: 0, y: 0 };
    ctx.save();
    ctx.translate(VIEW_W / 2 - cam.x + shake.x, VIEW_H / 2 - cam.y + shake.y);

    this.#renderGround(ctx, cam);

    // entity layer: vehicles under people (a person is drawn "on" a car),
    // player last so it is never hidden.
    const view = cam.getVisibleRect(80);
    const ents = game.entities;
    for (const pass of RENDER_PASSES) {
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (e.kind !== pass || e === game.player) continue;
        if (e.x < view.x || e.x > view.x + view.w || e.y < view.y || e.y > view.y + view.h) continue;
        e.render(ctx, game);
      }
    }
    if (game.player) game.player.render(ctx, game);

    if (game.renderWorldFx) game.renderWorldFx(ctx); // particles, tracers (m4)

    ctx.restore(); // back to logical space

    // 4) screen-space: HUD (m7) then state overlay
    if (game.renderHud) game.renderHud(ctx);
    game.state.renderOverlay(ctx);

    ctx.restore(); // drop clip
  }

  #renderGround(ctx, cam) {
    const view = cam.getVisibleRect();
    const cx0 = Math.max(0, Math.floor(view.x / CHUNK_PX));
    const cy0 = Math.max(0, Math.floor(view.y / CHUNK_PX));
    const cx1 = Math.min(Math.ceil(MAP_W * TILE / CHUNK_PX) - 1, Math.floor((view.x + view.w) / CHUNK_PX));
    const cy1 = Math.min(Math.ceil(MAP_H * TILE / CHUNK_PX) - 1, Math.floor((view.y + view.h) / CHUNK_PX));

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx + ',' + cy;
        let chunk = this.chunks.get(key);
        if (!chunk) {
          chunk = this.#bakeChunk(cx, cy);
          this.chunks.set(key, chunk);
        }
        ctx.drawImage(chunk, cx * CHUNK_PX, cy * CHUNK_PX, CHUNK_PX, CHUNK_PX);
      }
    }
  }

  // ---- chunk baking --------------------------------------------------------

  #bakeChunk(cx, cy) {
    const S = this.bakeScale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(CHUNK_PX * S);
    canvas.height = Math.ceil(CHUNK_PX * S);
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.translate(-cx * CHUNK_PX, -cy * CHUNK_PX); // draw in world coordinates

    const map = this.map;
    const tx0 = cx * CHUNK_TILES, ty0 = cy * CHUNK_TILES;
    const tx1 = Math.min(MAP_W - 1, tx0 + CHUNK_TILES - 1);
    const ty1 = Math.min(MAP_H - 1, ty0 + CHUNK_TILES - 1);

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        this.#bakeTile(ctx, map, tx, ty);
      }
    }

    // buildings whose rect touches this chunk
    const px0 = tx0 * TILE, py0 = ty0 * TILE, px1 = (tx1 + 1) * TILE, py1 = (ty1 + 1) * TILE;
    for (const b of map.buildings) {
      const bx = b.tx * TILE, by = b.ty * TILE, bw = b.tw * TILE, bh = b.th * TILE;
      if (bx + bw < px0 || bx > px1 || by + bh < py0 || by > py1) continue;
      this.#bakeBuilding(ctx, b, bx, by, bw, bh);
    }

    // trees in range
    for (const t of map.trees) {
      if (t.x < px0 - 20 || t.x > px1 + 20 || t.y < py0 - 20 || t.y > py1 + 20) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(t.x + 2, t.y + 3, t.r, t.r * 0.85, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4c7042';
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5d8551';
      ctx.beginPath(); ctx.arc(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.6, 0, Math.PI * 2); ctx.fill();
    }

    // replay permanent decals that live in this chunk
    for (const d of this.decals) {
      if (d.x >= px0 && d.x < px1 && d.y >= py0 && d.y < py1) this.#paintDecal(ctx, d);
    }

    return canvas;
  }

  #bakeTile(ctx, map, tx, ty) {
    const t = map.tileType(tx, ty);
    const x = tx * TILE, y = ty * TILE;

    switch (t) {
      case T.ROAD_H:
      case T.ROAD_V:
      case T.ROAD_CROSS: {
        ctx.fillStyle = PALETTE.road;
        ctx.fillRect(x, y, TILE, TILE);
        // subtle asphalt variation
        if (tileHash(tx, ty) > 0.8) {
          ctx.fillStyle = 'rgba(255,255,255,0.02)';
          ctx.fillRect(x, y, TILE, TILE);
        }
        // dashed center line between the two directions of each band
        const inBandX = (tx - 2) % CITY.BLOCK_PERIOD;
        const inBandY = (ty - 2) % CITY.BLOCK_PERIOD;
        ctx.fillStyle = PALETTE.roadLine;
        if (t === T.ROAD_V && inBandX === 1) {
          ctx.fillRect(x + TILE - 1.5, y + 4, 3, 12); // two dashes per tile
          // second dash straddles tile edge; the next tile draws its own
        } else if (t === T.ROAD_H && inBandY === 1) {
          ctx.fillRect(x + 4, y + TILE - 1.5, 12, 3);
        }
        break;
      }
      case T.SIDEWALK: {
        ctx.fillStyle = PALETTE.sidewalk;
        ctx.fillRect(x, y, TILE, TILE);
        // pavement seams
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
        // curb edge against any road neighbour
        ctx.fillStyle = PALETTE.sidewalkEdge;
        const road = (ttx, tty) => {
          const n = map.tileType(ttx, tty);
          return n === T.ROAD_H || n === T.ROAD_V || n === T.ROAD_CROSS;
        };
        if (road(tx, ty - 1)) ctx.fillRect(x, y, TILE, 2);
        if (road(tx, ty + 1)) ctx.fillRect(x, y + TILE - 2, TILE, 2);
        if (road(tx - 1, ty)) ctx.fillRect(x, y, 2, TILE);
        if (road(tx + 1, ty)) ctx.fillRect(x + TILE - 2, y, 2, TILE);
        break;
      }
      case T.GRASS: {
        ctx.fillStyle = PALETTE.grass;
        ctx.fillRect(x, y, TILE, TILE);
        const h = tileHash(tx, ty);
        if (h > 0.6) {
          ctx.fillStyle = 'rgba(255,255,240,0.06)';
          ctx.fillRect(x + h * 20, y + (1 - h) * 20, 6, 6);
        }
        break;
      }
      case T.WATER: {
        ctx.fillStyle = PALETTE.water;
        ctx.fillRect(x, y, TILE, TILE);
        // lighter shoreline against land
        const land = (ttx, tty) => {
          const n = map.tileType(ttx, tty);
          return n !== T.WATER;
        };
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        if (land(tx, ty - 1)) ctx.fillRect(x, y, TILE, 3);
        if (land(tx, ty + 1)) ctx.fillRect(x, y + TILE - 3, TILE, 3);
        if (land(tx - 1, ty)) ctx.fillRect(x, y, 3, TILE);
        if (land(tx + 1, ty)) ctx.fillRect(x + TILE - 3, y, 3, TILE);
        // gentle deep-water banding
        if ((tx + ty) % 5 === 0) {
          ctx.fillStyle = PALETTE.waterDeep;
          ctx.fillRect(x + 6, y + 14, 14, 2);
        }
        break;
      }
      case T.BUILDING: {
        // base under the building rect (visible only if a building insets)
        ctx.fillStyle = PALETTE.grass;
        ctx.fillRect(x, y, TILE, TILE);
        break;
      }
    }
  }

  #bakeBuilding(ctx, b, x, y, w, h) {
    // drop shadow (fake depth, sun from top-left)
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + 4, y + 5, w, h);

    // walls (slightly darker rim) then roof
    ctx.fillStyle = shade(b.color, 0.62);
    ctx.fillRect(x, y, w, h);
    const inset = 3;
    ctx.fillStyle = b.color;
    ctx.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

    // top-left highlight edge (sun)
    ctx.fillStyle = 'rgba(255,255,250,0.28)';
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y, 2, h);

    if (b.kind === 'hospital') {
      // white cross on the roof
      ctx.fillStyle = '#f4f2ec';
      const cx = x + w / 2, cy = y + h / 2, arm = Math.min(w, h) * 0.28, thick = arm * 0.45;
      ctx.fillRect(cx - thick / 2, cy - arm, thick, arm * 2);
      ctx.fillRect(cx - arm, cy - thick / 2, arm * 2, thick);
    } else if (b.kind === 'police') {
      // badge-ish shield
      ctx.fillStyle = '#dfe4ec';
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.9, cy - r * 0.35);
      ctx.lineTo(cx + r * 0.6, cy + r);
      ctx.lineTo(cx, cy + r * 1.25);
      ctx.lineTo(cx - r * 0.6, cy + r);
      ctx.lineTo(cx - r * 0.9, cy - r * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = PALETTE.police;
      ctx.font = `700 ${Math.round(r)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', cx, cy + r * 0.1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    } else {
      // roof details: AC units, skylights, vents
      for (const d of b.details) {
        const dx = x + d.fx * w, dy = y + d.fy * h;
        if (d.kind === 'ac') {
          ctx.fillStyle = 'rgba(120,120,124,0.9)';
          ctx.fillRect(dx, dy, 10, 8);
          ctx.fillStyle = 'rgba(70,70,74,0.9)';
          ctx.fillRect(dx + 2, dy + 2, 6, 4);
        } else if (d.kind === 'skylight') {
          ctx.fillStyle = 'rgba(180,200,215,0.7)';
          ctx.fillRect(dx, dy, 12, 9);
          ctx.strokeStyle = 'rgba(60,60,64,0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(dx + 0.5, dy + 0.5, 11, 8);
        } else {
          ctx.fillStyle = 'rgba(90,90,94,0.9)';
          ctx.beginPath(); ctx.arc(dx + 4, dy + 4, 4, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  // live=true paints onto an already-baked chunk (must set up its transform);
  // live=false runs inside #bakeChunk where the transform is already applied.
  #paintDecal(ctx, d, live = false) {
    ctx.save();
    if (live) {
      const cx = Math.floor(d.x / CHUNK_PX), cy = Math.floor(d.y / CHUNK_PX);
      ctx.setTransform(this.bakeScale, 0, 0, this.bakeScale, -cx * CHUNK_PX * this.bakeScale, -cy * CHUNK_PX * this.bakeScale);
    }
    ctx.translate(d.x, d.y);
    ctx.rotate(d.angle || 0);
    if (d.kind === 'blood') {
      ctx.fillStyle = PALETTE.blood;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.ellipse(0, 0, d.size, d.size * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(d.size * 0.6, d.size * 0.3, d.size * 0.35, d.size * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (d.kind === 'skid') {
      ctx.strokeStyle = PALETTE.skidmark;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-d.size, 0);
      ctx.lineTo(d.size, 0);
      ctx.stroke();
    } else if (d.kind === 'scorch') {
      ctx.fillStyle = 'rgba(20,18,16,0.55)';
      ctx.beginPath();
      ctx.arc(0, 0, d.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// vehicles → wrecks/pickups → peds & cops (people draw over cars)
const RENDER_PASSES = ['vehicle', 'pickup', 'pedestrian', 'cop', 'player'];

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r},${g},${b})`;
}
