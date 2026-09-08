/* Three.js view over the headless simulation in sim.js.
 *
 * This file owns rendering, camera, input and audio. It owns no game rules — those
 * live in sim.js, shared in spirit with the 2D Canvas port. If a number here changes
 * how the game plays rather than how it looks, it's in the wrong file.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSim, T } from "./sim.js";

const M = window.MAZE;
const $ = (id) => document.getElementById(id);

/* Panda world coords are (x east, y north, z up); the exporter's root node flips
   Z-up to Y-up, so a game point (x, y, z) sits at (x, z, -y) in Three. */
const TO3 = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

const ENEMY_TINT = {
  cheken: 0xffe08a, chris: 0x8fdc72, fetus: 0xff9ec4, rose: 0xd98cff,
};
const ORB_TINT = { red: 0xff4d5e, white: 0xeaf4ff, yellow: 0xffd24d, blue: 0x4db8ff };

// ---------------------------------------------------------------- audio
const Sound = (() => {
  let ctx = null, master = null, muted = false;
  const ensure = () => {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.45;
    master.connect(ctx.destination);
  };
  const tone = (type, f0, f1, dur, gain) => {
    if (muted || !ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  };
  const noise = (dur, gain, freq) => {
    if (muted || !ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start();
  };
  return {
    unlock() { ensure(); if (ctx && ctx.state === "suspended") ctx.resume(); },
    toggle() { muted = !muted; return muted; },
    shoot()      { tone("square", 720, 300, 0.07, 0.04); },
    enemyShoot() { tone("sawtooth", 260, 190, 0.09, 0.02); },
    hit()        { noise(0.06, 0.12, 1400); },
    kill()       { tone("square", 300, 70, 0.3, 0.07); noise(0.2, 0.15, 700); },
    orb()        { tone("sine", 620, 1180, 0.18, 0.08); },
    donut()      { tone("sine", 380, 720, 0.16, 0.07); },
    damage()     { tone("sawtooth", 190, 70, 0.22, 0.085); },
    denied()     { tone("square", 150, 110, 0.22, 0.05); },
    jump()       { tone("sine", 300, 620, 0.09, 0.03); },
    win()  { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone("triangle", f, f, 0.26, 0.09), i * 110)); },
    lose() { [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone("sawtooth", f, f * 0.85, 0.34, 0.07), i * 150)); },
  };
})();

// ---------------------------------------------------------------- renderer
const canvas = $("game");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070b);
scene.fog = new THREE.Fog(0x070c14, 70, 330);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1200);

// The maze has a ceiling, and its faces point straight down — under a hemisphere
// light that means they only ever receive the ground colour, so they render pure
// black across the top of the screen. A little ambient keeps them readable.
scene.add(new THREE.HemisphereLight(0x6fd8ff, 0x1b2836, 1.15));
scene.add(new THREE.AmbientLight(0x35506a, 0.55));
const key = new THREE.DirectionalLight(0xdff4ff, 2.0);
key.position.set(50, 110, 40);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 260;
key.shadow.camera.left = -45; key.shadow.camera.right = 45;
key.shadow.camera.top = 45;   key.shadow.camera.bottom = -45;
key.shadow.bias = -0.002;
scene.add(key, key.target);

const portalLight = new THREE.PointLight(0x7ee08a, 160, 100);
portalLight.position.copy(TO3(M.PORTAL.x, M.PORTAL.y, 7));
scene.add(portalLight);

// ---------------------------------------------------------------- sim
const sim = createSim(M);

// ---------------------------------------------------------------- input
const keys = Object.create(null);
const input = { mx: 0, my: 0, aim: 0, fire: false, jump: false };
let mouseFire = false;
const LOOK_SPEED = 0.0042;      // rad per pixel; 0.0022 felt like turning in treacle
const TOUCH_LOOK = 0.010;
const move = { x: 0, y: 0 };    // smoothed, so a key tap doesn't cross a corridor
let yaw = Math.PI / 2, pitch = 0.24;
let locked = false;

addEventListener("keydown", (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  keys[k] = true;
  if (k === " " || k.startsWith("Arrow")) e.preventDefault();
  if (k === "m") toggleMute();
});
addEventListener("keyup", (e) => { keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false; });
addEventListener("blur", () => { for (const k in keys) keys[k] = false; mouseFire = false; });

/** Pointer lock is unavailable in some embedded contexts; fall back to drag-to-look. */
function lockPointer() {
  try {
    // Chrome returns a promise here and rejects it in embedded contexts; older
    // browsers return undefined. Promise.resolve handles both without leaving an
    // unhandled rejection in the console.
    Promise.resolve(canvas.requestPointerLock && canvas.requestPointerLock())
      .catch(() => {});
  } catch (_) { /* drag-to-look still works */ }
}

canvas.addEventListener("click", () => {
  Sound.unlock();
  if (sim.state === "play" && !locked) lockPointer();
});
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  $("hint").hidden = locked || sim.state !== "play";
});
let dragging = false;
canvas.addEventListener("mousedown", () => { dragging = true; });
addEventListener("mouseup", () => { dragging = false; });
addEventListener("mousemove", (e) => {
  // Pointer lock is the good path, but it isn't always available (embedded frames,
  // or the player pressed Esc). Drag-to-look keeps the game controllable either way.
  if (!locked && !dragging) return;
  yaw -= e.movementX * LOOK_SPEED;
  pitch = Math.max(-0.30, Math.min(0.58, pitch + e.movementY * LOOK_SPEED * 0.8));
});
// Fire on any left click over the canvas. Gating this on pointer lock meant that
// if the lock failed or the player pressed Esc, clicking did nothing whatsoever.
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0 && sim.state === "play") mouseFire = true;
});
addEventListener("mouseup", (e) => { if (e.button === 0) mouseFire = false; });

// touch: left half moves, right half looks, tap-and-hold on the right fires
const touch = { move: null, lookId: null, lastX: 0, lastY: 0, fire: false };
const isTouch = matchMedia("(pointer: coarse)").matches;
if (isTouch) $("touch").hidden = false;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  Sound.unlock();
  canvas.setPointerCapture(e.pointerId);
  if (e.clientX < innerWidth / 2) {
    touch.move = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
    placeStick(e.clientX, e.clientY, 0, 0);
  } else {
    touch.lookId = e.pointerId; touch.lastX = e.clientX; touch.lastY = e.clientY;
    touch.fire = true;
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (touch.move && e.pointerId === touch.move.id) {
    const dx = e.clientX - touch.move.ox, dy = e.clientY - touch.move.oy;
    const d = Math.hypot(dx, dy) || 1, cl = Math.min(d, 46);
    placeStick(touch.move.ox, touch.move.oy, (dx / d) * cl, (dy / d) * cl);
    touch.move.x = d < 8 ? 0 : dx / d;
    touch.move.y = d < 8 ? 0 : -dy / d;
  } else if (e.pointerId === touch.lookId) {
    yaw -= (e.clientX - touch.lastX) * TOUCH_LOOK;
    pitch = Math.max(-0.30, Math.min(0.58, pitch + (e.clientY - touch.lastY) * TOUCH_LOOK * 0.8));
    touch.lastX = e.clientX; touch.lastY = e.clientY;
  }
});
function endTouch(e) {
  if (touch.move && e.pointerId === touch.move.id) { touch.move = null; $("stick").style.cssText = ""; }
  if (e.pointerId === touch.lookId) { touch.lookId = null; touch.fire = false; }
}
canvas.addEventListener("pointerup", endTouch);
canvas.addEventListener("pointercancel", endTouch);
function placeStick(cx, cy, dx, dy) {
  const s = $("stick");
  s.style.left = cx - 59 + "px"; s.style.top = cy - 59 + "px";
  s.style.right = "auto"; s.style.bottom = "auto";
  s.firstElementChild.style.transform = `translate(${dx}px,${dy}px)`;
}
$("btnJump").addEventListener("pointerdown", (e) => { e.preventDefault(); keys[" "] = true; });
$("btnJump").addEventListener("pointerup", () => { keys[" "] = false; });

// ---------------------------------------------------------------- assets
const loader = new GLTFLoader();
const load = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let ready = false;                 // assets loaded; startGame is a no-op before this
let ralph, mixer, clipRun, clipWalk, active = null;
const enemyMeshes = [];
const orbMeshes = [];
const donutMeshes = [];
const shotPool = [];
const eshotPool = [];
let portal;
const particles = [];

function poolShot(pool, color, radius) {
  const geo = new THREE.SphereGeometry(radius, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color });
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    pool.push(m);
  }
}

async function boot() {
  const urls = ["assets/maze.glb", "assets/ralph.glb", "assets/cheken.glb", "assets/gianteye.glb"];
  let done = 0;
  const bar = $("loadbar");
  const [mazeG, ralphG, chekenG, eyeG] = await Promise.all(urls.map(async (u) => {
    const g = await load(u);
    bar.style.transform = `scaleX(${++done / urls.length})`;
    return g;
  }));

  mazeG.scene.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = true; } });
  scene.add(mazeG.scene);

  ralph = ralphG.scene;
  ralph.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  scene.add(ralph);
  mixer = new THREE.AnimationMixer(ralph);
  for (const c of ralphG.animations) {
    if (c.name === "run") clipRun = mixer.clipAction(c);
    if (c.name === "walk") clipWalk = mixer.clipAction(c);
  }

  // one source mesh, tinted per enemy type — 4 separate models would be ~50 MB
  const src = chekenG.scene;
  for (const e of sim.enemies) {
    const m = src.clone(true);
    m.scale.setScalar(0.4);
    m.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.material = o.material.clone();
      o.material.color = new THREE.Color(ENEMY_TINT[e.type] || 0xffffff);
    });
    scene.add(m);
    enemyMeshes.push(m);
  }

  portal = eyeG.scene;
  portal.position.copy(TO3(M.PORTAL.x, M.PORTAL.y, 0));
  scene.add(portal);

  const orbGeo = new THREE.SphereGeometry(0.95, 16, 12);
  for (const o of sim.orbs) {
    const m = new THREE.Mesh(orbGeo, new THREE.MeshStandardMaterial({
      color: ORB_TINT[o.c] || 0xffffff, emissive: ORB_TINT[o.c] || 0xffffff,
      emissiveIntensity: 1.1, roughness: 0.35,
    }));
    m.position.copy(TO3(o.x, o.y, 1.9));
    scene.add(m);
    orbMeshes.push(m);
  }

  const donutGeo = new THREE.TorusGeometry(0.85, 0.34, 10, 20);
  for (const d of sim.donuts) {
    const m = new THREE.Mesh(donutGeo, new THREE.MeshStandardMaterial({
      color: 0xffb35c, emissive: 0xff8a3c, emissiveIntensity: 0.55, roughness: 0.5,
    }));
    m.position.copy(TO3(d.x, d.y, 1.7));
    m.rotation.x = Math.PI / 2;
    scene.add(m);
    donutMeshes.push(m);
  }

  poolShot(shotPool, 0x9ff4ff, 0.28);
  poolShot(eshotPool, 0xff8a5c, 0.36);

  ready = true;
  $("loading").hidden = true;
  $("title").hidden = false;
  resize();
  renderer.setAnimationLoop(frame);
}

// ---------------------------------------------------------------- particles
const partGeo = new THREE.SphereGeometry(0.13, 5, 4);   // Ralph is ~2 units tall
function burst(x, y, z, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    m.position.copy(TO3(x, y, z));
    const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2;
    const s = speed * (0.4 + Math.random());
    m.userData.v = new THREE.Vector3(Math.cos(a) * s, Math.sin(e) * s, Math.sin(a) * s);
    m.userData.life = 0.5 + Math.random() * 0.4;
    m.userData.t = 0;
    scene.add(m);
    particles.push(m);
  }
}

// ---------------------------------------------------------------- camera
const CAM_DIST = 8, CAM_HEIGHT = 2.6;
// The maze mesh tops out at z = 8.33. Pitching up used to raise the boom past that
// (2.6 + 8*sin(0.95) = 9.1) and pop the camera through the ceiling into open space.
const CEILING_Z = 8.33, CAM_MIN_Z = 0.85;

function updateCamera(p) {
  // Look direction in game space, then converted. Pitch raises the camera rather
  // than tilting past the character.
  const back = CAM_DIST * Math.cos(pitch);
  const up = CAM_HEIGHT + CAM_DIST * Math.sin(pitch);

  const px = p.x - Math.cos(yaw) * back;
  const py = p.y - Math.sin(yaw) * back;

  // Pull the camera in if a wall is between it and the player — the maze has
  // 13-unit rooms, so a fixed boom ends up inside geometry constantly. Sample finely:
  // at 8 steps an 8-unit boom skips a whole cell between probes and slides through
  // thin walls.
  const STEPS = 20;
  let f = 1;
  for (let s = 1; s <= STEPS; s++) {
    const t = s / STEPS;
    const tx = p.x + (px - p.x) * t, ty = p.y + (py - p.y) * t;
    if (sim.hitsWall(tx, ty, 1.4)) { f = Math.max(0.06, (s - 1) / STEPS); break; }
  }
  // keep the camera inside the building, whatever the pitch
  const rawZ = p.z + up * f + 1.5 * (1 - f);
  const camZ = Math.min(CEILING_Z - 1.15, Math.max(CAM_MIN_Z, rawZ));
  camera.position.copy(TO3(p.x + (px - p.x) * f, p.y + (py - p.y) * f, camZ));
  const look = TO3(p.x + Math.cos(yaw) * 9, p.y + Math.sin(yaw) * 9, p.z + 3.4);
  camera.lookAt(look);
  key.position.copy(TO3(p.x + 40, p.y + 30, 90));
  key.target.position.copy(TO3(p.x, p.y, 0));
  key.target.updateMatrixWorld();
}

// ---------------------------------------------------------------- HUD
let lastHud = "";
function syncHud() {
  const p = sim.player;
  const k = `${p.hp}|${sim.orbsHeld}|${sim.kills}|${Math.ceil(sim.timeLeft)}`;
  if (k === lastHud) return;
  lastHud = k;
  $("hpfill").style.transform = `scaleX(${p.hp / T.startHP})`;
  $("hplabel").textContent = p.hp;
  $("hpwrap").classList.toggle("low", p.hp <= 30);
  $("vOrbs").textContent = `${sim.orbsHeld}/${T.needOrbs}`;
  $("vKills").textContent = `${sim.kills}/${T.needKills}`;
  $("chipOrbs").classList.toggle("done", sim.orbsHeld >= T.needOrbs);
  $("chipKills").classList.toggle("done", sim.kills >= T.needKills);
  const s = Math.max(0, Math.ceil(sim.timeLeft));
  const el = $("timer");
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  el.classList.toggle("warn", s <= 60 && s > 20);
  el.classList.toggle("crit", s <= 20);
}

function handleEvents() {
  for (const ev of sim.events) {
    switch (ev.type) {
      case "shoot": Sound.shoot(); break;
      case "enemyShoot": Sound.enemyShoot(); break;
      case "hit": Sound.hit(); burst(ev.x, ev.y, ev.z, 0xffd24d, 6, 9); break;
      case "kill": Sound.kill(); burst(ev.x, ev.y, ev.z, 0xff8a5c, 16, 13); break;
      case "sparks": burst(ev.x, ev.y, ev.z, new THREE.Color(ev.color), 4, 7); break;
      case "orb": Sound.orb(); burst(ev.x, ev.y, ev.z, new THREE.Color(ORB_TINT[ev.color] || 0xffffff), 14, 10); break;
      case "donut": Sound.donut(); burst(ev.x, ev.y, ev.z, 0xffb35c, 10, 9); break;
      case "damage": Sound.damage(); flash(); break;
      case "denied": Sound.denied(); break;
      case "jump": Sound.jump(); break;
      case "win": Sound.win(); finish(true); break;
      case "lose": Sound.lose(); finish(false); break;
    }
  }
  sim.events.length = 0;
}

let hurt = 0;
const flash = () => { hurt = 1; };

function finish(won) {
  document.exitPointerLock?.();
  $("hud").hidden = true;
  $("hint").hidden = true;
  $("verdict").textContent = won ? "You Win" : "Game Over";
  $("verdict").className = "verdict " + (won ? "win" : "lose");
  const s = Math.max(0, Math.ceil(sim.timeLeft));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  $("reason").textContent = won ? `Escaped with ${clock} left on the clock.` : sim.reason;
  $("tally").innerHTML =
    `<div><b>${sim.kills}</b>KILLS</div><div><b>${sim.orbsHeld}</b>ORBS</div><div><b>${clock}</b>LEFT</div>`;
  $("end").hidden = false;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();

/** dtOverride lets tests advance the view deterministically, without depending on
 *  requestAnimationFrame (which a hidden tab never fires). */
function frame(dtOverride) {
  const dt = Math.min(0.05, typeof dtOverride === "number" ? dtOverride : clock.getDelta());

  if (sim.state === "play") {
    // forward/back at full speed, strafe reduced — sidestepping at the same rate as
    // running is what made side-to-side feel like it crossed a whole corridor
    let fwd = 0, side = 0;
    if (keys.w || keys.ArrowUp) fwd += 1;
    if (keys.s || keys.ArrowDown) fwd -= 1;
    if (keys.d || keys.ArrowRight) side += 1;
    if (keys.a || keys.ArrowLeft) side -= 1;
    if (touch.move) { fwd += touch.move.y; side += touch.move.x; }
    const mag = Math.hypot(fwd, side);
    if (mag > 1) { fwd /= mag; side /= mag; }
    side *= T.strafeFactor;

    const f = { x: Math.cos(yaw), y: Math.sin(yaw) };
    const r = { x: Math.cos(yaw - Math.PI / 2), y: Math.sin(yaw - Math.PI / 2) };
    const tx = f.x * fwd + r.x * side;
    const ty = f.y * fwd + r.y * side;

    // ramp toward the target instead of snapping to it
    const k = Math.min(1, dt * T.moveSmoothing);
    move.x += (tx - move.x) * k;
    move.y += (ty - move.y) * k;
    if (Math.abs(move.x) < 0.004) move.x = 0;
    if (Math.abs(move.y) < 0.004) move.y = 0;

    input.mx = move.x; input.my = move.y;
    input.aim = yaw;
    input.fire = mouseFire || touch.fire || !!keys.f || !!keys.Enter;
    input.jump = !!keys[" "];

    sim.step(dt, input);
    handleEvents();
    syncHud();
    $("msg").textContent = sim.message;
    $("msg").classList.toggle("show", !!sim.message);
  }

  // ---- sync visuals to sim state
  const p = sim.player;
  if (ralph) {
    ralph.position.copy(TO3(p.x, p.y, p.z));
    // Ralph's model faces -Y in Panda space, which is +Z after the axis flip
    ralph.rotation.y = Math.atan2(Math.cos(p.aim), -Math.sin(p.aim));
    const want = p.moving ? clipRun : null;
    if (want !== active) {
      if (active) active.fadeOut(0.18);
      active = want;
      if (active) active.reset().fadeIn(0.18).play();
    }
    if (mixer) mixer.update(dt);
  }

  for (let i = 0; i < enemyMeshes.length; i++) {
    const e = sim.enemies[i], m = enemyMeshes[i];
    m.visible = e.alive;
    if (!e.alive) continue;
    m.position.copy(TO3(e.x, e.y, 0));
    m.lookAt(TO3(p.x, p.y, 0));            // the original's permanent lookAt
    const flashOn = e.flash > 0;
    m.traverse((o) => {
      if (o.isMesh) o.material.emissive = new THREE.Color(flashOn ? 0xff3344 : 0x000000);
    });
  }

  for (let i = 0; i < orbMeshes.length; i++) {
    const o = sim.orbs[i];
    orbMeshes[i].visible = !o.got;
    if (!o.got) {
      orbMeshes[i].position.y = 1.9 + Math.sin(sim.t * 2.4 + i) * 0.35;
      orbMeshes[i].rotation.y += dt;
    }
  }
  for (let i = 0; i < donutMeshes.length; i++) {
    donutMeshes[i].visible = !sim.donuts[i].got;
    donutMeshes[i].rotation.z += dt * 1.6;
  }

  drawPool(shotPool, sim.shots);
  drawPool(eshotPool, sim.eshots);

  if (portal) {
    portal.rotation.y += dt * 0.9;
    const ready = sim.orbsHeld >= T.needOrbs && sim.kills >= T.needKills;
    portalLight.color.setHex(ready ? 0x7ee08a : 0x4b6a86);
    portalLight.intensity = 140 + Math.sin(sim.t * 2) * 40;
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.userData.t += dt;
    if (q.userData.t >= q.userData.life) { scene.remove(q); particles.splice(i, 1); continue; }
    q.position.addScaledVector(q.userData.v, dt);
    q.userData.v.multiplyScalar(0.92);
    q.userData.v.y -= 14 * dt;
    q.material.opacity = 1 - q.userData.t / q.userData.life;
  }

  updateCamera(p);

  if (hurt > 0) { hurt = Math.max(0, hurt - dt * 2.2); $("hurt").style.opacity = hurt * 0.45; }

  renderer.render(scene, camera);
}

function drawPool(pool, list) {
  for (let i = 0; i < pool.length; i++) {
    const on = i < list.length;
    pool[i].visible = on;
    if (on) pool[i].position.copy(TO3(list[i].x, list[i].y, list[i].z));
  }
}

// ---------------------------------------------------------------- ui
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

function startGame() {
  if (!ready) return;              // don't start on top of a half-loaded scene
  Sound.unlock();
  sim.start();
  yaw = Math.PI / 2; pitch = 0.24;
  lastHud = "";
  $("title").hidden = true;
  $("end").hidden = true;
  $("hud").hidden = false;
  $("hint").hidden = isTouch;
  syncHud();
  if (!isTouch) lockPointer();
}

function toggleMute() {
  $("mute").textContent = Sound.toggle() ? "SOUND OFF" : "SOUND ON";
}

$("btnStart").addEventListener("click", startGame);
$("btnAgain").addEventListener("click", startGame);
$("btnMenu").addEventListener("click", () => {
  sim.state = "title";
  $("end").hidden = true;
  $("hud").hidden = true;
  $("title").hidden = false;
});
$("mute").addEventListener("click", toggleMute);

window.__GAME3D = { sim, T, scene, camera, renderer, startGame, frame,
                    get ready() { return ready; },
                    get yaw() { return yaw; }, set yaw(v) { yaw = v; },
                    get pitch() { return pitch; }, set pitch(v) { pitch = v; },
                    PITCH_MIN: -0.30, PITCH_MAX: 0.58, CEILING_Z,
                    keys, input };

boot().catch((err) => {
  $("loading").innerHTML =
    `<p style="color:#ff6b7a;max-width:60ch">Failed to load: ${err && err.message ? err.message : err}</p>`;
  console.error(err);
});
