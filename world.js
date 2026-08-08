'use strict';
/* world.js — procedural city: tile map generation, queries, collision, rendering.
 * The city is an island: water border, roads on a 12-tile period (2 tiles wide),
 * 10x10 city blocks between them filled with sidewalk rings, building lots,
 * parks and the occasional lake. Everything is driven by a seeded RNG so the
 * map is identical on every load. */

const TILE = 40;
const MAP_W = 112, MAP_H = 112;
const WORLD_W = MAP_W * TILE, WORLD_H = MAP_H * TILE;
const ROAD_PERIOD = 12, ROAD_W = 2;

const T = { ROAD: 0, SIDEWALK: 1, BUILDING: 2, PARK: 3, WATER: 4 };

// orthogonal unit directions: 0=E, 1=S, 2=W, 3=N (screen coords, y down)
const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

const map = new Uint8Array(MAP_W * MAP_H);
const trees = [];   // {x, y, r} in px — park/decor canopies
const lamps = [];   // {x, y} in px — intersection street lamps (night glow)
let minimapImg = null; // prerendered offscreen minimap canvas

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H; }
function tileType(tx, ty) { return inBounds(tx, ty) ? map[ty * MAP_W + tx] : T.WATER; }
function isRoadTile(tx, ty) { return tileType(tx, ty) === T.ROAD; }
function isIntersectionTile(tx, ty) {
  return tx % ROAD_PERIOD < ROAD_W && ty % ROAD_PERIOD < ROAD_W && tileType(tx, ty) === T.ROAD;
}
function isSolidTile(tx, ty) { const t = tileType(tx, ty); return t === T.BUILDING || t === T.WATER; }
function isSolidAt(px, py) { return isSolidTile(Math.floor(px / TILE), Math.floor(py / TILE)); }

function genWorld(seed) {
  const rng = mulberry32(seed);
  // base pass: water border, road grid, everything else starts as sidewalk
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    let t;
    if (tx < 3 || ty < 3 || tx >= MAP_W - 3 || ty >= MAP_H - 3) t = T.WATER;
    else if (tx % ROAD_PERIOD < ROAD_W || ty % ROAD_PERIOD < ROAD_W) t = T.ROAD;
    else t = T.SIDEWALK;
    map[ty * MAP_W + tx] = t;
  }
  // block pass: 10x10 interiors between roads
  const blocksX = Math.floor(MAP_W / ROAD_PERIOD), blocksY = Math.floor(MAP_H / ROAD_PERIOD);
  for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) {
    const x0 = bx * ROAD_PERIOD + ROAD_W, y0 = by * ROAD_PERIOD + ROAD_W;
    if (x0 + 10 > MAP_W - 3 || y0 + 10 > MAP_H - 3) continue;
    const roll = rng();
    const park = roll < 0.14, lake = !park && roll < 0.20;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const tx = x0 + x, ty = y0 + y;
      const ring = x === 0 || y === 0 || x === 9 || y === 9;
      if (ring) { map[ty * MAP_W + tx] = T.SIDEWALK; continue; }
      map[ty * MAP_W + tx] = park ? T.PARK : lake ? T.WATER : T.BUILDING;
    }
    if (park) {
      const n = 8 + (rng() * 8 | 0);
      for (let i = 0; i < n; i++) trees.push({ x: (x0 + 1 + rng() * 8) * TILE, y: (y0 + 1 + rng() * 8) * TILE, r: 7 + rng() * 9 });
    } else if (!lake) {
      // the 8x8 core is four 4x4 lots; some become mini park plazas
      for (let ly = 0; ly < 2; ly++) for (let lx = 0; lx < 2; lx++) {
        const lotX = x0 + 1 + lx * 4, lotY = y0 + 1 + ly * 4;
        if (rng() < 0.18) {
          for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) map[(lotY + y) * MAP_W + lotX + x] = T.PARK;
          if (rng() < 0.8) trees.push({ x: (lotX + 2) * TILE, y: (lotY + 2) * TILE, r: 8 + rng() * 6 });
        }
      }
    }
  }
  // street lamps at every road intersection (used for night light pools)
  for (let a = 0; a * ROAD_PERIOD + 1 < MAP_W; a++) for (let b = 0; b * ROAD_PERIOD + 1 < MAP_H; b++) {
    const tx = a * ROAD_PERIOD, ty = b * ROAD_PERIOD;
    if (tileType(tx, ty) === T.ROAD) lamps.push({ x: (tx + 1) * TILE, y: (ty + 1) * TILE });
  }
}

// center (px) of the intersection at grid coords (a, b)
function intersectionCenter(a, b) { return { x: (a * ROAD_PERIOD + 1) * TILE, y: (b * ROAD_PERIOD + 1) * TILE }; }

// resolve a circle against solid tiles; returns corrected position + hit flag
function collideCircle(px, py, r) {
  let hit = false;
  const tx0 = Math.floor((px - r) / TILE), tx1 = Math.floor((px + r) / TILE);
  const ty0 = Math.floor((py - r) / TILE), ty1 = Math.floor((py + r) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (!isSolidTile(tx, ty)) continue;
    const cx = Math.max(tx * TILE, Math.min(px, tx * TILE + TILE));
    const cy = Math.max(ty * TILE, Math.min(py, ty * TILE + TILE));
    const dx = px - cx, dy = py - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      hit = true;
      const d = Math.sqrt(d2);
      if (d < 0.001) { px += r; } else { px += dx / d * (r - d); py += dy / d * (r - d); }
    }
  }
  return { x: px, y: py, hit };
}

// cheap line-of-sight: sample along the segment, blocked by solid tiles
function losClear(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / (TILE * 0.5)));
  for (let i = 1; i < steps; i++) {
    if (isSolidAt(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)) return false;
  }
  return true;
}

// random point on one of the given tile types, in a ring around (cx, cy)
function randomTilePoint(types, cx, cy, minD, maxD) {
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * Math.PI * 2, d = minD + Math.random() * (maxD - minD);
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (types.indexOf(tileType(tx, ty)) >= 0) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
  }
  return null;
}

/* ---------- rendering ---------- */

const TILE_COLORS = {};
TILE_COLORS[T.ROAD] = '#30303a';
TILE_COLORS[T.SIDEWALK] = '#47475a';
TILE_COLORS[T.PARK] = '#2e6b3c';
TILE_COLORS[T.WATER] = '#17395e';
TILE_COLORS[T.BUILDING] = '#3a3a44';

function drawWorld(g, camX, camY, vw, vh) {
  const tx0 = Math.max(0, Math.floor(camX / TILE)), tx1 = Math.min(MAP_W - 1, Math.ceil((camX + vw) / TILE));
  const ty0 = Math.max(0, Math.floor(camY / TILE)), ty1 = Math.min(MAP_H - 1, Math.ceil((camY + vh) / TILE));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const t = map[ty * MAP_W + tx];
    const x = tx * TILE, y = ty * TILE;
    g.fillStyle = TILE_COLORS[t];
    g.fillRect(x, y, TILE, TILE);
    if (t === T.ROAD) {
      // lane divider dashes: between the two road columns/rows, mid-block only
      g.fillStyle = '#b8a44a';
      if (tx % ROAD_PERIOD === 0 && ty % ROAD_PERIOD >= ROAD_W && isRoadTile(tx, ty - 1) && isRoadTile(tx, ty + 1)) {
        g.fillRect(x + TILE - 1.5, y + 8, 3, TILE - 16);
      }
      if (ty % ROAD_PERIOD === 0 && tx % ROAD_PERIOD >= ROAD_W && isRoadTile(tx - 1, ty) && isRoadTile(tx + 1, ty)) {
        g.fillRect(x + 8, y + TILE - 1.5, TILE - 16, 3);
      }
    } else if (t === T.WATER) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(x + 6, y + 10 + ((tx * 7 + ty * 13) % 14), TILE - 12, 2);
    }
  }
  // building rooftops: one rect per 4x4 lot (lot origins sit at tx%4===3 by construction)
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (map[ty * MAP_W + tx] !== T.BUILDING || tx % 4 !== 3 || ty % 4 !== 3) continue;
    const shade = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
    const v = 62 + (shade % 26);
    const x = tx * TILE, y = ty * TILE, S = 4 * TILE;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x + 5, y + 7, S, S); // drop shadow
    g.fillStyle = 'rgb(' + v + ',' + (v + 4) + ',' + (v + 12) + ')';
    g.fillRect(x, y, S, S);
    g.fillStyle = 'rgb(' + (v - 18) + ',' + (v - 14) + ',' + (v - 6) + ')';
    g.fillRect(x + 10, y + 10, S - 20, S - 20); // roof inset
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.strokeRect(x + 24.5, y + 24.5, S - 49, S - 49);
  }
  // park trees
  g.fillStyle = '#1d4a28';
  for (const tr of trees) {
    if (tr.x < camX - 40 || tr.x > camX + vw + 40 || tr.y < camY - 40 || tr.y > camY + vh + 40) continue;
    g.beginPath(); g.arc(tr.x + 3, tr.y + 4, tr.r, 0, Math.PI * 2); g.fill(); // canopy shadow
    g.fillStyle = '#2f7a40';
    g.beginPath(); g.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1d4a28';
  }
  // lamp posts (the glow itself is drawn by the night overlay pass)
  g.fillStyle = '#8a8a96';
  for (const l of lamps) {
    if (l.x < camX - 20 || l.x > camX + vw + 20 || l.y < camY - 20 || l.y > camY + vh + 20) continue;
    g.fillRect(l.x - 2, l.y - 2, 4, 4);
  }
}

/* ---------- minimap prerender ---------- */

function buildMinimap() {
  const scale = 2;
  minimapImg = document.createElement('canvas');
  minimapImg.width = MAP_W * scale; minimapImg.height = MAP_H * scale;
  const g = minimapImg.getContext('2d');
  const colors = {};
  colors[T.ROAD] = '#6d6d78'; colors[T.SIDEWALK] = '#3c3c46'; colors[T.BUILDING] = '#22222a';
  colors[T.PARK] = '#2e7d46'; colors[T.WATER] = '#2b5d8f';
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    g.fillStyle = colors[map[ty * MAP_W + tx]];
    g.fillRect(tx * scale, ty * scale, scale, scale);
  }
}
