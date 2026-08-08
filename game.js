'use strict';
/* game.js — bootstrap, input, camera, spawning, wanted system, day/night cycle,
 * HUD + minimap, and the main loop. Plain scripts share one global scope, so
 * this file wires together world.js, entities.js and missions.js. */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const miniCtx = mini.getContext('2d');

const DAY_LENGTH = 150; // seconds per full day/night cycle
const WORLD_SEED = 20260808;

let gameTime = 0;
let dayT = 0.32;          // 0=midnight, 0.5=noon; start mid-morning
let money = 0;
let wanted = 0;           // 0..5 stars
let heat = 0;             // fractional progress toward the next star
let lastCrimeT = -99, lastShootCrime = -99, lastCarCrime = -99, decayAcc = 0;
let shootCool = 0, spawnAcc = 0, hudAcc = 0, copSpawnAcc = 0;

const keys = {};
const mouse = { x: 0, y: 0, down: false };
const cam = { x: 0, y: 0 };
const toasts = [];
const touch = { active: false, ax: 0, ay: 0 };
let overlayOn = true;

/* ---------- persistence ---------- */

function loadMoney() {
  try { money = parseInt(localStorage.getItem('opencity_money') || '0', 10) || 0; }
  catch (e) { money = 0; }
}
function saveMoney() {
  try { localStorage.setItem('opencity_money', String(money)); } catch (e) { /* private mode */ }
}
function addMoney(n) { money += n; saveMoney(); }

/* ---------- tiny WebAudio SFX (no assets) ---------- */

let audioCtx = null;
function sfx(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const cfg = {
      shoot:      { f: 170, t: 0.09, type: 'square',   v: 0.12 },
      crash:      { f: 65,  t: 0.18, type: 'sawtooth', v: 0.16 },
      cash:       { f: 880, t: 0.14, type: 'sine',     v: 0.14 },
      checkpoint: { f: 660, t: 0.10, type: 'sine',     v: 0.12 },
      start:      { f: 520, t: 0.16, type: 'triangle', v: 0.14 },
      fail:       { f: 140, t: 0.30, type: 'triangle', v: 0.14 }
    }[kind];
    if (!cfg) return;
    o.type = cfg.type; o.frequency.value = cfg.f;
    g.gain.setValueAtTime(cfg.v, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + cfg.t);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + cfg.t);
  } catch (e) { /* audio unavailable — fine */ }
}

/* ---------- toasts ---------- */

function toast(text) { toasts.push({ text: text, until: gameTime + 3.5 }); if (toasts.length > 3) toasts.shift(); }

/* ---------- wanted / crime system ---------- */

function setWanted(n) { wanted = Math.max(0, Math.min(5, n)); heat = 0; lastCrimeT = gameTime; }

function addCrime(type, x, y) {
  lastCrimeT = gameTime;
  if (type === 'shoot') {
    if (gameTime - lastShootCrime < 2.5) return; // one star per shooting spree
    lastShootCrime = gameTime;
    heat += 1;
  } else if (type === 'ped') heat += 1;
  else if (type === 'kill') heat += 1.2;
  else if (type === 'car') {
    if (gameTime - lastCarCrime < 1.0) return; // pile-ups count once per second
    lastCarCrime = gameTime;
    heat += 0.5;
  }
  else if (type === 'cop') heat += 1.5;
  if (heat >= 1) {
    const add = Math.floor(heat);
    heat -= add;
    wanted = Math.min(5, wanted + add);
    if (wanted > 0) toast('Wanted level ' + wanted + '!');
  }
  if (x !== undefined) scarePeds(x, y, 260);
  missionCrimeHook(type);
}

function policeSeesPlayer() {
  const t = player.inCar || player;
  for (const c of cars) {
    if (!c.police || c.wreck) continue;
    const d2 = (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y);
    if (d2 < 550 * 550 && losClear(c.x, c.y, t.x, t.y)) return true;
  }
  return false;
}

function updateWanted(dt) {
  if (wanted <= 0) return;
  // stars decay only after lying low: no fresh crimes and no cop with eyes on you
  if (gameTime - lastCrimeT > 12 && !policeSeesPlayer()) {
    decayAcc += dt;
    if (decayAcc > 6) {
      decayAcc = 0;
      wanted--;
      heat = 0;
      if (wanted === 0) toast('You lost the heat.');
    }
  } else decayAcc = 0;
}

/* ---------- interact (E) ---------- */

function interact() {
  if (player.inCar) { exitCar(); return; }
  let best = null, bestD = 62 * 62;
  for (const c of cars) {
    if (c.wreck) continue;
    const d2 = (c.x - player.x) * (c.x - player.x) + (c.y - player.y) * (c.y - player.y);
    if (d2 < bestD) { bestD = d2; best = c; }
  }
  if (best) {
    if (best.ai === 'traffic') { best.ai = null; addCrime('car', best.x, best.y); toast('Car "borrowed".'); }
    if (best.police) { addCrime('cop', best.x, best.y); toast('You stole a cop car. Bold.'); best.police = false; best.color = '#d8d8e0'; }
    best.parked = false;
    best.offRoadT = 0;
    player.inCar = best;
    sfx('start');
  }
}

function exitCar() {
  const car = player.inCar;
  if (!car) return;
  // step out on the first free side
  const spots = [[0, 34], [0, -34], [34, 0], [-34, 0]];
  for (const s of spots) {
    const nx = car.x + Math.cos(car.angle) * s[0] - Math.sin(car.angle) * s[1];
    const ny = car.y + Math.sin(car.angle) * s[0] + Math.cos(car.angle) * s[1];
    if (!isSolidAt(nx, ny)) { player.x = nx; player.y = ny; break; }
  }
  player.inCar = null;
}

/* ---------- collisions between cars / cars vs people ---------- */

function handleCarCollisions() {
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 34 * 34 || d2 < 0.01) continue;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const overlap = 34 - d;
    // parked/wrecked cars are immovable; the mover takes the full push
    const aMove = (a === player.inCar || a.ai) && !a.wreck && !a.parked;
    const bMove = (b === player.inCar || b.ai) && !b.wreck && !b.parked;
    const aShare = aMove ? (bMove ? 0.5 : 1) : 0;
    const bShare = bMove ? (aMove ? 0.5 : 1) : 0;
    a.x -= nx * overlap * aShare; a.y -= ny * overlap * aShare;
    b.x += nx * overlap * bShare; b.y += ny * overlap * bShare;
    const rel = Math.abs((a.vx - b.vx) * nx + (a.vy - b.vy) * ny);
    if (rel > 90) {
      const damp = 0.55;
      a.vx -= nx * rel * damp * aShare; a.vy -= ny * rel * damp * aShare;
      b.vx += nx * rel * damp * bShare; b.vy += ny * rel * damp * bShare;
      a.health -= rel * 0.05; b.health -= rel * 0.05;
      if (rel > 150) {
        onCarCrash(a === player.inCar ? a : b === player.inCar ? b : a, rel);
        if (a === player.inCar || b === player.inCar) {
          const other = a === player.inCar ? b : a;
          addCrime(other.police ? 'cop' : 'car', other.x, other.y);
        }
      }
    }
  }
}

function handleRunovers(dt) {
  for (const c of cars) {
    if (c.speed < 120) continue;
    const isPlayer = c === player.inCar;
    for (const p of peds) {
      if (p.dead) continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy < 26 * 26) {
        p.dead = true;
        scarePeds(p.x, p.y, 240);
        if (isPlayer) addCrime('ped', p.x, p.y);
      }
    }
    // knocking the player (on foot) around
    if (!player.inCar && player.stun <= 0) {
      const dx = player.x - c.x, dy = player.y - c.y;
      if (dx * dx + dy * dy < 28 * 28) {
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const res = collideCircle(player.x + dx / d * 46, player.y + dy / d * 46, player.r);
        player.x = res.x; player.y = res.y;
        player.stun = 0.9;
        scarePeds(player.x, player.y, 200);
      }
    }
  }
  if (player.stun > 0) player.stun -= dt;
}

function onCarCrash(car, impact) {
  scarePeds(car.x, car.y, 220);
  sfx('crash');
}

/* ---------- population management ---------- */

function manageSpawns(dt) {
  spawnAcc -= dt;
  if (spawnAcc > 0) return;
  spawnAcc = 0.5;
  const px = player.inCar ? player.inCar.x : player.x;
  const py = player.inCar ? player.inCar.y : player.y;

  let traffic = 0, parked = 0;
  for (const c of cars) {
    const d2 = (c.x - px) * (c.x - px) + (c.y - py) * (c.y - py);
    if (c.ai === 'traffic') {
      traffic++;
      if (d2 > 1500 * 1500 || c.remove) c.gone = true;
    } else if (c.parked) {
      parked++;
      if (d2 > 1600 * 1600) c.gone = true;
    } else if (c !== player.inCar && !c.police && d2 > 1500 * 1500) c.gone = true;
  }
  for (let i = cars.length - 1; i >= 0; i--) if (cars[i].gone) cars.splice(i, 1);
  for (let i = peds.length - 1; i >= 0; i--) {
    const d2 = (peds[i].x - px) * (peds[i].x - px) + (peds[i].y - py) * (peds[i].y - py);
    if (d2 > 1300 * 1300) peds.splice(i, 1);
  }

  if (traffic < 9) {
    const p = randomTilePoint([T.ROAD], px, py, 700, 1100);
    if (p) {
      const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
      const vertical = isRoadTile(tx, ty - 1) || isRoadTile(tx, ty + 1);
      const dir = vertical ? (Math.random() < 0.5 ? 1 : 3) : (Math.random() < 0.5 ? 0 : 2);
      cars.push(makeCar(p.x, p.y, dir * Math.PI / 2, { ai: 'traffic', dir: dir }));
    }
  }
  if (parked < 6) {
    const p = randomTilePoint([T.ROAD], px, py, 250, 900);
    if (p) cars.push(makeCar(p.x, p.y, (Math.random() < 0.5 ? 0 : 1) * Math.PI, { parked: true }));
  }
  if (peds.length < 16) {
    const p = randomTilePoint([T.SIDEWALK, T.PARK], px, py, 300, 900);
    if (p) peds.push(makePed(p.x, p.y));
  }
}

function managePolice(dt) {
  let cops = 0;
  for (const c of cars) if (c.police) cops++;
  const px = player.inCar ? player.inCar.x : player.x;
  const py = player.inCar ? player.inCar.y : player.y;
  copSpawnAcc -= dt;
  if (wanted > 0 && cops < wanted && copSpawnAcc <= 0) {
    copSpawnAcc = 1.5; // reinforcements arrive one at a time
    const p = randomTilePoint([T.ROAD], px, py, 750, 1150);
    if (p) cars.push(makeCar(p.x, p.y, Math.atan2(py - p.y, px - p.x), { police: true, color: '#ececf2' }));
  }
  // when the heat is gone, cops give up and leave
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (!c.police) continue;
    const d2 = (c.x - px) * (c.x - px) + (c.y - py) * (c.y - py);
    if (wanted <= 0) {
      c.leaveT = (c.leaveT || 0) + dt;
      if (c.leaveT > 5 || d2 > 900 * 900) cars.splice(i, 1);
    } else if (d2 > 1700 * 1700) cars.splice(i, 1); // lost far behind; will respawn nearer
  }
}

/* ---------- input ---------- */

function bindInput() {
  window.addEventListener('keydown', function (e) {
    if (overlayOn) dismissOverlay();
    keys[e.code] = true;
    if (e.code === 'KeyE') interact();
    if (e.code === 'KeyF') tryShoot();
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.code) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  canvas.addEventListener('mousemove', function (e) {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
  });
  canvas.addEventListener('mousedown', function (e) { if (overlayOn) { dismissOverlay(); return; } mouse.down = true; tryShoot(); });
  window.addEventListener('mouseup', function () { mouse.down = false; });
  bindTouch();
}

function dismissOverlay() {
  overlayOn = false;
  const o = document.getElementById('overlay');
  if (o) o.style.display = 'none';
}

function tryShoot() {
  if (shootCool > 0 || player.stun > 0) return;
  shootCool = 0.22;
  const src = player.inCar || player;
  fireBullet(src.x, src.y, player.angle);
  scarePeds(src.x, src.y, 220);
  addCrime('shoot', src.x, src.y);
  sfx('shoot');
}

// virtual joystick + buttons, shown only on touch devices
function bindTouch() {
  if (!('ontouchstart' in window)) return;
  const ui = document.getElementById('touch-ui');
  if (ui) ui.style.display = 'block';
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  if (stick) {
    let sid = null;
    stick.addEventListener('touchstart', function (e) { sid = e.changedTouches[0].identifier; if (overlayOn) dismissOverlay(); e.preventDefault(); });
    stick.addEventListener('touchmove', function (e) {
      for (const t of e.changedTouches) {
        if (t.identifier !== sid) continue;
        const r = stick.getBoundingClientRect();
        let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
        const m = Math.hypot(dx, dy), max = r.width / 2;
        if (m > max) { dx *= max / m; dy *= max / m; }
        touch.active = true; touch.ax = dx / max; touch.ay = dy / max;
        if (knob) { knob.style.left = (50 + touch.ax * 32) + '%'; knob.style.top = (50 + touch.ay * 32) + '%'; }
      }
      e.preventDefault();
    });
    const end = function (e) {
      touch.active = false; touch.ax = 0; touch.ay = 0;
      if (knob) { knob.style.left = '50%'; knob.style.top = '50%'; }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);
  }
  const bE = document.getElementById('btn-e'), bF = document.getElementById('btn-fire');
  if (bE) bE.addEventListener('touchstart', function (e) { if (overlayOn) dismissOverlay(); else interact(); e.preventDefault(); });
  if (bF) bF.addEventListener('touchstart', function (e) { if (!overlayOn) tryShoot(); e.preventDefault(); });
}

/* ---------- per-frame update ---------- */

function handlePlayerInput(dt) {
  if (player.inCar) {
    const car = player.inCar;
    let throttle = 0, steer = 0;
    if (keys.KeyW || keys.ArrowUp) throttle += 1;
    if (keys.KeyS || keys.ArrowDown) throttle -= 1;
    if (keys.KeyA || keys.ArrowLeft) steer -= 1;
    if (keys.KeyD || keys.ArrowRight) steer += 1;
    if (touch.active) { throttle = -touch.ay; steer = touch.ax; }
    updateCarPhysics(car, dt, { throttle: throttle, steer: steer, brake: !!keys.Space });
    player.x = car.x; player.y = car.y;
    player.angle = car.angle;
    player.speedNow = car.speed;
  } else {
    let mx = 0, my = 0;
    if (keys.KeyW || keys.ArrowUp) my -= 1;
    if (keys.KeyS || keys.ArrowDown) my += 1;
    if (keys.KeyA || keys.ArrowLeft) mx -= 1;
    if (keys.KeyD || keys.ArrowRight) mx += 1;
    if (touch.active) { mx = touch.ax; my = touch.ay; }
    const m = Math.hypot(mx, my);
    if (m > 0 && player.stun <= 0) {
      mx /= Math.max(1, m); my /= Math.max(1, m);
      const res = collideCircle(player.x + mx * player.speed * dt, player.y + my * player.speed * dt, player.r);
      player.x = res.x; player.y = res.y;
      player.speedNow = player.speed;
    } else player.speedNow = 0;
    // aim: mouse on desktop, movement direction on touch
    if (touch.active && m > 0.2) player.angle = Math.atan2(my, mx);
    else player.angle = Math.atan2(cam.y + mouse.y - player.y, cam.x + mouse.x - player.x);
  }
  shootCool -= dt;
  if (mouse.down) tryShoot(); // hold to keep firing
}

function updateCamera(dt) {
  const t = player.inCar || player;
  const look = 0.35;
  const tx = t.x + (t.vx || 0) * look - canvas.width / 2;
  const ty = t.y + (t.vy || 0) * look - canvas.height / 2;
  const k = Math.min(1, 5 * dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  cam.x = Math.max(0, Math.min(WORLD_W - canvas.width, cam.x));
  cam.y = Math.max(0, Math.min(WORLD_H - canvas.height, cam.y));
}

function step(dt) {
  gameTime += dt;
  dayT = (dayT + dt / DAY_LENGTH) % 1;
  handlePlayerInput(dt);
  for (const c of cars) {
    if (c === player.inCar || c.wreck || c.parked) continue;
    if (c.police) updatePolice(c, dt);
    else if (c.ai === 'traffic') updateTraffic(c, dt);
  }
  handleCarCollisions();
  handleRunovers(dt);
  updatePeds(dt);
  updateBullets(dt);
  updateMissions(dt);
  updateWanted(dt);
  managePolice(dt);
  manageSpawns(dt);
  updateCamera(dt);
  render();
  updateHUD(dt);
}

/* ---------- rendering ---------- */

let nightCanvas = null;
function render() {
  const vw = canvas.width, vh = canvas.height;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, vw, vh);
  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  drawWorld(ctx, cam.x, cam.y, vw, vh);
  drawMissionWorld(ctx, gameTime);
  for (const p of peds) {
    if (p.x < cam.x - 30 || p.x > cam.x + vw + 30 || p.y < cam.y - 30 || p.y > cam.y + vh + 30) continue;
    drawPed(ctx, p);
  }
  for (const c of cars) {
    if (c.x < cam.x - 60 || c.x > cam.x + vw + 60 || c.y < cam.y - 60 || c.y > cam.y + vh + 60) continue;
    drawCar(ctx, c, gameTime);
  }
  drawPlayer(ctx);
  drawBullets(ctx);
  ctx.restore();
  drawNight(vw, vh);
}

function drawNight(vw, vh) {
  const light = 0.5 + 0.5 * Math.sin((dayT - 0.25) * Math.PI * 2); // 1 at noon, 0 at midnight
  const darkness = (1 - light) * 0.62;
  if (darkness < 0.02) return;
  if (!nightCanvas) { nightCanvas = document.createElement('canvas'); }
  if (nightCanvas.width !== vw || nightCanvas.height !== vh) { nightCanvas.width = vw; nightCanvas.height = vh; }
  const g = nightCanvas.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, vw, vh);
  g.fillStyle = 'rgba(8,10,42,' + darkness + ')';
  g.fillRect(0, 0, vw, vh);
  // punch light pools out of the darkness
  g.globalCompositeOperation = 'destination-out';
  const holes = [];
  const t = player.inCar || player;
  holes.push({ x: t.x - cam.x, y: t.y - cam.y, r: player.inCar ? 190 : 150, a: 0.9 });
  if (player.inCar) { // headlight reach
    holes.push({ x: t.x - cam.x + Math.cos(t.angle) * 120, y: t.y - cam.y + Math.sin(t.angle) * 120, r: 130, a: 0.7 });
  }
  for (const l of lamps) {
    const x = l.x - cam.x, y = l.y - cam.y;
    if (x < -140 || x > vw + 140 || y < -140 || y > vh + 140) continue;
    holes.push({ x: x, y: y, r: 120, a: 0.75 });
  }
  for (const c of cars) {
    if (c.wreck) continue;
    const x = c.x - cam.x, y = c.y - cam.y;
    if (x < -120 || x > vw + 120 || y < -120 || y > vh + 120) continue;
    holes.push({ x: x + Math.cos(c.angle) * 60, y: y + Math.sin(c.angle) * 60, r: 70, a: 0.55 });
  }
  for (const h of holes) {
    const grad = g.createRadialGradient(h.x, h.y, 6, h.x, h.y, h.r);
    grad.addColorStop(0, 'rgba(0,0,0,' + h.a + ')');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(h.x, h.y, h.r, 0, Math.PI * 2); g.fill();
  }
  ctx.drawImage(nightCanvas, 0, 0);
}

/* ---------- HUD + minimap ---------- */

function updateHUD(dt) {
  hudAcc -= dt;
  if (hudAcc > 0) return;
  hudAcc = 0.12;
  const el = function (id) { return document.getElementById(id); };
  const moneyEl = el('hud-money');
  if (moneyEl) moneyEl.textContent = '$' + money;
  const starsEl = el('hud-stars');
  if (starsEl) {
    let s = '';
    for (let i = 0; i < 5; i++) s += i < wanted ? '★' : '☆';
    starsEl.textContent = s;
    starsEl.style.color = wanted > 0 ? '#ffd24a' : '#55565f';
  }
  const mEl = el('hud-mission');
  if (mEl) {
    if (missionState.active) {
      mEl.textContent = missionState.active.hud();
      mEl.style.display = 'block';
    } else mEl.style.display = 'none';
  }
  const sEl = el('hud-speed');
  if (sEl) {
    if (player.inCar) {
      sEl.textContent = Math.round(player.inCar.speed * 0.18) + ' mph';
      sEl.style.display = 'block';
    } else sEl.style.display = 'none';
  }
  const toastEl = el('toast');
  if (toastEl) {
    let html = '';
    for (const t of toasts) if (gameTime < t.until) html += '<div>' + t.text + '</div>';
    toastEl.innerHTML = html;
  }
  drawMinimap();
}

function drawMinimap() {
  const w = mini.width, h = mini.height;
  miniCtx.fillStyle = '#141418';
  miniCtx.fillRect(0, 0, w, h);
  if (minimapImg) miniCtx.drawImage(minimapImg, 0, 0, w, h);
  const sx = w / WORLD_W, sy = h / WORLD_H;
  const blip = function (x, y, color, r) {
    miniCtx.fillStyle = color;
    miniCtx.beginPath(); miniCtx.arc(x * sx, y * sy, r, 0, Math.PI * 2); miniCtx.fill();
  };
  for (const c of cars) if (c.police && !c.wreck) {
    const blink = ((gameTime * 4 + c.lightPhase) | 0) % 2 === 0;
    blip(c.x, c.y, blink ? '#ff4040' : '#4070ff', 3);
  }
  if (!missionState.active) {
    for (const m of missionState.markers) {
      if (gameTime < (missionState.cooldowns[m.def.id] || 0)) continue;
      blip(m.x, m.y, m.def.color, 3.5);
    }
  } else {
    const bs = missionState.active.blips ? missionState.active.blips() : [];
    for (const b of bs) blip(b.x, b.y, b.color, 3.5);
  }
  const px = player.inCar ? player.inCar.x : player.x;
  const py = player.inCar ? player.inCar.y : player.y;
  blip(px, py, '#ffffff', 4);
  blip(px, py, '#2fbf71', 2.2);
  // view rectangle
  miniCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  miniCtx.strokeRect(cam.x * sx, cam.y * sy, canvas.width * sx, canvas.height * sy);
}

/* ---------- init + main loop ---------- */

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function init() {
  genWorld(WORLD_SEED);
  buildMinimap();
  initMissions();
  loadMoney();
  const start = intersectionCenter(4, 4);
  player.x = start.x; player.y = start.y;
  cam.x = player.x - window.innerWidth / 2;
  cam.y = player.y - window.innerHeight / 2;
  // starter population around the player
  for (let i = 0; i < 7; i++) {
    const p = randomTilePoint([T.ROAD], player.x, player.y, 150, 800);
    if (p) {
      const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
      const vertical = isRoadTile(tx, ty - 1) || isRoadTile(tx, ty + 1);
      const dir = vertical ? (Math.random() < 0.5 ? 1 : 3) : (Math.random() < 0.5 ? 0 : 2);
      cars.push(makeCar(p.x, p.y, dir * Math.PI / 2, { ai: 'traffic', dir: dir }));
    }
  }
  for (let i = 0; i < 4; i++) {
    const p = randomTilePoint([T.ROAD], player.x, player.y, 80, 500);
    if (p) cars.push(makeCar(p.x, p.y, Math.random() * Math.PI * 2, { parked: true }));
  }
  for (let i = 0; i < 12; i++) {
    const p = randomTilePoint([T.SIDEWALK, T.PARK], player.x, player.y, 80, 700);
    if (p) peds.push(makePed(p.x, p.y));
  }
  resize();
  if (window.addEventListener) window.addEventListener('resize', resize);
  bindInput();
}

init();

let lastT = 0;
function loop(t) {
  const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0.016);
  lastT = t;
  step(dt);
  requestAnimationFrame(loop);
}
if (typeof requestAnimationFrame === 'function') requestAnimationFrame(loop);
