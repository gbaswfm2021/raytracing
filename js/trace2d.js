// In-browser 2D sequential ray tracer used for the live preview.
// It mirrors solver/RayTrace2D.cs (the native solver run through the FullMeta kernel) and returns the same
// "raytrace-result/2" shape, so the preview and solver results are interchangeable.
//
// Reads raytrace-model/2 (materials + wavelengths, or a source spectrum split into bins) and raytrace-model/1
// (nAfter / ambientIndex). Per surface:
// a non-empty materialAfter wins, else a numeric nAfter becomes a constant material, else the ambient medium.

import { LINES, abbeData, outsideValidRange, refractiveIndex, wavelengthColor } from "./materials.js";
import { binSpectrum } from "./spectra.js";

const EPS = 1e-9;
const PARAXIAL_HEIGHT_MM = 0.01;     // near-axis ray offset for collimated sources
const PARAXIAL_ANGLE_RAD = 1e-4;     // near-axis ray angle for point sources
const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);
const str = value => (typeof value === "string" ? value : "");

const constantMaterial = n => ({ id: `n=${n}`, name: `n = ${n}`, formula: "constant", n });

/** Materials, wavelengths and surfaces of either model format, with references resolved. Throws on bad references. */
export function resolveModel(document) {
  const model = document?.model || {};
  const settings = model.settings || {};
  const materials = [];
  const byId = new Map();
  const addMaterial = m => { if (!byId.has(m.id)) { byId.set(m.id, m); materials.push(m); } return byId.get(m.id); };
  for (const m of Array.isArray(model.materials) ? model.materials : []) {
    if (m && typeof m.id === "string" && m.id) addMaterial(m);
  }
  const lookup = (id, owner) => {
    const m = byId.get(id);
    if (!m) throw new Error(`${owner} refers to unknown material "${id}".`);
    return m;
  };

  const ambient = str(settings.ambientMaterial) ? lookup(settings.ambientMaterial, "Ambient medium")
    : addMaterial(constantMaterial(num(settings.ambientIndex, 1)));

  const list = Array.isArray(model.surfaces) ? model.surfaces : [];
  const surfaces = list.map((s, index) => {
    const id = s?.id || `surface${index}`;
    const material = str(s?.materialAfter) ? lookup(s.materialAfter, `Surface ${s?.name || id}`)
      : s?.nAfter !== undefined && s?.nAfter !== null && s?.nAfter !== "" ? addMaterial(constantMaterial(num(s.nAfter, 1)))
        : ambient;
    return { id, name: s?.name || "Surface", index, x: num(s?.x, 0), radius: num(s?.radius, 0),
      semiAperture: Math.max(EPS, num(s?.semiAperture, 10)), material };
  }).sort((a, b) => a.x - b.x);

  // A source spectrum (blackbody / table) replaces the wavelength list with equal-width bins weighted by band power.
  const binned = binSpectrum(model.source?.spectrum, model.source?.spectrum?.bins, "Light source");
  const declared = binned
    ? binned.bins.map((b, i) => ({ id: `bin${i + 1}`, label: `bin ${i + 1}`, lambdaNm: b.lambdaNm, weight: b.weight }))
    : (Array.isArray(model.wavelengths) ? model.wavelengths : []).filter(w => w && Number.isFinite(Number(w.lambdaNm)));
  const wavelengths = (declared.length ? declared : [{ id: "d", label: "d", lambdaNm: LINES.d, weight: 1 }])
    .map((w, i) => {
      const lambdaNm = Number(w.lambdaNm);
      return { id: str(w.id) || `w${i}`, label: str(w.label) || `${lambdaNm} nm`, lambdaNm,
        weight: Math.max(0, num(w.weight, 1)),
        color: /^#[0-9a-fA-F]{6}$/.test(str(w.color)) ? w.color : wavelengthColor(lambdaNm) };
    });
  const warnings = [];
  let primary = wavelengths.find(w => w.id === settings.primaryWavelength);
  if (!primary) {
    if (binned) primary = wavelengths.reduce((a, b) => (b.weight > a.weight ? b : a));     // strongest band
    else {
      if (str(settings.primaryWavelength)) warnings.push(`Primary wavelength "${settings.primaryWavelength}" not found; using ${wavelengths[0].label}.`);
      primary = wavelengths[0];
    }
  }
  return { materials, ambient, surfaces, wavelengths, primaryId: primary.id, warnings };
}

/** Sorted surfaces with resolved materials (used by the preview to draw the layout). */
export function surfacesOf(document) {
  try { return resolveModel(document).surfaces; } catch { return []; }
}

/** x coordinate of a surface at height y (spherical cap nearest the vertex). */
export function surfaceSagX(surface, y) {
  const R = surface.radius;
  if (Math.abs(R) < EPS) return surface.x;
  const inside = R * R - y * y;
  if (inside < 0) return null;
  return surface.x + R - Math.sign(R) * Math.sqrt(inside);
}

function sourceGeometry(source = {}) {
  return {
    kind: source.kind === "point" ? "point" : "collimated",
    sx: num(source.x, -20), sy: num(source.y, 0),
    angle: num(source.angleDeg, 0) * Math.PI / 180,
    width: num(source.width, 10),
    count: Math.max(1, Math.min(500, Math.trunc(num(source.rayCount, 11)))),
  };
}

export function sourceRays(source = {}) {
  const { kind, sx, sy, angle, width, count } = sourceGeometry(source);
  const rays = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1) - 0.5;
    if (kind === "point") {
      const a = f * angle;
      rays.push({ p: [sx, sy], d: [Math.cos(a), Math.sin(a)] });
    } else {
      const d = [Math.cos(angle), Math.sin(angle)];
      rays.push({ p: [sx - f * width * d[1], sy + f * width * d[0]], d });
    }
  }
  return rays;
}

/** Central ray plus a near-axis neighbour, used for the paraxial focus. */
function paraxialPair(source = {}) {
  const { kind, sx, sy, angle } = sourceGeometry(source);
  if (kind === "point") {
    return [{ p: [sx, sy], d: [1, 0] }, { p: [sx, sy], d: [Math.cos(PARAXIAL_ANGLE_RAD), Math.sin(PARAXIAL_ANGLE_RAD)] }];
  }
  const d = [Math.cos(angle), Math.sin(angle)];
  return [{ p: [sx, sy], d }, { p: [sx - PARAXIAL_HEIGHT_MM * d[1], sy + PARAXIAL_HEIGHT_MM * d[0]], d }];
}

function intersect(p, d, s) {
  if (Math.abs(s.radius) < EPS) {
    if (Math.abs(d[0]) < EPS) return null;
    const t = (s.x - p[0]) / d[0];
    if (t <= EPS) return null;
    return { hit: [p[0] + t * d[0], p[1] + t * d[1]], normal: [-1, 0] };
  }
  const c = [s.x + s.radius, 0];
  const oc = [p[0] - c[0], p[1] - c[1]];
  const b = oc[0] * d[0] + oc[1] * d[1];
  const cc = oc[0] * oc[0] + oc[1] * oc[1] - s.radius * s.radius;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let best = null, bestDistance = Infinity;
  for (const t of [-b - sq, -b + sq]) {
    if (t <= EPS) continue;
    const distance = Math.abs(p[0] + t * d[0] - s.x);
    if (distance < bestDistance) { bestDistance = distance; best = t; }
  }
  if (best === null || bestDistance > Math.abs(s.radius)) return null;
  const hit = [p[0] + best * d[0], p[1] + best * d[1]];
  const n = [hit[0] - c[0], hit[1] - c[1]], len = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
  return { hit, normal: [n[0] / len, n[1] / len] };
}

/** Trace one ray. indices[i] is the refractive index after surfaces[i]; screenX = null skips the screen. */
function traceRay(start, surfaces, nAmbient, indices, screenX, screenHalf) {
  let p = start.p, d = start.d, n1 = nAmbient;
  const ray = { status: "missed", points: [p] };
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const result = intersect(p, d, s);
    if (!result || Math.abs(result.hit[1]) > s.semiAperture) {
      if (Math.abs(d[0]) > EPS) { const t = (s.x - p[0]) / d[0]; ray.points.push([p[0] + t * d[0], p[1] + t * d[1]]); }
      return { ...ray, status: "blocked", stoppedAt: s.id, lastP: p, finalDir: d };
    }
    ray.points.push(result.hit);
    let normal = result.normal;
    if (normal[0] * d[0] + normal[1] * d[1] > 0) normal = [-normal[0], -normal[1]];
    const n2 = indices[i];
    const eta = n1 / n2, cosI = -(normal[0] * d[0] + normal[1] * d[1]);
    const k = 1 - eta * eta * (1 - cosI * cosI);
    if (k < 0) return { ...ray, status: "tir", stoppedAt: s.id, lastP: result.hit, finalDir: d };
    const f = eta * cosI - Math.sqrt(k);
    const nd = [eta * d[0] + f * normal[0], eta * d[1] + f * normal[1]], len = Math.sqrt(nd[0] * nd[0] + nd[1] * nd[1]);
    d = [nd[0] / len, nd[1] / len]; p = result.hit; n1 = n2;
  }
  ray.lastP = p; ray.finalDir = d;
  if (screenX === null) return ray;
  if (d[0] > EPS && screenX > p[0]) {
    const t = (screenX - p[0]) / d[0], hit = [p[0] + t * d[0], p[1] + t * d[1]];
    ray.points.push(hit);
    if (Math.abs(hit[1]) <= screenHalf) { ray.status = "screen"; ray.screenY = hit[1]; }
  } else {
    ray.points.push([p[0] + 20 * d[0], p[1] + 20 * d[1]]);
  }
  return ray;
}

/** Final ray line y = a + b x (from the last surface hit). */
const finalLine = r => { const b = r.finalDir[1] / r.finalDir[0]; return [r.lastP[1] - b * r.lastP[0], b]; };

/** Weighted least-squares waist of a set of lines [a, b, w]: minimises Σ w (y_i(x) − ȳ(x))². */
function bestFocus(lines) {
  if (lines.length < 2) return null;
  let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (const [a, b, w] of lines) { sw += w; sa += w * a; sb += w * b; saa += w * a * a; sbb += w * b * b; sab += w * a * b; }
  if (sw <= 0) return null;
  const varB = sbb / sw - (sb / sw) ** 2, covAB = sab / sw - (sa / sw) * (sb / sw), varA = saa / sw - (sa / sw) ** 2;
  if (varB <= 1e-15) return null;
  const x = -covAB / varB;
  return { x, rms: Math.sqrt(Math.max(0, varA + 2 * covAB * x + varB * x * x)) };
}

/** Weighted centroid and RMS of screen hits [y, w]. */
function spot(hits) {
  let sw = 0, sy = 0;
  for (const [y, w] of hits) { sw += w; sy += w * y; }
  if (!hits.length || sw <= 0) return null;
  const mean = sy / sw;
  let v = 0;
  for (const [y, w] of hits) v += w * (y - mean) ** 2;
  return { mean, rms: Math.sqrt(v / sw) };
}

const usable = r => r.status !== "blocked" && r.status !== "tir" && Math.abs(r.finalDir[0]) > EPS;

function paraxialFocus(pair, surfaces, nAmbient, indices) {
  const [chief, near] = pair.map(start => traceRay(start, surfaces, nAmbient, indices, null, 0));
  if (!usable(chief) || !usable(near)) return null;
  const [a1, b1] = finalLine(chief), [a2, b2] = finalLine(near);
  return Math.abs(b2 - b1) > 1e-15 ? (a1 - a2) / (b2 - b1) : null;
}

function bundleStats(rays, weight = 1) {
  const hits = rays.filter(r => r.screenY !== undefined).map(r => [r.screenY, weight]);
  const stats = { rayCount: rays.length, raysOnScreen: hits.length };
  const s = spot(hits);
  if (s) { stats.screenCentroidMm = s.mean; stats.screenRmsSpotMm = s.rms; }
  const focus = bestFocus(rays.filter(r => r.status === "screen" && usable(r)).map(r => [...finalLine(r), weight]));
  if (focus) { stats.bestFocusXmm = focus.x; stats.bestFocusRmsMm = focus.rms; }
  return stats;
}

export function traceModel(document) {
  const model = document?.model || {};
  const resolved = resolveModel(document);
  const { surfaces, ambient, wavelengths } = resolved;
  const screenX = num(model.screen?.x, 100), screenHalf = num(model.screen?.height, 40) / 2;
  const starts = sourceRays(model.source);
  const pair = paraxialPair(model.source);
  const warnings = [...resolved.warnings];

  const indicesAt = lambdaNm => surfaces.map(s => refractiveIndex(s.material, lambdaNm));
  const used = [ambient, ...surfaces.map(s => s.material)].filter((m, i, all) => all.indexOf(m) === i);
  for (const w of wavelengths) {
    for (const m of used) {
      if (outsideValidRange(m, w.lambdaNm)) warnings.push(`λ = ${w.lambdaNm} nm is outside the valid range of ${m.name || m.id}.`);
    }
  }

  const rays = [];
  const perWavelength = [];
  const allHits = [], allLines = [];
  for (const w of wavelengths) {
    const nAmbient = refractiveIndex(ambient, w.lambdaNm), indices = indicesAt(w.lambdaNm);
    const traced = starts.map(start => traceRay(start, surfaces, nAmbient, indices, screenX, screenHalf));
    for (const r of traced) {
      if (r.screenY !== undefined) allHits.push([r.screenY, w.weight]);
      if (r.status === "screen" && usable(r)) allLines.push([...finalLine(r), w.weight]);
      const { lastP, finalDir, ...rest } = r;
      rays.push({ wavelength: w.id, ...rest });
    }
    const stats = bundleStats(traced);
    const paraxial = paraxialFocus(pair, surfaces, nAmbient, indices);
    if (paraxial !== null) stats.paraxialFocusXmm = paraxial;
    perWavelength.push({ id: w.id, label: w.label, lambdaNm: w.lambdaNm, weight: w.weight, color: w.color,
      indices: Object.fromEntries(surfaces.map((s, i) => [s.id, indices[i]])), stats });
  }

  const stats = {};
  const poly = spot(allHits);
  if (poly) { stats.polychromaticCentroidMm = poly.mean; stats.polychromaticRmsSpotMm = poly.rms; }
  const polyFocus = bestFocus(allLines);
  if (polyFocus) { stats.polychromaticBestFocusXmm = polyFocus.x; stats.polychromaticBestFocusRmsMm = polyFocus.rms; }

  // Chromatic focal shift, always between the F and C lines (independent of the model's wavelength list).
  const atLine = lambdaNm => {
    const nAmbient = refractiveIndex(ambient, lambdaNm), indices = indicesAt(lambdaNm);
    const bundle = bundleStats(starts.map(start => traceRay(start, surfaces, nAmbient, indices, screenX, screenHalf)));
    return { paraxial: paraxialFocus(pair, surfaces, nAmbient, indices), best: bundle.bestFocusXmm };
  };
  const F = atLine(LINES.F), C = atLine(LINES.C);
  const shift = {};
  if (F.paraxial !== null && C.paraxial !== null) shift.paraxialFC = F.paraxial - C.paraxial;
  if (Number.isFinite(F.best) && Number.isFinite(C.best)) shift.bestFocusFC = F.best - C.best;
  const foci = perWavelength.map(w => w.stats.paraxialFocusXmm).filter(Number.isFinite);
  if (foci.length) shift.rangeAll = Math.max(...foci) - Math.min(...foci);
  stats.chromaticFocalShiftMm = shift;

  return {
    schema: "raytrace-result/2", solver: "browser preview (trace2d.js)",
    primaryWavelength: resolved.primaryId,
    rays, wavelengths: perWavelength,
    materials: resolved.materials.map(abbeData),
    stats, warnings,
  };
}
