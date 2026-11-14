// Refractive-index models, spectral lines and wavelength colours shared by the live preview tracer.
// solver/RayTrace2D.cs implements the same formulas; keep the two in sync.
//
// Formulas (λ in µm):
//   constant   n
//   cauchy     n = A + B[0]/λ² + B[1]/λ⁴ + ...
//   sellmeier  n² − 1 = Σ B[i] λ² / (λ² − C[i])          (C in µm²)
//   gas        n − 1 = Σ B[i] / (C[i] − λ⁻²)              (C in µm⁻², e.g. Ciddor 1996 air)

/** Fraunhofer lines used for Abbe numbers and the F–C chromatic focal shift (nm). */
export const LINES = Object.freeze({ F: 486.1327, d: 587.5618, C: 656.2725 });

export const FORMULAS = Object.freeze(["constant", "cauchy", "sellmeier", "gas"]);

const finite = value => typeof value === "number" && Number.isFinite(value);
const numberList = value => (Array.isArray(value) ? value.map(Number) : []);

/** Refractive index of a material at a vacuum wavelength given in nm. Throws if it is undefined there. */
export function refractiveIndex(material, lambdaNm) {
  const label = material?.name || material?.id || "material";
  const formula = material?.formula || "constant";
  const um = lambdaNm / 1000;
  const l2 = um * um;
  let n;
  if (formula === "constant") {
    n = Number(material.n);
  } else if (formula === "cauchy") {
    const B = numberList(material.B);
    n = Number(material.A);
    for (let i = 0; i < B.length; i++) n += B[i] / Math.pow(l2, i + 1);
  } else if (formula === "sellmeier") {
    const B = numberList(material.B), C = numberList(material.C);
    if (B.length !== C.length) throw new Error(`Material ${label}: Sellmeier B and C need the same number of terms.`);
    let n2 = 1;
    for (let i = 0; i < B.length; i++) n2 += B[i] * l2 / (l2 - C[i]);
    n = n2 > 0 ? Math.sqrt(n2) : NaN;
  } else if (formula === "gas") {
    const B = numberList(material.B), C = numberList(material.C);
    if (B.length !== C.length) throw new Error(`Material ${label}: gas formula B and C need the same number of terms.`);
    n = 1;
    for (let i = 0; i < B.length; i++) n += B[i] / (C[i] - 1 / l2);
  } else {
    throw new Error(`Material ${label}: unknown formula "${formula}".`);
  }
  if (!finite(n) || n <= 0) throw new Error(`Material ${label} has no valid refractive index at ${lambdaNm} nm.`);
  return n;
}

/** nF, nd, nC and the Abbe number νd = (nd − 1)/(nF − nC); abbeVd is null for a non-dispersive material. */
export function abbeData(material) {
  const nF = refractiveIndex(material, LINES.F), nd = refractiveIndex(material, LINES.d), nC = refractiveIndex(material, LINES.C);
  const dn = nF - nC;
  return { id: material.id, nF, nd, nC, abbeVd: Math.abs(dn) > 1e-12 ? (nd - 1) / dn : null };
}

/** True when lambdaNm lies outside the material's declared validRangeUm. */
export function outsideValidRange(material, lambdaNm) {
  const range = material?.validRangeUm;
  if (!Array.isArray(range) || range.length !== 2) return false;
  const um = lambdaNm / 1000;
  return um < Number(range[0]) || um > Number(range[1]);
}

/** Approximate display colour of a vacuum wavelength (Bruton's piecewise fit), as #rrggbb. */
export function wavelengthColor(lambdaNm) {
  const l = Number(lambdaNm);
  let r = 0, g = 0, b = 0;
  if (l >= 380 && l < 440) { r = -(l - 440) / 60; b = 1; }
  else if (l >= 440 && l < 490) { g = (l - 440) / 50; b = 1; }
  else if (l >= 490 && l < 510) { g = 1; b = -(l - 510) / 20; }
  else if (l >= 510 && l < 580) { r = (l - 510) / 70; g = 1; }
  else if (l >= 580 && l < 645) { r = 1; g = -(l - 645) / 65; }
  else if (l >= 645 && l <= 780) { r = 1; }
  else return "#9aa4ae";                                   // outside the visible band: neutral grey
  const fade = l < 420 ? 0.3 + 0.7 * (l - 380) / 40 : l > 700 ? 0.3 + 0.7 * (780 - l) / 80 : 1;
  const channel = c => Math.round(255 * Math.pow(Math.max(0, c) * fade, 0.8)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
