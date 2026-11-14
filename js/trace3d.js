// 3D non-sequential ray tracer (raytrace3d-model/1 -> raytrace3d-result/1).
//
// Scene: solid objects made of exact analytic faces (conic caps, cylinders, planes, spheres) and thin plates,
// each placed by position + rotation (X, then Y, then Z, about the object's origin). Rays carry flux (W) and a
// wavelength; at every face the surface property decides absorption / specular reflection / refraction, and the
// rays either split into both branches ("split") or follow one branch chosen at random ("monteCarlo").
// Every watt ends in exactly one bucket: absorbed, escaped (left the scene) or lost (below the flux threshold
// or past maxIntersections), so emitted = absorbed + escaped + lost.
//
// Pure JS with no DOM access: runs on the main thread (tests, single rays) and in js/trace3d-worker.js.

import { outsideValidRange, refractiveIndex, wavelengthColor, LINES } from "./materials.js";
import { cieXYZ, compileSpectrum, planckRelative } from "./spectra.js";

export { compileSpectrum, planckRelative };

export const T_MIN = 1e-7;          // mm: ignore hits closer than this (self-intersection guard)
const COINCIDENT = 1e-7;            // mm: hits this close are the same point (cemented interfaces)

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);
const str = value => (typeof value === "string" ? value : "");
const num3 = (value, fallback = [0, 0, 0]) => (Array.isArray(value) ? [0, 1, 2].map(i => num(value[i], fallback[i])) : [...fallback]);

// ---- vector / matrix helpers ------------------------------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.sqrt(dot(a, a)); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const neg = a => [-a[0], -a[1], -a[2]];

/** Rotation matrix (row-major 3x3) for rotationDeg [rx, ry, rz], applied X first, then Y, then Z: R = Rz·Ry·Rx. */
export function rotationMatrix([rx, ry, rz]) {
  const r = Math.PI / 180;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx * r), Math.sin(rx * r), Math.cos(ry * r), Math.sin(ry * r), Math.cos(rz * r), Math.sin(rz * r)];
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}
const mul = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];
const mulT = (R, v) => [
  R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
  R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
  R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
];

/** Two vectors perpendicular to d (unit) and to each other: for d = +z they are +x and +y. */
export function basis(d) {
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(a, d));
  return [u, cross(d, u)];
}

// ---- seeded random numbers (xoshiro128**, seeded by splitmix32) -----------------------------------------
const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
export function createRng(seed = 1) {
  let s = (Math.trunc(seed) >>> 0) || 1;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split(), b = split(), c = split(), d = split();
  return () => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c = (c ^ a) >>> 0; d = (d ^ b) >>> 0; b = (b ^ c) >>> 0; a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0; d = rotl(d, 11);
    return result / 4294967296;
  };
}

// ---- geometry -----------------------------------------------------------------------------------------
/** Sag of a conic surface z(r²) = c r² / (1 + √(1 − (1+k) c² r²)), NaN beyond its extent. */
export function conicSag(c, k, r2) {
  const q = 1 - (1 + k) * c * c * r2;
  return q < 0 ? NaN : c * r2 / (1 + Math.sqrt(q));
}

/** Real roots of A t² + B t + C = 0 (numerically stable form). */
function quadRoots(A, B, C) {
  if (A === 0) return B !== 0 ? [-C / B] : [];
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const q = -0.5 * (B + (B >= 0 ? sq : -sq));
  if (q === 0) return [0];
  return [q / A, C / q];
}

// Each face works in object-local coordinates: hit(p, d) -> [{ t, n (outward unit normal), uv }],
// extent = [u0, u1, v0, v1] of its uv chart (null if it has no flat chart), tess() -> triangles.

function conicCap(name, z0, c, k, rMax, sign) {
  const e = 1 + k, rMax2 = rMax * rMax * (1 + 1e-12);
  const at = (x, y) => {
    const z = z0 + conicSag(c, k, x * x + y * y);
    const g = [2 * c * x, 2 * c * y, 2 * c * e * (z - z0) - 2];
    return { p: [x, y, z], n: scale(norm(g), sign) };
  };
  return {
    name, extent: [-rMax, rMax, -rMax, rMax],
    hit(p, d) {
      const px = p[0], py = p[1], pz = p[2] - z0;
      if (c === 0) {
        if (d[2] === 0) return [];
        const t = -pz / d[2];
        if (t <= T_MIN) return [];
        const x = px + t * d[0], y = py + t * d[1];
        return x * x + y * y > rMax2 ? [] : [{ t, n: [0, 0, -sign], uv: [x, y] }];
      }
      const A = c * (d[0] * d[0] + d[1] * d[1] + e * d[2] * d[2]);
      const B = 2 * (c * (px * d[0] + py * d[1] + e * pz * d[2]) - d[2]);
      const C = c * (px * px + py * py + e * pz * pz) - 2 * pz;
      const out = [];
      for (const t of quadRoots(A, B, C)) {
        if (t <= T_MIN) continue;
        const x = px + t * d[0], y = py + t * d[1], z = pz + t * d[2], r2 = x * x + y * y;
        if (r2 > rMax2) continue;
        const s = conicSag(c, k, r2);
        if (!(Math.abs(z - s) <= 1e-6 * (1 + Math.abs(s)))) continue;     // keep the branch through the vertex
        out.push({ t, n: scale(norm([2 * c * x, 2 * c * y, 2 * c * e * z - 2]), sign), uv: [x, y] });
      }
      return out;
    },
    tess() {
      const rings = 10, seg = 48, tris = [];
      const P = (i, j) => { const r = rMax * i / rings, f = 2 * Math.PI * j / seg; return at(r * Math.cos(f), r * Math.sin(f)); };
      for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
        const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), dd = P(i, j + 1);
        tris.push([a, b, cc]);
        if (i > 0) tris.push([a, cc, dd]);
      }
      return tris;
    },
  };
}

function cylinderSide(name, r, z0, z1) {
  return {
    name, extent: [-Math.PI * r, Math.PI * r, z0, z1],
    hit(p, d) {
      const A = d[0] * d[0] + d[1] * d[1];
      if (A === 0) return [];
      const B = 2 * (p[0] * d[0] + p[1] * d[1]), C = p[0] * p[0] + p[1] * p[1] - r * r;
      const out = [];
      for (const t of quadRoots(A, B, C)) {
        if (t <= T_MIN) continue;
        const x = p[0] + t * d[0], y = p[1] + t * d[1], z = p[2] + t * d[2];
        if (z < z0 - 1e-12 || z > z1 + 1e-12) continue;
        out.push({ t, n: [x / r, y / r, 0], uv: [r * Math.atan2(y, x), z] });
      }
      return out;
    },
    tess() {
      const seg = 48, tris = [];
      const P = (j, z) => { const f = 2 * Math.PI * j / seg; return { p: [r * Math.cos(f), r * Math.sin(f), z], n: [Math.cos(f), Math.sin(f), 0] }; };
      for (let j = 0; j < seg; j++) {
        const a = P(j, z0), b = P(j + 1, z0), c = P(j + 1, z1), d = P(j, z1);
        tris.push([a, b, c], [a, c, d]);
      }
      return tris;
    },
  };
}

/** Plane face: axis 0/1/2 with the plane at `offset`, outward normal sign, uv axes and bounds (rect or circle). */
function planeFace(name, axis, offset, outward, [ua, va], bound) {
  const n = [0, 0, 0]; n[axis] = outward;
  const extent = bound.r !== undefined ? [-bound.r, bound.r, -bound.r, bound.r] : [-bound.hu, bound.hu, -bound.hv, bound.hv];
  const point = (u, v) => { const q = [0, 0, 0]; q[axis] = offset; q[ua] = u; q[va] = v; return { p: q, n }; };
  return {
    name, extent,
    hit(p, d) {
      if (d[axis] === 0) return [];
      const t = (offset - p[axis]) / d[axis];
      if (t <= T_MIN) return [];
      const u = p[ua] + t * d[ua], v = p[va] + t * d[va];
      const inside = bound.r !== undefined ? u * u + v * v <= bound.r * bound.r * (1 + 1e-12)
        : Math.abs(u) <= bound.hu * (1 + 1e-12) && Math.abs(v) <= bound.hv * (1 + 1e-12);
      if (!inside) return [];
      const q = [0, 0, 0]; q[axis] = offset; q[ua] = u; q[va] = v;
      return [{ t, n, uv: [u, v] }];
    },
    tess() {
      if (bound.r !== undefined) {
        const seg = 48, tris = [], c = point(0, 0);
        for (let j = 0; j < seg; j++) {
          const f0 = 2 * Math.PI * j / seg, f1 = 2 * Math.PI * (j + 1) / seg;
          tris.push([c, point(bound.r * Math.cos(f0), bound.r * Math.sin(f0)), point(bound.r * Math.cos(f1), bound.r * Math.sin(f1))]);
        }
        return tris;
      }
      const a = point(-bound.hu, -bound.hv), b = point(bound.hu, -bound.hv), c = point(bound.hu, bound.hv), d = point(-bound.hu, bound.hv);
      return [[a, b, c], [a, c, d]];
    },
  };
}

/** Convex planar polygon: plane through p0 with outward normal n, in-plane axes e1/e2, vertices in (e1, e2) coordinates. */
function polygonFace(name, p0, n, e1, e2, poly) {
  const us = poly.map(q => q[0]), vs = poly.map(q => q[1]);
  const inside = (u, v) => {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const c = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
      if (Math.abs(c) <= 1e-12 * (1 + Math.abs(bx - ax) + Math.abs(by - ay))) continue;
      if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
    }
    return true;
  };
  const point = ([u, v]) => ({ p: add(p0, add(scale(e1, u), scale(e2, v))), n });
  return {
    name, extent: [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)],
    hit(p, d) {
      const denom = dot(d, n);
      if (denom === 0) return [];
      const t = dot(sub(p0, p), n) / denom;
      if (t <= T_MIN) return [];
      const q = sub(add(p, scale(d, t)), p0), u = dot(q, e1), v = dot(q, e2);
      return inside(u, v) ? [{ t, n, uv: [u, v] }] : [];
    },
    tess() {
      const tris = [];
      for (let i = 1; i < poly.length - 1; i++) tris.push([point(poly[0]), point(poly[i]), point(poly[i + 1])]);
      return tris;
    },
  };
}

/**
 * Isosceles triangular prism, extruded along local y (height), cross-section in the x–z plane: apex at +x,
 * the two equal faces "entrance" (z < 0 side) and "exit" (z > 0 side), the "base" face at −x.
 */
function prismFaces(apexDeg, side, height) {
  const half = apexDeg * Math.PI / 360, t = side * Math.cos(half), b = 2 * side * Math.sin(half), hy = height / 2;
  const A = [t / 2, 0], B = [-t / 2, -b / 2], C = [-t / 2, b / 2];                 // (x, z)
  const centroid = [(A[0] + B[0] + C[0]) / 3, 0];
  const side3 = (name, P, Q) => {
    const e1 = norm([Q[0] - P[0], 0, Q[1] - P[1]]), e2 = [0, 1, 0];
    let n = cross(e1, e2);
    const mid = [(P[0] + Q[0]) / 2, 0, (P[1] + Q[1]) / 2];
    if (dot(n, sub(mid, [centroid[0], 0, centroid[1]])) < 0) n = neg(n);
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    return polygonFace(name, [P[0], 0, P[1]], n, e1, e2, [[0, -hy], [L, -hy], [L, hy], [0, hy]]);
  };
  const tri = [A, B, C];
  return [
    side3("entrance", A, B), side3("exit", C, A), side3("base", B, C),
    polygonFace("top", [0, hy, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1], tri),
    polygonFace("bottom", [0, -hy, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], tri),
  ];
}

function sphereFace(name, R) {
  return {
    name, extent: null,
    hit(p, d) {
      const out = [];
      for (const t of quadRoots(1, 2 * dot(p, d), dot(p, p) - R * R)) {
        if (t <= T_MIN) continue;
        const q = add(p, scale(d, t));
        out.push({ t, n: scale(q, 1 / R), uv: [Math.atan2(q[1], q[0]), Math.acos(Math.max(-1, Math.min(1, q[2] / R)))] });
      }
      return out;
    },
    tess() {
      const lat = 24, lon = 48, tris = [];
      const P = (i, j) => { const th = Math.PI * i / lat, f = 2 * Math.PI * j / lon; const n = [Math.sin(th) * Math.cos(f), Math.sin(th) * Math.sin(f), Math.cos(th)]; return { p: scale(n, R), n }; };
      for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
        const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
        tris.push([a, b, c], [a, c, d]);
      }
      return tris;
    },
  };
}

/** Face names each object kind provides (for analyses and faceProperties). */
export const FACES = Object.freeze({
  lens: ["front", "back", "edge"],
  block: ["front", "back", "left", "right", "bottom", "top"],
  cylinder: ["front", "back", "side"],
  sphere: ["surface"],
  plate: ["front"],
  prism: ["entrance", "exit", "base", "top", "bottom"],
});

function buildGeometry(o, label) {
  const kind = o.kind;
  if (kind === "lens") {
    const L = o.lens || {};
    const R1 = num(L.radius1, 0), R2 = num(L.radius2, 0), k1 = num(L.conic1, 0), k2 = num(L.conic2, 0);
    const t = num(L.thickness, 5), r = num(L.diameter, 25) / 2;
    const c1 = R1 ? 1 / R1 : 0, c2 = R2 ? 1 / R2 : 0;
    const z0 = conicSag(c1, k1, r * r), z1 = t + conicSag(c2, k2, r * r);
    if (!(r > 0) || !Number.isFinite(z0) || !Number.isFinite(z1)) throw new Error(`${label}: the diameter is larger than a surface allows.`);
    if (!(z1 > z0)) throw new Error(`${label}: the edge thickness is not positive (increase thickness or reduce diameter).`);
    return { solid: true, radius: Math.hypot(r, Math.max(Math.abs(z0), Math.abs(z1), t)),
      faces: [conicCap("front", 0, c1, k1, r, +1), conicCap("back", t, c2, k2, r, -1), cylinderSide("edge", r, z0, z1)] };
  }
  if (kind === "block") {
    const [w, h, dz] = num3(o.block?.size, [10, 10, 10]).map(Math.abs);
    if (!(w > 0 && h > 0 && dz > 0)) throw new Error(`${label}: block sizes must be positive.`);
    const [hx, hy, hz] = [w / 2, h / 2, dz / 2];
    return { solid: true, radius: Math.hypot(hx, hy, hz), faces: [
      planeFace("front", 2, -hz, -1, [0, 1], { hu: hx, hv: hy }), planeFace("back", 2, hz, 1, [0, 1], { hu: hx, hv: hy }),
      planeFace("left", 0, -hx, -1, [2, 1], { hu: hz, hv: hy }), planeFace("right", 0, hx, 1, [2, 1], { hu: hz, hv: hy }),
      planeFace("bottom", 1, -hy, -1, [0, 2], { hu: hx, hv: hz }), planeFace("top", 1, hy, 1, [0, 2], { hu: hx, hv: hz }),
    ] };
  }
  if (kind === "cylinder") {
    const r = num(o.cylinder?.diameter, 10) / 2, len = num(o.cylinder?.length, 10);
    if (!(r > 0 && len > 0)) throw new Error(`${label}: cylinder diameter and length must be positive.`);
    return { solid: true, radius: Math.hypot(r, len), faces: [
      planeFace("front", 2, 0, -1, [0, 1], { r }), planeFace("back", 2, len, 1, [0, 1], { r }), cylinderSide("side", r, 0, len)] };
  }
  if (kind === "sphere") {
    const R = num(o.sphere?.diameter, 10) / 2;
    if (!(R > 0)) throw new Error(`${label}: sphere diameter must be positive.`);
    return { solid: true, radius: R, faces: [sphereFace("surface", R)] };
  }
  if (kind === "prism") {
    const P = o.prism || {};
    const apex = num(P.apexAngleDeg, 60), side = num(P.sideLength, 30), height = num(P.height, 20);
    if (!(apex > 0 && apex < 180 && side > 0 && height > 0)) throw new Error(`${label}: prism needs 0 < apex angle < 180° and positive sizes.`);
    return { solid: true, radius: Math.hypot(side, height / 2), faces: prismFaces(apex, side, height) };
  }
  if (kind === "plate") {
    const P = o.plate || {};
    const bound = P.shape === "circle" ? { r: num(P.diameter, 10) / 2 } : { hu: num(P.width, 10) / 2, hv: num(P.height, 10) / 2 };
    if (!((bound.r ?? Math.min(bound.hu, bound.hv)) > 0)) throw new Error(`${label}: plate size must be positive.`);
    return { solid: false, radius: bound.r ?? Math.hypot(bound.hu, bound.hv), faces: [planeFace("front", 2, 0, 1, [0, 1], bound)] };
  }
  throw new Error(`${label}: unknown object kind "${kind}".`);
}

// ---- surface properties ------------------------------------------------------------------------------
const DEFAULT_GLASS = Object.freeze({ id: "(default)", name: "Uncoated (Fresnel)", kind: "fresnel" });
const DEFAULT_ABSORBER = Object.freeze({ id: "(default)", name: "Absorber", kind: "absorber" });

function normalizeProperty(p, warnings) {
  const kind = ["fresnel", "mirror", "absorber", "table"].includes(p.kind) ? p.kind : "fresnel";
  const out = { id: p.id, name: p.name || p.id, kind };
  if (kind === "mirror") out.reflectance = Math.min(1, Math.max(0, num(p.reflectance, 1)));
  if (kind === "table") {
    let A = Math.max(0, num(p.absorptance, 0)), R = Math.max(0, num(p.reflectance, 0)), T = Math.max(0, num(p.transmittance, 1));
    const total = A + R + T;
    if (Math.abs(total - 1) > 1e-9) {
      warnings.push(`Surface property ${out.name}: A + R + T = ${total}; scaled to 1.`);
      if (total > 0) { A /= total; R /= total; T /= total; } else T = 1;
    }
    Object.assign(out, { absorptance: A, reflectance: R, transmittance: T });
  }
  return out;
}

/** Unpolarised Fresnel reflectance; 1 for total internal reflection. */
export function fresnelReflectance(n1, n2, cosI) {
  const eta = n1 / n2, k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return 1;
  const cosT = Math.sqrt(k);
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  return (rs * rs + rp * rp) / 2;
}

/** Branches at a face: [{ kind: absorb|reflect|transmit, fraction, d? }], fractions summing to 1. */
function interact(prop, d, nOut, n1, n2, solid) {
  const nf = dot(d, nOut) > 0 ? neg(nOut) : nOut;                // normal facing the incoming ray
  const cosI = -dot(nf, d);
  const reflectDir = () => norm(sub(d, scale(nf, 2 * dot(d, nf))));
  const refractDir = () => {
    if (!solid || n1 === n2) return d;
    const eta = n1 / n2, k = 1 - eta * eta * (1 - cosI * cosI);
    if (k < 0) return null;
    return norm(add(scale(d, eta), scale(nf, eta * cosI - Math.sqrt(k))));
  };
  const out = [];
  const push = (kind, fraction, dir) => { if (fraction > 0) out.push(dir ? { kind, fraction, d: dir } : { kind, fraction }); };
  if (prop.kind === "absorber") push("absorb", 1);
  else if (prop.kind === "mirror") { push("reflect", prop.reflectance, reflectDir()); push("absorb", 1 - prop.reflectance); }
  else if (prop.kind === "table") {
    const t = refractDir();
    push("absorb", prop.absorptance);
    if (t) { push("reflect", prop.reflectance, reflectDir()); push("transmit", prop.transmittance, t); }
    else push("reflect", prop.reflectance + prop.transmittance, reflectDir());       // TIR: the transmitted part reflects
  } else {                                                                            // fresnel
    const t = refractDir();
    if (!t) push("reflect", 1, reflectDir());
    else if (!solid || n1 === n2) push("transmit", 1, t);
    else { const R = fresnelReflectance(n1, n2, cosI); push("reflect", R, reflectDir()); push("transmit", 1 - R, t); }
  }
  return out;
}

// ---- scene compilation --------------------------------------------------------------------------------
export function compileScene(document) {
  const model = document?.model || {};
  const settings = model.settings || {};
  const warnings = [];

  const materials = new Map();
  for (const m of Array.isArray(model.materials) ? model.materials : []) if (m && str(m.id)) materials.set(m.id, m);
  const material = (id, owner) => {
    const m = materials.get(id);
    if (!m) throw new Error(`${owner} refers to unknown material "${id}".`);
    return m;
  };
  const ambient = str(settings.ambientMaterial) ? material(settings.ambientMaterial, "Ambient medium")
    : { id: "n=1", name: "n = 1", formula: "constant", n: 1 };

  const properties = new Map();
  for (const p of Array.isArray(model.surfaceProperties) ? model.surfaceProperties : []) {
    if (p && str(p.id)) properties.set(p.id, normalizeProperty(p, warnings));
  }
  const property = (id, owner) => {
    const p = properties.get(id);
    if (!p) throw new Error(`${owner} refers to unknown surface property "${id}".`);
    return p;
  };

  const objects = (Array.isArray(model.objects) ? model.objects : []).map((o, index) => {
    const id = str(o?.id) || `object${index}`, name = str(o?.name) || id, label = `Object ${name}`;
    const geometry = buildGeometry(o || {}, label);
    if (geometry.solid && !str(o.material)) throw new Error(`${label} needs a material.`);
    const defaultProp = str(o.surfaceProperty) ? property(o.surfaceProperty, label) : geometry.solid ? DEFAULT_GLASS : DEFAULT_ABSORBER;
    const faceProps = {};
    for (const [face, propId] of Object.entries(o.faceProperties || {})) {
      if (!str(propId)) continue;
      if (!geometry.faces.some(f => f.name === face)) { warnings.push(`${label} has no face "${face}"; its surface property is ignored.`); continue; }
      faceProps[face] = property(propId, `${label} face ${face}`);
    }
    return {
      index, id, name, kind: o.kind, solid: geometry.solid, faces: geometry.faces, radius: geometry.radius,
      position: num3(o.position), R: rotationMatrix(num3(o.rotationDeg)),
      material: geometry.solid ? material(o.material, label) : null,
      defaultProp, faceProps, propertyOf(face) { return faceProps[face] || defaultProp; },
    };
  });
  const objectById = new Map(objects.map(o => [o.id, o]));

  const declared = (Array.isArray(model.wavelengths) ? model.wavelengths : []).filter(w => w && Number.isFinite(Number(w.lambdaNm)));
  const wavelengths = (declared.length ? declared : [{ id: "d", label: "d", lambdaNm: LINES.d, weight: 1 }]).map((w, i) => {
    const lambdaNm = Number(w.lambdaNm);
    return { id: str(w.id) || `w${i}`, label: str(w.label) || `${lambdaNm} nm`, lambdaNm, weight: Math.max(0, num(w.weight, 1)),
      color: /^#[0-9a-fA-F]{6}$/.test(str(w.color)) ? w.color : wavelengthColor(lambdaNm) };
  });
  const used = [ambient, ...objects.map(o => o.material).filter(Boolean)].filter((m, i, all) => all.indexOf(m) === i);
  for (const w of wavelengths) for (const m of used) {
    if (outsideValidRange(m, w.lambdaNm)) warnings.push(`λ = ${w.lambdaNm} nm is outside the valid range of ${m.name || m.id}.`);
  }

  const sources = (Array.isArray(model.sources) ? model.sources : []).map((s, index) => {
    const id = str(s?.id) || `source${index}`;
    const direction = norm(num3(s?.direction, [0, 0, 1]));
    if (dot(direction, direction) === 0) throw new Error(`Source ${s?.name || id}: direction must not be zero.`);
    const [u, v] = basis(direction);
    return {
      id, name: str(s?.name) || id, kind: s?.kind === "point" ? "point" : "grid", position: num3(s?.position), direction, u, v,
      powerW: Math.max(0, num(s?.powerW, 1)), rayCount: Math.max(1, Math.min(1e7, Math.trunc(num(s?.rayCount, 1000)))),
      grid: { shape: s?.grid?.shape === "rectangle" ? "rectangle" : "circle", diameter: Math.max(0, num(s?.grid?.diameter, 10)),
        width: Math.max(0, num(s?.grid?.width, 10)), height: Math.max(0, num(s?.grid?.height, 10)),
        sampling: s?.grid?.sampling === "regular" ? "regular" : "random",
        divergenceRad: Math.min(90, Math.max(0, num(s?.grid?.divergenceHalfAngleDeg, 0))) * Math.PI / 180 },
      spectrum: compileSpectrum(s?.spectrum, `Source ${s?.name || id}`),
      point: { coneHalfAngleDeg: Math.min(180, Math.max(0, num(s?.point?.coneHalfAngleDeg, 180))),
        sampling: s?.point?.sampling === "regular" ? "regular" : "random" },
    };
  });

  for (const src of sources) {
    if (!src.spectrum) continue;
    for (const m of used) {
      if (outsideValidRange(m, src.spectrum.minNm) || outsideValidRange(m, src.spectrum.maxNm)) {
        warnings.push(`Source ${src.name}: spectrum ${src.spectrum.minNm}–${src.spectrum.maxNm} nm goes outside the valid range of ${m.name || m.id}.`);
      }
    }
  }

  const analyses = (Array.isArray(model.analyses) ? model.analyses : []).map((a, index) => {
    const id = str(a?.id) || `analysis${index}`, label = `Analysis ${a?.name || id}`;
    const object = objectById.get(a?.object);
    if (!object) throw new Error(`${label} refers to unknown object "${a?.object}".`);
    const face = object.faces.find(f => f.name === (str(a.face) || "front"));
    if (!face) throw new Error(`${label}: object ${object.name} has no face "${a.face}" (faces: ${object.faces.map(f => f.name).join(", ")}).`);
    const size = Array.isArray(a.sizeMm) && a.sizeMm.length === 2 ? a.sizeMm.map(Number) : null;
    const extent = size && size.every(x => x > 0) ? [-size[0] / 2, size[0] / 2, -size[1] / 2, size[1] / 2] : face.extent;
    if (!extent) throw new Error(`${label}: face ${face.name} has no flat chart; set sizeMm.`);
    const [nx, ny] = num3(a.pixels, [64, 64, 0]).slice(0, 2).map(n => Math.max(1, Math.min(1000, Math.trunc(n))));
    return { id, name: str(a.name) || id, kind: "irradiance", objectId: object.id, face: face.name, extent, nx, ny,
      display: a.display === "color" ? "color" : "power" };
  });

  let sceneRadius = 1;
  for (const o of objects) sceneRadius = Math.max(sceneRadius, Math.sqrt(dot(o.position, o.position)) + o.radius);
  for (const s of sources) sceneRadius = Math.max(sceneRadius, Math.sqrt(dot(s.position, s.position)));

  const scene = {
    objects, ambient, wavelengths, sources, analyses, warnings, sceneRadius,
    settings: {
      rayHandling: settings.rayHandling === "monteCarlo" ? "monteCarlo" : "split",
      fluxThreshold: Math.max(0, num(settings.fluxThreshold, 1e-4)),
      maxIntersections: Math.max(1, Math.trunc(num(settings.maxIntersections, 200))),
      randomSeed: Math.trunc(num(settings.randomSeed, 1)),
      displayRays: Math.max(0, Math.trunc(num(settings.displayRays, 200))),
      previewRayCap: Math.max(1, Math.trunc(num(settings.previewRayCap, 2000))),
    },
  };
  scene.indices = wavelengths.map(w => indexTable(scene, w.lambdaNm));
  warnings.push(...overlapWarnings(objects));
  return scene;
}

/** True if world point p is inside solid o (parity of crossings along a fixed, generic direction). */
function insideSolid(o, p) {
  const hits = [];
  objectHits(o, p, OVERLAP_PROBE, hits);
  return hits.length % 2 === 1;
}
const OVERLAP_PROBE = norm([0.5773, 0.5774, 0.5775]);

/**
 * Warnings for solids that overlap. Surface points of each solid, moved 1e-4 mm inwards, are tested against the
 * other solids: touching faces (cemented lenses) give no hits, real overlaps give many.
 */
export function overlapWarnings(objects) {
  const solids = objects.filter(o => o.solid);
  const samples = new Map(solids.map(o => {
    const points = [];
    for (const face of o.faces) {
      const tris = face.tess(), step = Math.max(1, Math.floor(tris.length / 60));
      // Triangle centres (never on a face's rim, where touching solids share points), projected onto the exact
      // analytic surface (a flat triangle's centre sits off a curved face by its chord sag), then 1e-4 mm inwards.
      for (let i = 0; i < tris.length; i += step) {
        const [a, b, c] = tris[i];
        const centre = scale(add(add(a.p, b.p), c.p), 1 / 3), n = norm(add(add(a.n, b.n), c.n));
        const exact = face.hit(sub(centre, scale(n, 1)), n).reduce((best, h) => (!best || Math.abs(h.t - 1) < Math.abs(best.t - 1) ? h : best), null);
        if (!exact) continue;
        const onSurface = add(sub(centre, scale(n, 1)), scale(n, exact.t));
        points.push(add(mul(o.R, sub(onSurface, scale(exact.n, 1e-4))), o.position));
      }
    }
    return [o, points];
  }));
  const warnings = [];
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    const a = solids[i], b = solids[j];
    const gap = Math.sqrt(dot(sub(a.position, b.position), sub(a.position, b.position)));
    if (gap > a.radius + b.radius) continue;
    const count = samples.get(a).filter(p => insideSolid(b, p)).length + samples.get(b).filter(p => insideSolid(a, p)).length;
    if (count >= 2) warnings.push(`Objects ${a.name} and ${b.name} overlap; the tracer assumes solids do not overlap (touching faces are fine).`);
  }
  return warnings;
}

/** Nearest object hit by a ray (for picking in the 3D view): { index, id, face, point } or null. */
export function pickObject(scene, origin, direction) {
  const hits = [];
  const d = norm(direction);
  for (const o of scene.objects) objectHits(o, origin, d, hits);
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (b.t < a.t ? b : a));
  return { index: best.object.index, id: best.object.id, face: best.face.name, point: add(origin, scale(d, best.t)) };
}

/** Refractive indices of the ambient medium and each solid at one wavelength. */
export function indexTable(scene, lambdaNm) {
  return { ambient: refractiveIndex(scene.ambient, lambdaNm),
    objects: scene.objects.map(o => (o.material ? refractiveIndex(o.material, lambdaNm) : null)) };
}

// ---- one interaction ------------------------------------------------------------------------------------
function objectHits(o, p, d, out) {
  const pl = mulT(o.R, sub(p, o.position)), dl = mulT(o.R, d);
  for (const face of o.faces) for (const h of face.hit(pl, dl)) out.push({ t: h.t, object: o, face, n: mul(o.R, h.n), uv: h.uv });
}

/** Nearest interaction of a ray in medium `inside` (object index, −1 = ambient); null if it leaves the scene. */
export function stepRay(scene, p, d, inside, nTable) {
  const all = [];
  for (const o of scene.objects) objectHits(o, p, d, all);
  if (!all.length) return null;
  let best = Infinity;
  for (const h of all) if (h.t < best) best = h.t;
  const near = all.filter(h => h.t - best < COINCIDENT);
  const primary = near.find(h => h.object.index === inside) || near.reduce((a, b) => (b.t < a.t ? b : a));
  const o = primary.object, nOut = primary.n;
  const n1 = inside >= 0 ? nTable.objects[inside] : nTable.ambient;
  let n2 = n1, nextInside = inside;
  if (o.solid) {
    if (dot(d, nOut) < 0) { nextInside = o.index; n2 = nTable.objects[o.index]; }
    else {
      const partner = near.find(h => h !== primary && h.object.solid && h.object.index !== o.index && dot(d, h.n) < 0);
      nextInside = partner ? partner.object.index : -1;
      n2 = partner ? nTable.objects[nextInside] : nTable.ambient;
    }
  }
  const branches = interact(o.propertyOf(primary.face.name), d, nOut, n1, n2, o.solid)
    .map(b => ({ ...b, inside: b.kind === "transmit" ? nextInside : inside }));
  return { point: add(p, scale(d, primary.t)), object: o, face: primary.face, uv: primary.uv, branches };
}

/**
 * Follow one ray deterministically (transmitted branch when there is one, else reflected) at one wavelength.
 * Used for single-ray checks (paraxial focus, 2D comparison). Returns { points, finalDir, status }.
 */
export function followRay(sceneOrDocument, origin, direction, lambdaNm, { maxSteps = 100 } = {}) {
  const scene = sceneOrDocument?.objects ? sceneOrDocument : compileScene(sceneOrDocument);
  const nTable = indexTable(scene, lambdaNm);
  let p = origin, d = norm(direction), inside = -1;
  const points = [p];
  for (let i = 0; i < maxSteps; i++) {
    const step = stepRay(scene, p, d, inside, nTable);
    if (!step) return { points, finalDir: d, status: "escaped" };
    points.push(step.point);
    const b = step.branches.find(x => x.kind === "transmit") || step.branches.find(x => x.kind === "reflect");
    if (!b) return { points, finalDir: d, status: "absorbed", object: step.object.id, face: step.face.name };
    p = step.point; d = b.d; inside = b.inside;
  }
  return { points, finalDir: d, status: "maxSteps" };
}

// ---- sources --------------------------------------------------------------------------------------------
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Direction uniformly distributed within a cone of half-angle `half` (rad) around d. */
function coneDirection(d, u, v, half, rng) {
  if (!(half > 0)) return d;
  const cosT = 1 - (1 - Math.cos(half)) * rng(), sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT)), f = 2 * Math.PI * rng();
  return norm(add(scale(d, cosT), scale(add(scale(u, Math.cos(f)), scale(v, Math.sin(f))), sinT)));
}

/** Ray starts { p, d } for a source; `cap` limits the count (preview). */
export function sampleSource(src, rng, cap = Infinity) {
  const count = Math.max(1, Math.min(src.rayCount, cap));
  const out = [];
  const at = (x, y) => add(src.position, add(scale(src.u, x), scale(src.v, y)));
  if (src.kind === "point") {
    const cosA = Math.cos(src.point.coneHalfAngleDeg * Math.PI / 180);
    for (let i = 0; i < count; i++) {
      const [a, b] = src.point.sampling === "regular" ? [(i + 0.5) / count, null] : [rng(), rng()];
      const cosT = 1 - (1 - cosA) * a, sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const f = b === null ? i * GOLDEN_ANGLE : 2 * Math.PI * b;
      out.push({ p: src.position, d: norm(add(scale(src.direction, cosT), scale(add(scale(src.u, Math.cos(f)), scale(src.v, Math.sin(f))), sinT))) });
    }
    return out;
  }
  const g = src.grid;
  if (g.divergenceRad > 0) {
    // Extended source such as the sun: same footprint, each ray tilted at random within the divergence cone.
    return sampleSource({ ...src, grid: { ...g, divergenceRad: 0 } }, rng, cap)
      .map(start => ({ p: start.p, d: coneDirection(src.direction, src.u, src.v, g.divergenceRad, rng) }));
  }
  if (g.shape === "circle") {
    const R = g.diameter / 2;
    if (g.sampling === "regular") {
      if (R === 0) return [{ p: src.position, d: src.direction }];
      const s = Math.sqrt(Math.PI * R * R / count), m = Math.ceil(R / s);
      for (let j = -m; j <= m; j++) for (let i = -m; i <= m; i++) {
        const x = i * s, y = j * s;
        if (x * x + y * y <= R * R * (1 + 1e-12)) out.push({ p: at(x, y), d: src.direction });
      }
      return out.length ? out : [{ p: src.position, d: src.direction }];
    }
    for (let i = 0; i < count; i++) {
      const r = R * Math.sqrt(rng()), f = 2 * Math.PI * rng();
      out.push({ p: at(r * Math.cos(f), r * Math.sin(f)), d: src.direction });
    }
    return out;
  }
  if (g.sampling === "regular") {
    const nx = Math.max(1, Math.round(Math.sqrt(count * (g.width || 1) / (g.height || 1)))), ny = Math.max(1, Math.round(count / nx));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push({ p: at(((i + 0.5) / nx - 0.5) * g.width, ((j + 0.5) / ny - 0.5) * g.height), d: src.direction });
    return out;
  }
  for (let i = 0; i < count; i++) out.push({ p: at((rng() - 0.5) * g.width, (rng() - 0.5) * g.height), d: src.direction });
  return out;
}

// ---- full trace -----------------------------------------------------------------------------------------
/**
 * Trace every source at every wavelength. options.rayCountCap limits rays per source per wavelength (preview).
 * Returns a raytrace3d-result/1 object.
 */
export function traceScene(document, options = {}) {
  const started = Date.now();
  const scene = compileScene(document);
  const s = scene.settings;
  const rng = createRng(s.randomSeed);
  const totals = { emittedW: 0, absorbedW: 0, escapedW: 0, lostW: 0, raysTraced: 0, segments: 0 };
  const faceStats = new Map();
  const statOf = key => {
    let st = faceStats.get(key);
    if (!st) faceStats.set(key, st = { incidentW: 0, absorbedW: 0, reflectedW: 0, transmittedW: 0, hits: 0 });
    return st;
  };
  const analyses = scene.analyses.map(a => ({ ...a, grid: new Float64Array(a.nx * a.ny), xyz: new Float64Array(3 * a.nx * a.ny), hits: 0 }));
  const analysesAt = new Map();
  for (const a of analyses) {
    const key = `${a.objectId}/${a.face}`;
    analysesAt.set(key, [...(analysesAt.get(key) || []), a]);
  }
  const deposit = (a, [u, v], flux, xyz) => {
    const [u0, u1, v0, v1] = a.extent;
    if (u < u0 || u > u1 || v < v0 || v > v1) return;
    const ix = Math.min(a.nx - 1, Math.floor((u - u0) / (u1 - u0) * a.nx));
    const iy = Math.min(a.ny - 1, Math.floor((v - v0) / (v1 - v0) * a.ny));
    const k = iy * a.nx + ix;
    a.grid[k] += flux; a.hits++;
    a.xyz[3 * k] += flux * xyz[0]; a.xyz[3 * k + 1] += flux * xyz[1]; a.xyz[3 * k + 2] += flux * xyz[2];
  };
  const totalWeight = scene.wavelengths.reduce((sum, w) => sum + w.weight, 0);
  if (!(totalWeight > 0) && scene.sources.some(src => !src.spectrum)) throw new Error("All wavelength weights are zero.");
  const escapeLength = Math.max(10, 0.5 * scene.sceneRadius);
  const display = [];
  const MAX_DISPLAY_POINTS = 60000;
  let displayPoints = 0;
  const raysPerSource = [];

  /** Trace one launched ray and all its branches. tag = { wavelength, lambdaNm?, color? } for drawing. */
  const traceOne = (start, flux0, nTable, tag, show, lambdaNm) => {
    const xyz = cieXYZ(lambdaNm);                      // for true-colour irradiance maps
    totals.emittedW += flux0; totals.raysTraced++;
    if (onProgress && totals.raysTraced % 500 === 0 && Date.now() - lastProgress > 200) { lastProgress = Date.now(); onProgress(Math.min(1, totals.raysTraced / planned)); }
    const newPoly = (p, fluxW) => { const poly = { ...tag, fluxW, points: [p] }; display.push(poly); displayPoints++; return poly; };
    const threshold = flux0 * s.fluxThreshold;
    const stack = [{ p: start.p, d: start.d, flux: flux0, inside: -1, depth: 0, poly: show && displayPoints < MAX_DISPLAY_POINTS ? newPoly(start.p, flux0) : null }];
    while (stack.length) {
      const ray = stack.pop();
      const step = stepRay(scene, ray.p, ray.d, ray.inside, nTable);
      if (!step) {
        totals.escapedW += ray.flux;
        if (ray.poly) { ray.poly.points.push(add(ray.p, scale(ray.d, escapeLength))); displayPoints++; }
        continue;
      }
      totals.segments++;
      if (ray.poly) { ray.poly.points.push(step.point); displayPoints++; }
      const key = `${step.object.id}/${step.face.name}`;
      const stat = statOf(key);
      stat.incidentW += ray.flux; stat.hits++;
      for (const a of analysesAt.get(key) || []) deposit(a, step.uv, ray.flux, xyz);
      let branches = step.branches;
      if (s.rayHandling === "monteCarlo") {
        let u = rng(), chosen = branches[branches.length - 1];
        for (const b of branches) { if (u < b.fraction) { chosen = b; break; } u -= b.fraction; }
        branches = [{ ...chosen, fraction: 1 }];
      }
      const ordered = [...branches].sort((a, b) => b.fraction - a.fraction);
      let continued = false;
      for (const b of ordered) {
        const f = ray.flux * b.fraction;
        if (b.kind === "absorb") { totals.absorbedW += f; stat.absorbedW += f; continue; }
        stat[b.kind === "reflect" ? "reflectedW" : "transmittedW"] += f;
        if (f < threshold || ray.depth + 1 >= s.maxIntersections) { totals.lostW += f; continue; }
        let poly = null;
        if (ray.poly && displayPoints < MAX_DISPLAY_POINTS) {
          if (!continued) { poly = ray.poly; continued = true; } else poly = newPoly(step.point, f);
        }
        stack.push({ p: step.point, d: b.d, flux: f, inside: b.inside, depth: ray.depth + 1, poly });
      }
    }
  };

  // Progress (full traces in the worker): planned launches, reported at most every 200 ms.
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const planned = Math.max(1, scene.sources.reduce((sum, src) => sum + Math.min(src.rayCount, options.rayCountCap ?? Infinity) * (src.spectrum ? 1 : scene.wavelengths.length), 0));
  let lastProgress = Date.now();

  const spectra = [];
  for (const src of scene.sources) {
    const starts = sampleSource(src, rng, options.rayCountCap ?? Infinity);
    raysPerSource.push({ id: src.id, rays: starts.length });
    const stride = s.displayRays > 0 ? Math.max(1, Math.ceil(starts.length / s.displayRays)) : Infinity;
    if (src.spectrum) {
      // Continuous spectrum: each ray draws its own wavelength (probability ∝ spectral power, equal flux per ray).
      const id = `${src.id}:spectrum`;
      spectra.push({ id, label: `${src.name}: ${src.spectrum.description}`, lambdaNm: null, weight: null, color: null,
        spectrum: { kind: src.spectrum.kind, minNm: src.spectrum.minNm, maxNm: src.spectrum.maxNm } });
      const flux0 = src.powerW / starts.length;
      if (!(flux0 > 0)) continue;
      starts.forEach((start, i) => {
        const lambdaNm = src.spectrum.sample(rng());
        traceOne(start, flux0, indexTable(scene, lambdaNm), { wavelength: id, lambdaNm, color: wavelengthColor(lambdaNm) }, i % stride === 0, lambdaNm);
      });
      continue;
    }
    starts.forEach((start, i) => {
      scene.wavelengths.forEach((w, li) => {
        const flux0 = src.powerW * (w.weight / totalWeight) / starts.length;
        if (flux0 > 0) traceOne(start, flux0, scene.indices[li], { wavelength: w.id }, i % stride === 0, w.lambdaNm);
      });
    });
  }

  const zero = { incidentW: 0, absorbedW: 0, reflectedW: 0, transmittedW: 0, hits: 0 };
  return {
    schema: "raytrace3d-result/1",
    solver: "browser (trace3d.js)",
    rayHandling: s.rayHandling,
    rayCountCap: Number.isFinite(options.rayCountCap) ? options.rayCountCap : null,
    raysPerSource,
    totals,
    wavelengths: [...(scene.sources.some(src => !src.spectrum) ? scene.wavelengths.map(({ id, label, lambdaNm, weight, color }) => ({ id, label, lambdaNm, weight, color })) : []), ...spectra],
    objects: scene.objects.map(o => ({ id: o.id, name: o.name,
      faces: Object.fromEntries(o.faces.map(f => [f.name, { ...(faceStats.get(`${o.id}/${f.name}`) || zero) }])) })),
    analyses: analyses.map(a => {
      const [u0, u1, v0, v1] = a.extent;
      const du = (u1 - u0) / a.nx, dv = (v1 - v0) / a.ny, area = du * dv;
      let totalW = 0, peak = 0, cu = 0, cv = 0;
      const wPerMm2 = new Array(a.grid.length);
      for (let iy = 0; iy < a.ny; iy++) for (let ix = 0; ix < a.nx; ix++) {
        const flux = a.grid[iy * a.nx + ix];
        wPerMm2[iy * a.nx + ix] = flux / area;
        totalW += flux; peak = Math.max(peak, flux / area);
        cu += flux * (u0 + (ix + 0.5) * du); cv += flux * (v0 + (iy + 0.5) * dv);
      }
      return { id: a.id, name: a.name, kind: a.kind, object: a.objectId, face: a.face, display: a.display, pixels: [a.nx, a.ny], extentMm: a.extent,
        wPerMm2, totalW, peakWPerMm2: peak, centroidMm: totalW > 0 ? [cu / totalW, cv / totalW] : null, hits: a.hits,
        // CIE XYZ per pixel (flux × colour-matching function, summed; 3 values per pixel, row-major) for true-colour display
        xyz: Array.from(a.xyz, v => v / area) };
    }),
    displayRays: display,
    warnings: scene.warnings,
    elapsedMs: Date.now() - started,
  };
}

/** Triangles of every face in world coordinates, for the viewer: [{ objectId, face, positions, normals }]. */
export function tessellateScene(scene) {
  const meshes = [];
  for (const o of scene.objects) for (const face of o.faces) {
    const tris = face.tess();
    const positions = new Float32Array(tris.length * 9), normals = new Float32Array(tris.length * 9);
    let k = 0;
    for (const tri of tris) for (const v of tri) {
      const p = add(mul(o.R, v.p), o.position), n = mul(o.R, v.n);
      positions.set(p, k); normals.set(n, k); k += 3;
    }
    meshes.push({ objectId: o.id, objectIndex: o.index, face: face.name, property: o.propertyOf(face.name), solid: o.solid, positions, normals });
  }
  return meshes;
}
