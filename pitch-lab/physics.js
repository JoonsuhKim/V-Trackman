// Pitch flight model (SI units).
// World frame: origin at the back tip of home plate, +x toward 1B (pitcher's left),
// +y toward the pitcher, +z up from field level.
// Forces: gravity, drag, Magnus (Nathan's Cd/CL fits), plus an optional
// seam-shifted-wake (SSW) term from a simplified seam-asymmetry model.
(function (root) {
  'use strict';

  var G = 9.80665;
  var BALL_MASS = 0.145;            // kg
  var BALL_RADIUS = 0.0366;         // m (9.125 in circumference)
  var BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
  var RUBBER_Y = 18.44;             // 60.5 ft from back tip of plate
  var PLATE_FRONT_Y = 0.4318;       // 17 in
  var RPM = 2 * Math.PI / 60;

  // ---------- small vector / quaternion helpers ----------
  function v(x, y, z) { return [x, y, z]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function perpTo(a, n) { return sub(a, mul(n, dot(a, n))); }

  // quaternions as [w, x, y, z]
  function qAxisAngle(axis, ang) {
    var s = Math.sin(ang / 2), n = norm(axis);
    return [Math.cos(ang / 2), n[0] * s, n[1] * s, n[2] * s];
  }
  function qMul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
  }
  function qConj(q) { return [q[0], -q[1], -q[2], -q[3]]; }
  function qNorm(q) {
    var l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  function qRot(q, p) {
    var r = qMul(qMul(q, [0, p[0], p[1], p[2]]), qConj(q));
    return [r[1], r[2], r[3]];
  }
  // rotation taking unit vector a onto unit vector b
  function qFromTo(a, b) {
    var d = dot(a, b);
    if (d < -0.999999) {
      var ax = cross([1, 0, 0], a);
      if (len(ax) < 1e-6) ax = cross([0, 1, 0], a);
      return qAxisAngle(ax, Math.PI);
    }
    var c = cross(a, b);
    return qNorm([1 + d, c[0], c[1], c[2]]);
  }
  // quaternion from orthonormal basis columns (ex, ey, ez expressed in world)
  function qFromBasis(ex, ey, ez) {
    var m00 = ex[0], m01 = ey[0], m02 = ez[0];
    var m10 = ex[1], m11 = ey[1], m12 = ez[1];
    var m20 = ex[2], m21 = ey[2], m22 = ez[2];
    var tr = m00 + m11 + m22, w, x, y, z, s;
    if (tr > 0) {
      s = Math.sqrt(tr + 1) * 2; w = 0.25 * s;
      x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s;
      x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s;
      x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s;
      x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    return qNorm([w, x, y, z]);
  }

  // ---------- environment ----------
  // Air density from temperature (C), relative humidity (%), altitude (m).
  function airDensity(tempC, rh, altitude) {
    var T = tempC + 273.15;
    var p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
    var pSat = 610.78 * Math.pow(10, 7.5 * tempC / (tempC + 237.3));
    var pv = Math.min(1, Math.max(0, rh / 100)) * pSat;
    return (p - pv) / (287.058 * T) + pv / (461.495 * T);
  }

  // Wind: speed (m/s) and direction in degrees.
  // 0 = blowing from the mound toward home (tailwind for the pitch),
  // 180 = from home toward the mound (headwind), 90 = toward 1B side.
  function windVector(speed, dirDeg) {
    var a = dirDeg * Math.PI / 180;
    return [speed * Math.sin(a), -speed * Math.cos(a), 0];
  }

  // ---------- seam geometry ----------
  // Baseball seam as a "tennis ball" curve on the unit sphere, resampled to
  // equal arc length so every sample stands for the same length of stitching.
  function seamCurve(n) {
    var a = 0.62, b = 0.38, c = 2 * Math.sqrt(a * b), fine = [], cum = [0], M = n * 8;
    for (var i = 0; i <= M; i++) {
      var t = i / M * 2 * Math.PI;
      fine.push([a * Math.cos(t) + b * Math.cos(3 * t), a * Math.sin(t) - b * Math.sin(3 * t), c * Math.sin(2 * t)]);
      if (i > 0) cum.push(cum[i - 1] + len(sub(fine[i], fine[i - 1])));
    }
    var total = cum[M], pts = [], j = 0;
    for (var k = 0; k < n; k++) {
      var target = k / n * total;
      while (cum[j + 1] < target) j++;
      var f = (target - cum[j]) / (cum[j + 1] - cum[j]);
      pts.push(norm(add(fine[j], mul(sub(fine[j + 1], fine[j]), f))));
    }
    return pts;
  }
  var SEAM = seamCurve(240);

  // Count how many times the seam passes the leading point per revolution for
  // spin about a unit axis given in the ball frame (2-seam / 4-seam etc).
  function seamCrossings(axisBall) {
    var a = norm(axisBall), cnt = 0, n = SEAM.length;
    for (var i = 0; i < n; i++) {
      var s0 = dot(SEAM[i], a), s1 = dot(SEAM[(i + 1) % n], a);
      if ((s0 < 0) !== (s1 < 0)) cnt++;
    }
    return cnt;
  }

  // Simplified SSW model. The flow separates around ~105 deg from the leading
  // point. Seams a bit upstream of that band trip the boundary layer (later
  // separation -> force toward that side); seams inside the band cause early
  // separation (force away from that side). Seam positions are averaged over
  // one revolution about the spin axis. Only the part that differs between the
  // two hemispheres either side of the spin equator is kept, so a pattern that
  // looks the same on both sides (a clean 4-seam) gives no SSW and the classic
  // "smooth side vs seam side" orientations give the most.
  var TRIP = { c: 80 * Math.PI / 180, s: 15 * Math.PI / 180, w: 1.0 };
  var SEP = { c: 106 * Math.PI / 180, s: 10 * Math.PI / 180, w: 1.25 };
  function gauss(x, c, s) { var d = (x - c) / s; return Math.exp(-0.5 * d * d); }

  function seamPush(p, vhat) {
    var alpha = Math.acos(Math.max(-1, Math.min(1, dot(p, vhat))));
    var w = TRIP.w * gauss(alpha, TRIP.c, TRIP.s) - SEP.w * gauss(alpha, SEP.c, SEP.s);
    if (Math.abs(w) < 1e-4) return null;
    var tr = perpTo(p, vhat), tl = len(tr);
    return tl < 1e-6 ? null : mul(tr, w / tl);
  }

  function sswRaw(spinAxisW, vhat, qBall, phases) {
    phases = phases || 36;
    var sum = [0, 0, 0], n = SEAM.length;
    var pts = SEAM.map(function (p) { return qRot(qBall, p); });
    for (var k = 0; k < phases; k++) {
      var qp = qAxisAngle(spinAxisW, k / phases * 2 * Math.PI);
      for (var i = 0; i < n; i++) {
        var p = qRot(qp, pts[i]);
        var pm = sub(p, mul(spinAxisW, 2 * dot(p, spinAxisW))); // mirror across spin equator
        var f1 = seamPush(p, vhat), f2 = seamPush(pm, vhat);
        if (f1) sum = add(sum, f1);
        if (f2) sum = sub(sum, f2);
      }
    }
    return mul(sum, 0.5 / (phases * n));
  }

  // Normalisation: the largest asymmetry over many random orientations.
  var SSW_SCALE = (function () {
    var best = 0, vh = [0, -1, 0];
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < 160; i++) {
      var q = qNorm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
      var e = rnd();
      var axis = norm(add(mul([1, 0, 0], e), mul(vh, Math.sqrt(1 - e * e))));
      var m = len(sswRaw(axis, vh, q, 18));
      if (m > best) best = m;
    }
    return best || 1;
  })();

  // Returns { dir (world, unit, perpendicular to v), level (0..1) }
  function sswEffect(spinAxisW, vhat, qBall) {
    var raw = sswRaw(spinAxisW, vhat, qBall, 36);
    var m = len(raw);
    return { dir: m > 1e-9 ? mul(raw, 1 / m) : [0, 0, 0], level: Math.min(1, m / SSW_SCALE) };
  }

  // ---------- spin axis ----------
  // tiltClock: hours (12 = pure backspin/rise, 3 = toward pitcher's right),
  // describing the Magnus movement direction as seen from the pitcher.
  // efficiency 0..1. gyroSign picks which way the gyro component points.
  function movementDir(tiltClock, vhat) {
    var th = (tiltClock % 12) / 12 * 2 * Math.PI;
    var m = [-Math.sin(th), 0, Math.cos(th)];
    return norm(perpTo(m, vhat));
  }
  function spinAxis(tiltClock, efficiency, vhat, gyroSign) {
    var m = movementDir(tiltClock, vhat);
    var wT = norm(cross(vhat, m));
    var e = Math.max(0, Math.min(1, efficiency));
    return norm(add(mul(wT, e), mul(vhat, (gyroSign || 1) * Math.sqrt(1 - e * e))));
  }

  // Spin frame: x = spin axis, y = flow direction projected off the axis.
  function spinFrameQuat(axis, vhat) {
    var ey = perpTo(vhat, axis);
    if (len(ey) < 1e-6) ey = perpTo([0, 0, 1], axis);
    ey = norm(ey);
    return qFromBasis(axis, ey, cross(axis, ey));
  }

  // Lift coefficient vs spin factor S = r*omega_T/v (Nathan's fit) and its inverse.
  function liftCoef(S) { return 1.120 * S / (0.583 + 2.333 * S); }
  var CL_MAX = 1.120 / 2.333;
  function spinFactorForLift(cl) { return cl >= CL_MAX * 0.999 ? Infinity : 0.583 * cl / (1.120 - 2.333 * cl); }

  // ---------- integration ----------
  // p: { release:[x,y,z], v0 (m/s), dir:[unit], spinRpm, spinAxis:[unit],
  //      rho, wind:[x,y,z], ssw:{dir,coef}, magnus:true, dt }
  function simulate(p, opts) {
    opts = opts || {};
    var dt = p.dt || 0.001;
    var K = p.rho * BALL_AREA / (2 * BALL_MASS);
    var omega = mul(p.spinAxis, p.spinRpm * RPM);
    var wind = p.wind || [0, 0, 0];
    var useMagnus = p.magnus !== false;
    var sswCoef = (p.ssw && p.ssw.coef) || 0;
    var sswDir0 = p.ssw && p.ssw.dir;
    var cd = 0.3008 + 0.0292 * (p.spinRpm / 1000);

    function accel(vel) {
      var vr = sub(vel, wind), sp = len(vr), vh = mul(vr, 1 / sp);
      var a = [0, 0, -G];
      a = add(a, mul(vr, -K * cd * sp));
      if (useMagnus && p.spinRpm > 0) {
        var wPerp = perpTo(omega, vh), wp = len(wPerp);
        if (wp > 1e-6) {
          var S = BALL_RADIUS * wp / sp;
          var cl = liftCoef(S);
          a = add(a, mul(norm(cross(wPerp, vh)), K * cl * sp * sp));
        }
      }
      if (useMagnus && sswCoef > 0 && sswDir0) {
        var d = perpTo(sswDir0, vh), dl = len(d);
        if (dl > 1e-6) a = add(a, mul(d, K * sswCoef * sp * sp / dl));
      }
      return a;
    }

    var pos = p.release.slice(), vel = mul(p.dir, p.v0), t = 0;
    var pts = [{ t: 0, p: pos.slice(), v: vel.slice() }], plate = null;
    var endY = opts.endY != null ? opts.endY : -0.8;
    for (var i = 0; i < 4000; i++) {
      var k1v = accel(vel), k1x = vel;
      var k2v = accel(add(vel, mul(k1v, dt / 2))), k2x = add(vel, mul(k1v, dt / 2));
      var k3v = accel(add(vel, mul(k2v, dt / 2))), k3x = add(vel, mul(k2v, dt / 2));
      var k4v = accel(add(vel, mul(k3v, dt))), k4x = add(vel, mul(k3v, dt));
      var nPos = add(pos, mul(add(add(k1x, mul(k2x, 2)), add(mul(k3x, 2), k4x)), dt / 6));
      var nVel = add(vel, mul(add(add(k1v, mul(k2v, 2)), add(mul(k3v, 2), k4v)), dt / 6));
      if (!plate && nPos[1] <= PLATE_FRONT_Y) {
        var f = (pos[1] - PLATE_FRONT_Y) / (pos[1] - nPos[1]);
        plate = {
          t: t + f * dt,
          p: add(pos, mul(sub(nPos, pos), f)),
          v: add(vel, mul(sub(nVel, vel), f))
        };
      }
      pos = nPos; vel = nVel; t += dt;
      pts.push({ t: t, p: pos.slice(), v: vel.slice() });
      if (pos[1] <= endY) break;
    }
    return { pts: pts, plate: plate };
  }

  function launchDir(pitch, yaw) {
    return [Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
  }

  // Build full sim params from a pitch description. Spin axis follows the
  // initial direction, so it is rebuilt for every aim.
  function buildParams(desc, dir, sswCached) {
    var axis = desc.spinAxisOverride || spinAxis(desc.tilt, desc.efficiency, dir, desc.gyroSign);
    var ssw = sswCached || null;
    if (!ssw && desc.sswStrength > 0 && desc.qRel) {
      // the seams are placed relative to the spin axis at release; the wake responds to the
      // average flow direction over the flight (desc.flowDir), as Nathan uses the average velocity
      var qBall = qMul(spinFrameQuat(axis, dir), desc.qRel);
      var eff = sswEffect(axis, desc.flowDir || dir, qBall);
      ssw = { dir: eff.dir, coef: desc.sswStrength * eff.level, level: eff.level };
    }
    return {
      release: desc.release, v0: desc.v0, dir: dir, spinRpm: desc.spinRpm,
      spinAxis: axis, rho: desc.rho, wind: desc.wind, ssw: ssw, dt: desc.dt
    };
  }

  // Find launch angles so the pitch crosses the plate front at target [x, z].
  function aim(desc, target) {
    var R = desc.release;
    var dy = R[1] - PLATE_FRONT_Y;
    var pitch = Math.atan2(target[1] - R[2], dy), yaw = Math.atan2(target[0] - R[0], dy);
    pitch += 0.03;
    var sim, params, sswCached = null;
    for (var i = 0; i < 8; i++) {
      // the seam asymmetry barely changes with small aim corrections, so compute it once
      params = buildParams(desc, launchDir(pitch, yaw), sswCached);
      sswCached = params.ssw;
      sim = simulate(params, { endY: PLATE_FRONT_Y - 0.01 });
      if (!sim.plate) { pitch += 0.05; continue; }
      var ex = target[0] - sim.plate.p[0], ez = target[1] - sim.plate.p[2];
      if (Math.abs(ex) < 0.0005 && Math.abs(ez) < 0.0005) break;
      pitch += Math.atan(ez / dy) * 1.05;
      yaw += Math.atan(ex / dy);
    }
    return { pitch: pitch, yaw: yaw, params: params };
  }

  // TrackMan-style breaks at the front of the plate, measured against the
  // straight line along the release velocity:
  //   VertBreak = actual height - straight-line height (gravity included)
  //   InducedVertBreak = VertBreak with the gravity drop over the flight added back
  //   HorzBreak = actual side - straight-line side
  // Returned in world x / z (m); x is +1B side.
  function breaks(params, sim) {
    sim = sim || simulate(params, { endY: PLATE_FRONT_Y - 0.01 });
    var pl = sim.plate;
    if (!pl) return { x: 0, z: 0, vert: 0 };
    var r = params.release, d = params.dir;
    var s = (r[1] - PLATE_FRONT_Y) / -d[1];
    var lx = r[0] + d[0] * s, lz = r[2] + d[2] * s;
    var vert = pl.p[2] - lz;
    return { x: pl.p[0] - lx, z: vert + 0.5 * G * pl.t * pl.t, vert: vert };
  }
  function inducedBreak(params) { return breaks(params); }

  // Aim at a plate target and fly the pitch. Second pass: SSW from the mid-flight
  // flow direction instead of the release direction.
  function flyTo(desc, target) {
    var a = aim(desc, target);
    var sim = simulate(a.params);
    if (a.params.ssw && sim.plate) {
      var mid = sim.pts[Math.min(sim.pts.length - 1, Math.round(sim.plate.t / 2 / (a.params.dt || 0.001)))];
      desc = Object.assign({}, desc, { flowDir: norm(mid.v) });
      a = aim(desc, target);
      sim = simulate(a.params);
    }
    return { a: a, sim: sim, desc: desc };
  }

  // Where a flown pitch crosses the plane at distance y from the plate: { x, z, t }.
  function crossingAt(sim, y) {
    var pts = sim.pts;
    for (var i = 0; i < pts.length - 1; i++) {
      if (pts[i].p[1] >= y && pts[i + 1].p[1] < y) {
        var f = (pts[i].p[1] - y) / (pts[i].p[1] - pts[i + 1].p[1]);
        return {
          x: pts[i].p[0] + (pts[i + 1].p[0] - pts[i].p[0]) * f,
          z: pts[i].p[2] + (pts[i + 1].p[2] - pts[i].p[2]) * f,
          t: pts[i].t + (pts[i + 1].t - pts[i].t) * f
        };
      }
    }
    return null;
  }

  // Plate target [x, z] that puts the pitch, t seconds after release, on the given flight path.
  // How far the pitch has come by then sets which point of the path it must meet. A miss
  // grows by similar triangles on the way to the plate.
  function targetOntoPath(desc, t, path, start) {
    var R = desc.release, T = start.slice();
    for (var i = 0; i < 12; i++) {
      var pts = flyTo(desc, T).sim.pts;
      var q = pts[Math.min(pts.length - 1, Math.round(t / (desc.dt || 0.001)))].p;
      var c = crossingAt(path, q[1]);
      if (!c) break;
      var ex = c.x - q[0], ez = c.z - q[2];
      if (Math.abs(ex) < 0.0005 && Math.abs(ez) < 0.0005) break;
      var gain = (R[1] - PLATE_FRONT_Y) / (R[1] - q[1]);
      T = [T[0] + ex * gain, T[1] + ez * gain];
    }
    return T;
  }

  function clockOf(right, up) { return ((Math.atan2(right, up) / (2 * Math.PI) * 12) + 12) % 12; }
  function wrapDeg(d) { return ((d + 540) % 360) - 180; }

  // Full evaluation: aim, simulate to behind the plate, compute metrics.
  function evaluate(desc, target) {
    var fly = flyTo(desc, target), a = fly.a, sim = fly.sim;
    desc = fly.desc;
    var br = breaks(a.params, sim);
    var pl = sim.plate;
    var vp = pl ? pl.v : [0, -1, 0];
    // SSW share of the break: same launch without the SSW force
    var sswBreak = { x: 0, z: 0 };
    if (a.params.ssw && a.params.ssw.coef > 0) {
      var b2 = breaks(Object.assign({}, a.params, { ssw: null }));
      sswBreak = { x: br.x - b2.x, z: br.z - b2.z };
    }
    var wPerp = perpTo(a.params.spinAxis, a.params.dir);

    // Spin-based vs movement-based (inferred) metrics, after Nathan (2021):
    // the inferred axis assumes all movement is Magnus; axis shift = phi_T - phi_M.
    var mag = { x: br.x - sswBreak.x, z: br.z - sswBreak.z };
    var mT = Math.hypot(br.x, br.z), mM = Math.hypot(mag.x, mag.z);
    var tiltT = clockOf(-br.x, br.z), tiltM = clockOf(-mag.x, mag.z);
    var deviation = wrapDeg((tiltT - tiltM) * 30);
    // inferred efficiency: transverse spin a Magnus-only model would need for the total movement
    var inferred = null;
    if (pl && mM > 0.005) {
      var midP = sim.pts[Math.min(sim.pts.length - 1, Math.round(pl.t / 2 / (a.params.dt || 0.001)))];
      var vAvg = (desc.v0 + len(vp)) / 2;
      var effAvg = len(perpTo(a.params.spinAxis, norm(midP.v)));
      var sTrue = BALL_RADIUS * desc.spinRpm * RPM * effAvg / vAvg;
      var sInf = spinFactorForLift(liftCoef(sTrue) * mT / mM);
      var effInf = sTrue > 0 ? effAvg * sInf / sTrue : 0;
      inferred = { tilt: tiltT, efficiency: effInf, effAvg: effAvg, activeRpm: desc.spinRpm * effInf };
    }
    return {
      aim: a, sim: sim, plate: pl,
      breakX: br.x, breakZ: br.z, vertBreak: br.vert, sswBreak: sswBreak,
      magnusBreak: mag, spinTilt: tiltM, deviation: deviation, inferred: inferred,
      flowDir: desc.flowDir || a.params.dir,
      flightTime: pl ? pl.t : null,
      plateSpeed: len(vp),
      vaa: Math.atan2(vp[2], -vp[1]) * 180 / Math.PI,
      haa: Math.atan2(vp[0], -vp[1]) * 180 / Math.PI,
      activeSpin: desc.spinRpm * len(wPerp),
      spinAxis: a.params.spinAxis,
      ssw: a.params.ssw
    };
  }

  // Movement mode: find tilt + transverse spin so the induced break matches
  // (armSide, rise) in metres. armSign: +1 RHP (arm side = -x), -1 LHP.
  function solveSpinForBreak(desc, target, goal, armSign) {
    var eff = Math.max(0.05, desc.efficiency);
    function breakFor(s) {
      var wT = Math.hypot(s[0], s[1]);
      var tilt = ((Math.atan2(s[0], s[1]) / (2 * Math.PI) * 12) + 12) % 12;
      var d = Object.assign({}, desc, { tilt: tilt, spinRpm: wT / eff });
      var a = aim(d, target);
      var b = inducedBreak(a.params);
      return { arm: -b.x * armSign, rise: b.z, tilt: tilt, wT: wT };
    }
    // screen components: s[0] toward pitcher's right, s[1] up (rpm of transverse spin)
    var goalScreen = [goal[0] * armSign, goal[1]];
    var mag = Math.hypot(goalScreen[0], goalScreen[1]);
    var s = mag > 1e-4 ? [goalScreen[0] / mag * 2000, goalScreen[1] / mag * 2000] : [0, 1];
    var res;
    for (var it = 0; it < 7; it++) {
      res = breakFor(s);
      var got = [res.arm * armSign, res.rise];
      var err = [goalScreen[0] - got[0], goalScreen[1] - got[1]];
      if (Math.hypot(err[0], err[1]) < 0.001) break;
      var h = 60;
      var bx = breakFor([s[0] + h, s[1]]), bz = breakFor([s[0], s[1] + h]);
      var J = [
        [(bx.arm * armSign - got[0]) / h, (bz.arm * armSign - got[0]) / h],
        [(bx.rise - got[1]) / h, (bz.rise - got[1]) / h]
      ];
      var det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      if (Math.abs(det) < 1e-12) break;
      var dx = (J[1][1] * err[0] - J[0][1] * err[1]) / det;
      var dz = (-J[1][0] * err[0] + J[0][0] * err[1]) / det;
      var step = Math.hypot(dx, dz), cap = 1500;
      if (step > cap) { dx *= cap / step; dz *= cap / step; }
      s = [s[0] + dx, s[1] + dz];
    }
    res = breakFor(s);
    return { tilt: res.tilt, activeRpm: res.wT, spinRpm: res.wT / eff };
  }

  var api = {
    constants: { G: G, BALL_RADIUS: BALL_RADIUS, RUBBER_Y: RUBBER_Y, PLATE_FRONT_Y: PLATE_FRONT_Y },
    vec: { add: add, sub: sub, mul: mul, dot: dot, cross: cross, len: len, norm: norm, perpTo: perpTo },
    quat: { axisAngle: qAxisAngle, mul: qMul, conj: qConj, norm: qNorm, rot: qRot, fromTo: qFromTo, fromBasis: qFromBasis },
    airDensity: airDensity, windVector: windVector,
    SEAM: SEAM, seamCrossings: seamCrossings, sswEffect: sswEffect, sswRaw: sswRaw,
    spinAxis: spinAxis, spinFrameQuat: spinFrameQuat, movementDir: movementDir,
    simulate: simulate, aim: aim, evaluate: evaluate, inducedBreak: inducedBreak, breaks: breaks,
    crossingAt: crossingAt, targetOntoPath: targetOntoPath,
    liftCoef: liftCoef, spinFactorForLift: spinFactorForLift, clockOf: clockOf,
    solveSpinForBreak: solveSpinForBreak, launchDir: launchDir
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PitchPhysics = api;
})(this);
