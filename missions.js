'use strict';
/* missions.js — five repeatable missions started from glowing street markers.
 * Each mission builds a small runtime object with update/draw/hud callbacks;
 * the manager drives it and handles payout, failure and marker cooldowns. */

const MISSION_DEFS = [
  { id: 'taxi',     name: 'Taxi Driver',    desc: 'Pick up 3 fares and get them there fast.',        color: '#ffd24a' },
  { id: 'delivery', name: 'Courier Run',    desc: 'Deliver 4 packages before the clock runs out.',   color: '#4ad2ff' },
  { id: 'race',     name: 'Street Race',    desc: 'Hit every checkpoint before time dies. Bring a car.', color: '#7dff6a' },
  { id: 'rampage',  name: 'Rampage',        desc: 'Cause 1000 points of chaos in 90 seconds.',       color: '#ff5a5a' },
  { id: 'escape',   name: 'Jailbreak Heat', desc: 'You are at 3 stars. Lose the cops to get paid.',  color: '#c77dff' }
];

const missionState = { markers: [], active: null, cooldowns: {} };

function initMissions() {
  const spots = [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]]; // intersection grid coords
  for (let i = 0; i < MISSION_DEFS.length; i++) {
    const c = intersectionCenter(spots[i][0], spots[i][1]);
    missionState.markers.push({ def: MISSION_DEFS[i], x: c.x, y: c.y });
  }
}

function distXY(x0, y0, x1, y1) { return Math.hypot(x1 - x0, y1 - y0); }
function playerSpeed() { return player.inCar ? player.inCar.speed : player.speedNow; }

function updateMissions(dt) {
  const px = player.inCar ? player.inCar.x : player.x;
  const py = player.inCar ? player.inCar.y : player.y;
  if (!missionState.active) {
    for (const m of missionState.markers) {
      if (gameTime < (missionState.cooldowns[m.def.id] || 0)) continue;
      if (distXY(px, py, m.x, m.y) < 46) { startMission(m); break; }
    }
    return;
  }
  const a = missionState.active;
  if (a.timed) {
    a.time -= dt;
    if (a.time <= 0) { failMission('Out of time'); return; }
  }
  a.update(dt);
}

function startMission(marker) {
  const def = marker.def;
  let rt = null;
  if (def.id === 'taxi') rt = buildTaxi(def);
  else if (def.id === 'delivery') rt = buildDelivery(def);
  else if (def.id === 'race') rt = buildRace(def, marker);
  else if (def.id === 'rampage') rt = buildRampage(def);
  else if (def.id === 'escape') rt = buildEscape(def);
  if (!rt) return;
  rt.def = def;
  missionState.active = rt;
  toast(def.name + ' — ' + def.desc);
  sfx('start');
}

function completeMission() {
  const rt = missionState.active;
  missionState.cooldowns[rt.def.id] = gameTime + 30;
  missionState.active = null;
  addMoney(rt.reward);
  toast(rt.def.name + ' complete! +$' + rt.reward);
  sfx('cash');
}

function failMission(why) {
  const rt = missionState.active;
  missionState.cooldowns[rt.def.id] = gameTime + 20;
  missionState.active = null;
  toast('Mission failed — ' + why);
  sfx('fail');
}

/* ---------- mission builders ---------- */

function buildTaxi(def) {
  const rt = { timed: false, time: 0, fare: 0, phase: 'pickup', reward: 0, target: null, timeLeft: 0 };
  rt.nextFare = function () {
    rt.fare++;
    rt.target = randomTilePoint([T.SIDEWALK], player.x, player.y, 500, 1300)
      || { x: player.x + 500, y: player.y };
    rt.phase = 'pickup';
  };
  rt.update = function (dt) {
    const px = player.inCar ? player.inCar.x : player.x;
    const py = player.inCar ? player.inCar.y : player.y;
    if (rt.phase === 'pickup') {
      if (distXY(px, py, rt.target.x, rt.target.y) < 60 && playerSpeed() < 60) {
        const d = randomTilePoint([T.SIDEWALK], rt.target.x, rt.target.y, 600, 1500)
          || { x: rt.target.x + 600, y: rt.target.y };
        rt.target = d;
        rt.timeLeft = distXY(px, py, d.x, d.y) / 230 + 14;
        rt.phase = 'dropoff';
        toast('Fare aboard — go, go, go!');
      }
    } else {
      rt.timeLeft -= dt;
      if (rt.timeLeft <= 0) { failMission('the fare lost patience'); return; }
      if (distXY(px, py, rt.target.x, rt.target.y) < 62 && playerSpeed() < 70) {
        const pay = 120 + Math.floor(rt.timeLeft * 8);
        rt.reward += pay;
        toast('Fare paid $' + pay);
        if (rt.fare >= 3) { rt.reward += 150; completeMission(); }
        else rt.nextFare();
      }
    }
  };
  rt.hud = function () {
    return rt.phase === 'pickup'
      ? 'Taxi: pick up fare ' + rt.fare + '/3'
      : 'Taxi: drop off — ' + Math.ceil(rt.timeLeft) + 's';
  };
  rt.blips = function () { return [{ x: rt.target.x, y: rt.target.y, color: def.color }]; };
  rt.nextFare();
  return rt;
}

function buildDelivery(def) {
  const targets = [];
  for (let i = 0; i < 4; i++) {
    const p = randomTilePoint([T.SIDEWALK], player.x, player.y, 450, 1600);
    if (p) targets.push(p);
  }
  const rt = { timed: true, time: 110, reward: 0, targets: targets, left: targets.length };
  rt.update = function () {
    const px = player.inCar ? player.inCar.x : player.x;
    const py = player.inCar ? player.inCar.y : player.y;
    for (let i = rt.targets.length - 1; i >= 0; i--) {
      const t = rt.targets[i];
      if (distXY(px, py, t.x, t.y) < 62 && playerSpeed() < 70) {
        rt.targets.splice(i, 1);
        rt.reward += 100;
        toast('Package delivered (+$100) — ' + rt.targets.length + ' left');
        sfx('cash');
      }
    }
    rt.left = rt.targets.length;
    if (rt.targets.length === 0) { rt.reward += 200; completeMission(); }
  };
  rt.hud = function () { return 'Courier: ' + rt.left + ' packages — ' + Math.ceil(rt.time) + 's'; };
  rt.blips = function () { return rt.targets.map(t => ({ x: t.x, y: t.y, color: def.color })); };
  return rt;
}

// random walk over the intersection grid -> checkpoints that always sit on roads
function genRacePath(x, y, count) {
  const maxA = Math.floor((MAP_W - 4) / ROAD_PERIOD);
  let a = Math.max(1, Math.min(maxA, Math.round((x / TILE - 1) / ROAD_PERIOD)));
  let b = Math.max(1, Math.min(maxA, Math.round((y / TILE - 1) / ROAD_PERIOD)));
  let dir = (Math.random() * 4) | 0;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const steps = 2 + ((Math.random() * 2) | 0);
    for (let s = 0; s < steps; s++) {
      a += DIRS[dir].x; b += DIRS[dir].y;
      if (a < 1 || a > maxA) { a -= DIRS[dir].x * 2 * steps; dir = (dir + 2) % 4; }
      if (b < 1 || b > maxA) { b -= DIRS[dir].y * 2 * steps; dir = (dir + 2) % 4; }
      a = Math.max(1, Math.min(maxA, a));
      b = Math.max(1, Math.min(maxA, b));
    }
    pts.push(intersectionCenter(a, b));
    if (Math.random() < 0.65) dir = (dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
  }
  return pts;
}

function buildRace(def, marker) {
  const cps = genRacePath(marker.x, marker.y, 8);
  const rt = { timed: true, time: 18, reward: 0, cps: cps, idx: 0 };
  rt.update = function () {
    const px = player.inCar ? player.inCar.x : player.x;
    const py = player.inCar ? player.inCar.y : player.y;
    const cp = rt.cps[rt.idx];
    if (cp && distXY(px, py, cp.x, cp.y) < 75) {
      rt.idx++;
      rt.time += 9;
      toast('Checkpoint ' + rt.idx + '/' + rt.cps.length + '  (+9s)');
      sfx('checkpoint');
      if (rt.idx >= rt.cps.length) {
        rt.reward = 400 + Math.floor(rt.time) * 5;
        completeMission();
      }
    }
  };
  rt.hud = function () { return 'Race: checkpoint ' + (rt.idx + 1) + '/' + rt.cps.length + ' — ' + Math.ceil(rt.time) + 's'; };
  rt.blips = function () {
    const out = [];
    if (rt.cps[rt.idx]) out.push({ x: rt.cps[rt.idx].x, y: rt.cps[rt.idx].y, color: def.color });
    if (rt.cps[rt.idx + 1]) out.push({ x: rt.cps[rt.idx + 1].x, y: rt.cps[rt.idx + 1].y, color: '#3a7a3a' });
    return out;
  };
  return rt;
}

function buildRampage(def) {
  const rt = { timed: true, time: 90, reward: 500, score: 0, goal: 1000 };
  rt.update = function () {
    if (rt.score >= rt.goal) completeMission();
  };
  rt.hud = function () { return 'Rampage: ' + rt.score + '/' + rt.goal + ' chaos — ' + Math.ceil(rt.time) + 's'; };
  rt.blips = function () { return []; };
  return rt;
}

function buildEscape(def) {
  const rt = { timed: true, time: 150, reward: 450 };
  setWanted(3);
  rt.update = function () {
    if (wanted <= 0) completeMission();
  };
  rt.hud = function () { return 'Lose the cops! — ' + Math.ceil(rt.time) + 's'; };
  rt.blips = function () { return []; };
  return rt;
}

// called from game.js whenever a crime happens; feeds the rampage score
function missionCrimeHook(type) {
  const a = missionState.active;
  if (!a || a.def.id !== 'rampage') return;
  const pts = { ped: 100, kill: 150, car: 80, shoot: 40, cop: 200 };
  a.score += pts[type] || 50;
}

/* ---------- mission world rendering ---------- */

function drawBeacon(g, x, y, color, time, big) {
  const pulse = 0.7 + 0.3 * Math.sin(time * 4);
  const r = (big ? 70 : 46) * pulse;
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  const grad = g.createLinearGradient(x, y - 190, x, y);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, color);
  g.globalAlpha = 0.28 * pulse;
  g.fillStyle = grad;
  g.fillRect(x - 13, y - 190, 26, 190);
  g.globalAlpha = 1;
}

function drawMissionWorld(g, time) {
  if (!missionState.active) {
    for (const m of missionState.markers) {
      if (gameTime < (missionState.cooldowns[m.def.id] || 0)) continue;
      drawBeacon(g, m.x, m.y, m.def.color, time, false);
    }
    return;
  }
  const a = missionState.active;
  if (a.def.id === 'taxi' && a.target) drawBeacon(g, a.target.x, a.target.y, a.def.color, time, true);
  else if (a.def.id === 'delivery') for (const t of a.targets) drawBeacon(g, t.x, t.y, a.def.color, time, false);
  else if (a.def.id === 'race') {
    const cp = a.cps[a.idx];
    if (cp) {
      drawBeacon(g, cp.x, cp.y, a.def.color, time, true);
      g.strokeStyle = a.def.color;
      g.lineWidth = 5;
      g.beginPath(); g.arc(cp.x, cp.y, 72, 0, Math.PI * 2); g.stroke();
    }
  }
}
