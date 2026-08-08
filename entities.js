'use strict';
/* entities.js — player, car physics, traffic/police AI, pedestrians, bullets.
 * Game-level hooks (onCarCrash, addCrime, exitCar, wanted) live in game.js and
 * are resolved at call time, which keeps this file free of UI concerns. */

const player = { x: 0, y: 0, r: 11, angle: 0, speed: 175, speedNow: 0, inCar: null, stun: 0 };
const cars = [], peds = [], bullets = [];

const CAR_COLORS = ['#b0413e', '#3e6fb0', '#4f9d55', '#b08a3e', '#7a4fb0', '#4fa8a0', '#9a9aa4', '#c8c8d0'];

function makeCar(x, y, angle, opts) {
  opts = opts || {};
  return {
    x: x, y: y, angle: angle, vx: 0, vy: 0, speed: 0, r: 18,
    color: opts.color || CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0],
    health: 100, wreck: false, wreckT: 0, remove: false,
    ai: opts.ai || null,           // 'traffic' | 'police' | null
    parked: !!opts.parked,
    police: !!opts.police,
    dir: opts.dir != null ? opts.dir : 0, // traffic heading (index into DIRS)
    turnCool: 0, offRoadT: 0, stuckT: 0, revT: 0,
    lightPhase: Math.random() * 10
  };
}

/* ---------- car physics ----------
 * Arcade model: velocity is split into a forward component (engine/brake/drag)
 * and a lateral component (decayed by grip). The handbrake slashes grip, so
 * the car keeps sliding sideways — that is the drift. */
function updateCarPhysics(car, dt, ctrl) {
  if (car.wreck) { car.vx *= 0.9; car.vy *= 0.9; car.speed = 0; return; }
  const ACCEL = 390, MAXS = 470, REVMAX = 150, BRAKE = 720;
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let s = car.vx * fx + car.vy * fy;       // signed forward speed
  let lx = car.vx - s * fx, ly = car.vy - s * fy; // lateral slide
  const th = ctrl.throttle || 0;
  if (th > 0) { s += ACCEL * th * dt; if (s > MAXS) s = MAXS; }
  else if (th < 0) {
    if (s > 20) s += th * BRAKE * dt;               // braking
    else { s += th * ACCEL * 0.55 * dt; if (s < -REVMAX) s = -REVMAX; } // reverse
  } else s -= s * 0.35 * dt;                        // rolling resistance
  s -= s * 0.12 * dt;                               // drag
  if (Math.abs(s) < 3 && th === 0) s = 0;
  const grip = ctrl.brake ? 1.6 : 7.5;
  const gl = Math.min(1, grip * dt);
  lx -= lx * gl; ly -= ly * gl;
  // steering authority scales with speed; handbrake rotates faster (drift entry)
  const sf = Math.max(-1, Math.min(1, s / 140));
  car.angle += (ctrl.steer || 0) * sf * (ctrl.brake ? 3.0 : 2.1) * dt;
  car.vx = fx * s + lx; car.vy = fy * s + ly;
  const res = collideCircle(car.x + car.vx * dt, car.y + car.vy * dt, car.r);
  if (res.hit) {
    const impact = Math.hypot(car.vx, car.vy);
    if (impact > 140) onCarCrash(car, impact);
    car.vx *= -0.32; car.vy *= -0.32;
    car.health -= impact * 0.03;
  }
  car.x = res.x; car.y = res.y;
  car.speed = Math.hypot(car.vx, car.vy);
  if (car.health <= 0 && !car.wreck) {
    car.wreck = true; car.vx = car.vy = 0; car.speed = 0;
    if (player.inCar === car) exitCar();
  }
}

/* ---------- traffic AI ----------
 * Follows a compass direction along the road grid with right-hand lane keeping.
 * Re-decides direction at each intersection, brakes for obstacles ahead. */
function updateTraffic(car, dt) {
  const ctrl = { throttle: 0.42, steer: 0, brake: false };
  const tx = Math.floor(car.x / TILE), ty = Math.floor(car.y / TILE);
  const onRoad = isRoadTile(tx, ty);
  car.offRoadT = onRoad ? 0 : car.offRoadT + dt;
  if (car.offRoadT > 5) { car.remove = true; return; } // hopelessly lost; recycle

  car.turnCool -= dt;
  if (onRoad && isIntersectionTile(tx, ty) && car.turnCool <= 0) {
    const cx = (tx - tx % ROAD_PERIOD + 1) * TILE, cy = (ty - ty % ROAD_PERIOD + 1) * TILE;
    if (Math.abs(car.x - cx) < 40 && Math.abs(car.y - cy) < 40) {
      car.turnCool = 0.8;
      const opts = [];
      for (let d = 0; d < 4; d++) {
        if (d === (car.dir + 2) % 4) continue; // no U-turns unless dead end
        if (isRoadTile(tx + DIRS[d].x * 2, ty + DIRS[d].y * 2)) opts.push(d);
      }
      if (opts.length === 0) car.dir = (car.dir + 2) % 4;
      else if (opts.indexOf(car.dir) >= 0 && Math.random() < 0.55) { /* keep straight */ }
      else car.dir = opts[(Math.random() * opts.length) | 0];
    }
  }

  const dv = DIRS[car.dir];
  let tpx = car.x + dv.x * 150, tpy = car.y + dv.y * 150;
  if (onRoad) { // pull toward the right-hand lane center
    if (dv.x !== 0) {
      const c0 = ty - ty % ROAD_PERIOD;
      tpy += ((c0 + (dv.x > 0 ? 1.5 : 0.5)) * TILE - car.y) * 0.9;
    } else {
      const c0 = tx - tx % ROAD_PERIOD;
      tpx += ((c0 + (dv.y > 0 ? 0.5 : 1.5)) * TILE - car.x) * 0.9;
    }
  }
  const desired = Math.atan2(tpy - car.y, tpx - car.x);
  let diff = desired - car.angle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  ctrl.steer = Math.max(-1, Math.min(1, diff * 3));

  // obstacle scan ahead: buildings, other cars, pedestrians
  const hx = Math.cos(car.angle), hy = Math.sin(car.angle);
  if (isSolidAt(car.x + hx * 90, car.y + hy * 90)) { ctrl.throttle = -0.6; ctrl.steer = diff >= 0 ? 1 : -1; }
  for (const o of cars) {
    if (o === car) continue;
    const dx = o.x - car.x, dy = o.y - car.y;
    if (dx * dx + dy * dy < 70 * 70 && dx * hx + dy * hy > 0) { ctrl.throttle = o.speed > 40 ? 0.2 : -0.5; break; }
  }
  for (const p of peds) {
    if (p.dead) continue;
    const dx = p.x - car.x, dy = p.y - car.y;
    if (dx * dx + dy * dy < 60 * 60 && dx * hx + dy * hy > 0) { ctrl.throttle = -0.7; break; }
  }
  updateCarPhysics(car, dt, ctrl);
}

/* ---------- police AI ----------
 * Direct pursuit steering toward the player with a fan of probe rays to slide
 * around buildings; backs up when wedged. Faster and more aggressive at
 * higher wanted levels. */
function updatePolice(car, dt) {
  const t = player.inCar || player;
  const ctrl = { throttle: 0.7 + 0.06 * wanted, steer: 0, brake: false };
  if (car.revT > 0) { // reversing out of a stuck position
    car.revT -= dt;
    ctrl.throttle = -0.7;
    updateCarPhysics(car, dt, ctrl);
    return;
  }
  const desired = Math.atan2(t.y - car.y, t.x - car.x);
  let chosen = desired;
  const probes = [0, 0.55, -0.55, 1.1, -1.1, 1.8, -1.8];
  for (const off of probes) {
    const a = desired + off;
    if (!isSolidAt(car.x + Math.cos(a) * 95, car.y + Math.sin(a) * 95)) { chosen = a; break; }
  }
  let diff = chosen - car.angle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  ctrl.steer = Math.max(-1, Math.min(1, diff * 3.2));
  if (Math.abs(diff) > 1.1) ctrl.throttle = 0.35; // slow into hard turns
  updateCarPhysics(car, dt, ctrl);
  if (car.speed < 30) {
    car.stuckT += dt;
    if (car.stuckT > 1.4) { car.stuckT = 0; car.revT = 0.7; }
  } else car.stuckT = 0;
}

/* ---------- pedestrians ---------- */

function makePed(x, y) {
  return {
    x: x, y: y, angle: Math.random() * Math.PI * 2,
    speed: 55 + Math.random() * 30,
    tx: x, ty: y, retarget: 0,
    state: 'walk', fearT: 0, fleeX: 0, fleeY: 0,
    dead: false, fadeT: 0, remove: false,
    color: 'hsl(' + ((Math.random() * 360) | 0) + ',45%,62%)'
  };
}

function updatePeds(dt) {
  for (const p of peds) {
    if (p.dead) { p.fadeT += dt; if (p.fadeT > 6) p.remove = true; continue; }
    if (p.state === 'flee') {
      p.fearT -= dt;
      p.angle = Math.atan2(p.y - p.fleeY, p.x - p.fleeX);
      movePed(p, p.angle, 205, dt);
      if (p.fearT <= 0) p.state = 'walk';
    } else {
      p.retarget -= dt;
      const dx = p.tx - p.x, dy = p.ty - p.y;
      if (dx * dx + dy * dy < 20 * 20 || p.retarget <= 0) {
        const np = randomTilePoint([T.SIDEWALK, T.PARK], p.x, p.y, 60, 420);
        if (np) { p.tx = np.x; p.ty = np.y; }
        p.retarget = 4 + Math.random() * 5;
      }
      p.angle = Math.atan2(dy, dx);
      movePed(p, p.angle, p.speed, dt);
    }
  }
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].remove) peds.splice(i, 1);
}

function movePed(p, a, sp, dt) {
  const r = collideCircle(p.x + Math.cos(a) * sp * dt, p.y + Math.sin(a) * sp * dt, 9);
  p.x = r.x; p.y = r.y;
}

function scarePeds(x, y, rad) {
  for (const p of peds) {
    if (p.dead) continue;
    const dx = p.x - x, dy = p.y - y;
    if (dx * dx + dy * dy < rad * rad) {
      p.state = 'flee'; p.fearT = 2 + Math.random() * 2.5; p.fleeX = x; p.fleeY = y;
    }
  }
}

/* ---------- bullets ---------- */

function fireBullet(x, y, angle) {
  bullets.push({ x: x, y: y, vx: Math.cos(angle) * 950, vy: Math.sin(angle) * 950, life: 0.65 });
}

function updateBullets(dt) {
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0) continue;
    if (isSolidAt(b.x, b.y)) { b.life = 0; continue; }
    for (const p of peds) {
      if (p.dead) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (dx * dx + dy * dy < 13 * 13) {
        p.dead = true;
        addCrime('shoot', p.x, p.y); addCrime('kill', p.x, p.y);
        b.life = 0; break;
      }
    }
    if (b.life <= 0) continue;
    for (const c of cars) {
      if (c === player.inCar) continue;
      const dx = c.x - b.x, dy = c.y - b.y;
      if (dx * dx + dy * dy < 24 * 24) {
        c.health -= 25;
        addCrime('shoot', c.x, c.y);
        b.life = 0; break;
      }
    }
  }
  for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].life <= 0) bullets.splice(i, 1);
}

/* ---------- drawing ---------- */

function drawCar(g, c, time) {
  const L = 46, W = 24;
  g.save();
  g.translate(c.x, c.y);
  g.rotate(c.angle);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(-L / 2 + 2, -W / 2 + 3, L, W);
  g.fillStyle = c.wreck ? '#2b2b2f' : c.color;
  g.fillRect(-L / 2, -W / 2, L, W);
  if (c.police && !c.wreck) { // black hood + trunk over the white body
    g.fillStyle = '#1a1a20';
    g.fillRect(-L / 2, -W / 2, 10, W);
    g.fillRect(L / 2 - 8, -W / 2, 8, W);
  }
  g.fillStyle = '#141820'; // cabin
  g.fillRect(-7, -W / 2 + 4, 15, W - 8);
  g.fillStyle = 'rgba(180,220,255,0.55)'; // windshield
  g.fillRect(8, -W / 2 + 4, 3, W - 8);
  if (c.police && !c.wreck) { // flashing light bar
    const blink = ((time * 4 + c.lightPhase) | 0) % 2 === 0;
    g.fillStyle = blink ? '#ff4040' : '#4070ff';
    g.fillRect(-4, -W / 2 + 3, 8, 5);
    g.fillStyle = blink ? '#4070ff' : '#ff4040';
    g.fillRect(-4, W / 2 - 8, 8, 5);
  }
  if (c.wreck) { // smoke hint
    g.fillStyle = 'rgba(120,120,120,0.35)';
    g.beginPath(); g.arc(6, -6 - (time * 20 + c.lightPhase * 10) % 14, 6, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

function drawPed(g, p) {
  if (p.dead) {
    const a = Math.max(0, 1 - p.fadeT / 6);
    g.fillStyle = 'rgba(150,20,20,' + (0.55 * a) + ')';
    g.beginPath(); g.arc(p.x, p.y, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(120,120,130,' + a + ')';
    g.beginPath(); g.arc(p.x + 5, p.y + 2, 5, 0, Math.PI * 2); g.fill();
    return;
  }
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.beginPath(); g.arc(p.x + 1, p.y + 2, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = p.color;
  g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e8d8b0';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(p.x, p.y);
  g.lineTo(p.x + Math.cos(p.angle) * 10, p.y + Math.sin(p.angle) * 10);
  g.stroke();
}

function drawPlayer(g) {
  if (player.inCar) return;
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.arc(player.x + 1, player.y + 2, player.r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e8c15a';
  g.beginPath(); g.arc(player.x, player.y, player.r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#222';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(player.x, player.y);
  g.lineTo(player.x + Math.cos(player.angle) * 17, player.y + Math.sin(player.angle) * 17);
  g.stroke();
  g.fillStyle = '#2b2b30';
  g.beginPath(); g.arc(player.x, player.y, 4.5, 0, Math.PI * 2); g.fill();
}

function drawBullets(g) {
  g.strokeStyle = '#ffe08a';
  g.lineWidth = 3;
  for (const b of bullets) {
    g.beginPath();
    g.moveTo(b.x, b.y);
    g.lineTo(b.x - b.vx * 0.014, b.y - b.vy * 0.014);
    g.stroke();
  }
}
