// FullMeta "raytrace" application package.
//
// Strategy: reuse the platform's generic schema-project editor (tree, settings forms, save,
// validate are all driven by raytrace.schema.json) and add the ray-tracing specific parts:
//   * renderPreview      -> optical layout + live rays (js/preview.js, js/trace2d.js)
//   * mountEditorPanels  -> "Run native solver" panel (js/run-panel.js) calling the kernel
//   * launcher profile + createModelDocument so "Create project" works from the Workspace page
//   * tree catalogs      -> "Add material from library" (materials/library.json) and spectral-line presets
//   * editor layout      -> Settings in its own column next to the tree, results under the graphics (js/layout.js)
//   * 3D projects (modelFormat raytrace3d-model/1, raytrace3d.schema.json) -> js/app3d.js: WebGL view,
//     trace in a background worker (js/trace3d-worker.js -> js/trace3d.js), results panel
import { createSchemaProjectPackage } from "../../platform/ui/widgets/model-editor/schema-project-package.js";
import { createSchemaTreeActionPlans } from "../../platform/ui/widgets/tree/widget.js";
import { drawRaytracePreview } from "./js/preview.js";
import { createRunPanel } from "./js/run-panel.js";
import { createApp3D } from "./js/app3d.js";
import { applyRaytraceLayout } from "./js/layout.js";

const templateUrl = new URL("./templates/lens-2d.json", import.meta.url);
const libraryUrl = new URL("./materials/library.json", import.meta.url);

// Wavelength presets offered by right-click on Wavelengths (vacuum wavelengths, nm).
const SPECTRAL_LINES = [
  ["h", 404.6561, "mercury violet"], ["g", 435.8343, "mercury blue"], ["F", 486.1327, "hydrogen blue"],
  ["e", 546.0740, "mercury green"], ["d", 587.5618, "helium yellow"], ["C", 656.2725, "hydrogen red"],
  ["r", 706.5188, "helium red"],
];

async function loadLibrary() {
  const response = await fetch(libraryUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the raytrace material library (${response.status}).`);
  const library = await response.json();
  return Array.isArray(library.materials) ? library.materials : [];
}

/** First id not used in the collection: base, base-2, base-3, … */
function freeId(collection, base) {
  const used = new Set((Array.isArray(collection) ? collection : []).map(item => item?.id));
  let id = base, k = 2;
  while (used.has(id)) id = `${base}-${k++}`;
  return id;
}

// Workaround for a platform bug (this build): schema-project-package.js line 138 calls an
// undefined `isRecord` helper, so every schema-driven project throws "isRecord is not defined".
// An unresolved identifier in an ES module falls back to globalThis, so supplying it here fixes
// it without editing platform files. Remove once the platform defines the helper itself.
if (typeof globalThis.isRecord !== "function") {
  globalThis.isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
}

const template3dUrl = new URL("./templates/nonseq-3d.json", import.meta.url);

async function loadJson(url, what) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the raytrace ${what} (${response.status}).`);
  return response.json();
}
const loadTemplate = () => loadJson(templateUrl, "project template");

/** 3D non-sequential projects use raytrace3d.schema.json and the 3D editor integration (js/app3d.js). */
const is3dModel = document => String(document?.modelFormat || "").startsWith("raytrace3d-model/");

export async function createApplicationPackage({ model, modelLocation } = {}) {
  if (!model || !modelLocation) {
    // Workspace launcher: no project is open, so build the package from the bundled 2D template.
    model = await loadTemplate();
    modelLocation = templateUrl;
  }
  const base = await createSchemaProjectPackage({ model, modelLocation });
  const [template, template3d] = await Promise.all([loadTemplate(), loadJson(template3dUrl, "3D project template")]);
  // The generic package ships uiProfileSchema: {}, but the editor reads
  // uiProfileSchema.properties.behavior.properties.tree (runtime.js treeUiSetting), so load the
  // shared FullMeta UI profile schema (the same file the FEM app uses).
  const uiProfileSchema = await loadJson(new URL("../../platform/ui/widgets/model-editor/fullmeta-ui-profile-1.schema.json", import.meta.url), "shared UI profile schema");
  const library = await loadLibrary();

  // Tree catalogs: each entry becomes a context-menu item; the matching insertion's factory gets it as catalogEntry.
  const catalogs = {
    materialLibrary: library.map(material => ({
      action: `add-library-material:${material.id}`, label: `Add ${material.name} (library)`, material,
    })),
    spectralLines: SPECTRAL_LINES.map(([id, lambdaNm, what]) => ({
      action: `add-spectral-line:${id}`, label: `Add ${id} line (${lambdaNm} nm, ${what})`, line: { id, lambdaNm },
    })),
  };
  const collectionAt = (document, path) => path.reduce((value, part) => value?.[part], document);
  const itemFactories = {
    ...base.editorFactories,
    libraryMaterial({ model: document, destinationPath, catalogEntry }) {
      const material = structuredClone(catalogEntry.material);
      material.id = freeId(collectionAt(document, destinationPath), material.id);
      return material;
    },
    spectralLine({ model: document, destinationPath, catalogEntry }) {
      const { id, lambdaNm } = catalogEntry.line;
      return { id: freeId(collectionAt(document, destinationPath), id), label: id, lambdaNm, weight: 1 };
    },
  };

  // Editor integration: 2D (live preview + native solver panel) or 3D (WebGL view + worker trace + results panel).
  let renderPreview, mountEditorPanels;
  if (is3dModel(model)) {
    const app3d = createApp3D();
    renderPreview = args => app3d.renderPreview(args);
    mountEditorPanels = ({ settingsView }) => app3d.mountPanel(applyRaytraceLayout(settingsView, "Illumination results"));
  } else {
    let lastPreviewArgs = null, latestModel = null, nativeResult = null, nativeResultKey = null;
    const modelKey = document => JSON.stringify(document?.model ?? null);
    const runtime = base.modelSchema["x-fullmeta-runtime"];
    const runPanel = createRunPanel({
      route: runtime.editorApi.traceRun.route,
      applicationId: base.id,
      schemaPath: base.schemaPath,
      getModel: () => latestModel,
      onResult(result) {
        nativeResult = result;
        nativeResultKey = modelKey(latestModel);
        if (lastPreviewArgs) renderPreview(lastPreviewArgs);
      },
    });
    renderPreview = args => {
      lastPreviewArgs = args;
      latestModel = args.model;
      const current = nativeResult && nativeResultKey === modelKey(args.model) ? nativeResult : null;
      drawRaytracePreview({ ...args, nativeResult: current });
    };
    mountEditorPanels = ({ settingsView }) => runPanel.mount(applyRaytraceLayout(settingsView, "Solver results"));
  }

  const profiles = [
    { id: "lens-2d", name: "2D lens system", status: "available",
      description: "Sequential refracting surfaces along the optical axis, dispersive materials, several wavelengths." },
    { id: "nonseq-3d", name: "3D non-sequential", status: "available",
      description: "Solid lenses, blocks, mirrors and detectors in 3D; Fresnel splitting, irradiance maps, flux report." },
  ];

  return {
    ...base,
    manifest: { ...base.manifest, name: "Ray Tracing" },
    uiProfileSchema,
    editorFactories: itemFactories,
    treeActionCatalogs: () => ({ catalogs }),
    treeActionPlans(context) {
      return createSchemaTreeActionPlans({ ...context, descriptor: base.modelSchema["x-fullmeta-ui-tree"], itemFactories });
    },
    renderPreview,
    mountEditorPanels,
    launcher: {
      name: "Ray Tracing",
      description: "2D lens design with dispersion, and 3D non-sequential ray tracing.",
      profiles,
      defaultProfileId: profiles[0].id,
    },
    createModelDocument({ modelId, profileId, folder }) {
      const threeD = profileId === "nonseq-3d";
      const document = structuredClone(threeD ? template3d : template);
      const depth = String(folder || "projects/x").split("/").filter(Boolean).length;
      document["x-fullmeta-schema"] = `${"../".repeat(depth)}applications/raytrace/${threeD ? "raytrace3d" : "raytrace"}.schema.json`;
      document.metadata = { ...document.metadata, id: modelId, name: modelId };
      return document;
    },
  };
}
