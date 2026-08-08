# Open City

Top-down 2D open-world crime sandbox: procedural city, driving with drift, traffic & pedestrian AI, police wanted system, 5 missions. Canvas, no dependencies.

## Features

- Procedural island city from a seeded tile map: road grid with intersections and lane dashes, building blocks with shaded rooftops, parks with trees, lakes and a water border
- Smooth velocity-look-ahead camera following the player on foot or in a car
- On-foot mode (WASD) and driving mode: walk up to any car and press E to enter/exit — steal traffic cars or even cop cars (it's a crime)
- Arcade car physics: acceleration, braking, reverse, handbrake drifting, collision with buildings and other cars, damage and wrecks
- Traffic AI that keeps right-hand lanes, decides turns at intersections and brakes for obstacles; pedestrians that wander sidewalks and flee from gunfire, crashes and speeding cars
- Police wanted system with 0-5 stars: running over pedestrians, crashing into cars, shooting and stealing cars raise heat; police cruisers chase, ram and get reinforcements; stars decay when you break line of sight and lie low
- 5 repeatable missions started from glowing street beacons, all paying money:
  - **Taxi Driver** — 3 chained fares, paid by speed
  - **Courier Run** — 4 timed package drop-offs
  - **Street Race** — 8 checkpoints on a generated road loop, each adds time
  - **Rampage** — 1000 chaos points in 90 seconds
  - **Jailbreak Heat** — starts at 3 wanted stars, lose the cops to get paid
- HUD: minimap with player/police/mission blips and viewport rect, money, wanted stars, mission tracker, speedometer, toast messages
- Day/night cycle with a darkness overlay punched by street lamps, headlights and mission beacons
- Touch support: virtual joystick + FIRE / E buttons on touch devices
- Money persists across sessions via localStorage; tiny WebAudio sound effects generated in code (no assets)

## Run

Open index.html in any modern browser. No build step, no dependencies.

## Controls

- **WASD / arrows** — walk, or throttle / steer when driving
- **E** — enter / exit a nearby car
- **Space** — handbrake (drift)
- **Mouse** — aim, **click or F** — shoot (hold to keep firing)
- Walk into a glowing beacon to start its mission

## Tech notes

- Single `Uint8Array` tile map drives rendering, collision (circle-vs-tile resolution), AI navigation, line-of-sight checks and the prerendered minimap — one source of truth, no scene graph
- Car physics splits velocity into a forward component (engine/brake/drag) and a lateral component decayed by grip; the handbrake slashes grip so the car slides — drift emerges from the model instead of being scripted
- Traffic follows compass directions with right-hand lane-center correction and intersection decision points; police use pursuit steering with a fan of probe rays to slide around buildings and a reverse-unstick behavior
- Night rendering is a separate canvas composited with `destination-out` radial gradients for every light source, so lamps and headlights genuinely illuminate the darkness
- Whole game is plain-script globals across 4 files (`world.js`, `entities.js`, `missions.js`, `game.js`) so it runs from `file://` with zero tooling; the simulation is headless-testable (step function) and was verified with a stubbed-DOM Node smoke test

## Roadmap

- Player health, hospital/wasted respawn and busted state when cops pin you
- More vehicle types (taxi cab requirement for fares, faster sports cars, heavier trucks) with per-model handling stats
- Pedestrian drivers who abandon wrecked traffic cars, and armed police on foot at high wanted levels
- Roadblocks and spike strips at 4+ stars, plus a helicopter searchlight at 5
- Safehouse map screen with mission replay medals and best-time leaderboards in localStorage
- Gamepad support and a proper drift scoring system for the race mission
