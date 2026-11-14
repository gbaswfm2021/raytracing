// Stage 1 acceptance checks for the JS tracer (run by tests/run.html).
import { LINES, abbeData, refractiveIndex } from "../js/materials.js";
import { traceModel } from "../js/trace2d.js";
import { runEditorChecks } from "./editor-checks.js";
import { runChecks3d } from "./checks3d.js";

const base = new URL("../", import.meta.url);
const getJson = async path => {
  const response = await fetch(new URL(path, base), { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};

export async function runChecks() {
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  // 1. Library coefficients reproduce the catalogue nd (and νd where the catalogue gives it).
  const library = await getJson("materials/library.json");
  const catalogue = { "N-BK7": [1.5168, 64.17], "N-SF11": [1.78472, 25.68], "fused-silica": [1.4585, 67.8], "CaF2": [1.4338, 95.0] };
  for (const [id, [nd, vd]] of Object.entries(catalogue)) {
    const m = library.materials.find(entry => entry.id === id);
    const a = abbeData(m);
    check(`${id} nd`, Math.abs(a.nd - nd) < 2e-4, { computed: a.nd, catalogue: nd });
    check(`${id} vd`, Math.abs(a.abbeVd - vd) < 0.3, { computed: a.abbeVd, catalogue: vd });
  }
  const air = library.materials.find(entry => entry.id === "air-ciddor");
  const nAir = refractiveIndex(air, LINES.d);
  check("Ciddor air nd", Math.abs((nAir - 1) * 1e4 - 2.77) < 0.03, { computed: nAir });

  // 2. raytrace-model/1 back-compatibility: the old biconvex sample still traces, same best focus as before.
  const v1 = await getJson("samples/raytrace_biconvex_lens/raytrace_model.json");
  const r1 = traceModel(v1);
  check("v1 sample best focus 51.901 mm", Math.abs(r1.wavelengths[0].stats.bestFocusXmm - 51.901) < 5e-4,
    { bestFocusXmm: r1.wavelengths[0].stats.bestFocusXmm, schema: r1.schema });

  // 3. Singlet vs achromatic doublet: F–C paraxial focal shift.
  const singlet = traceModel(await getJson("samples/raytrace_singlet_bk7/raytrace_model.json"));
  const doublet = traceModel(await getJson("samples/raytrace_achromat_doublet/raytrace_model.json"));
  const sShift = singlet.stats.chromaticFocalShiftMm.paraxialFC, dShift = doublet.stats.chromaticFocalShiftMm.paraxialFC;
  // paraxialFocusXmm is a position; back focal distance = focus − last vertex (≈ f minus the principal-plane offset).
  const sBfd = singlet.wavelengths.find(w => w.id === "d").stats.paraxialFocusXmm - 5;
  const dBfd = doublet.wavelengths.find(w => w.id === "d").stats.paraxialFocusXmm - 9;
  check("singlet back focal distance ≈ 100 mm", Math.abs(sBfd - 100) < 5, { backFocalDistanceMm_d: sBfd });
  check("doublet back focal distance ≈ 100 mm", Math.abs(dBfd - 100) < 5, { backFocalDistanceMm_d: dBfd });
  const vd = abbeData(library.materials.find(entry => entry.id === "N-BK7")).abbeVd;
  check("singlet F–C shift ≈ −f/νd", Math.abs(Math.abs(sShift) - 100 / vd) < 0.25, { paraxialFC: sShift, expected: -100 / vd });
  check("doublet shift < singlet/10", Math.abs(dShift) < Math.abs(sShift) / 10, { doublet: dShift, singlet: sShift });
  check("result shape", singlet.schema === "raytrace-result/2" && singlet.rays.length === 3 * 11
    && singlet.materials.length > 0 && Array.isArray(singlet.warnings), { rays: singlet.rays.length });

  // 3D engine (Stage 2, phase 3a).
  try { await runChecks3d(check); } catch (error) { check("3D checks ran", false, { error: String(error?.stack || error) }); }

  // 4. Editor wiring (tree menus, insertions, dropdowns, schema validation).
  try { await runEditorChecks(check); } catch (error) { check("editor checks ran", false, { error: String(error?.stack || error) }); }

  return { checks, singlet: singlet.stats, doublet: doublet.stats, singletWavelengths: singlet.wavelengths.map(w => w.stats),
    doubletWavelengths: doublet.wavelengths.map(w => w.stats), warnings: [...singlet.warnings, ...doublet.warnings] };
}
