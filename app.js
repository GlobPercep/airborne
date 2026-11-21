import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

/* AIRBORNE — live flight tracker.
   Two data layers:
   - Global: OpenSky snapshot refreshed every ~15 min by a GitHub Actions cron
     (data/states.json). OpenSky blocks cross-origin browser fetches, so the
     fetch happens server-side at deploy time.
   - Live: airplanes.live point query (250 nm around the camera's sub-point,
     CORS-open) polled every 10 s, overriding the global layer where you look.
   Between fixes every aircraft is dead-reckoned along its great-circle track
   at its last known ground speed and vertical rate. */

const KM = 1 / 1000;                    // scene scale: 1 unit = 1000 km
const EARTH_R_KM = 6371;
const EARTH_R = EARTH_R_KM * KM;
const EARTH_R_M = 6371000;
const ALT_EXAG = 25;                    // cruise altitude ~12 km would be invisible at scale
const ALT_TO_UNITS = ALT_EXAG / 1e6;    // metres -> scene units, exaggerated
const DEG = Math.PI / 180;
const GLOBAL_URL = 'data/states.json';
const LIVE_URL = (lat, lon) => `https://api.airplanes.live/v2/point/${lat.toFixed(2)}/${lon.toFixed(2)}/250`;
const MAX_FIX_AGE = 90 * 60 * 1000;     // hide aircraft not heard from in 90 min
const CAP = 30000;

const CATS = [
  { id: 'airliner', label: 'Airliners',      color: '#46c8ff' },
  { id: 'private',  label: 'Private & GA',   color: '#ffc14d' },
  { id: 'heli',     label: 'Helicopters',    color: '#a78bfa' },
  { id: 'other',    label: 'Other',          color: '#8fa3bf' },
];

const HELI_TYPES = new Set(['B06', 'B407', 'B412', 'B429', 'B430', 'R22', 'R44', 'R66', 'S76', 'S92',
  'H500', 'H60', 'UH1', 'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75', 'EH10',
  'A109', 'A119', 'A129', 'A139', 'A149', 'A169', 'A189', 'AS50', 'AS55', 'AS65', 'B105', 'B212', 'B214']);
const AIRLINE_CS = /^[A-Z]{3}\d/;

function classify(callsign, typeCode, catStr) {
  if (catStr === 'A7' || (typeCode && HELI_TYPES.has(typeCode))) return 2;
  if (AIRLINE_CS.test(callsign)) return 0;
  if (callsign || typeCode) return 1;
  return 3;
}

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 1200);
camera.position.set(6.5, 9, 11.5);      // start over the North Atlantic / US east coast

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6.6;
controls.maxDistance = 60;
controls.rotateSpeed = 0.55;
controls.enablePan = false;

let lastW = 0, lastH = 0;
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ---------------- earth (day/night shader) ---------------- */
const texLoader = new THREE.TextureLoader();
const dayTex = texLoader.load('textures/earth_atmos_2048.jpg');
const nightTex = texLoader.load('textures/earth_lights_2048.png');
dayTex.colorSpace = nightTex.colorSpace = THREE.SRGBColorSpace;
dayTex.anisotropy = nightTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    dayMap: { value: dayTex },
    nightMap: { value: nightTex },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D dayMap, nightMap;
    uniform vec3 sunDir;
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vec3 day = texture2D(dayMap, vUv).rgb;
      vec3 night = texture2D(nightMap, vUv).rgb;
      float nd = dot(normalize(vN), sunDir);
      float dayside = smoothstep(-0.12, 0.18, nd);
      vec3 lit = day * (0.25 + 0.85 * clamp(nd, 0.0, 1.0));
      vec3 dark = night * vec3(1.0, 0.85, 0.62) * 1.6 + day * 0.02;
      gl_FragColor = vec4(mix(dark, lit, dayside), 1.0);
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 64), earthMat));

scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * 1.045, 64, 48),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec3 vN, vPos;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vN, vPos;
      void main() {
        vec3 v = normalize(cameraPosition - vPos);
        float rim = pow(1.0 - abs(dot(v, normalize(vN))), 3.5);
        gl_FragColor = vec4(vec3(0.25, 0.55, 1.0) * rim * 1.1, 1.0);
      }`,
  })
));

{ // stars
  const n = 3200;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(500 + Math.random() * 300);
    p.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x9fb4d8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.75,
  })));
}

/* ---------------- aircraft points ---------------- */
function makeGlowSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowSprite();

const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 10);
const posAttr = geom.attributes.position;
const colAttr = geom.attributes.color;
const points = new THREE.Points(geom, new THREE.PointsMaterial({
  size: 0.05, map: glowTex, vertexColors: true, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
}));
points.frustumCulled = false;
scene.add(points);

const selMarker = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.95,
}));
selMarker.scale.setScalar(0.35);
selMarker.visible = false;
scene.add(selMarker);

const PATH_N = 64;
const pathGeom = new THREE.BufferGeometry();
pathGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3));
const pathLine = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.55,
}));
pathLine.visible = false;
scene.add(pathLine);

const TRAIL_MAX = 120;
const trailGeom = new THREE.BufferGeometry();
trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
const trailLine = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.35,
}));
trailLine.visible = false;
scene.add(trailLine);

/* ---------------- aircraft store ---------------- */
let N = 0;
const icaos = [], callsigns = [], regs = [], types = [];
const cat = new Uint8Array(CAP);
const isLive = new Uint8Array(CAP);
const fixMs = new Float64Array(CAP);
const altM = new Float64Array(CAP);
const gsMs = new Float64Array(CAP);
const vrMs = new Float64Array(CAP);
const lonRad = new Float64Array(CAP);
const sinLat = new Float64Array(CAP);
const cosLat = new Float64Array(CAP);
const sinTrk = new Float64Array(CAP);
const cosTrk = new Float64Array(CAP);
const curLat = new Float64Array(CAP);   // dead-reckoned, updated each frame
const curLon = new Float64Array(CAP);
const curAlt = new Float64Array(CAP);
const byIcao = new Map();

const catVisible = CATS.map(() => true);
let globalTime = 0;     // epoch ms of last global snapshot
let liveTime = 0;       // epoch ms of last live-layer merge
let selIdx = -1;
const trail = [];       // [lat, lon, altM] fixes for the selected aircraft

function upsert(icao, callsign, reg, type, catStr, lat, lon, alt, gs, track, vr, fix, live) {
  let i = byIcao.get(icao);
  if (i === undefined) {
    if (N >= CAP) return;
    i = N++;
    byIcao.set(icao, i);
    icaos[i] = icao;
  } else if (fix <= fixMs[i]) {
    return;                              // older fix than what we have
  }
  callsigns[i] = callsign || callsigns[i] || '';
  regs[i] = reg || regs[i] || '';
  types[i] = type || types[i] || '';
  cat[i] = classify(callsigns[i], types[i], catStr);
  fixMs[i] = fix;
  altM[i] = alt;
  gsMs[i] = gs;
  vrMs[i] = vr;
  lonRad[i] = lon * DEG;
  const la = lat * DEG;
  sinLat[i] = Math.sin(la);
  cosLat[i] = Math.cos(la);
  sinTrk[i] = Math.sin(track * DEG);
  cosTrk[i] = Math.cos(track * DEG);
  isLive[i] = live ? 1 : 0;
  const c = new THREE.Color(CATS[cat[i]].color);
  colAttr.array[i * 3] = c.r; colAttr.array[i * 3 + 1] = c.g; colAttr.array[i * 3 + 2] = c.b;
  colAttr.needsUpdate = true;
  if (i === selIdx) trail.push([lat, lon, alt]);
  return i;
}

function ingestOpenSky(json) {
  const t = json.time * 1000;
  for (const s of json.states || []) {
    if (s[8] || s[5] == null || s[6] == null) continue;         // on ground / no position
    const fix = (s[3] || s[4]) * 1000;
    upsert(s[0], (s[1] || '').trim(), '', '', null,
      s[6], s[5], s[7] ?? s[13] ?? 0, s[9] || 0, s[10] || 0, s[11] || 0, fix, false);
  }
  if (t > globalTime) globalTime = t;
}

function ingestLive(json) {
  const now = Date.now();
  for (const a of json.ac || []) {
    if (a.lat == null || a.lon == null || a.alt_baro === 'ground') continue;
    const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom ?? 0);
    upsert(a.hex, (a.flight || '').trim(), a.r || '', a.t || '', a.category || null,
      a.lat, a.lon, altFt * 0.3048, (a.gs || 0) * 0.514444, a.track ?? a.true_heading ?? 0,
      (a.baro_rate || 0) * 0.00508, now - (a.seen_pos || 0) * 1000, true);
  }
  liveTime = now;
}

/* ---------------- dead reckoning ---------------- */
/* great-circle forward from the last fix; closed-form so it never drifts */
function reckon(i, nowMs, out) {
  const dt = (nowMs - fixMs[i]) / 1000;
  const d = (gsMs[i] * dt) / EARTH_R_M;         // angular distance
  const sd = Math.sin(d), cd = Math.cos(d);
  const sLa = sinLat[i] * cd + cosLat[i] * sd * cosTrk[i];
  const la2 = Math.asin(Math.max(-1, Math.min(1, sLa)));
  const lo2 = lonRad[i] + Math.atan2(sinTrk[i] * sd * cosLat[i], cd - sinLat[i] * sLa);
  const al2 = Math.max(0, altM[i] + vrMs[i] * dt);
  out[0] = la2; out[1] = lo2; out[2] = al2;
}

const rk = [0, 0, 0];
function writePositions(nowMs) {
  const arr = posAttr.array;
  for (let i = 0; i < N; i++) {
    const age = nowMs - fixMs[i];
    if (age > MAX_FIX_AGE || !catVisible[cat[i]]) {
      arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0;   // parked inside the Earth
      continue;
    }
    reckon(i, nowMs, rk);
    curLat[i] = rk[0]; curLon[i] = rk[1]; curAlt[i] = rk[2];
    const r = EARTH_R + rk[2] * ALT_TO_UNITS;
    const cLa = Math.cos(rk[0]);
    arr[i * 3] = r * cLa * Math.cos(rk[1]);
    arr[i * 3 + 1] = r * Math.sin(rk[0]);
    arr[i * 3 + 2] = -r * cLa * Math.sin(rk[1]);
  }
  posAttr.needsUpdate = true;
}

function llaToVec(latRad, lonRad2, alt, v) {
  const r = EARTH_R + alt * ALT_TO_UNITS;
  const cLa = Math.cos(latRad);
  v.set(r * cLa * Math.cos(lonRad2), r * Math.sin(latRad), -r * cLa * Math.sin(lonRad2));
  return v;
}

/* ---------------- sun / terminator ---------------- */
function gmstRad(ms) {
  const d = ms / 86400000 - 10957.5;    // days since J2000
  return ((280.46061837 + 360.98564736629 * d) % 360) * DEG;
}
function updateSun(nowMs) {
  const n = nowMs / 86400000 - 10957.5;
  const L = (280.460 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = 23.439 * DEG;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  const gm = gmstRad(nowMs);
  const cg = Math.cos(gm), sg = Math.sin(gm);
  earthMat.uniforms.sunDir.value.set(x * cg + y * sg, z, -(-x * sg + y * cg)).normalize();
}

/* ---------------- selection ---------------- */
const $ = id => document.getElementById(id);
const tmpV = new THREE.Vector3();

function buildPath(i) {
  // projected great-circle track for the next 25 minutes
  const pa = pathGeom.attributes.position.array;
  const now = Date.now();
  for (let k = 0; k < PATH_N; k++) {
    reckon(i, now + (k / (PATH_N - 1)) * 25 * 60000, rk);
    llaToVec(rk[0], rk[1], rk[2], tmpV);
    pa[k * 3] = tmpV.x; pa[k * 3 + 1] = tmpV.y; pa[k * 3 + 2] = tmpV.z;
  }
  pathGeom.attributes.position.needsUpdate = true;
}

function updateTrail() {
  const n = Math.min(trail.length, TRAIL_MAX);
  if (n < 2) { trailLine.visible = false; return; }
  const ta = trailGeom.attributes.position.array;
  const start = trail.length - n;
  for (let k = 0; k < n; k++) {
    const f = trail[start + k];
    llaToVec(f[0] * DEG, f[1] * DEG, f[2], tmpV);
    ta[k * 3] = tmpV.x; ta[k * 3 + 1] = tmpV.y; ta[k * 3 + 2] = tmpV.z;
  }
  trailGeom.setDrawRange(0, n);
  trailGeom.attributes.position.needsUpdate = true;
  trailLine.visible = true;
}

function select(i) {
  selIdx = i;
  trail.length = 0;
  if (i < 0) {
    selMarker.visible = pathLine.visible = trailLine.visible = false;
    $('info').style.display = 'none';
    return;
  }
  if (!catVisible[cat[i]]) toggleCat(cat[i]);
  trail.push([curLat[i] / DEG, curLon[i] / DEG, curAlt[i]]);
  const col = CATS[cat[i]].color;
  pathLine.material.color.set(col);
  selMarker.material.color.set(col);
  selMarker.visible = pathLine.visible = true;
  buildPath(i);
  $('info').style.display = 'block';
  updateInfo(true);
}
$('info-close').addEventListener('click', () => select(-1));

let lastInfo = 0;
function updateInfo(force) {
  if (selIdx < 0) return;
  const now = performance.now();
  if (!force && now - lastInfo < 500) return;
  lastInfo = now;
  const i = selIdx;
  $('info-name').textContent = callsigns[i] || regs[i] || icaos[i].toUpperCase();
  $('i-reg').textContent = regs[i] || '—';
  $('i-type').textContent = types[i] || '—';
  $('i-icao').textContent = icaos[i].toUpperCase();
  $('i-alt').textContent = `${Math.round(curAlt[i]).toLocaleString()} m · FL${Math.round(curAlt[i] / 0.3048 / 100)}`;
  $('i-spd').textContent = `${Math.round(gsMs[i] * 3.6)} km/h · ${Math.round(gsMs[i] / 0.514444)} kt`;
  $('i-trk').textContent = Math.round(Math.atan2(sinTrk[i], cosTrk[i]) / DEG + 360) % 360 + '°';
  $('i-vs').textContent = (vrMs[i] >= 0 ? '+' : '') + vrMs[i].toFixed(1) + ' m/s';
  const age = Math.round((Date.now() - fixMs[i]) / 1000);
  $('i-fix').textContent = (isLive[i] ? 'live · ' : 'global · ') + (age < 90 ? age + ' s ago' : Math.round(age / 60) + ' min ago');
}

/* ---------------- picking (click + hover) ---------------- */
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.06;
const earthSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_R);
const occV = new THREE.Vector3();
const pickNdc = new THREE.Vector2();

function pickAt(clientX, clientY) {
  if (!N) return -1;
  pickNdc.set((clientX / lastW) * 2 - 1, -(clientY / lastH) * 2 + 1);
  raycaster.setFromCamera(pickNdc, camera);
  const hits = raycaster.intersectObject(points);
  for (const h of hits) {
    const i = h.index;
    if (i >= N || !catVisible[cat[i]]) continue;
    const a = posAttr.array;
    if (a[i * 3] === 0 && a[i * 3 + 1] === 0 && a[i * 3 + 2] === 0) continue;
    // occlusion: planes hug the surface, so give the near-side a generous margin
    if (raycaster.ray.intersectSphere(earthSphere, occV) &&
        occV.distanceTo(raycaster.ray.origin) < h.distance - 0.35) continue;
    return i;
  }
  return -1;
}
window.__pick = pickAt;   // debug hooks
window.__size = () => [lastW, lastH];
window.__pollLive = () => pollLive(true).then(() => ({ liveTime, n: N }));

let downX = 0, downY = 0;
canvas.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
canvas.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
  select(pickAt(e.clientX, e.clientY));
});

const tooltip = $('tooltip');
const tooltipName = $('tooltip-name');
const tooltipSub = $('tooltip-sub');
const tooltipDot = tooltip.querySelector('.dot');
let lastHoverRun = 0;
canvas.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const now = performance.now();
  if (now - lastHoverRun < 30) return;
  lastHoverRun = now;
  const i = pickAt(e.clientX, e.clientY);
  if (i < 0) {
    tooltip.style.display = 'none';
    canvas.style.cursor = '';
    return;
  }
  tooltipName.textContent = callsigns[i] || regs[i] || icaos[i].toUpperCase();
  tooltipSub.textContent = types[i] || (regs[i] && callsigns[i] ? regs[i] : '');
  const col = CATS[cat[i]].color;
  tooltipDot.style.color = tooltipDot.style.background = col;
  tooltip.style.display = 'flex';
  tooltip.style.left = Math.min(e.clientX + 14, lastW - tooltip.offsetWidth - 8) + 'px';
  tooltip.style.top = Math.min(e.clientY + 12, lastH - tooltip.offsetHeight - 8) + 'px';
  canvas.style.cursor = 'pointer';
});
canvas.addEventListener('pointerleave', () => {
  tooltip.style.display = 'none';
  canvas.style.cursor = '';
});

/* ---------------- search ---------------- */
const searchEl = $('search'), resultsEl = $('search-results');
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim().toUpperCase();
  resultsEl.innerHTML = '';
  if (q.length < 2) { resultsEl.style.display = 'none'; return; }
  let found = 0;
  for (let i = 0; i < N && found < 8; i++) {
    if (Date.now() - fixMs[i] > MAX_FIX_AGE) continue;
    const label = callsigns[i] || regs[i] || icaos[i].toUpperCase();
    if (!label.includes(q) && !(regs[i] || '').toUpperCase().includes(q)) continue;
    const b = document.createElement('button');
    b.textContent = label + (types[i] ? ` · ${types[i]}` : '');
    b.addEventListener('click', () => {
      select(i);
      resultsEl.style.display = 'none';
      searchEl.value = label;
      searchEl.blur();
    });
    resultsEl.appendChild(b);
    found++;
  }
  resultsEl.style.display = found ? 'block' : 'none';
});

/* ---------------- group chips ---------------- */
function toggleCat(ci) {
  catVisible[ci] = !catVisible[ci];
  document.querySelectorAll('.chip')[ci].classList.toggle('off', !catVisible[ci]);
  if (selIdx >= 0 && !catVisible[cat[selIdx]]) select(-1);
}
function buildChips() {
  const box = $('groups');
  box.innerHTML = '';
  CATS.forEach((c, ci) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (catVisible[ci] ? '' : ' off');
    chip.innerHTML = `<span class="dot" style="color:${c.color};background:${c.color}"></span>` +
      `${c.label} <span class="n" id="chip-n-${ci}">0</span>`;
    chip.addEventListener('click', () => toggleCat(ci));
    box.appendChild(chip);
  });
}
buildChips();

/* ---------------- HUD ---------------- */
let lastHud = 0;
function updateHud() {
  const now = performance.now();
  if (now - lastHud < 1000) return;
  lastHud = now;
  const nowMs = Date.now();
  $('clock-text').textContent = new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const counts = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (nowMs - fixMs[i] > MAX_FIX_AGE) continue;
    counts[cat[i]]++;
    total++;
  }
  counts.forEach((c, ci) => { const el = $('chip-n-' + ci); if (el) el.textContent = c.toLocaleString(); });
  $('stats').textContent = `${total.toLocaleString()} aircraft airborne`;
  const gAge = globalTime ? Math.max(0, Math.round((nowMs - globalTime) / 60000)) : null;
  const lAge = liveTime ? Math.round((nowMs - liveTime) / 1000) : null;
  $('freshness').textContent =
    (gAge === null ? 'global: —' : `global: ${gAge} min ago`) +
    (lAge === null ? ' · live region: —' : ` · live region: ${lAge} s ago`);
}

/* ---------------- data polling ---------------- */
async function pollGlobal() {
  try {
    const res = await fetch(GLOBAL_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('states.json ' + res.status);
    const json = await res.json();
    if (json.time * 1000 > globalTime) ingestOpenSky(json);
    return json;
  } catch (e) {
    console.warn('global poll failed:', e.message);
    return null;
  }
}

function cameraSubpoint() {
  const p = camera.position;
  const r = p.length();
  return { lat: Math.asin(p.y / r) / DEG, lon: Math.atan2(-p.z, p.x) / DEG };
}

let livePollBusy = false;
async function pollLive(force) {
  if ((document.hidden && !force) || livePollBusy) return;
  livePollBusy = true;
  try {
    const { lat, lon } = cameraSubpoint();
    const res = await fetch(LIVE_URL(lat, lon), { signal: AbortSignal.timeout(9000) });
    if (res.ok) ingestLive(await res.json());
  } catch { /* offline or rate-limited — global layer keeps things moving */ }
  livePollBusy = false;
}

setInterval(pollGlobal, 120000);
setInterval(pollLive, 10000);

/* ---------------- main loop ---------------- */
function tick() {
  requestAnimationFrame(tick);
  resize();                              // self-heals if the tab was sized 0x0 at load
  const nowMs = Date.now();
  writePositions(nowMs);
  updateSun(nowMs);
  if (selIdx >= 0) {
    llaToVec(curLat[selIdx], curLon[selIdx], curAlt[selIdx], selMarker.position);
    buildPath(selIdx);
    updateTrail();
    updateInfo();
  }
  updateHud();
  controls.update();
  renderer.render(scene, camera);
}

/* ---------------- boot ---------------- */
const setLoad = (pct, msg) => { $('bar').style.width = pct + '%'; $('load-status').textContent = msg; };
async function boot() {
  $('load-error').style.display = $('retry').style.display = 'none';
  setLoad(10, 'loading global snapshot…');
  const json = await pollGlobal();
  if (!json) {
    $('load-status').textContent = '';
    $('load-error').textContent = 'Could not load aircraft data — check your connection.';
    $('load-error').style.display = 'block';
    $('retry').style.display = 'inline-block';
    return;
  }
  setLoad(70, 'contacting live feed…');
  writePositions(Date.now());
  await pollLive();
  setLoad(100, 'ready');
  $('loading').classList.add('done');
}
$('retry').addEventListener('click', boot);
boot();
tick();
