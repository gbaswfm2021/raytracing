// Editor wiring checks: drive package.js the way the model editor does (tree menus, insertions,
// reference dropdowns, schema validation) without clicking. Run by tests/run.html.
import { createApplicationPackage } from "../package.js";
import { configureModelSchema } from "../../../platform/model-rust/js/api.js";

const base = new URL("../", import.meta.url);
const getJson = async path => (await fetch(new URL(path, base), { cache: "no-store" })).json();

export async function runEditorChecks(check) {
  const doubletPath = "samples/raytrace_achromat_doublet/raytrace_model.json";
  const doublet = await getJson(doubletPath);
  // The sample's schema path is relative to projects/<name>/, so open it from there.
  const modelLocation = new URL(`../../projects/raytrace_achromat_doublet/raytrace_model.json`, base);
  const pkg = await createApplicationPackage({ model: doublet, modelLocation });
  let counter = 0;
  const plans = pkg.treeActionPlans({
    model: doublet, catalogs: pkg.treeActionCatalogs().catalogs,
    makeId: stem => `${stem}_${++counter}`, makeName: (_path, name) => name,
  });

  const materials = plans.menuTarget(null, ["model", "materials"]);
  const materialMenu = plans.menuEntries(materials).map(e => e.label).filter(Boolean);
  check("materials menu lists library + custom", materialMenu.some(l => l.includes("N-BK7")) && materialMenu.some(l => l.includes("Calcium fluoride"))
    && materialMenu.includes("Add custom material"), { materialMenu });
  const bk7 = plans.insertionForAction("add-library-material:N-BK7", materials)?.item;
  check("library N-BK7 copy gets a free id", bk7?.id === "N-BK7-2" && bk7?.formula === "sellmeier" && bk7?.B?.length === 3, { bk7 });
  const caf2 = plans.insertionForAction("add-library-material:CaF2", materials)?.item;
  check("library CaF2 copy keeps its id", caf2?.id === "CaF2", { id: caf2?.id });
  const custom = plans.insertionForAction("add-material", materials)?.item;
  check("custom material template", custom && custom.formula === "constant" && custom.n === 1.5 && !("B" in custom) && typeof custom.id === "string", { custom });

  const waves = plans.menuTarget(null, ["model", "wavelengths"]);
  const e = plans.insertionForAction("add-spectral-line:e", waves)?.item;
  const f2 = plans.insertionForAction("add-spectral-line:F", waves)?.item;
  check("spectral line presets", e?.id === "e" && e?.lambdaNm === 546.074 && f2?.id === "F-2", { e, f2 });
  const customWave = plans.insertionForAction("add-wavelength", waves)?.item;
  check("custom wavelength template", customWave?.lambdaNm === 550 && customWave?.weight === 1, { customWave });

  const surface = plans.insertionForAction("add-surface", plans.menuTarget(null, ["model", "surfaces"]))?.item;
  check("new surface uses materialAfter, not nAfter", surface?.materialAfter === "" && !("nAfter" in surface), { surface });

  const reference = pkg.modelSchema.$defs.surface.properties.materialAfter["x-fullmeta-modelReference"];
  const options = pkg.referenceOptions({ reference, currentValue: "N-BK7", fieldLabel: "Material after surface", model: doublet });
  check("materialAfter dropdown", options?.[0]?.label === "Ambient medium" && ["air", "N-BK7", "N-SF11"].every(id => options.some(o => o.value === id)),
    { options: options?.map(o => `${o.value}: ${o.label}`) });

  // The editor configures the WASM model contract with the active schema before validating; do the same.
  configureModelSchema(pkg.modelSchema, pkg.schemaDocuments || []);
  for (const path of [doubletPath, "samples/raytrace_singlet_bk7/raytrace_model.json", "samples/raytrace_biconvex_lens/raytrace_model.json", "templates/lens-2d.json"]) {
    const issues = await pkg.validateDocument({ value: await getJson(path) });
    const list = Array.isArray(issues) ? issues : issues?.errors || issues?.issues || [];
    check(`schema validation: ${path}`, list.length === 0, { issues: list.slice(0, 5) });
  }

  // ---- 3D project (raytrace3d.schema.json) ----
  const splitter = await getJson("samples/raytrace3d_beam_splitter/raytrace_model.json");
  const pkg3 = await createApplicationPackage({ model: splitter, modelLocation: new URL("../../projects/raytrace3d_beam_splitter/raytrace_model.json", base) });
  check("3D package uses the 3D schema", pkg3.modelSchema.$id.endsWith("raytrace3d.schema.json") && pkg3.launcher.profiles.length === 2, { id: pkg3.modelSchema.$id });
  const plans3 = pkg3.treeActionPlans({ model: splitter, catalogs: pkg3.treeActionCatalogs().catalogs,
    cloneItem: item => ({ ...structuredClone(item), id: `${item.id}_copy` }),   // the editor passes cloneWithUniqueIds
    makeId: stem => `${stem}_${++counter}`, makeName: (_path, name) => name });
  const objects = plans3.menuTarget(null, ["model", "objects"]);
  const objectMenu = plans3.menuEntries(objects).map(e => e.label);
  const lens = plans3.insertionForAction("add-lens", objects)?.item;
  const plate = plans3.insertionForAction("add-plate", objects)?.item;
  check("3D objects menu and templates", objectMenu.includes("Add Lens") && lens?.kind === "lens" && lens?.lens?.diameter === 25
    && typeof lens.id === "string" && plate?.kind === "plate", { objectMenu, lens, plate });
  const mirrorProp = plans3.insertionForAction("add-prop-mirror", plans3.menuTarget(null, ["model", "surfaceProperties"]))?.item;
  const pointSource = plans3.insertionForAction("add-point-source", plans3.menuTarget(null, ["model", "sources"]))?.item;
  const irr = plans3.insertionForAction("add-irradiance", plans3.menuTarget(null, ["model", "analyses"]))?.item;
  check("3D surface property / source / analysis templates", mirrorProp?.kind === "mirror" && pointSource?.point?.coneHalfAngleDeg === 10
    && irr?.kind === "irradiance", { mirrorProp, pointSource, irr });
  const lib3 = plans3.insertionForAction("add-library-material:N-BK7", plans3.menuTarget(null, ["model", "materials"]))?.item;
  check("3D material library menu", lib3?.id === "N-BK7", { id: lib3?.id });
  // Right-click on an item: Duplicate / Rename / Delete (wavelengths: no Rename); duplicate gets a new id.
  const itemTarget = plans3.menuTarget(["model", "objects", 1], null);
  const itemMenu = plans3.menuEntries(itemTarget).map(e => e.action).filter(Boolean);
  const waveMenu = plans3.menuEntries(plans3.menuTarget(["model", "wavelengths", 0], null)).map(e => e.action).filter(Boolean);
  const dup = plans3.insertionForAction("duplicate-item", itemTarget);
  check("item menu: duplicate / rename / delete", ["duplicate-item", "rename", "delete"].every(a => itemMenu.includes(a))
    && !itemMenu.includes("add-lens") && waveMenu.includes("delete") && !waveMenu.includes("rename")
    && dup?.item?.kind === splitter.model.objects[1].kind && dup.item.id !== splitter.model.objects[1].id && dup.afterIndex === 1,
    { itemMenu, waveMenu, duplicateId: dup?.item?.id, afterIndex: dup?.afterIndex });
  const sunSource = plans3.insertionForAction("add-sun-source", plans3.menuTarget(null, ["model", "sources"]))?.item;
  const prismObj = plans3.insertionForAction("add-prism", objects)?.item;
  check("sunlight source and prism templates", sunSource?.spectrum?.kind === "blackbody" && sunSource?.grid?.divergenceHalfAngleDeg === 0.267
    && prismObj?.prism?.apexAngleDeg === 60, { sunSource, prismObj });
  const twoD = plans.menuEntries(plans.menuTarget(["model", "surfaces", 0], null)).map(e => e.action).filter(Boolean);
  check("2D item menu has delete", twoD.includes("delete") && twoD.includes("duplicate-item"), { twoD });

  const created = pkg3.createModelDocument({ modelId: "new3d", profileId: "nonseq-3d", folder: "projects/new3d" });
  check("Create project: 3D profile", created.modelFormat === "raytrace3d-model/1" && created["x-fullmeta-schema"] === "../../applications/raytrace/raytrace3d.schema.json",
    { modelFormat: created.modelFormat, schema: created["x-fullmeta-schema"] });

  configureModelSchema(pkg3.modelSchema, pkg3.schemaDocuments || []);
  for (const path of ["samples/raytrace3d_singlet/raytrace_model.json", "samples/raytrace3d_parabolic_mirror/raytrace_model.json", "samples/raytrace3d_sunlight_prism/raytrace_model.json",
    "samples/raytrace3d_beam_splitter/raytrace_model.json", "templates/nonseq-3d.json"]) {
    const issues = await pkg3.validateDocument({ value: await getJson(path) });
    const list = Array.isArray(issues) ? issues : issues?.errors || issues?.issues || [];
    check(`schema validation: ${path}`, list.length === 0, { issues: list.slice(0, 5) });
  }
}
