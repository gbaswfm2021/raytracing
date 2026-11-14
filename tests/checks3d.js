// Stage 2 (phase 3a) acceptance checks for the 3D non-sequential engine (run by tests/run.html).
import { refractiveIndex } from "../js/materials.js";
import { traceModel } from "../js/trace2d.js";
import { compileScene, compileSpectrum, createRng, followRay, fresnelReflectance, pickObject, planckRelative, traceScene } from "../js/trace3d.js";
import { cieXYZ, xyzToLinearSrgb } from "../js/spectra.js";

const base = new URL("../", import.meta.url);
const getJson = async path => {
  const response = await fetch(new URL(path, base), { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const clone = value => JSON.parse(JSON.stringify(value));
/** z where the final segment of a followed ray crosses the plane x = 0 (meridional y–z rays: y = 0). */
const axisCrossing = r => { const p = r.points.at(-1), d = r.finalDir; return p[2] - p[1] * d[2] / d[1]; };
const yAtZ = (r, z) => { const p = r.points.at(-1), d = r.finalDir; return p[1] + (z - p[2]) * d[1] / d[2]; };

export async function runChecks3d(check) {
  const singlet3d = await getJson("examples/raytrace3d_singlet/raytrace_model.json");
  const singlet2d = await getJson("examples/raytrace_singlet_bk7/raytrace_model.json");
  const mirror = await getJson("examples/raytrace3d_parabolic_mirror/raytrace_model.json");
  const splitter = await getJson("examples/raytrace3d_beam_splitter/raytrace_model.json");

  // 1. 2D ↔ 3D: the same singlet, meridional rays, screen heights at z = 103 for every wavelength.
  {
    const r2 = traceModel(singlet2d);
    const scene = compileScene(singlet3d);
    let worst = 0, compared = 0;
    for (const w of r2.wavelengths) {
      for (const ray of r2.rays.filter(r => r.wavelength === w.id && r.status === "screen")) {
        const h = ray.points[0][1];
        const r3 = followRay(scene, [0, h, -20], [0, 0, 1], w.lambdaNm);
        worst = Math.max(worst, Math.abs(yAtZ(r3, 103) - ray.screenY)); compared++;
      }
    }
    check("3D singlet matches 2D tracer (screen y, F/d/C)", compared === 33 && worst < 1e-9, { compared, worstDifferenceMm: worst });
  }

  // 2. Lensmaker (thick lens): EFL from a near-axis ray vs 1/f = (n−1)[1/R1 − 1/R2 + (n−1)t/(n R1 R2)].
  {
    const scene = compileScene(singlet3d);
    const n = refractiveIndex(singlet3d.model.materials[1], 587.5618), R1 = 103.4, R2 = -103.4, t = 5;
    const f = 1 / ((n - 1) * (1 / R1 - 1 / R2 + (n - 1) * t / (n * R1 * R2)));
    const h = 0.001, r = followRay(scene, [0, h, -20], [0, 0, 1], 587.5618);
    const efl = -h / (r.finalDir[1] / r.finalDir[2]);
    check("lensmaker EFL (thick lens, d line)", Math.abs(efl / f - 1) < 1e-3, { traced: efl, formula: f, relative: efl / f - 1 });
  }

  // 3. Parabolic mirror: every reflected ray crosses the axis at z = R/2 = −100 mm.
  {
    const model = clone(mirror);
    model.model.objects = model.model.objects.filter(o => o.id !== "det");     // no focal obstruction
    model.model.analyses = [];
    const scene = compileScene(model);
    let worst = 0;
    for (const h of [0.5, 2, 5, 10, 15, 20, 24]) {
      const r = followRay(scene, [0, h, -150], [0, 0, 1], 587.5618);
      worst = Math.max(worst, Math.abs(axisCrossing(r) + 100));
    }
    // An off-meridian ray (x and y) must also pass through the focus point.
    const r = followRay(scene, [7, -11, -150], [0, 0, 1], 587.5618);
    const p = r.points.at(-1), d = r.finalDir, tz = (-100 - p[2]) / d[2];
    const miss = Math.hypot(p[0] + tz * d[0], p[1] + tz * d[1]);
    check("parabolic mirror focuses to a point at R/2", worst < 1e-9 && miss < 1e-9, { worstAxisErrorMm: worst, skewRayMissMm: miss });
  }

  // 4. Fresnel: normal incidence on N-BK7 reflects ((n−1)/(n+1))²; TIR beyond the critical angle.
  {
    const model = clone(singlet3d);
    model.model.wavelengths = [{ id: "d", label: "d", lambdaNm: 587.5618, weight: 1 }];
    model.model.sources = [{ id: "s", kind: "grid", position: [0, 0, -20], direction: [0, 0, 1], powerW: 1, rayCount: 1,
      grid: { shape: "circle", diameter: 0, sampling: "regular" } }];
    model.model.objects = model.model.objects.filter(o => o.id === "lens1");
    model.model.analyses = [];
    // First interaction only: otherwise the front face also books light reflected back from the rear face.
    model.model.settings.maxIntersections = 1;
    const result = traceScene(model);
    const n = refractiveIndex(model.model.materials[1], 587.5618), expected = ((n - 1) / (n + 1)) ** 2;
    const front = result.objects[0].faces.front;
    check("Fresnel reflectance at normal incidence", Math.abs(front.reflectedW - expected) < 1e-12, { reflectedW: front.reflectedW, expected });
    const crit = Math.asin(1 / 1.5);
    check("total internal reflection beyond the critical angle",
      fresnelReflectance(1.5, 1, Math.cos(crit + 0.01)) === 1 && fresnelReflectance(1.5, 1, Math.cos(crit - 0.01)) < 1, { criticalDeg: crit * 180 / Math.PI });
  }

  // 5. Energy balance in split and Monte Carlo modes (beam splitter and singlet).
  for (const [label, doc] of [["beam splitter", splitter], ["singlet", singlet3d], ["mirror", mirror]]) {
    for (const mode of ["split", "monteCarlo"]) {
      const model = clone(doc);
      model.model.settings.rayHandling = mode;
      const { totals } = traceScene(model, { rayCountCap: 3000 });
      const residual = totals.emittedW - (totals.absorbedW + totals.escapedW + totals.lostW);
      check(`energy balance: ${label}, ${mode}`, Math.abs(residual) < 1e-12 * totals.emittedW, { totals, residual });
    }
  }

  // 6. Beam splitter: exact split in split mode.
  {
    const result = traceScene(splitter);
    const a = result.analyses.find(x => x.id === "irrA").totalW, b = result.analyses.find(x => x.id === "irrB").totalW;
    const absorbedBs = result.objects.find(o => o.id === "bs").faces.front.absorbedW;
    check("beam splitter 49 / 49 / 2 %", Math.abs(a - 0.49) < 1e-9 && Math.abs(b - 0.49) < 1e-9 && Math.abs(absorbedBs - 0.02) < 1e-9
      && result.totals.escapedW < 1e-12, { detectorA: a, detectorB: b, splitterAbsorbed: absorbedBs, escaped: result.totals.escapedW });
  }

  // 7. Irradiance of a uniform collimated beam: 1 W over Ø20 mm → 1/(100π) W/mm² (Monte Carlo, ±3 %).
  {
    const model = {
      application: "raytrace", modelFormat: "raytrace3d-model/1",
      model: {
        materials: [{ id: "air", formula: "constant", n: 1 }], wavelengths: [{ id: "d", lambdaNm: 587.5618, weight: 1 }],
        surfaceProperties: [{ id: "black", kind: "absorber" }],
        objects: [{ id: "det", kind: "plate", position: [0, 0, 10], rotationDeg: [0, 0, 0], surfaceProperty: "black",
          plate: { shape: "rectangle", width: 30, height: 30 } }],
        sources: [{ id: "s", kind: "grid", position: [0, 0, 0], direction: [0, 0, 1], powerW: 1, rayCount: 40000,
          grid: { shape: "circle", diameter: 20, sampling: "random" } }],
        analyses: [{ id: "a", object: "det", face: "front", pixels: [30, 30] }],
        settings: { ambientMaterial: "air", randomSeed: 7, displayRays: 0 },
      },
    };
    const a = traceScene(model).analyses[0];
    let sum = 0, n = 0;
    for (let iy = 10; iy < 20; iy++) for (let ix = 10; ix < 20; ix++) { sum += a.wPerMm2[iy * 30 + ix]; n++; }
    const expected = 1 / (100 * Math.PI);
    check("irradiance of a uniform beam", Math.abs(sum / n / expected - 1) < 0.03 && Math.abs(a.totalW - 1) < 1e-9,
      { meanCentralWPerMm2: sum / n, expected, totalW: a.totalW });

    // Inverse-square law: point source, 5° cone, detector at 100 and 200 mm.
    const point = clone(model);
    point.model.sources = [{ id: "p", kind: "point", position: [0, 0, 0], direction: [0, 0, 1], powerW: 1, rayCount: 40000,
      point: { coneHalfAngleDeg: 5, sampling: "regular" } }];
    point.model.objects[0].plate = { shape: "rectangle", width: 4, height: 4 };
    point.model.analyses = [{ id: "a", object: "det", face: "front", pixels: [1, 1] }];
    const at = z => { const m = clone(point); m.model.objects[0].position = [0, 0, z]; return traceScene(m).analyses[0].wPerMm2[0]; };
    const e100 = at(100), e200 = at(200);
    const intensity = 1 / (2 * Math.PI * (1 - Math.cos(5 * Math.PI / 180)));
    check("inverse-square law (point source)", Math.abs(e100 / (intensity / 1e4) - 1) < 0.03 && Math.abs(e100 / e200 / 4 - 1) < 0.03,
      { e100, expected100: intensity / 1e4, ratio: e100 / e200 });
  }

  // 8. Continuous spectra: blackbody sampler peaks at Wien's λmax and reproduces the band fraction; flat table → uniform.
  {
    const T = 5778, sun = compileSpectrum({ kind: "blackbody", temperatureK: T, minNm: 300, maxNm: 2500 }, "test");
    const rng = createRng(11), bins = new Float64Array(440);           // 5 nm bins over 300–2500 nm
    let visible = 0; const N = 400000;
    for (let i = 0; i < N; i++) {
      const l = sun.sample(rng());
      bins[Math.min(439, Math.floor((l - 300) / 5))]++;
      if (l >= 380 && l <= 780) visible++;
    }
    // smooth over ±2 bins before locating the peak (Monte Carlo noise)
    let best = 0, peakNm = 0;
    for (let i = 2; i < 438; i++) { const s = bins[i - 2] + bins[i - 1] + bins[i] + bins[i + 1] + bins[i + 2]; if (s > best) { best = s; peakNm = 300 + 5 * i + 2.5; } }
    const wien = 2.897771955e6 / T;
    // independent reference: Simpson's rule on Planck's law
    const simpson = (a, b, n = 20000) => { const h = (b - a) / n; let s = planckRelative(a, T) + planckRelative(b, T); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * planckRelative(a + i * h, T); return s * h / 3; };
    const fraction = simpson(380, 780) / simpson(300, 2500);
    check("blackbody spectrum sampling (Wien peak, visible fraction)", Math.abs(peakNm - wien) < 15 && Math.abs(visible / N - fraction) < 0.005,
      { peakNm, wienNm: wien, sampledVisibleFraction: visible / N, planckVisibleFraction: fraction });
    const flat = compileSpectrum({ kind: "table", points: [[400, 1], [700, 1]] }, "test");
    let mean = 0; for (let i = 0; i < 100000; i++) mean += flat.sample(rng()); mean /= 100000;
    check("tabulated spectrum sampling (flat 400–700 nm)", Math.abs(mean - 550) < 1.5, { meanNm: mean });
  }

  // 9. Prism at minimum deviation: δ = 2 asin(n sin(α/2)) − α, symmetric exit, blue deviated more than red.
  {
    const prismDoc = await getJson("examples/raytrace3d_sunlight_prism/raytrace_model.json");
    const scene = compileScene(prismDoc);
    const src = prismDoc.model.sources[0], d0 = src.direction;
    const glass = prismDoc.model.materials[1];
    const deviation = lambda => {
      const r = followRay(scene, src.position, d0, lambda);
      const dIn = d0.map(x => x / Math.hypot(...d0)), dOut = r.finalDir;
      return { deg: Math.acos(Math.max(-1, Math.min(1, dIn[0] * dOut[0] + dIn[1] * dOut[1] + dIn[2] * dOut[2]))) * 180 / Math.PI, dOut };
    };
    const n = refractiveIndex(glass, 587.5618), alpha = 60 * Math.PI / 180;
    const expected = (2 * Math.asin(n * Math.sin(alpha / 2)) - alpha) * 180 / Math.PI;
    const dLine = deviation(587.5618), F = deviation(486.1327), C = deviation(656.2725);
    check("prism minimum deviation (d line) and dispersion order", Math.abs(dLine.deg - expected) < 0.01 && Math.abs(dLine.dOut[0] + d0[0] / Math.hypot(...d0)) < 1e-3
      && F.deg > dLine.deg && dLine.deg > C.deg, { tracedDeg: dLine.deg, formulaDeg: expected, exitDirX: dLine.dOut[0], F_deg: F.deg, C_deg: C.deg });
    const { totals, analyses } = traceScene(prismDoc, { rayCountCap: 3000 });
    const residual = totals.emittedW - (totals.absorbedW + totals.escapedW + totals.lostW);
    check("sunlight prism: energy balance and light on the screen", Math.abs(residual) < 1e-12 && analyses[0].totalW > 0.6,
      { totals, screenW: analyses[0].totalW });
  }

  // 10. True colour: CIE functions behave, and on the prism screen blue light lands where the F line does.
  {
    const y555 = cieXYZ(555)[1], blue = xyzToLinearSrgb(cieXYZ(460)), green = xyzToLinearSrgb(cieXYZ(530)), red = xyzToLinearSrgb(cieXYZ(650));
    const dominant = c => c.indexOf(Math.max(...c));
    check("CIE colour matching → sRGB", Math.abs(y555 - 1) < 0.03 && dominant(blue) === 2 && dominant(green) === 1 && dominant(red) === 0,
      { y555, blue, green, red });
    const prismDoc = await getJson("examples/raytrace3d_sunlight_prism/raytrace_model.json");
    const a = traceScene(prismDoc, { rayCountCap: 20000 }).analyses[0];
    const [nx, ny] = a.pixels, [u0, u1] = a.extentMm, du = (u1 - u0) / nx;
    let sR = 0, sB = 0, cR = 0, cB = 0;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const k = iy * nx + ix, [r, , b] = xyzToLinearSrgb([a.xyz[3 * k], a.xyz[3 * k + 1], a.xyz[3 * k + 2]]).map(v => Math.max(0, v));
      const u = u0 + (ix + 0.5) * du; sR += r; cR += r * u; sB += b; cB += b * u;
    }
    cR /= sR; cB /= sB;
    // where the F (blue) and C (red) lines land on the screen, in its local u coordinate
    const screen = prismDoc.model.objects.find(o => o.id === "screen"), ry = screen.rotationDeg[1] * Math.PI / 180;
    const ex = [Math.cos(ry), 0, -Math.sin(ry)];
    const uAt = l => { const p = followRay(compileScene(prismDoc), prismDoc.model.sources[0].position, prismDoc.model.sources[0].direction, l).points.at(-1);
      return (p[0] - screen.position[0]) * ex[0] + (p[2] - screen.position[2]) * ex[2]; };
    const uF = uAt(486.1327), uC = uAt(656.2725);
    check("true-colour map: blue where the F line lands, red where C lands", Math.abs(cB - cR) > 1 && Math.sign(cB - cR) === Math.sign(uF - uC),
      { blueCentroidMm: cB, redCentroidMm: cR, uF, uC });
  }

  // 11. 2D spectrum bins: weights are the Planck band integrals (normalised), strongest band is primary.
  {
    const doc = clone(await getJson("examples/raytrace_singlet_bk7/raytrace_model.json"));
    doc.model.source.spectrum = { kind: "blackbody", temperatureK: 5778, minNm: 380, maxNm: 780, bins: 8 };
    const r = traceModel(doc);
    const w = r.wavelengths;
    const band = (a, b) => { let s = 0; const n = 2000, h = (b - a) / n; for (let i = 0; i < n; i++) s += planckRelative(a + (i + 0.5) * h, 5778) * h; return s; };
    const ratio = w[0].weight / w[7].weight, expected = band(380, 430) / band(730, 780);
    const strongest = w.reduce((x, y) => (y.weight > x.weight ? y : x));
    check("2D spectrum → weighted bins", w.length === 8 && Math.abs(w.reduce((s, x) => s + x.weight, 0) - 1) < 1e-12
      && Math.abs(ratio / expected - 1) < 1e-6 && r.primaryWavelength === strongest.id && Number.isFinite(r.stats.polychromaticRmsSpotMm),
      { bins: w.map(x => [x.lambdaNm, x.weight]), ratio, expected, primary: r.primaryWavelength });
  }

  // 12. Overlap warning: overlapping blocks warn, a cemented doublet does not.
  {
    const base3 = { application: "raytrace", modelFormat: "raytrace3d-model/1",
      model: { materials: [{ id: "air", formula: "constant", n: 1 }, { id: "g", formula: "constant", n: 1.5 }, { id: "f", formula: "constant", n: 1.7 }],
        sources: [], analyses: [], settings: { ambientMaterial: "air" } } };
    const blocks = clone(base3);
    blocks.model.objects = [{ id: "a", name: "A", kind: "block", position: [0, 0, 0], rotationDeg: [0, 0, 0], material: "g", block: { size: [10, 10, 10] } },
      { id: "b", name: "B", kind: "block", position: [4, 0, 0], rotationDeg: [0, 0, 30], material: "g", block: { size: [10, 10, 10] } }];
    const doublet = clone(base3);
    doublet.model.objects = [
      { id: "l1", name: "Crown", kind: "lens", position: [0, 0, 0], rotationDeg: [0, 0, 0], material: "g", lens: { radius1: 62, radius2: -62, thickness: 6, diameter: 25 } },
      { id: "l2", name: "Flint", kind: "lens", position: [0, 0, 6], rotationDeg: [0, 0, 0], material: "f", lens: { radius1: -62, radius2: -131.1, thickness: 3, diameter: 25 } }];
    const wBlocks = compileScene(blocks).warnings, wDoublet = compileScene(doublet).warnings;
    check("overlap warning (overlapping blocks yes, cemented doublet no)", wBlocks.some(w => w.includes("overlap")) && !wDoublet.some(w => w.includes("overlap")),
      { wBlocks, wDoublet });
  }

  // 13. Picking: rays from the camera side find the right object.
  {
    const scene = compileScene(singlet3d);
    const lens = pickObject(scene, [0, 0, -50], [0, 0, 1]), det = pickObject(scene, [0, 0, 150], [0, 0, -1]), none = pickObject(scene, [0, 50, -50], [0, 0, 1]);
    check("pick objects in the 3D view", lens?.id === "lens1" && lens.face === "front" && det?.id === "det" && none === null, { lens, det, none });
  }

  // 14. Large run: throughput and progress reports (main thread here; the worker runs the same code).
  {
    const model = clone(singlet3d);
    model.model.sources[0].rayCount = 100000;
    let reports = 0;
    const started = performance.now();
    const r = traceScene(model, { onProgress: () => { reports++; } });
    const seconds = (performance.now() - started) / 1000;
    // (headless virtual time freezes the clock, so throughput is measured in tests/perf.html instead)
    check("large run: 100 000 rays × 3 λ completes", r.totals.raysTraced === 300000 && Math.abs(r.totals.emittedW - 1) < 1e-9,
      { seconds, raysPerSecond: Math.round(r.totals.raysTraced / seconds), segmentsPerSecond: Math.round(r.totals.segments / seconds), progressReports: reports });
  }

  // 15. Reproducibility: same seed → identical result; RNG mean ≈ 0.5.
  {
    const a = traceScene(singlet3d, { rayCountCap: 500 }), b = traceScene(singlet3d, { rayCountCap: 500 });
    const rng = createRng(3); let mean = 0; for (let i = 0; i < 100000; i++) mean += rng(); mean /= 100000;
    check("seeded runs are reproducible", JSON.stringify(a.analyses) === JSON.stringify(b.analyses) && Math.abs(mean - 0.5) < 0.005, { rngMean: mean });
  }
}
