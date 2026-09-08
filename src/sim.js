/* Headless game simulation — no rendering, no DOM, no Three.js.
 *
 * These are the 2016 game's rules, carried over from the Phase 2 Canvas port
 * (imelendez/amazing-race-web) where they're covered by 29 tests. The point of
 * keeping this file renderer-agnostic is that the 2D and 3D builds are two views
 * of one game, not two games.
 *
 * The only thing 3D adds back is the jump, which the original had and the
 * top-down port dropped.
 */

export const T = {
  playerR: 3.2,
  // The original ran at 60, but that was a top-down/behind view of a 1-unit-tall
  // character in ~15-unit corridors — 58 units/sec is nearly 60 body-lengths a
  // second, which reads as teleporting from a third-person camera. Slower here.
  playerSpeed: 44,
  strafeFactor: 0.75,       // sideways is slower than forward, as in most shooters
  moveSmoothing: 11,        // per-second ramp, so a tap doesn't cross a corridor
  jumpV: 9,                 // original: vz = 8, gravity 16
  gravity: 26,
  shotSpeed: 120,
  shotR: 1.0,
  shotLife: 2.4,
  fireCooldown: 0.17,

  enemyR: 3.6,
  enemyHP: 5,               // original was 7 hits
  enemySpeed: 7,            // straight from the original
  enemyPatrol: 5,           // ±5 units on a fixed axis — from the original
  enemyShotSpeed: 62,
  enemyShotR: 1.4,
  enemyFireCd: 1.15,
  enemySightRange: 155,
  enemyDamage: 5,           // −5 HP per hit, from the original

  orbR: 5,
  donutR: 5,
  donutHeal: 15,
  portalR: 9,

  startHP: 100,
  timeLimit: 240,           // 4:00, from the original
  needOrbs: 3,
  needKills: 4,
};

export function createSim(M) {
  const { CELL, GW, GH, ORIGIN_X, TOP_Y } = M;
  const GRID = M.decodeGrid();

  const gi = (x) => Math.floor((x - ORIGIN_X) / CELL);
  const gj = (y) => Math.floor((TOP_Y - y) / CELL);
  const isWallCell = (i, j) =>
    i < 0 || i >= GW || j < 0 || j >= GH ? true : !!GRID[j * GW + i];

  function hitsWall(x, y, r) {
    const i0 = gi(x - r), i1 = gi(x + r);
    const j0 = gj(y + r), j1 = gj(y - r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || i >= GW || j < 0 || j >= GH) return true;
        if (!GRID[j * GW + i]) continue;
        const rx0 = ORIGIN_X + i * CELL, rx1 = rx0 + CELL;
        const ry1 = TOP_Y - j * CELL, ry0 = ry1 - CELL;
        const cx = x < rx0 ? rx0 : x > rx1 ? rx1 : x;
        const cy = y < ry0 ? ry0 : y > ry1 ? ry1 : y;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  function canSee(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const steps = Math.ceil(Math.hypot(dx, dy) / (CELL * 0.7));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (isWallCell(gi(ax + dx * t), gj(ay + dy * t))) return false;
    }
    return true;
  }

  const S = {
    T, hitsWall, canSee, isWallCell, gi, gj,
    state: "title",
    events: [],           // drained by the view each frame for sound/particles
  };

  S.reset = function () {
    S.t = 0;
    S.timeLeft = T.timeLimit;
    S.kills = 0;
    S.orbsHeld = 0;
    S.shots = [];
    S.eshots = [];
    S.portalTouch = false;
    S.message = "";
    S.messageT = 0;
    S.events.length = 0;
    S.player = {
      x: M.SPAWN.x, y: M.SPAWN.y, z: 0, vz: 0,
      aim: Math.PI / 2, hp: T.startHP, cd: 0,
      grounded: true, moving: false,
    };
    S.enemies = M.ENEMIES.map((e) => ({
      type: e.t, x: e.x, y: e.y, hx: e.x, hy: e.y,
      axis: e.axis === "X" ? "x" : "y", dir: 1,
      hp: T.enemyHP, alive: true, cd: Math.random() * T.enemyFireCd, flash: 0,
    }));
    S.orbs = M.ORBS.map((o) => ({ x: o.x, y: o.y, c: o.c, got: false }));
    S.donuts = M.DONUTS.map((d) => ({ x: d.x, y: d.y, got: false }));
  };

  const emit = (type, x, y, z, extra) =>
    S.events.push(Object.assign({ type, x, y, z: z || 0 }, extra));

  function say(msg, secs) {
    S.message = msg;
    S.messageT = secs || 2;
  }

  function slide(e, dx, dy, r) {
    if (dx && !hitsWall(e.x + dx, e.y, r)) e.x += dx;
    if (dy && !hitsWall(e.x, e.y + dy, r)) e.y += dy;
  }

  /** input: { mx, my, aim, fire, jump } — mx/my is a normalised world-space move vector */
  S.step = function (dt, input) {
    S.t += dt;
    if (S.messageT > 0 && (S.messageT -= dt) <= 0) S.message = "";
    if (S.state !== "play") return;

    S.timeLeft -= dt;
    if (S.timeLeft <= 0) {
      S.timeLeft = 0;
      return end(false, "Time ran out.");
    }

    const p = S.player;
    p.aim = input.aim;

    // --- movement
    // Respect the magnitude of the input, clamped to 1: normalising it unconditionally
    // would throw away the view's acceleration ramp and its reduced strafe speed, and
    // an analog stick at 20% would move you at full pace.
    const len = Math.hypot(input.mx, input.my);
    p.moving = len > 0.02;
    if (p.moving) {
      const speed = Math.min(1, len) * T.playerSpeed * dt;
      slide(p, (input.mx / len) * speed, (input.my / len) * speed, T.playerR);
    }

    // --- jump (the original had one; the 2D port dropped it)
    if (input.jump && p.grounded) {
      p.vz = T.jumpV;
      p.grounded = false;
      emit("jump", p.x, p.y, p.z);
    }
    if (!p.grounded) {
      p.vz -= T.gravity * dt;
      p.z += p.vz * dt;
      if (p.z <= 0) { p.z = 0; p.vz = 0; p.grounded = true; }
    }

    // --- firing
    p.cd -= dt;
    if (input.fire && p.cd <= 0) {
      p.cd = T.fireCooldown;
      const sx = p.x + Math.cos(p.aim) * (T.playerR + 1);
      const sy = p.y + Math.sin(p.aim) * (T.playerR + 1);
      S.shots.push({
        x: sx, y: sy, z: p.z + 1.6,
        vx: Math.cos(p.aim) * T.shotSpeed,
        vy: Math.sin(p.aim) * T.shotSpeed,
        life: T.shotLife,
      });
      emit("shoot", sx, sy, p.z + 1.6);
    }

    // --- player shots
    for (let i = S.shots.length - 1; i >= 0; i--) {
      const s = S.shots[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0 || hitsWall(s.x, s.y, T.shotR)) {
        if (s.life > 0) emit("sparks", s.x, s.y, s.z, { color: "#7fe9ff" });
        S.shots.splice(i, 1);
        continue;
      }
      for (const e of S.enemies) {
        if (!e.alive) continue;
        if (Math.hypot(e.x - s.x, e.y - s.y) < T.enemyR + T.shotR) {
          e.hp--; e.flash = 0.14;
          S.shots.splice(i, 1);
          emit("sparks", s.x, s.y, s.z, { color: "#ffd24d" });
          if (e.hp <= 0) {
            e.alive = false;
            S.kills++;
            emit("kill", e.x, e.y, 2);
            if (S.kills === T.needKills) say("Kill quota met.", 1.8);
          } else emit("hit", e.x, e.y, 2);
          break;
        }
      }
    }

    // --- enemies
    for (const e of S.enemies) {
      if (!e.alive) continue;
      if (e.flash > 0) e.flash -= dt;

      const home = e.axis === "x" ? e.hx : e.hy;
      const cur = e.axis === "x" ? e.x : e.y;
      if (cur - home > T.enemyPatrol) e.dir = -1;
      else if (cur - home < -T.enemyPatrol) e.dir = 1;

      const step = e.dir * T.enemySpeed * dt;
      const nx = e.axis === "x" ? e.x + step : e.x;
      const ny = e.axis === "y" ? e.y + step : e.y;
      if (hitsWall(nx, ny, T.enemyR)) e.dir *= -1;
      else { e.x = nx; e.y = ny; }

      e.cd -= dt;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (e.cd <= 0 && d < T.enemySightRange && canSee(e.x, e.y, p.x, p.y)) {
        e.cd = T.enemyFireCd;
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        S.eshots.push({
          x: e.x + Math.cos(a) * (T.enemyR + 1),
          y: e.y + Math.sin(a) * (T.enemyR + 1),
          z: 2,
          vx: Math.cos(a) * T.enemyShotSpeed,
          vy: Math.sin(a) * T.enemyShotSpeed,
          life: 4,
        });
        if (d < 120) emit("enemyShoot", e.x, e.y, 2);
      }
    }

    // --- enemy shots
    for (let i = S.eshots.length - 1; i >= 0; i--) {
      const s = S.eshots[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0 || hitsWall(s.x, s.y, T.enemyShotR)) {
        S.eshots.splice(i, 1);
        continue;
      }
      // a jump can carry you over an incoming shot
      if (Math.hypot(p.x - s.x, p.y - s.y) < T.playerR + T.enemyShotR &&
          Math.abs(p.z + 1.4 - s.z) < 2.4) {
        S.eshots.splice(i, 1);
        p.hp -= T.enemyDamage;
        emit("damage", p.x, p.y, p.z + 1.4);
        if (p.hp <= 0) { p.hp = 0; return end(false, "You ran out of health."); }
      }
    }

    // --- pickups
    for (const o of S.orbs) {
      if (o.got) continue;
      if (Math.hypot(p.x - o.x, p.y - o.y) < T.playerR + T.orbR) {
        o.got = true;
        S.orbsHeld++;
        emit("orb", o.x, o.y, 2.5, { color: o.c });
        if (S.orbsHeld === T.needOrbs) say("Orb quota met.", 1.8);
      }
    }
    for (const d of S.donuts) {
      if (d.got) continue;
      if (Math.hypot(p.x - d.x, p.y - d.y) < T.playerR + T.donutR) {
        // The original always eats the donut and caps at 100. An earlier version of
        // this skipped the pickup at full health to avoid "wasting" it, which is both
        // unfaithful and reads as a broken pickup when you walk over one and nothing
        // happens. Always eat it.
        const before = p.hp;
        d.got = true;
        p.hp = Math.min(T.startHP, p.hp + T.donutHeal);
        emit("donut", d.x, d.y, 2.5);
        say(p.hp > before ? "+" + (p.hp - before) + " health" : "Health already full", 1.2);
      }
    }

    // --- portal
    if (Math.hypot(p.x - M.PORTAL.x, p.y - M.PORTAL.y) < T.playerR + T.portalR) {
      const needO = S.orbsHeld < T.needOrbs, needK = S.kills < T.needKills;
      if (!needO && !needK) return end(true, "");
      if (!S.portalTouch) {
        S.portalTouch = true;
        // the original's refusals, word for word
        if (needO && needK) say("Not enough orbs. Not enough kills.");
        else if (needO) say("Not enough orbs.");
        else say("Not enough kills.");
        emit("denied", p.x, p.y, 2);
      }
    } else S.portalTouch = false;
  };

  function end(won, reason) {
    S.state = "over";
    S.won = won;
    S.reason = reason;
    emit(won ? "win" : "lose", S.player.x, S.player.y, 0);
  }

  S.start = function () {
    S.reset();
    S.state = "play";
  };

  S.reset();
  return S;
}
