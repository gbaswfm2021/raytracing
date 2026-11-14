// Source spectra (blackbody, tabulated) and colour science shared by the 2D and 3D tracers.
// solver/RayTrace2D.cs mirrors planckRelative, the table interpolation and binSpectrum; keep them in sync.

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);

const PLANCK_C2_NM_K = 1.438776877e7;     // second radiation constant hc/k in nm·K

/** Planck spectral radiance per unit wavelength, up to a constant: λ⁻⁵ / (exp(c2/λT) − 1). */
export function planckRelative(lambdaNm, temperatureK) {
  return 1 / (Math.pow(lambdaNm, 5) * Math.expm1(PLANCK_C2_NM_K / (lambdaNm * temperatureK)));
}

/**
 * Spectral power density (relative, per nm) and range of a source spectrum, or null for kind "wavelengths".
 * kind "blackbody" { temperatureK, minNm, maxNm }; kind "table" { points: [[nm, value], …], minNm?, maxNm? }.
 */
export function spectrumDensity(spec, label) {
  const kind = spec?.kind;
  if (!kind || kind === "wavelengths") return null;
  if (kind === "blackbody") {
    const T = num(spec.temperatureK, 5778), minNm = num(spec.minNm, 300), maxNm = num(spec.maxNm, 2500);
    if (!(T > 0)) throw new Error(`${label}: blackbody temperature must be positive.`);
    if (!(minNm > 0 && maxNm > minNm)) throw new Error(`${label}: spectrum range must satisfy 0 < min < max.`);
    return { kind, minNm, maxNm, density: l => planckRelative(l, T), description: `${T} K blackbody, ${minNm}–${maxNm} nm` };
  }
  if (kind === "table") {
    const points = (Array.isArray(spec.points) ? spec.points : [])
      .map(p => [Number(p?.[0]), Math.max(0, Number(p?.[1]))]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .sort((a, b) => a[0] - b[0]);
    if (points.length < 2) throw new Error(`${label}: a tabulated spectrum needs at least two [nm, value] points.`);
    const minNm = Math.max(points[0][0], num(spec.minNm, points[0][0]));
    const maxNm = Math.min(points.at(-1)[0], num(spec.maxNm, points.at(-1)[0]));
    if (!(minNm > 0 && maxNm > minNm)) throw new Error(`${label}: spectrum range must satisfy 0 < min < max.`);
    const density = l => {
      let lo = 0, hi = points.length - 1;                     // binary search for the segment containing l
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] <= l) lo = mid; else hi = mid; }
      const [x0, y0] = points[lo], [x1, y1] = points[hi];
      return x1 === x0 ? y0 : y0 + (y1 - y0) * (Math.min(Math.max(l, x0), x1) - x0) / (x1 - x0);
    };
    return { kind, minNm, maxNm, density, description: `tabulated spectrum (${points.length} points), ${minNm}–${maxNm} nm` };
  }
  throw new Error(`${label}: unknown spectrum kind "${kind}".`);
}

/** Integral of the density over [a, b] by Simpson's rule (n even). */
function integrate(density, a, b, n = 64) {
  const h = (b - a) / n;
  let s = density(a) + density(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * density(a + i * h);
  return s * h / 3;
}

/**
 * Continuous spectrum → sampler (3D tracer). sample(u) maps u ∈ [0, 1) to a wavelength with probability
 * proportional to spectral power (inverse CDF on 4096 intervals), so every ray carries the same flux.
 */
export function compileSpectrum(spec, label) {
  const s = spectrumDensity(spec, label);
  if (!s) return null;
  const N = 4096, xs = new Float64Array(N + 1), cdf = new Float64Array(N + 1);
  let previous = s.density(s.minNm);
  xs[0] = s.minNm;
  for (let i = 1; i <= N; i++) {
    xs[i] = s.minNm + (s.maxNm - s.minNm) * i / N;
    const value = s.density(xs[i]);
    cdf[i] = cdf[i - 1] + 0.5 * (previous + value) * (xs[i] - xs[i - 1]);
    previous = value;
  }
  const total = cdf[N];
  if (!(total > 0)) throw new Error(`${label}: the spectrum has no power in ${s.minNm}–${s.maxNm} nm.`);
  return {
    kind: s.kind, minNm: s.minNm, maxNm: s.maxNm, description: s.description,
    sample(u) {
      const target = u * total;
      let lo = 0, hi = N;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] <= target) lo = mid; else hi = mid; }
      const span = cdf[hi] - cdf[lo];
      return xs[lo] + (span > 0 ? (target - cdf[lo]) / span : 0) * (xs[hi] - xs[lo]);
    },
  };
}

/**
 * Continuous spectrum → `bins` equal-width bands (2D tracer): [{ lambdaNm (band centre), weight (band power) }].
 * Weights are normalised to sum to 1.
 */
export function binSpectrum(spec, bins, label) {
  const s = spectrumDensity(spec, label);
  if (!s) return null;
  const n = Math.max(1, Math.min(200, Math.trunc(num(bins, 16)))), width = (s.maxNm - s.minNm) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = s.minNm + i * width;
    out.push({ lambdaNm: a + width / 2, weight: integrate(s.density, a, a + width) });
  }
  const total = out.reduce((sum, b) => sum + b.weight, 0);
  if (!(total > 0)) throw new Error(`${label}: the spectrum has no power in ${s.minNm}–${s.maxNm} nm.`);
  for (const b of out) b.weight /= total;
  return { bins: out, description: s.description };
}

// ---- colour ---------------------------------------------------------------------------------------------
const lobe = (l, mu, s1, s2) => { const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };

/**
 * CIE 1931 2° colour-matching functions x̄, ȳ, z̄ at a wavelength (nm), from the multi-lobe Gaussian fit of
 * C. Wyman, P.-P. Sloan, P. Shirley, "Simple analytic approximations to the CIE XYZ color matching functions",
 * JCGT 2(2), 2013. Accurate to a few percent of the peak, which is ample for display colours.
 */
export function cieXYZ(lambdaNm) {
  const l = lambdaNm;
  return [
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8),
  ];
}

/** CIE XYZ → linear sRGB (D65). */
export function xyzToLinearSrgb([X, Y, Z]) {
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z];
}

/** Linear sRGB component (0–1, clipped) → 8-bit gamma-encoded value. */
export function srgbByte(c) {
  const x = Math.min(1, Math.max(0, c));
  return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
}
