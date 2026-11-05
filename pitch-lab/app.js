// Pitch Lab UI: pitch tabs, 3D field, metrics board, seam orientation editor.
(function () {
'use strict';
var P = window.PitchPhysics, V = P.vec, Q = P.quat, C = P.constants;
var HALF_PLATE = 0.2159, R_BALL = C.BALL_RADIUS;
var IN = 0.0254, FT = 0.3048, MPH = 0.44704;
var COL = { axis: '#ff9f0a', travel: '#64d2ff', ssw: '#ff5fdc', gx: '#ff453a', gy: '#30d158', gz: '#0a84ff' };

// ---------- presets ----------
var ORIENT = {
  '4S': { label: '4-seam', axis: [0, 0, 1] },
  '2S': { label: '2-seam', axis: [1, 1, 0] },
  // 2-seam spin axis tipped 20° toward a seam pole: one hemisphere carries more seam
  '2Sx': { label: 'Seam-shifted A', axis: [-0.664, 0.664, 0.342] },
  '2Sy': { label: 'Seam-shifted B', axis: [-0.664, 0.664, -0.342] }
};
// Tilt in hours for an RHP, mirrored for lefties. Placeholder values until real TrackMan defaults are supplied.
var TYPES = [
  { id: 'FB', name: 'Fastball',  color: '#ff453a', mph: 94.0, rpm: 2350, tilt: 1.0,  eff: 95, orient: '4S' },
  { id: 'SI', name: 'Sinker',    color: '#ff9f0a', mph: 92.5, rpm: 2150, tilt: 2.25, eff: 90, orient: '2Sx' },
  { id: 'CT', name: 'Cutter',    color: '#ac8e68', mph: 88.5, rpm: 2400, tilt: 11.5, eff: 45, orient: '4S' },
  { id: 'SL', name: 'Slider',    color: '#ffd60a', mph: 84.0, rpm: 2500, tilt: 9.5,  eff: 30, orient: '4S' },
  { id: 'SW', name: 'Sweeper',   color: '#bf5af2', mph: 81.5, rpm: 2650, tilt: 9.0,  eff: 80, orient: '2S' },
  { id: 'CB', name: 'Curveball', color: '#0a84ff', mph: 78.0, rpm: 2650, tilt: 7.0,  eff: 80, orient: '4S' },
  { id: 'CH', name: 'Changeup',  color: '#30d158', mph: 84.5, rpm: 1800, tilt: 2.25, eff: 85, orient: '2Sx' },
  { id: 'SP', name: 'Splitter',  color: '#64d2ff', mph: 86.0, rpm: 1300, tilt: 1.75, eff: 70, orient: '2S' }
];
function typeById(id) { return TYPES.filter(function (t) { return t.id === id; })[0]; }
var SLOTS = {
  over: { h: 0.92, side: 0.14, ext: 0.97 },
  tq:   { h: 0.82, side: 0.30, ext: 1.00 },
  side: { h: 0.56, side: 0.50, ext: 1.03 },
  sub:  { h: 0.30, side: 0.42, ext: 0.96 }
};
var VENUES = [
  { name: 'Sea level', alt: 50, temp: 72, rh: 60 },
  { name: 'Hot day game', alt: 50, temp: 92, rh: 75 },
  { name: 'Cold April night', alt: 50, temp: 48, rh: 45 },
  { name: 'Coors Field', alt: 5200, temp: 75, rh: 30 }
];
var DEF = {
  env: { temp: 72, rh: 60, alt: 50, wind: 0, windDir: 180, mound: 10 },
  pitcher: { height: 74 }, batter: { height: 72 }, cam: { height: 69, fov: 12, back: 10 }
};

// ---------- state ----------
var S = {
  env: Object.assign({}, DEF.env),
  pitcher: { hand: 'R', slot: 'tq', height: DEF.pitcher.height },
  batter: { side: 'R', height: DEF.batter.height },
  cam: Object.assign({}, DEF.cam),
  view: 'pitcher',
  showVAA: false,
  tunnel: { on: false, gather: false },
  pitches: [],
  sel: null
};
// Calibrated so 'Seam-shifted A' on the default sinker (asymmetry ~0.5) gives ~6 in of non-Magnus
// movement and ~18° axis deviation, the size Nathan (2021) reports for Alex Cobb's sinker.
var SSW_CMAX = 0.14;
var nextId = 1;

function cur() { return S.pitches.filter(function (p) { return p.id === S.sel; })[0] || null; }
function handSign() { return S.pitcher.hand === 'R' ? 1 : -1; }
function mirrorTilt(h) { return (24 - h) % 12; }
function fmtClock(h) {
  h = ((h % 12) + 12) % 12;
  var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  return (hh % 12 === 0 ? 12 : hh % 12) + ':' + (mm < 10 ? '0' : '') + mm;
}
function parseClock(s) { var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s).trim()); if (!m) return NaN; return ((+m[1] % 12) * 60 + (+m[2])) % 720; }
function axisDeg(h) { return (180 + h * 30) % 360; }
function qRelFor(orientId) { return Q.fromTo(V.norm(ORIENT[orientId].axis), [1, 0, 0]); }
function fToC(f) { return (f - 32) * 5 / 9; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function $(id) { return document.getElementById(id); }
function round(v, step) { var d = Math.max(0, Math.round(-Math.log10(step))); return +v.toFixed(d); }
function f1(v) { return (Math.abs(v) < 0.05 ? 0 : v).toFixed(1); }
// movement-based tilt minus the measured (release) spin tilt, degrees, + = clockwise from the pitcher
function devTotal(r) { return ((((r.inferred.tilt - r.desc.tilt) * 30) + 540) % 360) - 180; }

function zoneLimits() { var h = S.batter.height * IN; return { bot: h * 0.2764, top: h * 0.5635 }; }
function zoneCenterFt() { var z = zoneLimits(); return Math.round((z.bot + z.top) / 2 / FT * 100) / 100; }
// release estimated from the pitcher profile (ft); each pitch can override it
function autoRelease() {
  var k = SLOTS[S.pitcher.slot], hFt = S.pitcher.height / 12;
  return {
    h: Math.round((hFt * k.h + S.env.mound / 12) * 100) / 100,
    side: Math.round(hFt * k.side * handSign() * 100) / 100,
    ext: Math.round(hFt * k.ext * 100) / 100
  };
}
function rel(p) {
  var a = autoRelease();
  return { h: p.rel.h != null ? p.rel.h : a.h, side: p.rel.side != null ? p.rel.side : a.side, ext: p.rel.ext != null ? p.rel.ext : a.ext };
}
function typeDefaults(p) {
  var t = typeById(p.type);
  return { mph: t.mph, rpm: t.rpm, tiltMin: Math.round((S.pitcher.hand === 'R' ? t.tilt : mirrorTilt(t.tilt)) * 60) % 720, eff: t.eff };
}

function makePitch(typeId) {
  var t = typeById(typeId);
  var sameType = S.pitches.filter(function (p) { return p.type === typeId; }).length;
  var p = {
    id: nextId++, type: typeId, name: t.name + (sameType ? ' ' + (sameType + 1) : ''), color: t.color,
    mode: 'physics', ivb: 0, hb: 0,
    rel: { h: null, side: null, ext: null },
    target: { side: 0, height: zoneCenterFt() },
    ssw: { on: false, strength: 100, orient: t.orient, qRel: qRelFor(t.orient) },
    result: null, solve: null
  };
  Object.assign(p, typeDefaults(p));
  return p;
}
// movement this pitch type makes with its default spin (used to reset IVB / HB)
function defaultMovement(p) {
  var tmp = JSON.parse(JSON.stringify(Object.assign({}, p, { result: null, solve: null })));
  Object.assign(tmp, typeDefaults(p)); tmp.mode = 'physics';
  var r = computePitch(tmp);
  return { ivb: Math.round(r.breakZ / IN * 10) / 10, hb: Math.round(-r.breakX / IN * 10) / 10 };
}

// ---------- metrics board ----------
// edit(p): whether the tile is an input for this pitch right now
function relNote(k) { return function (p) { return p.rel[k] == null ? 'default · from profile' : 'custom'; }; }
var TILES = [
  { group: 'Release', items: [
    { key: 'mph', name: 'RelSpeed', sub: 'Velocity', unit: 'mph', min: 50, max: 106, step: 0.1, edit: function () { return true; },
      get: function (p) { return p.mph; }, set: function (p, v) { p.mph = v; }, def: function (p) { return typeDefaults(p).mph; },
      note: function (p) { return (p.mph * 1.609).toFixed(1) + ' km/h'; } },
    { key: 'relH', name: 'RelHeight', unit: 'ft', min: 1.5, max: 7.8, step: 0.01, edit: function () { return true; }, relKey: 'h',
      get: function (p) { return rel(p).h; }, set: function (p, v) { p.rel.h = v; }, note: relNote('h') },
    { key: 'relSide', name: 'RelSide', sub: '3B side +', unit: 'ft', min: -4.5, max: 4.5, step: 0.01, edit: function () { return true; }, relKey: 'side',
      get: function (p) { return rel(p).side; }, set: function (p, v) { p.rel.side = v; }, note: relNote('side') },
    { key: 'ext', name: 'Extension', unit: 'ft', min: 4, max: 8, step: 0.01, edit: function () { return true; }, relKey: 'ext',
      get: function (p) { return rel(p).ext; }, set: function (p, v) { p.rel.ext = v; }, note: relNote('ext') }
  ] },
  { group: 'Spin', items: [
    { key: 'rpm', name: 'SpinRate', unit: 'rpm', min: 300, max: 3600, step: 10, edit: function (p) { return p.mode === 'physics'; },
      get: function (p) { return p.rpm; }, set: function (p, v) { p.rpm = v; }, def: function (p) { return typeDefaults(p).rpm; },
      note: function (p) { return p.result ? 'active ' + Math.round(p.result.activeSpin) + ' rpm' : ''; } },
    { key: 'tilt', name: 'Spin Tilt', sub: 'measured axis', unit: '', min: 0, max: 705, step: 15, edit: function (p) { return p.mode === 'physics'; },
      get: function (p) { return p.tiltMin; }, set: function (p, v) { p.tiltMin = v; }, def: function (p) { return typeDefaults(p).tiltMin; },
      fmt: function (v) { return fmtClock(v / 60); }, parse: parseClock, note: function () { return 'SpinAxis3dTilt · pitcher view'; } },
    { key: 'axis', name: 'Spin Axis', sub: 'measured', unit: '°', min: 0, max: 359, step: 1, edit: function (p) { return p.mode === 'physics'; },
      get: function (p) { return Math.round(axisDeg(p.tiltMin / 60)); },
      set: function (p, v) { p.tiltMin = Math.round((((v - 180) / 30) % 12 + 12) % 12 * 60) % 720; },
      def: function (p) { return Math.round(axisDeg(typeDefaults(p).tiltMin / 60)); }, note: function () { return '180° = pure backspin'; } },
    { key: 'eff', name: 'Spin Eff.', sub: 'Active / total', unit: '%', min: 0, max: 100, step: 1, edit: function () { return true; },
      get: function (p) { return p.eff; }, set: function (p, v) { p.eff = v; }, def: function (p) { return typeDefaults(p).eff; },
      note: function (p) { return 'gyro angle ' + Math.round(Math.acos(Math.min(1, p.eff / 100)) * 180 / Math.PI) + '°'; } }
  ] },
  { group: 'Location', items: [
    { key: 'theight', name: 'PlateLocHeight', unit: 'ft', min: 0.3, max: 5.2, step: 0.01, edit: function (p) { return !isGathered(p); },
      get: function (p) { return p.target.height; }, set: function (p, v) { p.target.height = v; }, def: function () { return zoneCenterFt(); },
      note: function () { var z = zoneLimits(); return 'zone ' + (z.bot / FT).toFixed(2) + '–' + (z.top / FT).toFixed(2) + ' ft'; } },
    { key: 'tside', name: 'PlateLocSide', sub: '3B side +', unit: 'ft', min: -2, max: 2, step: 0.01, edit: function (p) { return !isGathered(p); },
      get: function (p) { return p.target.side; }, set: function (p, v) { p.target.side = v; }, def: function () { return 0; },
      note: function () { return 'plate edge ±0.71 ft'; } },
    { key: 'call', name: 'Call', span: 2, kind: 'call' }
  ] },
  { group: 'Movement', items: [
    { key: 'ivb', name: 'IVB', sub: 'Induced Vert. Break', unit: 'in', min: -28, max: 28, step: 0.1, edit: function (p) { return p.mode === 'movement'; },
      get: function (p) { return p.mode === 'movement' ? p.ivb : (p.result ? round(p.result.breakZ / IN, 0.1) : null); },
      set: function (p, v) { p.ivb = v; }, reset: function (p) { p.ivb = defaultMovement(p).ivb; },
      note: function (p) { return p.result ? (p.result.breakZ * 100).toFixed(1) + ' cm' : ''; } },
    { key: 'hb', name: 'HB', sub: 'Horz. Break, 3B +', unit: 'in', min: -28, max: 28, step: 0.1, edit: function (p) { return p.mode === 'movement'; },
      get: function (p) { return p.mode === 'movement' ? p.hb : (p.result ? round(-p.result.breakX / IN, 0.1) : null); },
      set: function (p, v) { p.hb = v; }, reset: function (p) { p.hb = defaultMovement(p).hb; },
      note: function (p) { return p.result ? (-p.result.breakX * 100).toFixed(1) + ' cm' : ''; } },
    { key: 'vb', name: 'VB', sub: 'Vert. Break', unit: 'in', out: function (r) { return f1(r.vertBreak / IN); }, note: function () { return 'gravity included'; } },
    { key: 'sswb', name: 'SSW Break', unit: 'in', cls: 'ssw', out: function (r) { return f1(Math.hypot(r.sswBreak.x, r.sswBreak.z) / IN); },
      note: function (p) { var r = p.result; return 'H ' + f1(-r.sswBreak.x / IN) + ' · V ' + f1(r.sswBreak.z / IN) + ' in'; } }
  ] },
  { group: 'Inferred', items: [
    { key: 'itilt', name: 'Tilt', sub: 'from movement', unit: '', out: function (r) { return r.inferred ? fmtClock(r.inferred.tilt) : '—'; },
      note: function (p) { var r = p.result; return r.inferred ? 'SpinAxis ' + Math.round(axisDeg(r.inferred.tilt)) + '° · TrackMan Tilt' : 'too little movement'; } },
    { key: 'dev', name: 'Axis Deviation', unit: '°', cls: 'ssw', out: function (r) { return r.inferred ? devTotal(r).toFixed(1) : '—'; },
      note: function (p) { var r = p.result; return 'SSW ' + (r.deviation >= 0 ? '+' : '') + r.deviation.toFixed(1) + '° · path ' + (r.inferred ? (devTotal(r) - r.deviation).toFixed(1) : '0') + '° · + = clockwise'; } },
    { key: 'ieff', name: 'Spin Eff.', sub: 'from movement', unit: '%', out: function (r) { return r.inferred ? (r.inferred.efficiency * 100).toFixed(1) : '—'; },
      note: function (p) { var r = p.result; return r.inferred ? 'true ' + (r.inferred.effAvg * 100).toFixed(1) + '% mid-flight' : ''; } },
    { key: 'iact', name: 'Active Spin', sub: 'from movement', unit: 'rpm', out: function (r) { return r.inferred ? Math.round(r.inferred.activeRpm) : '—'; },
      note: function (p) { var r = p.result; return r.inferred ? 'true ' + Math.round(r.desc.spinRpm * r.inferred.effAvg) + ' rpm' : ''; } }
  ] },
  { group: 'Flight', items: [
    { key: 'zspd', name: 'ZoneSpeed', unit: 'mph', out: function (r) { return (r.plateSpeed / MPH).toFixed(1); },
      note: function (p) { return 'drop ' + (p.result.plateSpeed / MPH - p.mph).toFixed(1) + ' mph'; } },
    { key: 'ztime', name: 'ZoneTime', unit: 's', out: function (r) { return r.flightTime.toFixed(3); }, note: function () { return 'release → front of plate'; } },
    { key: 'vaa', name: 'VAA', sub: 'Vert. Appr. Angle', unit: '°', out: function (r) { return r.vaa.toFixed(2); }, note: function () { return 'at front of plate'; } },
    { key: 'haa', name: 'HAA', sub: 'Horz. Appr. Angle', unit: '°', out: function (r) { return (-r.haa).toFixed(2); }, note: function () { return '3B side +'; } }
  ] }
];
var tileEls = {};
function buildBoard() {
  var g = $('groups');
  TILES.forEach(function (grp) {
    var row = document.createElement('div'); row.className = 'group';
    row.innerHTML = '<div class="glabel">' + grp.group + '</div><div class="ggrid"></div>';
    var grid = row.querySelector('.ggrid');
    grp.items.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tile' + (t.span ? ' span2' : '') + (t.cls ? ' ' + t.cls : '');
      var label = '<b>' + t.name + '</b>' + (t.sub ? ' ' + t.sub : '');
      if (t.kind === 'call') {
        el.innerHTML = '<div class="k"><b>Call</b> KBO ABS zone</div><div class="v"><span class="call-v" data-r="call">—</span></div><div class="s" data-r="note">&nbsp;</div>';
      } else if (t.out) {
        el.innerHTML = '<div class="k">' + label + '</div><div class="v"><output data-r="val">—</output><small>' + t.unit + '</small></div><div class="s" data-r="note">&nbsp;</div>';
      } else {
        el.innerHTML = '<div class="k">' + label + '</div>' +
          '<button type="button" class="rst" data-r="rst" title="Reset to default" aria-label="Reset ' + t.name + ' to default">↺</button>' +
          '<div class="v"><input data-r="val" id="m-' + t.key + '" inputmode="decimal" aria-label="' + t.name + '"><small>' + t.unit + '</small></div>' +
          '<input type="range" data-r="range" min="' + t.min + '" max="' + t.max + '" step="' + t.step + '" aria-label="' + t.name + ' slider">' +
          '<div class="s" data-r="note">&nbsp;</div>';
        var inp = el.querySelector('[data-r=val]'), rng = el.querySelector('[data-r=range]'), rst = el.querySelector('[data-r=rst]');
        rng.addEventListener('input', function () {
          var p = cur(); if (!p) return;
          t.set(p, parseFloat(rng.value)); updateBoard(); changed('one', p.mode === 'movement');
        });
        inp.addEventListener('change', function () {
          var p = cur(); if (!p) return;
          var v = t.parse ? t.parse(inp.value) : parseFloat(inp.value);
          if (isNaN(v)) { updateBoard(true); return; }
          t.set(p, Math.max(t.min, Math.min(t.max, v))); inp.blur(); updateBoard(true); changed('one', true);
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
        rst.addEventListener('click', function () { var p = cur(); if (!p) return; resetTile(t, p); updateBoard(true); changed('one', true); });
      }
      grid.appendChild(el);
      tileEls[t.key] = { t: t, el: el };
    });
    g.appendChild(row);
  });
}
function resetTile(t, p) {
  if (t.relKey) p.rel[t.relKey] = null;
  else if (t.reset) t.reset(p);
  else t.set(p, t.def(p));
}
function isDefault(t, p) {
  if (t.relKey) return p.rel[t.relKey] == null;
  if (!t.def) return false;
  return Math.abs(t.get(p) - t.def(p)) < t.step / 2;
}
function updateBoard(force) {
  var p = cur();
  $('groups').hidden = !p; $('bhead').hidden = !p; $('boardEmpty').hidden = !!p;
  if (!p) { $('solveOut').hidden = true; return; }
  $('pdot').style.background = p.color; $('ptitle').textContent = p.name;
  $('ptype').value = p.type;
  setSeg('mode', 'data-mode', p.mode);
  var r = p.result;
  Object.keys(tileEls).forEach(function (k) {
    var o = tileEls[k], t = o.t, el = o.el;
    var note = el.querySelector('[data-r=note]');
    if (t.kind === 'call') {
      var c = judge(r), cv = el.querySelector('[data-r=call]');
      cv.textContent = c == null ? '—' : c ? 'Strike' : 'Ball';
      cv.className = 'call-v ' + (c ? 'strike' : 'ball');
      note.textContent = r && r.plate ? 'crosses at ' + (r.plate.p[2] / FT).toFixed(2) + ' ft high, ' + (-r.plate.p[0] / FT).toFixed(2) + ' ft side' : '';
      return;
    }
    if (t.out) {
      el.querySelector('[data-r=val]').textContent = r ? t.out(r) : '—';
      note.textContent = r ? t.note(p) : '';
      return;
    }
    var editable = t.edit(p);
    el.classList.toggle('edit', editable);
    var inp = el.querySelector('[data-r=val]'), rng = el.querySelector('[data-r=range]'), rst = el.querySelector('[data-r=rst]');
    inp.readOnly = !editable; rng.hidden = !editable; rst.hidden = !editable;
    var val = t.get(p);
    if (val != null) {
      if (force || document.activeElement !== inp) inp.value = t.fmt ? t.fmt(val) : round(val, t.step);
      if (document.activeElement !== rng) rng.value = val;
    } else inp.value = '—';
    var def = editable && isDefault(t, p);
    rst.disabled = def; rst.classList.toggle('on', !def);
    note.textContent = t.note ? t.note(p) : '';
  });
  var mv = p.mode === 'movement';
  $('solveOut').hidden = !mv || !p.solve;
  if (mv && p.solve) {
    $('solveOut').textContent = 'Movement → Spin: needs ' + Math.round(p.solve.activeRpm) + ' rpm active spin → SpinRate ' + Math.round(p.solve.spinRpm) + ' rpm at ' + p.eff + '% Spin Eff., Tilt ' + fmtClock(p.solve.tilt) + (p.solve.spinRpm > 3500 ? ' · beyond a realistic SpinRate' : '');
  }
}

var ptypeSel = $('ptype');
TYPES.forEach(function (t) { var o = document.createElement('option'); o.value = t.id; o.textContent = t.name; ptypeSel.appendChild(o); });
ptypeSel.addEventListener('change', function () {
  var p = cur(); if (!p) return;
  var t = typeById(ptypeSel.value);
  p.type = t.id; p.color = t.color; p.name = t.name;
  Object.assign(p, typeDefaults(p));
  p.ssw.on = false; p.ssw.orient = t.orient; p.ssw.qRel = qRelFor(t.orient);
  if (p.mode === 'movement') { var m = defaultMovement(p); p.ivb = m.ivb; p.hb = m.hb; }
  renderTabs(); updateSeamUI(); updateBoard(true); changed('one', true);
});
$('resetAll').addEventListener('click', function () {
  var p = cur(); if (!p) return;
  Object.assign(p, typeDefaults(p));
  p.rel = { h: null, side: null, ext: null };
  // a gathered pitch keeps its tunnel target; the reset applies to the one it returns to
  if (p.home) p.home = { side: 0, height: zoneCenterFt() };
  else p.target = { side: 0, height: zoneCenterFt() };
  if (p.mode === 'movement') { var m = defaultMovement(p); p.ivb = m.ivb; p.hb = m.hb; }
  updateBoard(true); changed('one', true);
});

// ---------- rack rows (with reset) ----------
var rows = {};
function addRow(container, cfg) {
  var row = document.createElement('div');
  row.className = 'row';
  var id = 'in-' + cfg.key;
  row.innerHTML = '<label for="' + id + '">' + cfg.label + (cfg.sub ? '<small>' + cfg.sub + '</small>' : '') + '</label>' +
    '<input type="range" id="' + id + '" min="' + cfg.min + '" max="' + cfg.max + '" step="' + (cfg.step || 1) + '">' +
    '<div class="num"><input id="' + id + '-n" inputmode="decimal" aria-label="' + cfg.label + '"><span>' + (cfg.unit || '') + '</span></div>' +
    '<button type="button" class="rst" title="Reset to default" aria-label="Reset ' + cfg.label + '">↺</button>';
  container.appendChild(row);
  var r = row.querySelector('input[type=range]'), n = row.querySelector('.num input'), b = row.querySelector('.rst');
  var entry = {
    cfg: cfg, row: row,
    sync: function () {
      var val = cfg.get();
      if (val == null) return;
      r.value = val;
      if (document.activeElement !== n) n.value = cfg.fmt ? cfg.fmt(val) : (Math.round(val * 100) / 100);
      var def = Math.abs(val - cfg.def()) < (cfg.step || 1) / 2;
      b.disabled = def; b.classList.toggle('on', !def);
    }
  };
  r.addEventListener('input', function () { cfg.set(parseFloat(r.value)); syncAll(); changed(cfg.scope); });
  n.addEventListener('change', function () {
    var val = parseFloat(n.value);
    if (isNaN(val)) { entry.sync(); return; }
    cfg.set(Math.max(cfg.min, Math.min(cfg.max, val))); n.blur(); syncAll(); changed(cfg.scope);
  });
  b.addEventListener('click', function () { cfg.set(cfg.def()); syncAll(); changed(cfg.scope); });
  rows[cfg.key] = entry;
  return entry;
}
function syncAll() { Object.keys(rows).forEach(function (k) { rows[k].sync(); }); updateAutoRelNote(); paintRanges(); }
function ftIn(v) { return v + ' (' + Math.floor(v / 12) + '′' + (v % 12) + '″)'; }
function updateAutoRelNote() {
  var a = autoRelease();
  $('autoRelNote').innerHTML = 'Default release for every pitch: <b>RelHeight ' + a.h.toFixed(2) + ' ft · RelSide ' + a.side.toFixed(2) + ' ft · Extension ' + a.ext.toFixed(2) + ' ft</b>. Edit a pitch\'s Release row to override it.';
}

addRow($('pitcherRows'), { key: 'ph', label: 'Height', unit: 'in', min: 64, max: 83, step: 1, scope: 'all', def: function () { return DEF.pitcher.height; },
  get: function () { return S.pitcher.height; }, set: function (v) { S.pitcher.height = v; }, fmt: ftIn });
addRow($('batterRows'), { key: 'bh', label: 'Batter height', unit: 'in', min: 64, max: 81, step: 1, scope: 'zone', def: function () { return DEF.batter.height; },
  get: function () { return S.batter.height; }, set: function (v) { S.batter.height = v; }, fmt: ftIn });
function envRow(container, key, label, unit, min, max, step) {
  addRow(container, { key: key, label: label, unit: unit, min: min, max: max, step: step, scope: 'all', def: function () { return DEF.env[key]; },
    get: function () { return S.env[key]; }, set: function (v) { S.env[key] = v; } });
}
envRow($('envRows'), 'temp', 'Temperature', '°F', 25, 105, 1);
envRow($('envRows'), 'rh', 'Humidity', '%', 0, 100, 1);
envRow($('envRows'), 'alt', 'Altitude', 'ft', 0, 8000, 50);
envRow($('windRows'), 'wind', 'Wind speed', 'mph', 0, 30, 1);
envRow($('windRows'), 'windDir', 'Wind dir.', '°', 0, 359, 1);
envRow($('moundRows'), 'mound', 'Mound height', 'in', 0, 16, 0.5);
addRow($('camRows'), { key: 'camH', label: 'Eye height', sub: 'above mound', unit: 'in', min: 24, max: 100, step: 1, scope: 'view', def: function () { return DEF.cam.height; },
  get: function () { return S.cam.height; }, set: function (v) { S.cam.height = v; } });
addRow($('camRows'), { key: 'camBack', label: 'Behind rubber', sub: 'camera distance', unit: 'ft', min: 0, max: 30, step: 0.5, scope: 'view', def: function () { return DEF.cam.back; },
  get: function () { return S.cam.back; }, set: function (v) { S.cam.back = v; } });
addRow($('camRows'), { key: 'fov', label: 'Field of view', unit: '°', min: 4, max: 60, step: 0.5, scope: 'view', def: function () { return DEF.cam.fov; },
  get: function () { return S.cam.fov; }, set: function (v) { S.cam.fov = v; } });
addRow($('sswRows'), { key: 'sswStr', label: 'SSW strength', unit: '%', min: 0, max: 200, step: 5, scope: 'one', def: function () { return 100; },
  get: function () { var p = cur(); return p ? p.ssw.strength : null; }, set: function (v) { var p = cur(); if (p) p.ssw.strength = v; } });

// ---------- segmented buttons ----------
function seg(containerId, attr, onPick) {
  var c = $(containerId);
  c.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !c.contains(b) || !b.hasAttribute(attr)) return;
    if (onPick(b.getAttribute(attr), b) === false) return;
    c.querySelectorAll('button').forEach(function (x) { if (x.hasAttribute(attr)) x.setAttribute('aria-pressed', String(x === b)); });
  });
}
function setSeg(containerId, attr, val) {
  $(containerId).querySelectorAll('button[' + attr + ']').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute(attr) === val)); });
}

seg('mode', 'data-mode', function (m) {
  var p = cur(); if (!p) return false;
  if (m === 'movement' && p.mode !== 'movement' && p.result) {
    p.ivb = Math.round(p.result.breakZ / IN * 10) / 10;
    p.hb = Math.round(-p.result.breakX / IN * 10) / 10;
  }
  p.mode = m; updateBoard(true); changed('one', true);
});
seg('hand', 'data-hand', function (h) {
  if (h === S.pitcher.hand) return;
  S.pitcher.hand = h;
  S.pitches.forEach(function (p) {
    p.tiltMin = Math.round(mirrorTilt(p.tiltMin / 60) * 60) % 720;
    p.hb = -p.hb; p.target.side = -p.target.side;
    if (p.home) p.home.side = -p.home.side;
    if (p.rel.side != null) p.rel.side = -p.rel.side;
  });
  syncAll(); changed('all', true);
});
seg('slot', 'data-slot', function (s) { S.pitcher.slot = s; syncAll(); changed('all'); });
seg('batter', 'data-b', function (b) { S.batter.side = b; buildBatter(); if (S.view === 'side' || S.view === 'batter') moveCamera(S.view); else placeCamera(); rebuildPitches(); });
seg('viewsw', 'data-view', function (v) {
  if (v === S.view) return;
  S.view = v; $('stage').dataset.view = v;
  $('vaaBtn').hidden = v !== 'side';
  moveCamera(v);
});
$('sswOn').addEventListener('change', function (e) { var p = cur(); if (p) { p.ssw.on = e.target.checked; changed('one'); } });

VENUES.forEach(function (v) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.textContent = v.name;
  b.addEventListener('click', function () { S.env.alt = v.alt; S.env.temp = v.temp; S.env.rh = v.rh; syncAll(); changed('all'); });
  $('venues').appendChild(b);
});

document.querySelector('.tabs').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('.tabs button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
  document.querySelectorAll('aside > .pane').forEach(function (p) { p.hidden = p.dataset.pane !== b.dataset.tab; });
  if (b.dataset.tab === 'ball') { resizeBall(); renderBall(); }
});

// ---------- pitch tabs ----------
var ptabs = $('ptabs');
var EYE_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 6s1.8-3.2 5-3.2S11 6 11 6 9.2 9.2 6 9.2 1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>';
var EYE_OFF_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 6s1.8-3.2 5-3.2S11 6 11 6 9.2 9.2 6 9.2 1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 10.5 10 1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
var LOCK_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3.5 5.5V3.8a2.5 2.5 0 0 1 5 0v1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="currentColor"/></svg>';
var UNLOCK_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3.5 5.5V3.8a2.5 2.5 0 0 1 4.8-1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
function renderTabs() {
  var html = S.pitches.map(function (p) {
    var sel = p.id === S.sel;
    return '<div class="ptab' + (p.hidden ? ' off' : '') + '" role="tab" tabindex="0" aria-selected="' + sel + '" data-id="' + p.id + '" style="--pc:' + p.color + '">' +
      '<span class="dot"></span><span class="lbl">' + esc(p.name) + '</span><span class="meta">' + p.mph.toFixed(1) + '</span>' +
      '<button type="button" class="lock" data-eye="' + p.id + '" aria-pressed="' + !!p.hidden + '" aria-label="Hide the ' + esc(p.name) + ' trajectory" title="' + (p.hidden ? 'Hidden: click to show this trajectory' : 'Hide this trajectory') + '">' + (p.hidden ? EYE_OFF_ICON : EYE_ICON) + '</button>' +
      '<button type="button" class="lock" data-lock="' + p.id + '" aria-pressed="' + !!p.locked + '" aria-label="Keep ' + esc(p.name) + ' from being removed" title="' + (p.locked ? 'Locked: click to allow removing this pitch' : 'Lock this pitch so it can\'t be removed') + '">' + (p.locked ? LOCK_ICON : UNLOCK_ICON) + '</button>' +
      (p.locked ? '' : '<button type="button" class="x" data-close="' + p.id + '" aria-label="Remove ' + esc(p.name) + '">×</button>') + '</div>';
  }).join('');
  html += '<div class="addwrap"><button type="button" class="addbtn" id="addBtn" aria-haspopup="true" aria-expanded="false">+ Add pitch</button></div>';
  ptabs.innerHTML = html;
}
var menu = document.createElement('div'); menu.className = 'menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
document.body.appendChild(menu);
function openMenu(anchor) {
  var p = cur();
  menu.innerHTML = TYPES.map(function (t) {
    return '<button type="button" role="menuitem" data-add="' + t.id + '"><i style="background:' + t.color + '"></i>' + t.name + '</button>';
  }).join('') + (p ? '<hr><button type="button" role="menuitem" data-dup="1">Duplicate “' + esc(p.name) + '”</button>' : '');
  menu.hidden = false;
  var r = anchor.getBoundingClientRect(), mw = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left + window.scrollX, document.documentElement.clientWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + window.scrollY + 4) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  var first = menu.querySelector('button'); if (first) first.focus();
}
function closeMenu() { menu.hidden = true; var a = $('addBtn'); if (a) a.setAttribute('aria-expanded', 'false'); }
document.addEventListener('click', function (e) {
  if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'addBtn' && e.target.id !== 'emptyAdd') closeMenu();
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
menu.addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  var p;
  if (b.dataset.add) p = makePitch(b.dataset.add);
  else {
    var src = cur();
    p = JSON.parse(JSON.stringify(Object.assign({}, src, { result: null, solve: null })));
    p.id = nextId++; p.name = src.name + ' copy'; p.locked = false; p.hidden = false;
  }
  S.pitches.push(p); S.sel = p.id;
  closeMenu(); computePitch(p); if (S.tunnel.gather) regather(); selectionChanged();
});
ptabs.addEventListener('click', function (e) {
  if (e.target.id === 'addBtn') { if (menu.hidden) openMenu(e.target); else closeMenu(); return; }
  var ey = e.target.closest('[data-eye]');
  if (ey) {
    var hp = S.pitches.filter(function (q) { return q.id === +ey.dataset.eye; })[0];
    if (hp) { hp.hidden = !hp.hidden; renderTabs(); refresh(); }
    return;
  }
  var lk = e.target.closest('[data-lock]');
  if (lk) {
    var lp = S.pitches.filter(function (q) { return q.id === +lk.dataset.lock; })[0];
    if (lp) { lp.locked = !lp.locked; renderTabs(); }
    return;
  }
  var x = e.target.closest('[data-close]');
  if (x) {
    var id = +x.dataset.close, i = S.pitches.findIndex(function (p) { return p.id === id; });
    S.pitches.splice(i, 1);
    if (S.sel === id) S.sel = S.pitches.length ? S.pitches[Math.min(i, S.pitches.length - 1)].id : null;
    if (S.tunnel.gather) regather();
    selectionChanged(); return;
  }
  var t = e.target.closest('.ptab'); if (t) { S.sel = +t.dataset.id; selectionChanged(); }
});
ptabs.addEventListener('keydown', function (e) {
  var t = e.target.closest('.ptab'); if (!t || e.target !== t) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel = +t.dataset.id; selectionChanged(); }
});
$('emptyAdd').addEventListener('click', function (e) { if (menu.hidden) openMenu(e.target); else closeMenu(); });

function selectionChanged() {
  renderTabs(); syncAll(); updateSeamUI(); refresh(true);
  var t = ptabs.querySelector('.ptab[aria-selected="true"]');
  if (t) ptabs.scrollLeft = Math.max(0, t.offsetLeft - ptabs.clientWidth + t.offsetWidth + 120);
}

// ---------- physics bridge ----------
function rho() { return P.airDensity(fToC(S.env.temp), S.env.rh, S.env.alt * FT); }
function baseDesc(p) {
  var rp = rel(p);
  return {
    release: [-rp.side * FT, C.RUBBER_Y - rp.ext * FT, rp.h * FT],
    v0: p.mph * MPH,
    spinRpm: p.rpm,
    tilt: p.tiltMin / 60,
    efficiency: p.eff / 100,
    gyroSign: handSign(),
    rho: rho(),
    wind: P.windVector(S.env.wind * MPH, S.env.windDir),
    sswStrength: p.ssw.on ? SSW_CMAX * p.ssw.strength / 100 : 0,
    qRel: p.ssw.qRel
  };
}
function targetWorld(p) { return [-p.target.side * FT, p.target.height * FT]; }

function computePitch(p) {
  var desc = baseDesc(p), tgt = targetWorld(p);
  if (p.mode === 'movement') {
    // HB is + toward the pitcher's right, which is what armSign = +1 means to the solver
    var sol = P.solveSpinForBreak(desc, tgt, [p.hb * IN, p.ivb * IN], 1);
    p.rpm = Math.max(0, Math.round(sol.spinRpm));
    p.tiltMin = Math.round(sol.tilt * 60) % 720;
    desc.spinRpm = sol.spinRpm; desc.tilt = sol.tilt;
    p.solve = sol;
  } else p.solve = null;
  var r = P.evaluate(desc, tgt);
  r.desc = desc;
  p.result = r;
  return r;
}

// ---------- pitch tunnel ----------
// Each pitch's tunnel point is where it is 0.175 s after release. Slower pitches have come less far by
// then, so gathering puts each point on the reference pitch's flight path rather than on one spot.
var TUNNEL_T = 0.175;
// reference: the leftmost Fastball tab, or the leftmost tab when there is no Fastball
function tunnelRef() {
  return S.pitches.filter(function (p) { return p.type === 'FB'; })[0] || S.pitches[0] || null;
}
function tunnelPoint(p) {
  var pts = p.result.sim.pts, q = pts[Math.min(pts.length - 1, Math.round(TUNNEL_T / 0.001))].p;
  return { x: q[0], y: q[1], z: q[2] };
}
function isGathered(p) { return S.tunnel.on && S.tunnel.gather && p !== tunnelRef(); }
// Re-aim every other pitch so its tunnel point sits on the reference's path, remembering where it was aimed.
function regather() {
  var ref = tunnelRef(); if (!ref) return;
  if (ref.home) { ref.target = ref.home; ref.home = null; computePitch(ref); }
  if (!ref.result) computePitch(ref);
  S.pitches.forEach(function (p) {
    if (p === ref) return;
    if (!p.home) p.home = { side: p.target.side, height: p.target.height };
    computePitch(p);
    var T = P.targetOntoPath(p.result.desc, TUNNEL_T, ref.result.sim, targetWorld(p));
    p.target = { side: -T[0] / FT, height: T[1] / FT };
    computePitch(p);
  });
}
// Put every pitch back on the target it had before gathering.
function ungather() {
  S.pitches.forEach(function (p) {
    if (p.home) { p.target = p.home; p.home = null; computePitch(p); }
  });
}
$('tunnelBtn').addEventListener('click', function (e) {
  S.tunnel.on = !S.tunnel.on;
  e.currentTarget.setAttribute('aria-pressed', String(S.tunnel.on));
  $('gatherBtn').hidden = !S.tunnel.on;
  if (!S.tunnel.on && S.tunnel.gather) {
    S.tunnel.gather = false; $('gatherBtn').setAttribute('aria-pressed', 'false');
    ungather();
  }
  refresh(true);
});
$('gatherBtn').addEventListener('click', function (e) {
  S.tunnel.gather = !S.tunnel.gather;
  e.currentTarget.setAttribute('aria-pressed', String(S.tunnel.gather));
  if (S.tunnel.gather) regather(); else ungather();
  refresh(true);
});
$('vaaBtn').addEventListener('click', function (e) {
  S.showVAA = !S.showVAA;
  e.currentTarget.setAttribute('aria-pressed', String(S.showVAA));
  rebuildPitches();
});
function renderTunnelHud() {
  var el = $('tunnelInfo'), ref = tunnelRef(), p = cur();
  el.hidden = !S.tunnel.on || !ref || !ref.result;
  if (el.hidden) return;
  var text = 'Tunnel at ' + TUNNEL_T.toFixed(3) + ' s · reference ' + ref.name;
  if (p && p.result) {
    var q = tunnelPoint(p);
    text += ' · ' + p.name + ' ' + ((q.y - C.PLATE_FRONT_Y) / FT).toFixed(1) + ' ft from plate';
    var c = p === ref ? null : P.crossingAt(ref.result.sim, q.y);
    if (c) text += ', ' + f1(Math.hypot(c.x - q.x, c.z - q.z) / IN) + ' in off its path';
  }
  el.textContent = text;
}

var pending = null, pendingScope = null;
function changed(scope, heavy) {
  if (scope === 'view') { placeCamera(); rebuildPitches(); requestRender(); return; }
  if (scope === 'zone') { buildZone(); placeCamera(); rebuildPitches(); updateBoard(); renderTable(); requestRender(); return; }
  pendingScope = pendingScope === 'all' || scope === 'all' ? 'all' : 'one';
  if (pending) clearTimeout(pending);
  pending = setTimeout(function () {
    pending = null;
    if (pendingScope === 'all') S.pitches.forEach(computePitch);
    else if (cur()) computePitch(cur());
    if (S.tunnel.gather) regather();
    pendingScope = null;
    renderTabs(); syncAll(); refresh();
  }, heavy ? 90 : 16);
}

// ---------- 3D scene ----------
var stage = $('stage'), canvas = $('scene');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
var scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');
var camera = new THREE.PerspectiveCamera(S.cam.fov, 16 / 9, 0.05, 300);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight('#ffffff', '#3a3a3a', 1.0));
var sun = new THREE.DirectionalLight('#ffffff', 0.55); sun.position.set(-3, 30, 20); scene.add(sun);

// A baseball with seams and stitches, radius 1 (scale it). Used on the field, in the seam editor and the PiP.
function makeBall(c) {
  var g = new THREE.Group();
  var sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshLambertMaterial({ color: c.leather }));
  g.add(sphere);
  var pts = P.SEAM.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(1.004); });
  var curve = new THREE.CatmullRomCurve3(pts, true);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 400, 0.035, 8, true), new THREE.MeshLambertMaterial({ color: c.seam })));
  var stitchMat = new THREE.MeshLambertMaterial({ color: c.stitch });
  var sg = new THREE.BoxGeometry(0.016, 0.11, 0.012);
  for (var i = 0; i < 108; i++) {
    var u = i / 108, p = curve.getPointAt(u), tng = curve.getTangentAt(u);
    var m = new THREE.Mesh(sg, stitchMat);
    m.position.copy(p).multiplyScalar(1.005);
    var nrm = p.clone().normalize(), side = new THREE.Vector3().crossVectors(tng, nrm).normalize();
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tng, side, nrm));
    m.rotateZ(i % 2 ? 0.45 : -0.45);
    g.add(m);
  }
  return { group: g, sphere: sphere };
}
// spin is shown slowed down so the eye can follow it; relative speeds between pitches are kept
var SPIN_SLOW = 40;
function spinPhase(now, rpm) { return (now / 1000) * (rpm / 60 / SPIN_SLOW) * 2 * Math.PI; }

// Only what a pitcher needs: home plate, strike zone, batter's boxes, batter, release ball, flight.
(function () {
  var sh = new THREE.Shape();
  sh.moveTo(0, 0); sh.lineTo(HALF_PLATE, HALF_PLATE); sh.lineTo(HALF_PLATE, 0.4318);
  sh.lineTo(-HALF_PLATE, 0.4318); sh.lineTo(-HALF_PLATE, HALF_PLATE); sh.lineTo(0, 0);
  scene.add(new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: '#e9ecef' })));
})();
var chalk = new THREE.LineBasicMaterial({ color: '#cfd5db', transparent: true, opacity: 0.7 });
function polyline(pts, mat) {
  var g = new THREE.BufferGeometry().setFromPoints(pts.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2] || 0.002); }));
  var l = new THREE.Line(g, mat); scene.add(l); return l;
}
[-1, 1].forEach(function (sgn) {
  var x0 = sgn * (HALF_PLATE + 0.1524), x1 = sgn * (HALF_PLATE + 0.1524 + 1.219);
  polyline([[x0, -0.70], [x1, -0.70], [x1, 1.13], [x0, 1.13], [x0, -0.70]], chalk);
});

var zoneGroup = new THREE.Group(); scene.add(zoneGroup);
function buildZone() {
  while (zoneGroup.children.length) zoneGroup.remove(zoneGroup.children[0]);
  var z = zoneLimits(), y = C.PLATE_FRONT_Y;
  function line(pts, color, op) {
    var g = new THREE.BufferGeometry().setFromPoints(pts.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); }));
    zoneGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: op })));
  }
  line([[-HALF_PLATE, y, z.bot], [HALF_PLATE, y, z.bot], [HALF_PLATE, y, z.top], [-HALF_PLATE, y, z.top], [-HALF_PLATE, y, z.bot]], '#ffffff', 0.9);
  for (var k = 1; k < 3; k++) {
    var xx = -HALF_PLATE + k * 2 * HALF_PLATE / 3, zz = z.bot + k * (z.top - z.bot) / 3;
    line([[xx, y, z.bot], [xx, y, z.top]], '#ffffff', 0.22);
    line([[-HALF_PLATE, y, zz], [HALF_PLATE, y, zz]], '#ffffff', 0.22);
  }
}

var batterGroup = new THREE.Group(); scene.add(batterGroup);
// Original 2D silhouettes of two virtual hitters, drawn on a canvas and shown on a plane that
// faces the camera. Coordinates are in batter heights: x to the right, y up from the ground.
// RHB: slightly crouched, hands at the back shoulder, bat laid back. LHB: tall and upright,
// hands high, bat nearly vertical. Profile = seen from the pitcher, front = seen from the side.
var STANCES = {
  R: {
    profile: { head: [-0.02, 0.905], brim: -1, torso: [[-0.075, 0.81], [0.06, 0.825], [0.11, 0.55], [-0.035, 0.525]],
      legs: [[[0.015, 0.53], [-0.07, 0.29], [-0.045, 0.045]], [[0.08, 0.53], [0.11, 0.29], [0.065, 0.045]]],
      feet: [[[-0.045, 0.02], [-0.14, 0.02]], [[0.065, 0.02], [-0.03, 0.02]]],
      arms: [[[-0.035, 0.78], [0.03, 0.695], [0.105, 0.79]], [[0.045, 0.795], [0.15, 0.72], [0.105, 0.79]]],
      bat: [[0.095, 0.78], [0.235, 1.03]] },
    front: { head: [0.0, 0.905], brim: 0, torso: [[-0.115, 0.805], [0.115, 0.805], [0.09, 0.53], [-0.09, 0.53]],
      legs: [[[0.05, 0.53], [0.17, 0.3], [0.205, 0.045]], [[-0.05, 0.53], [-0.155, 0.3], [-0.2, 0.045]]],
      feet: [[[0.205, 0.02], [0.24, 0.02]], [[-0.2, 0.02], [-0.235, 0.02]]],
      arms: [[[0.1, 0.785], [0.0, 0.69], [-0.125, 0.82]], [[-0.1, 0.785], [-0.2, 0.7], [-0.125, 0.82]]],
      bat: [[-0.13, 0.83], [-0.27, 1.04]] }
  },
  L: {
    profile: { head: [-0.005, 0.91], brim: -1, torso: [[-0.06, 0.815], [0.07, 0.83], [0.095, 0.55], [-0.04, 0.53]],
      legs: [[[0.01, 0.535], [-0.045, 0.29], [-0.04, 0.045]], [[0.07, 0.535], [0.09, 0.29], [0.06, 0.045]]],
      feet: [[[-0.04, 0.02], [-0.13, 0.02]], [[0.06, 0.02], [-0.03, 0.02]]],
      arms: [[[-0.025, 0.79], [0.035, 0.73], [0.09, 0.865]], [[0.05, 0.8], [0.15, 0.78], [0.09, 0.865]]],
      bat: [[0.09, 0.86], [0.135, 1.12]] },
    front: { head: [0.0, 0.91], brim: 0, torso: [[-0.11, 0.81], [0.11, 0.81], [0.085, 0.535], [-0.085, 0.535]],
      legs: [[[0.05, 0.535], [0.13, 0.3], [0.165, 0.045]], [[-0.05, 0.535], [-0.12, 0.3], [-0.16, 0.045]]],
      feet: [[[0.165, 0.02], [0.2, 0.02]], [[-0.16, 0.02], [-0.195, 0.02]]],
      arms: [[[0.1, 0.79], [0.0, 0.73], [-0.115, 0.875]], [[-0.1, 0.79], [-0.2, 0.77], [-0.115, 0.875]]],
      bat: [[-0.115, 0.87], [-0.16, 1.13]] }
  }
};
var SIL_W = 0.8, SIL_H = 1.16; // plane size in batter heights
function silhouetteTexture(st, mirror) {
  var W = 400, Hc = Math.round(W * SIL_H / SIL_W), u = Hc / SIL_H;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = Hc;
  var g = cv.getContext('2d');
  function X(x) { return W / 2 + (mirror ? -x : x) * u; }
  function Y(y) { return Hc - y * u; }
  function limb(pts, w0, w1) {
    for (var i = 0; i < pts.length - 1; i++) {
      g.lineWidth = (w0 + (w1 - w0) * i / Math.max(1, pts.length - 2)) * u;
      g.beginPath(); g.moveTo(X(pts[i][0]), Y(pts[i][1])); g.lineTo(X(pts[i + 1][0]), Y(pts[i + 1][1])); g.stroke();
    }
  }
  g.fillStyle = g.strokeStyle = '#2b3744'; g.lineCap = 'round'; g.lineJoin = 'round';
  // faint rim so the figure reads against dark grass
  g.shadowColor = 'rgba(190, 210, 230, 0.45)'; g.shadowBlur = 0.01 * u;
  st.legs.forEach(function (l) { limb(l, 0.08, 0.058); });
  st.feet.forEach(function (f) { limb(f, 0.042, 0.042); });
  g.beginPath(); st.torso.forEach(function (q, i) { if (i) g.lineTo(X(q[0]), Y(q[1])); else g.moveTo(X(q[0]), Y(q[1])); }); g.closePath(); g.fill();
  g.lineWidth = 0.03 * u; g.stroke();
  limb([[ (st.torso[0][0] + st.torso[1][0]) / 2, 0.81 ], st.head], 0.06, 0.06);
  // bat behind the arms
  g.strokeStyle = '#3a2f24'; limb(st.bat, 0.022, 0.042); g.strokeStyle = '#2b3744';
  st.arms.forEach(function (a) { limb(a, 0.052, 0.045); });
  // helmet with brim toward where the hitter faces
  g.beginPath(); g.arc(X(st.head[0]), Y(st.head[1]), 0.066 * u, 0, Math.PI * 2); g.fill();
  if (st.brim) {
    var dir = (mirror ? -st.brim : st.brim);
    g.lineWidth = 0.022 * u; g.beginPath();
    g.moveTo(X(st.head[0]), Y(st.head[1] + 0.005)); g.lineTo(X(st.head[0]) + dir * 0.1 * u, Y(st.head[1] - 0.005)); g.stroke();
  }
  var tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}
var silCache = {};
function silTex(side, view, mirror) {
  var k = side + view + (mirror ? 'm' : '');
  // an LHB is the mirror image of the drawing; seen from behind the plate the profile flips too
  if (!silCache[k]) silCache[k] = silhouetteTexture(STANCES[side][view], (side === 'L') !== !!mirror);
  return silCache[k];
}
var batterMesh = null, batterKey = '';
function buildBatter() {
  if (batterMesh) { batterGroup.remove(batterMesh); batterMesh.geometry.dispose(); batterMesh.material.dispose(); batterMesh = null; }
  batterKey = '';
  if (S.batter.side === 'none') return;
  var H = S.batter.height * IN;
  batterMesh = new THREE.Mesh(new THREE.PlaneGeometry(SIL_W * H, SIL_H * H),
    new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, opacity: 0.95 }));
  var sx = S.batter.side === 'R' ? -1 : 1, off = HALF_PLATE + 0.1524 + 0.45;
  batterMesh.position.set(sx * off, 0.2, SIL_H * H / 2);
  batterMesh.up.set(0, 0, 1);
  batterGroup.add(batterMesh);
  orientBatter();
}
// keep the silhouette facing the camera and pick the drawing for where the camera stands:
// in front of the pitcher's side -> profile, behind the plate -> mirrored profile, beside -> front
function orientBatter() {
  if (!batterMesh) return;
  var bp = batterMesh.position, dx = camera.position.x - bp.x, dy = camera.position.y - bp.y;
  batterMesh.visible = Math.hypot(dx, dy) > 2.2;
  var ang = Math.abs(Math.atan2(dx, dy)) * 180 / Math.PI;
  var view = ang < 55 ? 'profile' : ang > 125 ? 'profile' : 'front', mirror = ang > 125;
  var key = view + mirror;
  if (key !== batterKey) { batterMesh.material.map = silTex(S.batter.side, view, mirror); batterMesh.material.needsUpdate = true; batterKey = key; }
  batterMesh.lookAt(bp.x + dx, bp.y + dy, bp.z);
}

var pitchGroup = new THREE.Group(); scene.add(pitchGroup);
// balls flown by Play, one per pitch being played
var playBallGeo = new THREE.SphereGeometry(R_BALL, 20, 14), playBalls = [];
function playBall(i) {
  if (!playBalls[i]) { playBalls[i] = new THREE.Mesh(playBallGeo, new THREE.MeshBasicMaterial({ color: '#ffffff' })); scene.add(playBalls[i]); }
  return playBalls[i];
}
// the ball at the release point, turning about its real spin axis
var relBall = makeBall({ leather: '#efe9dc', seam: '#c8323a', stitch: '#a8222a' });
relBall.group.scale.setScalar(R_BALL); relBall.group.visible = false; scene.add(relBall.group);

// The flight as one faint tube the size of the ball. Far cameras get a thicker tube so it stays visible.
function tubeRadius(pose) {
  var mid = new THREE.Vector3(0, 9, 1.3), dist = pose.pos.distanceTo(mid);
  var pxPerM = (stage.clientHeight || 400) / (2 * dist * Math.tan(pose.fov * Math.PI / 360));
  return Math.max(R_BALL, 3.5 / pxPerM);
}
function drawPitch(p, strong, radius) {
  var r = p.result; if (!r) return;
  var pts = [];
  for (var i = 0; i < r.sim.pts.length; i += 6) if (r.sim.pts[i].p[1] >= 0) pts.push(r.sim.pts[i]);
  if (pts.length < 2) return;
  var curve = new THREE.CatmullRomCurve3(pts.map(function (s) { return new THREE.Vector3(s.p[0], s.p[1], s.p[2]); }));
  var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, TUBE_SEGS, radius, TUBE_SIDES, false),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color), transparent: true, opacity: strong ? TUBE_ON : TUBE_OFF, depthWrite: false }));
  tube.renderOrder = strong ? 2 : 1;
  tube.userData = { y0: pts[0].p[1], y1: pts[pts.length - 1].p[1], pid: p.id, opacity: strong ? TUBE_ON : TUBE_OFF };
  // close both ends with a dome in the tube's own material
  var capGeo = new THREE.SphereGeometry(radius, TUBE_SIDES, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  function cap(u, out) {
    var m = new THREE.Mesh(capGeo, tube.material);
    m.position.copy(curve.getPointAt(u));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
    m.renderOrder = tube.renderOrder;
    tube.add(m);
    return m;
  }
  cap(0, curve.getTangentAt(0).negate());
  tube.userData.endCap = cap(1, curve.getTangentAt(1));
  pitchGroup.add(tube);
  return tube;
}
var TUBE_SEGS = 160, TUBE_SIDES = 18, TUBE_ON = 0.55, TUBE_OFF = 0.35, tubes = {};
// show a tube only up to its flying ball, so the trail grows behind it during Play
function trimTube(tube, y) {
  var d = tube.userData, frac = Math.max(0, Math.min(1, (d.y0 - y) / (d.y0 - d.y1)));
  tube.geometry.setDrawRange(0, Math.ceil(frac * TUBE_SEGS) * TUBE_SIDES * 6);
  tube.userData.endCap.visible = frac >= 1;
}
function rebuildPitches() {
  while (pitchGroup.children.length) {
    var c = pitchGroup.children[0]; pitchGroup.remove(c);
    c.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    if (c.material) c.material.dispose();
  }
  var sel = cur(), radius = tubeRadius(viewPose(S.view));
  tubes = {};
  S.pitches.forEach(function (p) { if (p !== sel && !p.hidden) tubes[p.id] = drawPitch(p, false, radius); });
  if (sel && !sel.hidden) tubes[sel.id] = drawPitch(sel, true, radius);
  buildTunnelMarks(sel, radius);
  buildVaaMark(sel);
  relBall.group.visible = !!(sel && sel.result);
  if (sel && sel.result) { var rp = sel.result.desc.release; relBall.group.position.set(rp[0], rp[1], rp[2]); }
}
// tunnel marks: one dot per pitch at its own 0.175 s position
function buildTunnelMarks(sel, radius) {
  var ref = tunnelRef();
  if (!S.tunnel.on || !ref || !ref.result) return;
  var r = radius * 1.25;
  S.pitches.forEach(function (p) {
    if (!p.result || p.hidden) return;
    var q = tunnelPoint(p);
    var dot = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color), transparent: true, opacity: p === sel ? 1 : 0.5 }));
    dot.position.set(q.x, q.y, q.z); dot.renderOrder = p === sel ? 4 : 3;
    pitchGroup.add(dot);
  });
}
// VAA mark for the side view: level line and approach line from the plate crossing, the angle between them shaded
var VAA_LEN = 8, vaaGroup = new THREE.Group(), vaaLabelAt = null;
scene.add(vaaGroup);
function buildVaaMark(sel) {
  while (vaaGroup.children.length) {
    var c = vaaGroup.children[0]; vaaGroup.remove(c);
    c.geometry.dispose(); c.material.dispose();
  }
  vaaLabelAt = null;
  if (!S.showVAA || !sel || sel.hidden || !sel.result || !sel.result.plate) return;
  var pl = sel.result.plate.p, a = -sel.result.vaa * Math.PI / 180;
  var o = new THREE.Vector3(pl[0], pl[1], pl[2]);
  var lvl = new THREE.Vector3(pl[0], pl[1] + VAA_LEN, pl[2]);
  var app = new THREE.Vector3(pl[0], pl[1] + VAA_LEN * Math.cos(a), pl[2] + VAA_LEN * Math.sin(a));
  function line(q, op) {
    var l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, q]), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: op }));
    l.renderOrder = 6; vaaGroup.add(l);
  }
  line(lvl, 0.55); line(app, 1);
  var g = new THREE.BufferGeometry().setFromPoints([o, lvl, app]);
  var wedge = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  wedge.renderOrder = 6; vaaGroup.add(wedge);
  vaaLabelAt = app.clone();
  $('vaaLabel').textContent = 'VAA ' + sel.result.vaa.toFixed(2).replace('-', '\u2212') + '°';
}
function placeVaaLabel() {
  var on = !!vaaLabelAt && S.view === 'side' && !camMove;
  vaaGroup.visible = on;
  $('vaaLabel').hidden = !on;
  if (!on) return;
  var q = vaaLabelAt.clone().project(camera);
  $('vaaLabel').style.left = ((q.x + 1) / 2 * stage.clientWidth) + 'px';
  $('vaaLabel').style.top = ((1 - q.y) / 2 * stage.clientHeight) + 'px';
}
function spinRelBall(now) {
  var f = ballFrame(); if (!f) return;
  var q = Q.mul(Q.axisAngle(f.axis, spinPhase(now, f.p.result.desc.spinRpm)), ballWorldQ(f));
  relBall.group.quaternion.copy(toThreeQ(q));
}

// Batter view: crouched eye height, the release in the corner of the eye at the centre of the upper
// quadrant on the mound side, the middle of the zone at the centre of the opposite lower quadrant
// (II and IV for a RHB, mirrored for a LHB). The aim follows from the release; the camera's place in
// the batter's box is solved so the zone lands where it should.
var BATTER_FOV = 46, BATTER_EYE = 0.8;
function batterPose() {
  var bs = S.batter.side === 'L' ? 1 : -1, z = zoneLimits(), eyeZ = S.batter.height * IN * BATTER_EYE;
  var sp = cur(), ra = sp ? rel(sp) : autoRelease();
  var rp = [-ra.side * FT, C.RUBBER_Y - ra.ext * FT, ra.h * FT], zp = [0, C.PLATE_FRONT_Y, (z.bot + z.top) / 2];
  var tv = Math.tan(BATTER_FOV * Math.PI / 360), a = camera.aspect;
  var relX = 0.5 * bs * a * tv, relY = 0.5 * tv;
  // aim that puts the release at its screen spot from camera position (x, y)
  function aimFrom(x, y) {
    var wx = rp[0] - x, wy = rp[1] - y, wz = rp[2] - eyeZ;
    var A = Math.sin(Math.atan2(wz, Math.hypot(wx, wy))) * Math.sqrt(relX * relX + relY * relY + 1);
    var down = Math.acos(A / Math.sqrt(1 + relY * relY)) - Math.atan2(1, relY);
    var bearing = Math.atan2(wx, wy) - Math.atan2(relX, relY * Math.sin(down) + Math.cos(down));
    return { down: down, bearing: bearing };
  }
  // where the middle of the zone lands on screen, minus where it should be
  function miss(m, y) {
    var x = bs * m, g = aimFrom(x, y), sb = Math.sin(g.bearing), cb = Math.cos(g.bearing), sd = Math.sin(g.down), cd = Math.cos(g.down);
    var vx = zp[0] - x, vy = zp[1] - y, vz = zp[2] - eyeZ;
    var side = vx * cb - vy * sb, along = vx * sb + vy * cb;
    var fwd = along * cd - vz * sd, up = along * sd + vz * cd;
    return [side / (fwd * a * tv) + 0.5 * bs, up / (fwd * tv) + 0.5];
  }
  var m = 1.1, y = -0.9, h = 0.005;
  for (var i = 0; i < 10; i++) {
    var e = miss(m, y);
    if (Math.abs(e[0]) + Math.abs(e[1]) < 0.002) break;
    var e1 = miss(m + h, y), e2 = miss(m, y + h);
    var j00 = (e1[0] - e[0]) / h, j01 = (e2[0] - e[0]) / h, j10 = (e1[1] - e[1]) / h, j11 = (e2[1] - e[1]) / h;
    var det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) break;
    m = Math.max(0.5, Math.min(2.5, m - (j11 * e[0] - j01 * e[1]) / det));
    y = Math.max(-3, Math.min(0.2, y - (j00 * e[1] - j10 * e[0]) / det));
  }
  var g = aimFrom(bs * m, y), pos = new THREE.Vector3(bs * m, y, eyeZ);
  return { pos: pos, look: pos.clone().add(new THREE.Vector3(Math.sin(g.bearing) * Math.cos(g.down), Math.cos(g.bearing) * Math.cos(g.down), -Math.sin(g.down))), fov: BATTER_FOV };
}

// ---------- cameras: pitcher (behind the rubber), side, catcher; moves between them glide ----------
function viewPose(v) {
  var z = zoneLimits();
  if (v === 'pitcher') {
    return { pos: new THREE.Vector3(0, C.RUBBER_Y + 0.05 + S.cam.back * FT, (S.env.mound + S.cam.height) * IN),
      look: new THREE.Vector3(0, 0.3, (z.bot + z.top) / 2 + 0.25), fov: S.cam.fov };
  }
  if (v === 'catcher') {
    // behind the plate, eye level at the line between the middle and top thirds of the zone
    var eye = z.bot + (z.top - z.bot) * 2 / 3;
    return { pos: new THREE.Vector3(0, -8.0, eye), look: new THREE.Vector3(0, 8, eye + 0.15), fov: 20 };
  }
  if (v === 'batter') {
    return batterPose();
  }
  // side-on from the side opposite the batter; distance chosen so plate-to-rubber fills the width
  var sx = S.batter.side === 'L' ? -1 : 1, fov = 30;
  var dist = 10.2 / (Math.tan(fov * Math.PI / 360) * Math.max(0.6, camera.aspect));
  return { pos: new THREE.Vector3(sx * dist, 9.0, 1.7), look: new THREE.Vector3(0, 9.0, 1.25), fov: fov };
}
var camMove = null, camLook = new THREE.Vector3();
function applyPose(pos, look, fov) {
  camera.position.copy(pos); camLook.copy(look); camera.lookAt(look);
  camera.fov = fov; camera.updateProjectionMatrix();
}
function placeCamera() {
  if (camMove) return;
  var t = viewPose(S.view); applyPose(t.pos, t.look, t.fov);
}
function moveCamera(v) {
  var to = viewPose(v), from = { pos: camera.position.clone(), look: camLook.clone(), fov: camera.fov };
  // swing out to the side and up on the way, like a crane shot, instead of flying through the scene
  var ctrl = from.pos.clone().add(to.pos).multiplyScalar(0.5);
  var sx = S.batter.side === 'L' ? -1 : 1;
  ctrl.x += sx * 0.35 * from.pos.distanceTo(to.pos); ctrl.z += 2.5;
  camMove = { from: from, to: to, ctrl: ctrl, t0: performance.now(), dur: 1100 };
}
function stepCamera(now) {
  if (!camMove) return false;
  var m = camMove, u = Math.min(1, (now - m.t0) / m.dur);
  var e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  var a = m.from.pos, c = m.ctrl, b = m.to.pos, k = 1 - e;
  var pos = new THREE.Vector3(
    k * k * a.x + 2 * k * e * c.x + e * e * b.x,
    k * k * a.y + 2 * k * e * c.y + e * e * b.y,
    k * k * a.z + 2 * k * e * c.z + e * e * b.z);
  applyPose(pos, m.from.look.clone().lerp(m.to.look, e), m.from.fov + (m.to.fov - m.from.fov) * e);
  if (u >= 1) { camMove = null; rebuildPitches(); }
  return true;
}

// Play flies the selected pitch, or every pitch on screen at once when "All pitches" is on
var anim = { playing: false, t0: 0, speed: 0.25, all: false, list: [] };
function posAt(p, t) {
  var pts = p.result.sim.pts;
  return pts[Math.min(pts.length - 1, Math.max(0, Math.round(t / 0.001)))].p;
}
function stopPlay() {
  anim.playing = false; $('play').textContent = '▶ Play';
  playBalls.forEach(function (b) { b.visible = false; });
  Object.keys(tubes).forEach(function (k) {
    if (tubes[k]) { tubes[k].geometry.setDrawRange(0, Infinity); tubes[k].userData.endCap.visible = true; }
  });
}
function requestRender() {}
function loop(now) {
  var p = cur();
  if (anim.playing) {
    var t = (now - anim.t0) / 1000 * anim.speed, last = 0;
    anim.list = anim.list.filter(function (q) { return q.result && S.pitches.indexOf(q) >= 0; });
    anim.list.forEach(function (q, i) {
      var pts = q.result.sim.pts, end = pts[pts.length - 1].t, b = playBall(i), pos = posAt(q, Math.min(t, end));
      last = Math.max(last, end);
      b.visible = true; b.position.set(pos[0], pos[1], pos[2]);
      if (tubes[q.id]) trimTube(tubes[q.id], pos[1]);
    });
    for (var j = anim.list.length; j < playBalls.length; j++) playBalls[j].visible = false;
    if (!anim.list.length || t >= last + 0.15) stopPlay();
  }
  stepCamera(now);
  orientBatter();
  spinRelBall(now);
  placeVaaLabel();
  renderer.render(scene, camera);
  if (ballState.spin && !$('ballEdit').hidden) { ballState.phase += 0.035; renderBall(); }
  renderPip(now);
  requestAnimationFrame(loop);
}
$('play').addEventListener('click', function () {
  var p = cur(); if (!p) return;
  anim.list = anim.all ? S.pitches.filter(function (q) { return q.result && !q.hidden; }) : [p];
  anim.playing = true; anim.t0 = performance.now(); $('play').textContent = '■ Playing';
});
$('playAll').addEventListener('click', function (e) {
  anim.all = !anim.all;
  e.currentTarget.setAttribute('aria-pressed', String(anim.all));
});
var SPEEDS = [0.1, 0.25, 0.5, 1];
$('speed').addEventListener('click', function () {
  anim.speed = SPEEDS[(SPEEDS.indexOf(anim.speed) + 1) % SPEEDS.length];
  $('speed').textContent = 'Speed ' + anim.speed + '×';
});

// click to aim (pitcher and catcher views)
var down = null;
canvas.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; });
// the unselected trajectory under the pointer, if any
var pickRay = new THREE.Raycaster();
function pickTube(e) {
  var rect = canvas.getBoundingClientRect();
  pickRay.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height * 2 - 1)), camera);
  var list = Object.keys(tubes).filter(function (k) { return tubes[k] && +k !== S.sel; }).map(function (k) { return tubes[k]; });
  var hits = pickRay.intersectObjects(list, false);
  return hits.length ? hits[0].object : null;
}
var hoverTube = null;
canvas.addEventListener('pointermove', function (e) {
  if (camMove || e.buttons) return;
  var t = pickTube(e);
  if (t === hoverTube) return;
  if (hoverTube && hoverTube.material) hoverTube.material.opacity = hoverTube.userData.opacity;
  if (t) t.material.opacity = TUBE_ON;
  hoverTube = t;
  canvas.style.cursor = t ? 'pointer' : '';
});
canvas.addEventListener('pointerleave', function () {
  if (hoverTube && hoverTube.material) hoverTube.material.opacity = hoverTube.userData.opacity;
  hoverTube = null; canvas.style.cursor = '';
});
canvas.addEventListener('pointerup', function (e) {
  var p = cur();
  if (!p || camMove || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  var picked = pickTube(e);
  if (picked) { S.sel = picked.userData.pid; hoverTube = null; canvas.style.cursor = ''; selectionChanged(); return; }
  if (S.view === 'side' || isGathered(p)) return;
  var rect = canvas.getBoundingClientRect();
  var ndc = new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height * 2 - 1));
  var ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  var o = ray.ray.origin, d = ray.ray.direction;
  if (Math.abs(d.y) < 1e-6) return;
  var t = (C.PLATE_FRONT_Y - o.y) / d.y; if (t <= 0) return;
  p.target.side = Math.max(-2, Math.min(2, Math.round(-(o.x + d.x * t) / FT * 100) / 100));
  p.target.height = Math.max(0.3, Math.min(5.2, Math.round((o.z + d.z * t) / FT * 100) / 100));
  updateBoard(true); changed('one', p.mode === 'movement');
});

function resizeStage() {
  var w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  placeCamera(); rebuildPitches();
}
new ResizeObserver(function () { resizeStage(); drawViews(); }).observe(stage);

// ---------- seam orientation editor ----------
// Gizmo rings use the field axes: X = 1B–3B line (tumble toward/away from home),
// Y = mound–home line (roll as the pitcher sees it), Z = vertical (turn left/right).
var ballCanvas = $('ballCanvas');
var bRenderer = new THREE.WebGLRenderer({ canvas: ballCanvas, antialias: true });
bRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
var bScene = new THREE.Scene(); bScene.background = new THREE.Color('#000000');
var bCam = new THREE.PerspectiveCamera(30, 1, 0.1, 60); bCam.up.set(0, 0, 1);
bScene.add(new THREE.HemisphereLight('#ffffff', '#3a3f48', 0.9));
var bl = new THREE.DirectionalLight('#ffffff', 0.5); bl.position.set(2, 3, 4); bScene.add(bl);
var editBall = makeBall({ leather: '#efe9dc', seam: '#c8323a', stitch: '#a8222a' });
var ballGroup = editBall.group, ballSphere = editBall.sphere; bScene.add(ballGroup);
var helperGroup = new THREE.Group(); bScene.add(helperGroup);
var zoneGroupB = new THREE.Group(); bScene.add(zoneGroupB);

// rotate gizmo: visible rings plus fat invisible rings for picking
var GIZMO_R = 1.42;
var gizmo = new THREE.Group(); bScene.add(gizmo);
var gizmoRings = [];
[['x', [1, 0, 0], COL.gx], ['y', [0, 1, 0], COL.gy], ['z', [0, 0, 1], COL.gz]].forEach(function (g) {
  var vis = new THREE.Mesh(new THREE.TorusGeometry(GIZMO_R, 0.022, 10, 128), new THREE.MeshBasicMaterial({ color: g[2], transparent: true, opacity: 0.65 }));
  var pick = new THREE.Mesh(new THREE.TorusGeometry(GIZMO_R, 0.11, 8, 64), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  // a torus lies in the XY plane (axis Z); turn it so its axis matches
  [vis, pick].forEach(function (m) {
    if (g[0] === 'x') m.rotation.y = Math.PI / 2;
    if (g[0] === 'y') m.rotation.x = Math.PI / 2;
    gizmo.add(m);
  });
  pick.userData = { axis: g[1], vis: vis };
  gizmoRings.push(pick);
});

// solid arrow from a cylinder + cone so it reads at small sizes
function fatArrow(dir, color, length, origin, radius) {
  var d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(), g = new THREE.Group();
  var r = radius || 0.04, mat = new THREE.MeshBasicMaterial({ color: color });
  var shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length - 0.3, 12), mat); shaft.position.y = (length - 0.3) / 2;
  var head = new THREE.Mesh(new THREE.ConeGeometry(r * 3, 0.3, 16), mat); head.position.y = length - 0.15;
  g.add(shaft); g.add(head);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  g.position.copy(origin || new THREE.Vector3());
  helperGroup.add(g); return g;
}
function ringAround(group, axis, angleDeg, opacity, tube) {
  var a = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  var any = Math.abs(a.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  var u = new THREE.Vector3().crossVectors(a, any).normalize(), w = new THREE.Vector3().crossVectors(a, u);
  var th = angleDeg * Math.PI / 180, pts = [];
  for (var i = 0; i < 96; i++) {
    var ph = i / 96 * Math.PI * 2;
    pts.push(a.clone().multiplyScalar(Math.cos(th)).add(u.clone().multiplyScalar(Math.sin(th) * Math.cos(ph))).add(w.clone().multiplyScalar(Math.sin(th) * Math.sin(ph))).multiplyScalar(1.03));
  }
  var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, tube, 6, true);
  group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: opacity })));
}
var ballState = { view: 'persp', spin: false, phase: 0, camDir: new THREE.Vector3(-0.55, 1, 0.55).normalize(), dist: 9.2 };

function toThreeQ(q) { return new THREE.Quaternion(q[1], q[2], q[3], q[0]); }
function fromThreeQ(t) { return [t.w, t.x, t.y, t.z]; }
function ballFrame() {
  var p = cur(); if (!p || !p.result) return null;
  var dir = p.result.aim.params.dir, axis = p.result.aim.params.spinAxis;
  // the seams are placed at release (dir); the wake answers the mid-flight flow (flow)
  return { p: p, dir: dir, flow: p.result.flowDir || dir, axis: axis, sf: P.spinFrameQuat(axis, dir) };
}
function ballWorldQ(f) { return Q.mul(f.sf, f.p.ssw.qRel); }
function setBallWorldQ(f, qw) { f.p.ssw.qRel = Q.norm(Q.mul(Q.conj(f.sf), qw)); f.p.ssw.orient = null; }

function renderBall() {
  var f = ballFrame(); if (!f || !ballCanvas.clientWidth) return;
  var qWorld = ballWorldQ(f);
  if (ballState.spin) qWorld = Q.mul(Q.axisAngle(f.axis, ballState.phase), qWorld);
  ballGroup.quaternion.copy(toThreeQ(qWorld));
  while (helperGroup.children.length) helperGroup.remove(helperGroup.children[0]);
  while (zoneGroupB.children.length) zoneGroupB.remove(zoneGroupB.children[0]);
  var ax = new THREE.Vector3(f.axis[0], f.axis[1], f.axis[2]);
  fatArrow(f.axis, COL.axis, 3.4, ax.clone().multiplyScalar(-1.7), 0.035);
  fatArrow(f.dir, COL.travel, 1.0, new THREE.Vector3(f.dir[0], f.dir[1], f.dir[2]).multiplyScalar(1.15));
  if ($('showZones').checked) {
    ringAround(zoneGroupB, f.dir, 106, 0.9, 0.016);
    ringAround(zoneGroupB, f.dir, 80, 0.35, 0.012);
  }
  var e = P.sswEffect(f.axis, f.flow, ballWorldQ(f));
  if (e.level > 0.02) fatArrow(e.dir, COL.ssw, 0.7 + 1.1 * e.level, new THREE.Vector3(e.dir[0], e.dir[1], e.dir[2]).multiplyScalar(1.05), 0.05);
  gizmo.visible = $('showGizmo').checked;
  var cd;
  if (ballState.view === 'pitcher') cd = new THREE.Vector3(-f.dir[0], -f.dir[1], -f.dir[2] + 0.12).normalize();
  else if (ballState.view === 'side') cd = new THREE.Vector3(-1, 0, 0.08).normalize();
  else if (ballState.view === 'axis') cd = ax.clone();
  else cd = ballState.camDir.clone();
  bCam.position.copy(cd.multiplyScalar(ballState.dist));
  bCam.up.copy(Math.abs(bCam.position.clone().normalize().z) > 0.97 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
  bCam.lookAt(0, 0, 0);
  bCam.updateMatrixWorld();
  bRenderer.render(bScene, bCam);
}
function resizeBall() {
  var w = ballCanvas.clientWidth; if (!w) return;
  bRenderer.setSize(w, w, false); bCam.aspect = 1; bCam.updateProjectionMatrix();
}
new ResizeObserver(function () { resizeBall(); renderBall(); }).observe(ballCanvas);

function ndcOf(e) {
  var r = ballCanvas.getBoundingClientRect();
  return new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1));
}
function toScreen(v) {
  var p = v.clone().project(bCam), w = ballCanvas.clientWidth;
  return new THREE.Vector2((p.x + 1) / 2 * w, (1 - p.y) / 2 * w);
}
var bRay = new THREE.Raycaster();
var drag = null, hoverRing = null;
function pickRing(e) {
  if (!gizmo.visible) return null;
  bRay.setFromCamera(ndcOf(e), bCam);
  var hits = bRay.intersectObjects(gizmoRings, false);
  return hits.length ? hits[0] : null;
}
function setHover(ring) {
  if (hoverRing === ring) return;
  gizmoRings.forEach(function (r) { r.userData.vis.material.opacity = r === ring ? 1 : 0.65; });
  hoverRing = ring; renderBall();
}
function clearOrientChips() { orientBox.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); }
function applyWorldRotation(axis, ang) {
  var f = ballFrame(); if (!f) return;
  setBallWorldQ(f, Q.mul(Q.axisAngle(axis, ang), ballWorldQ(f)));
  clearOrientChips(); updateSswReadout(); updateRotFields(); renderBall();
}
ballCanvas.addEventListener('pointerdown', function (e) {
  if (!ballFrame()) return;
  ballCanvas.setPointerCapture(e.pointerId);
  var hit = pickRing(e);
  if (hit) {
    // on-screen direction the ring moves at the grab point, for 0.01 rad of rotation
    var A = new THREE.Vector3().fromArray(hit.object.userData.axis);
    var H = hit.point.clone().sub(A.clone().multiplyScalar(hit.point.dot(A))).setLength(GIZMO_R);
    var T = new THREE.Vector3().crossVectors(A, H);
    var s0 = toScreen(H), s1 = toScreen(H.clone().add(T.multiplyScalar(0.01)));
    drag = { mode: 'ring', axis: hit.object.userData.axis, last: [e.clientX, e.clientY], tan: s1.sub(s0) };
    setHover(hit.object);
  } else {
    bRay.setFromCamera(ndcOf(e), bCam);
    var onBall = bRay.intersectObject(ballSphere, false).length > 0;
    drag = { mode: onBall ? 'ball' : 'orbit', last: [e.clientX, e.clientY] };
  }
  ballCanvas.style.cursor = 'grabbing';
});
ballCanvas.addEventListener('pointermove', function (e) {
  if (!drag) { var h = pickRing(e); setHover(h ? h.object : null); ballCanvas.style.cursor = h ? 'pointer' : 'grab'; return; }
  var dx = e.clientX - drag.last[0], dy = e.clientY - drag.last[1]; drag.last = [e.clientX, e.clientY];
  if (!dx && !dy) return;
  if (drag.mode === 'ring') {
    // follow the ring: project the mouse motion onto the ring's on-screen tangent at the grab point
    var t = drag.tan, l2 = t.lengthSq(), ang;
    if (l2 < 0.04) ang = (dx - dy) * 0.01;
    else ang = 0.01 * (dx * t.x + dy * t.y) / l2;
    applyWorldRotation(drag.axis, ang);
  } else if (drag.mode === 'ball') {
    var right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    bCam.matrixWorld.extractBasis(right, up, fwd);
    var k = Math.PI / (ballCanvas.clientWidth || 300) * 1.3;
    if (dx) applyWorldRotation([up.x, up.y, up.z], dx * k);
    if (dy) applyWorldRotation([right.x, right.y, right.z], dy * k);
  } else {
    // orbit the camera around the ball
    if (ballState.view !== 'persp') { ballState.camDir.copy(bCam.position).normalize(); ballState.view = 'persp'; setSeg('ballView', 'data-v', 'persp'); }
    var cdv = ballState.camDir;
    cdv.applyAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.01);
    var rgt = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), cdv).normalize();
    var next = cdv.clone().applyAxisAngle(rgt, dy * 0.01);
    if (Math.abs(next.z) < 0.97) cdv.copy(next);
    cdv.normalize();
    renderBall();
  }
});
function endDrag() {
  if (!drag) return;
  var rotated = drag.mode !== 'orbit';
  drag = null; ballCanvas.style.cursor = 'grab';
  if (rotated) changed('one');
}
ballCanvas.addEventListener('pointerup', endDrag);
ballCanvas.addEventListener('pointercancel', endDrag);
ballCanvas.addEventListener('pointerleave', function () { if (!drag) setHover(null); });
ballCanvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  ballState.dist = Math.max(5.5, Math.min(16, ballState.dist * (e.deltaY > 0 ? 1.08 : 0.93)));
  renderBall();
}, { passive: false });
seg('ballView', 'data-v', function (v) { ballState.view = v; if (v === 'persp') ballState.camDir.set(-0.55, 1, 0.55).normalize(); renderBall(); });
$('spinToggle').addEventListener('click', function (e) {
  ballState.spin = !ballState.spin;
  e.currentTarget.setAttribute('aria-pressed', String(ballState.spin));
  e.currentTarget.textContent = ballState.spin ? 'Stop spin' : 'Spin it';
  if (!ballState.spin) { ballState.phase = 0; renderBall(); }
});
['showZones', 'showGizmo'].forEach(function (id) { $(id).addEventListener('change', renderBall); });

// rotation fields: X/Y/Z angles of the ball in the field frame, with step buttons
var ROT_AXES = [
  { k: 'x', label: 'X · tumble', axis: [1, 0, 0], color: COL.gx },
  { k: 'y', label: 'Y · roll', axis: [0, 1, 0], color: COL.gy },
  { k: 'z', label: 'Z · turn', axis: [0, 0, 1], color: COL.gz }
];
ROT_AXES.forEach(function (a) {
  var row = document.createElement('div'); row.className = 'rot';
  row.innerHTML = '<label for="rot-' + a.k + '"><i style="background:' + a.color + '"></i>' + a.label + '</label>' +
    '<button type="button" data-d="-1" aria-label="Rotate ' + a.k + ' minus one step">−</button>' +
    '<div class="num"><input id="rot-' + a.k + '" inputmode="decimal"><span>°</span></div>' +
    '<button type="button" data-d="1" aria-label="Rotate ' + a.k + ' plus one step">+</button>';
  row.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      applyWorldRotation(a.axis, +b.dataset.d * (+$('rotStep').value) * Math.PI / 180); changed('one');
    });
  });
  row.querySelector('input').addEventListener('change', function (e) {
    var f = ballFrame(), v = parseFloat(e.target.value);
    if (!f || isNaN(v)) { updateRotFields(); return; }
    var eul = new THREE.Euler().setFromQuaternion(toThreeQ(ballWorldQ(f)), 'XYZ');
    eul[a.k] = v * Math.PI / 180;
    setBallWorldQ(f, fromThreeQ(new THREE.Quaternion().setFromEuler(eul)));
    e.target.blur();
    clearOrientChips(); updateSswReadout(); updateRotFields(); renderBall(); changed('one');
  });
  $('rotRows').appendChild(row);
});
function updateRotFields() {
  var f = ballFrame(); if (!f) return;
  var eul = new THREE.Euler().setFromQuaternion(toThreeQ(ballWorldQ(f)), 'XYZ');
  ROT_AXES.forEach(function (a) {
    var el = $('rot-' + a.k);
    if (document.activeElement !== el) el.value = Math.round(eul[a.k] * 180 / Math.PI);
  });
}

var orientBox = $('orientPresets');
Object.keys(ORIENT).forEach(function (k) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.dataset.o = k; b.textContent = ORIENT[k].label;
  orientBox.appendChild(b);
});
orientBox.addEventListener('click', function (e) {
  var b = e.target.closest('button'); var p = cur(); if (!b || !p) return;
  p.ssw.orient = b.dataset.o; p.ssw.qRel = qRelFor(b.dataset.o);
  updateSeamUI(); changed('one');
});
$('orientReset').addEventListener('click', function () {
  var p = cur(); if (!p) return;
  var o = typeById(p.type).orient;
  p.ssw.orient = o; p.ssw.qRel = qRelFor(o);
  updateSeamUI(); changed('one');
});
function updateSeamUI() {
  var p = cur();
  $('ballEmpty').hidden = !!p; $('ballEdit').hidden = !p;
  if (!p) return;
  orientBox.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.o === p.ssw.orient)); });
  $('sswOn').checked = p.ssw.on;
}

function updateSswReadout() {
  var f = ballFrame(); if (!f) return;
  var axisBall = Q.rot(Q.conj(f.p.ssw.qRel), [1, 0, 0]);
  $('sswSeams').textContent = P.seamCrossings(axisBall);
  var e = P.sswEffect(f.axis, f.flow, ballWorldQ(f));
  $('sswLevel').textContent = Math.round(e.level * 100) + '%';
  var r = f.p.result;
  var dt = r.inferred ? devTotal(r) : 0;
  $('sswClock').textContent = (dt >= 0 ? '+' : '') + dt.toFixed(1) + '°';
  if (e.level < 0.02) {
    $('sswWhy').innerHTML = 'Both sides of the spin axis carry the same seam pattern, so the wake stays centred: all movement is Magnus and the movement-based Tilt matches the spin.';
    return;
  }
  var h = P.clockOf(-e.dir[0], e.dir[2]);
  if (!f.p.ssw.on) {
    $('sswWhy').innerHTML = 'SSW is off, so the flight is spin only. With this orientation it would push toward <b>' + fmtClock(h) + '</b> (pitcher view). Tick the box below to see it.';
    return;
  }
  $('sswWhy').innerHTML = 'SSW pushes toward <b>' + fmtClock(h) + '</b> (pitcher view), across the Magnus direction. ' +
    (r.inferred ? 'Movement points to <b>' + fmtClock(r.inferred.tilt) + '</b> while the measured spin tilt is <b>' + fmtClock(r.desc.tilt) + '</b>: an axis deviation of <b>' + (dt >= 0 ? '+' : '') + dt.toFixed(1) + '°</b> (SSW ' + (r.deviation >= 0 ? '+' : '') + r.deviation.toFixed(1) + '°, path curvature ' + ((dt - r.deviation) >= 0 ? '+' : '') + (dt - r.deviation).toFixed(1) + '°). A movement-only tracker would read Spin Eff. as <b>' + (r.inferred.efficiency * 100).toFixed(0) + '%</b> (true ' + (r.inferred.effAvg * 100).toFixed(0) + '%).' : '');
}

// ---------- 2D plots ----------
function prep(cv) {
  var dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = +cv.dataset.h;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx: ctx, w: w, h: h };
}
var INK = {}, PLOT_FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, sans-serif';
function readInk() {
  var cs = getComputedStyle(document.documentElement), tok = function (n) { return cs.getPropertyValue(n).trim(); };
  INK = { grid: tok('--plot-grid'), axis: tok('--plot-axis'), text: tok('--plot-text'), zone: tok('--plot-zone'), ring: tok('--plot-ring') };
}
function ordered() { var sel = cur(); return S.pitches.filter(function (p) { return p !== sel && p.result && !p.hidden; }).concat(sel && sel.result && !sel.hidden ? [sel] : []); }

function drawTop() {
  var c = prep($('top')), ctx = c.ctx, pad = { l: 38, r: 10, t: 22, b: 22 };
  var span = C.RUBBER_Y + 0.5;
  var X = function (y) { return pad.l + (C.RUBBER_Y - y) / span * (c.w - pad.l - pad.r); };
  var Yp = function (x) { return (c.h - pad.b + pad.t) / 2 + x / (3.6 * FT) * (c.h - pad.t - pad.b); }; // 3B side (-x) drawn up
  ctx.font = '11px ' + PLOT_FONT; ctx.fillStyle = INK.text; ctx.strokeStyle = INK.grid; ctx.lineWidth = 1;
  [-1.5, -0.75, 0, 0.75, 1.5].forEach(function (ft) { var y = Yp(-ft * FT); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(c.w - pad.r, y); ctx.stroke(); ctx.fillText(ft.toFixed(1), 2, y + 4); });
  var stepFt = c.w < 420 ? 20 : 10;
  for (var f = 0; f <= 60; f += stepFt) ctx.fillText(f + "'", X(f * FT) - 8, c.h - 6);
  ctx.strokeStyle = INK.zone; ctx.strokeRect(X(C.PLATE_FRONT_Y), Yp(-HALF_PLATE), X(0) - X(C.PLATE_FRONT_Y), Yp(HALF_PLATE) - Yp(-HALF_PLATE));
  ordered().forEach(function (p) {
    var strong = p.id === S.sel;
    ctx.strokeStyle = p.color; ctx.globalAlpha = strong ? 1 : 0.3; ctx.lineWidth = strong ? 2.2 : 1.3;
    ctx.beginPath(); p.result.sim.pts.forEach(function (s, i) { var px = X(s.p[1]), py = Yp(s.p[0]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.stroke();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK.text; ctx.fillText('↑ 3B side (ft)      ft from plate', pad.l, 12);
}
function drawMov() {
  var c = prep($('mov')), ctx = c.ctx, size = Math.min(c.w - 30, c.h - 24), ox = (c.w - size) / 2 + 8, oy = 6;
  var lim = 25, M = function (v) { return v / lim * size / 2; };
  var cx = ox + size / 2, cy = oy + size / 2;
  ctx.font = '11px ' + PLOT_FONT; ctx.strokeStyle = INK.grid; ctx.fillStyle = INK.text; ctx.lineWidth = 1;
  for (var g = -20; g <= 20; g += 5) {
    ctx.beginPath(); ctx.moveTo(cx + M(g), oy); ctx.lineTo(cx + M(g), oy + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, cy - M(g)); ctx.lineTo(ox + size, cy - M(g)); ctx.stroke();
  }
  ctx.strokeStyle = INK.axis; ctx.beginPath(); ctx.moveTo(ox, cy); ctx.lineTo(ox + size, cy); ctx.moveTo(cx, oy); ctx.lineTo(cx, oy + size); ctx.stroke();
  [-20, -10, 10, 20].forEach(function (g) { ctx.fillText(g, cx + M(g) - 6, cy + 12); ctx.fillText(g, cx + 3, cy - M(g) + 3); });
  ctx.fillText('HB (in) →', ox + size - 56, cy - 5); ctx.fillText('IVB (in)', cx + 4, oy + 10);
  if (!S.pitches.length) ctx.fillText('No pitches yet', cx - 40, cy + 30);
  ordered().forEach(function (p) {
    var r = p.result, hb = -r.breakX / IN, ivb = r.breakZ / IN, strong = p.id === S.sel;
    ctx.fillStyle = p.color; ctx.globalAlpha = strong ? 1 : 0.4;
    ctx.beginPath(); ctx.arc(cx + M(hb), cy - M(ivb), strong ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
    if (strong) { ctx.strokeStyle = INK.ring; ctx.lineWidth = 1.5; ctx.stroke(); }
  });
  ctx.globalAlpha = 1;
}
function drawViews() { readInk(); drawTop(); drawMov(); }
// Redraw the plots when the appearance changes, whether from the system or the viewer's own toggle.
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawViews);
new MutationObserver(drawViews).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
// Sliders show their filled part through --p, since WebKit has no track-progress pseudo element.
function paintRanges() {
  document.querySelectorAll('input[type=range]').forEach(function (r) {
    var lo = +r.min || 0, hi = +r.max || 100;
    r.style.setProperty('--p', ((r.value - lo) / (hi - lo) * 100) + '%');
  });
}
document.addEventListener('input', function (e) { if (e.target.type === 'range') paintRanges(); });

// ---------- call, table ----------
function judge(r) {
  if (!r || !r.plate) return null;
  var z = zoneLimits(), x = r.plate.p[0], h = r.plate.p[2];
  return Math.abs(x) <= HALF_PLATE + R_BALL && h <= z.top + R_BALL && h >= z.bot - R_BALL;
}
function renderHud() {
  var p = cur(), r = p && p.result, call = judge(r), el = $('call');
  el.hidden = call == null;
  el.textContent = call ? 'Strike' : 'Ball';
  el.className = 'call ' + (call ? 'strike' : 'ball');
  var rh = rho();
  $('rhoNote').innerHTML = 'Air density <b>' + rh.toFixed(3) + ' kg/m³</b> (' + ((rh / 1.204 - 1) * 100).toFixed(1) + '% vs. 68°F at sea level). Thinner air means less drag and less movement.';
}
function renderTable() {
  var head = '<thead><tr><th>Pitch</th><th>RelSpeed</th><th>SpinRate</th><th>Tilt</th><th>Spin Eff.</th><th>IVB</th><th>HB</th><th>VB</th><th>VAA</th><th>ZoneTime</th><th>SSW</th><th>Call</th></tr></thead>';
  if (!S.pitches.length) { $('cmp').innerHTML = head + '<tbody><tr><td colspan="12" style="text-align:left;color:var(--muted)">No pitches yet. Use “+ Add pitch” above the field.</td></tr></tbody>'; return; }
  $('cmp').innerHTML = head + '<tbody>' + S.pitches.map(function (p) {
    var r = p.result; if (!r) return '';
    var c = judge(r);
    return '<tr data-id="' + p.id + '" class="' + (p.id === S.sel ? 'current' : '') + '"><td class="name"><i style="background:' + p.color + '"></i>' + esc(p.name) + '</td>' +
      '<td>' + p.mph.toFixed(1) + '</td><td>' + Math.round(r.desc.spinRpm) + '</td><td>' + fmtClock(r.desc.tilt) + '</td><td>' + p.eff + '%</td>' +
      '<td>' + f1(r.breakZ / IN) + '</td><td>' + f1(-r.breakX / IN) + '</td><td>' + f1(r.vertBreak / IN) + '</td>' +
      '<td>' + r.vaa.toFixed(1) + '°</td><td>' + r.flightTime.toFixed(3) + '</td><td>' + f1(Math.hypot(r.sswBreak.x, r.sswBreak.z) / IN) + '</td><td>' + (c ? 'Strike' : 'Ball') + '</td></tr>';
  }).join('') + '</tbody>';
}
$('cmp').addEventListener('click', function (e) {
  var row = e.target.closest('tr[data-id]'); if (!row) return;
  S.sel = +row.dataset.id; selectionChanged();
});

function refresh(force) {
  var has = S.pitches.length > 0;
  $('empty').hidden = has; $('stageCtrl').hidden = !has;
  buildZone(); placeCamera(); rebuildPitches();
  var p = cur();
  updateBoard(force); renderHud(); renderTunnelHud(); renderTable(); drawViews(); paintRanges();
  if (p) { updateSswReadout(); updateRotFields(); }
  if ($('tab-ball').getAttribute('aria-selected') === 'true') renderBall();
  requestRender();
}

// ---------- spin PiP: shown while the seam editor is off screen ----------
var pipEl = $('pip'), pipCanvas = $('pipCanvas');
var pRenderer = new THREE.WebGLRenderer({ canvas: pipCanvas, antialias: true });
pRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
var pScene = new THREE.Scene(); pScene.background = new THREE.Color('#000000');
var pCam = new THREE.PerspectiveCamera(28, 1, 0.1, 40); pCam.up.set(0, 0, 1);
pScene.add(new THREE.HemisphereLight('#ffffff', '#2a2a2a', 0.95));
var pl = new THREE.DirectionalLight('#ffffff', 0.45); pl.position.set(1, 3, 4); pScene.add(pl);
var pipBall = makeBall({ leather: '#e4e4e4', seam: '#141414', stitch: '#2e2e2e' });
pScene.add(pipBall.group);
// Spin band: the great circle perpendicular to the spin axis, with chevrons pointing the way the
// surface turns. Built around local +Y and aimed along the axis each frame. Low Spin Eff. tips the
// axis toward the camera, so the band turns into an ellipse instead of fading.
var pipBand = (function () {
  var g = new THREE.Group(), R = 1.05, W = 0.3;
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(R, R, W, 96, 1, true),
    new THREE.MeshBasicMaterial({ color: '#d97757', transparent: true, opacity: 0.92, side: THREE.DoubleSide })));
  var sh = new THREE.Shape();
  // a chevron pointing toward +x, drawn as a thick V
  sh.moveTo(-0.05, 0.085); sh.lineTo(0.035, 0); sh.lineTo(-0.05, -0.085); sh.lineTo(-0.012, -0.085); sh.lineTo(0.073, 0); sh.lineTo(-0.012, 0.085); sh.closePath();
  var cg = new THREE.ShapeGeometry(sh), cm = new THREE.MeshBasicMaterial({ color: '#f2f2f2', side: THREE.DoubleSide });
  var up = new THREE.Vector3(0, 1, 0);
  for (var i = 0; i < 22; i++) {
    var a = i / 22 * Math.PI * 2;
    var radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    var tangent = new THREE.Vector3().crossVectors(up, radial);   // surface velocity for positive spin about +Y
    var m = new THREE.Mesh(cg, cm);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, up, radial));
    m.position.copy(radial).multiplyScalar(R + 0.004);
    g.add(m);
  }
  pScene.add(g);
  return g;
})();
var seamInView = false;
new IntersectionObserver(function (es) { seamInView = es[0].isIntersecting; }, { threshold: 0.35 }).observe($('ballCanvas').parentNode);
function renderPip(now) {
  var f = ballFrame();
  var show = !!f && !(seamInView && !$('ballEdit').hidden && $('tab-ball').getAttribute('aria-selected') === 'true');
  if (pipEl.hidden === show) pipEl.hidden = !show;
  if (!show) return;
  var w = pipCanvas.clientWidth;
  if (w && pipCanvas.width !== Math.round(w * pRenderer.getPixelRatio())) pRenderer.setSize(w, w, false);
  // the PiP turns at half the field ball's rate (1/80 of real) so it is easy on the eyes
  var rpm = f.p.result.desc.spinRpm, phase = spinPhase(now, rpm) / 2;
  pipBall.group.quaternion.copy(toThreeQ(Q.mul(Q.axisAngle(f.axis, phase), ballWorldQ(f))));
  // look along the flight, from just behind the ball, as the pitcher sees it leave the hand
  pCam.position.set(-f.dir[0] * 6.2, -f.dir[1] * 6.2, -f.dir[2] * 6.2 + 0.4);
  pCam.lookAt(0, 0, 0);
  pCam.updateMatrixWorld();
  // the band stays put on the spin equator: perpendicular to the axis, turning only when the axis does
  pipBand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(f.axis[0], f.axis[1], f.axis[2]));
  pRenderer.render(pScene, pCam);
  var r = f.p.result;
  $('pipName').textContent = f.p.name;
  $('pipTilt').textContent = fmtClock(r.desc.tilt);
  $('pipRpm').textContent = Math.round(r.desc.spinRpm) + ' rpm · ' + f.p.eff + '%';
}
pipEl.addEventListener('click', function () {
  $('tab-ball').click();
  $('ballCanvas').parentNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ---------- player name and saved sets ----------
// A set is one player's pitches, pitcher, batter and environment. Saved in the artifact's shared store;
// where that isn't available (signed out, local preview) it falls back to this browser's storage.
var setDb = window.claude ? claude.use('db') : Promise.resolve(null);
var SET_KEY = 'pitchlab.sets';
function localSets() {
  try { return JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch (e) { return {}; }
}
function setId(name) {
  var k = name.trim().toLowerCase(), h = 5381;
  for (var i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  return 's' + h.toString(16) + '-' + k.length;
}
function within(promise) {
  return Promise.race([promise, new Promise(function (_, no) { setTimeout(function () { no(new Error('timeout')); }, 10000); })]);
}
function listSets() {
  return setDb.then(function (db) {
    if (!db) {
      var m = localSets();
      return Object.keys(m).map(function (k) { return Object.assign({ id: k }, m[k]); });
    }
    return within(db.collection('sets').get()).then(function (snap) {
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    });
  }).then(function (l) { return l.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); }); });
}
function writeSet(id, body) {
  return setDb.then(function (db) {
    if (db) return within(db.collection('sets').doc(id).set(body));
    var m = localSets(); m[id] = body;
    localStorage.setItem(SET_KEY, JSON.stringify(m));
  });
}
function removeSet(id) {
  return setDb.then(function (db) {
    if (db) return within(db.collection('sets').doc(id).delete());
    var m = localSets(); delete m[id];
    localStorage.setItem(SET_KEY, JSON.stringify(m));
  });
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function setBody(name) {
  return clone({
    name: name, updated: Date.now(),
    pitcher: S.pitcher, batter: S.batter, env: S.env, tunnel: S.tunnel,
    sel: S.pitches.indexOf(cur()),
    pitches: S.pitches.map(function (p) {
      return { type: p.type, name: p.name, color: p.color, mode: p.mode, mph: p.mph, rpm: p.rpm, tiltMin: p.tiltMin, eff: p.eff,
        ivb: p.ivb, hb: p.hb, rel: p.rel, target: p.home || p.target, ssw: p.ssw, hidden: !!p.hidden, locked: !!p.locked };
    })
  });
}
function applySet(saved) {
  var d = clone(saved);
  if (anim.playing) stopPlay();
  hoverTube = null;
  Object.assign(S.pitcher, d.pitcher); Object.assign(S.batter, d.batter); Object.assign(S.env, d.env);
  S.tunnel = { on: !!(d.tunnel && d.tunnel.on), gather: !!(d.tunnel && d.tunnel.on && d.tunnel.gather) };
  S.pitches = (d.pitches || []).filter(function (p) { return typeById(p.type); }).map(function (p) {
    return Object.assign(p, { id: nextId++, home: null, result: null, solve: null });
  });
  var pick = S.pitches[d.sel] || S.pitches[0];
  S.sel = pick ? pick.id : null;
  setSeg('hand', 'data-hand', S.pitcher.hand); setSeg('slot', 'data-slot', S.pitcher.slot); setSeg('batter', 'data-b', S.batter.side);
  $('tunnelBtn').setAttribute('aria-pressed', String(S.tunnel.on));
  $('gatherBtn').setAttribute('aria-pressed', String(S.tunnel.gather));
  $('gatherBtn').hidden = !S.tunnel.on;
  buildBatter();
  S.pitches.forEach(computePitch);
  if (S.tunnel.gather) regather();
  $('playerName').value = d.name || '';
  selectionChanged();
}
function setStatus(text) { $('setStatus').textContent = text; }
$('saveSet').addEventListener('click', function () {
  var name = $('playerName').value.trim();
  if (!name) { setStatus('Enter a player name first'); $('playerName').focus(); return; }
  setStatus('Saving…');
  writeSet(setId(name), setBody(name)).then(function () {
    setStatus('Saved ' + name + ' · ' + S.pitches.length + (S.pitches.length === 1 ? ' pitch' : ' pitches'));
  }, function () { setStatus('Couldn\'t save. You may have view-only access, or the store is out of reach.'); });
});
var setMenu = document.createElement('div'); setMenu.className = 'menu setmenu'; setMenu.hidden = true;
document.body.appendChild(setMenu);
function renderSetMenu(list) {
  setMenu.textContent = '';
  if (!list.length) {
    var none = document.createElement('div'); none.className = 'setnone'; none.textContent = 'No saved sets yet. Enter a player name and press Save set.';
    setMenu.appendChild(none); return;
  }
  list.forEach(function (d) {
    var row = document.createElement('div'); row.className = 'setrow';
    var load = document.createElement('button'); load.type = 'button'; load.className = 'setload';
    var nm = document.createElement('b'); nm.textContent = d.name || 'Unnamed';
    var meta = document.createElement('span'); meta.textContent = (d.pitches ? d.pitches.length : 0) + ' pitches · ' + new Date(d.updated || 0).toLocaleDateString();
    load.appendChild(nm); load.appendChild(meta);
    load.addEventListener('click', function () { setMenu.hidden = true; applySet(d); setStatus('Loaded ' + (d.name || 'set')); });
    var del = document.createElement('button'); del.type = 'button'; del.className = 'setdel'; del.textContent = 'Delete'; del.setAttribute('aria-label', 'Delete ' + (d.name || 'set'));
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      // two clicks: the viewer's frame has no confirm dialog
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Sure?'; return; }
      removeSet(d.id).then(function () { setStatus('Deleted ' + (d.name || 'set')); openSets(); }, function () { setStatus('Couldn\'t delete that set.'); });
    });
    row.appendChild(load); row.appendChild(del);
    setMenu.appendChild(row);
  });
}
function openSets() {
  var r = $('openSets').getBoundingClientRect();
  setMenu.hidden = false;
  setMenu.textContent = 'Loading…';
  setMenu.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setMenu.style.left = Math.max(8, Math.min(r.left + window.scrollX, document.documentElement.clientWidth - 288)) + 'px';
  listSets().then(renderSetMenu, function () { setMenu.textContent = 'Couldn\'t reach saved sets. Try again in a moment.'; });
}
$('openSets').addEventListener('click', function () { if (setMenu.hidden) openSets(); else setMenu.hidden = true; });
document.addEventListener('click', function (e) {
  if (!setMenu.hidden && !setMenu.contains(e.target) && e.target.id !== 'openSets') setMenu.hidden = true;
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu.hidden = true; });

// ---------- boot: one fastball down the middle ----------
buildBoard();
buildBatter();
var first = makePitch('FB');
S.pitches.push(first); S.sel = first.id;
computePitch(first);
renderTabs();
syncAll();
updateSeamUI();
resizeStage();
refresh(true);
requestAnimationFrame(loop);
})();
