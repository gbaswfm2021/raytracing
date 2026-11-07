// In-browser 2D sequential ray tracer used for the live preview.
// It mirrors solver/RayTrace2D.cs (the native solver run through the FullMeta kernel) and
// returns the same "raytrace-result/1" shape, so the preview and solver results are interchangeable.

const EPS = 1e-9;
const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);

export function surfacesOf(document) {
  const list = Array.isArray(document?.model?.surfaces) ? document.model.surfaces : [];
  return list.map((s, index) => ({
    id: s?.id || `surface${index}`, name: s?.name || "Surface", index,
    x: num(s?.x, 0), radius: num(s?.radius, 0), semiAperture: Math.max(EPS, num(s?.semiAperture, 10)), nAfter: num(s?.nAfter, 1),
  })).sort((a, b) => a.x - b.x);
}

/** x coordinate of a surface at height y (spherical cap nearest the vertex). */
export function surfaceSagX(surface, y) {
  const R = surface.radius;
  if (Math.abs(R) < EPS) return surface.x;
  const inside = R * R - y * y;
  if (inside < 0) return null;
  return surface.x + R - Math.sign(R) * Math.sqrt(inside);
}

export function sourceRays(source = {}) {
  const kind = source.kind === "point" ? "point" : "collimated";
  const sx = num(source.x, -20), sy = num(source.y, 0);
  const angle = num(source.angleDeg, 0) * Math.PI / 180;
  const width = num(source.width, 10);
  const count = Math.max(1, Math.min(500, Math.trunc(num(source.rayCount, 11))));
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
  const n = [hit[0] - c[0], hit[1] - c[1]], len = Math.hypot(n[0], n[1]);
  return { hit, normal: [n[0] / len, n[1] / len] };
}

function traceRay(start, surfaces, ambient, screenX, screenHalf) {
  let p = start.p, d = start.d, n1 = ambient;
  const ray = { status: "missed", points: [p] };
  for (const s of surfaces) {
    const result = intersect(p, d, s);
    if (!result || Math.abs(result.hit[1]) > s.semiAperture) {
      if (Math.abs(d[0]) > EPS) { const t = (s.x - p[0]) / d[0]; ray.points.push([p[0] + t * d[0], p[1] + t * d[1]]); }
      return { ...ray, status: "blocked", stoppedAt: s.id, finalDir: d };
    }
    ray.points.push(result.hit);
    let normal = result.normal;
    if (normal[0] * d[0] + normal[1] * d[1] > 0) normal = [-normal[0], -normal[1]];
    const eta = n1 / s.nAfter, cosI = -(normal[0] * d[0] + normal[1] * d[1]);
    const k = 1 - eta * eta * (1 - cosI * cosI);
    if (k < 0) return { ...ray, status: "tir", stoppedAt: s.id, finalDir: d };
    const f = eta * cosI - Math.sqrt(k);
    const nd = [eta * d[0] + f * normal[0], eta * d[1] + f * normal[1]], len = Math.hypot(nd[0], nd[1]);
    d = [nd[0] / len, nd[1] / len]; p = result.hit; n1 = s.nAfter;
  }
  ray.finalDir = d;
  if (d[0] > EPS && screenX > p[0]) {
    const t = (screenX - p[0]) / d[0], hit = [p[0] + t * d[0], p[1] + t * d[1]];
    ray.points.push(hit);
    if (Math.abs(hit[1]) <= screenHalf) { ray.status = "screen"; ray.screenY = hit[1]; }
  } else {
    ray.points.push([p[0] + 20 * d[0], p[1] + 20 * d[1]]);
  }
  return ray;
}

export function traceModel(document) {
  const model = document?.model || {};
  const surfaces = surfacesOf(document);
  const ambient = num(model.settings?.ambientIndex, 1);
  const screenX = num(model.screen?.x, 100), screenHalf = num(model.screen?.height, 40) / 2;
  const rays = sourceRays(model.source).map(start => traceRay(start, surfaces, ambient, screenX, screenHalf));
  const hits = rays.filter(r => r.screenY !== undefined).map(r => r.screenY);
  const stats = { rayCount: rays.length, raysOnScreen: hits.length };
  if (hits.length) {
    const mean = hits.reduce((a, b) => a + b, 0) / hits.length;
    stats.screenCentroidMm = mean;
    stats.screenRmsSpotMm = Math.sqrt(hits.reduce((a, y) => a + (y - mean) ** 2, 0) / hits.length);
  }
  const finals = rays.filter(r => r.status === "screen" && Math.abs(r.finalDir[0]) > EPS)
    .map(r => { const q = r.points[r.points.length - 2], b = r.finalDir[1] / r.finalDir[0]; return [q[1] - b * q[0], b]; });
  if (finals.length >= 2) {
    const n = finals.length;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (const [a, b] of finals) { sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    const varB = sbb / n - (sb / n) ** 2, covAB = sab / n - (sa / n) * (sb / n), varA = saa / n - (sa / n) ** 2;
    if (varB > 1e-15) {
      const x = -covAB / varB;
      stats.bestFocusXmm = x;
      stats.bestFocusRmsMm = Math.sqrt(Math.max(0, varA + 2 * covAB * x + varB * x * x));
    }
  }
  return {
    schema: "raytrace-result/1", solver: "browser preview (trace2d.js)",
    rays: rays.map(({ finalDir, ...rest }) => rest), stats,
  };
}
