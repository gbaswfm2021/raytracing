// FullMeta "raytrace" application package.
//
// Strategy: reuse the platform's generic schema-project editor (tree, settings forms, save,
// validate are all driven by raytrace.schema.json) and add the ray-tracing specific parts:
//   * renderPreview      -> optical layout + live rays (js/preview.js, js/trace2d.js)
//   * mountEditorPanels  -> "Run native solver" panel (js/run-panel.js) calling the kernel
//   * launcher profile + createModelDocument so "Create project" works from the Workspace page
import { createSchemaProjectPackage } from "../../platform/ui/widgets/model-editor/schema-project-package.js";
import { drawRaytracePreview } from "./js/preview.js";
import { createRunPanel } from "./js/run-panel.js";

const templateUrl = new URL("./templates/lens-2d.json", import.meta.url);

// Workaround for a platform bug (this build): schema-project-package.js line 138 calls an
// undefined `isRecord` helper, so every schema-driven project throws "isRecord is not defined".
// An unresolved identifier in an ES module falls back to globalThis, so supplying it here fixes
// it without editing platform files. Remove once the platform defines the helper itself.
if (typeof globalThis.isRecord !== "function") {
  globalThis.isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadTemplate() {
  const response = await fetch(templateUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the raytrace project template (${response.status}).`);
  return response.json();
}

export async function createApplicationPackage({ model, modelLocation } = {}) {
  let template = null;
  if (!model || !modelLocation) {
    // Workspace launcher: no project is open, so build the package from the bundled template.
    template = await loadTemplate();
    model = template;
    modelLocation = templateUrl;
  }
  const base = await createSchemaProjectPackage({ model, modelLocation });
  template ||= await loadTemplate();
  // The generic package ships uiProfileSchema: {}, but the editor reads
  // uiProfileSchema.properties.behavior.properties.tree (runtime.js treeUiSetting), so load the
  // shared FullMeta UI profile schema (the same file the FEM app uses).
  const uiProfileResponse = await fetch(new URL("../../platform/ui/widgets/model-editor/fullmeta-ui-profile-1.schema.json", import.meta.url), { cache: "no-store" });
  if (!uiProfileResponse.ok) throw new Error(`Could not load the shared UI profile schema (${uiProfileResponse.status}).`);
  const uiProfileSchema = await uiProfileResponse.json();

  let lastPreviewArgs = null;
  let latestModel = null;
  let nativeResult = null;
  let nativeResultKey = null;
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
      if (lastPreviewArgs) render(lastPreviewArgs);
    },
  });

  function render(args) {
    lastPreviewArgs = args;
    latestModel = args.model;
    const current = nativeResult && nativeResultKey === modelKey(args.model) ? nativeResult : null;
    drawRaytracePreview({ ...args, nativeResult: current });
  }

  const profile = {
    id: "lens-2d", name: "2D lens system", status: "available",
    description: "Sequential refracting surfaces along the optical axis, collimated or point source.",
  };

  return {
    ...base,
    manifest: { ...base.manifest, name: base.modelSchema.title || "Ray Tracing" },
    uiProfileSchema,
    renderPreview: render,
    mountEditorPanels({ settingsView }) { runPanel.mount(settingsView); },
    launcher: {
      name: base.modelSchema.title || "Ray Tracing",
      description: base.modelSchema.description || "",
      profiles: [profile],
      defaultProfileId: profile.id,
    },
    createModelDocument({ modelId, folder }) {
      const document = structuredClone(template);
      const depth = String(folder || "projects/x").split("/").filter(Boolean).length;
      document["x-fullmeta-schema"] = `${"../".repeat(depth)}applications/raytrace/raytrace.schema.json`;
      document.metadata = { ...document.metadata, id: modelId, name: modelId };
      return document;
    },
  };
}
