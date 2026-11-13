import { createSchemaProjectPackage } from '../../platform/ui/widgets/model-editor/widget.js';
import { drawSceneView } from '../../platform/ui/widgets/scene-view/widget.js';
import { activeModelSchema, activateModelSchema, loadModelSchema } from './schema-documents.js';
import { raytracingIssues, rayScene, traceRays } from './js/trace.js';

const workspaceUrl = new URL('../../', import.meta.url);
const defaultDocument = () => ({
  application: 'raytracing', 'x-fullmeta-schema': '../../applications/raytracing/raytracing.schema.json',
  format: 'fullmeta-raytracing/1', metadata: { id: 'raytracing-project', name: 'Lens example' },
  model: { source: { zMm: 0, radiusMm: 1, samplesPerAxis: 5 }, lens: { zMm: 10, radiusMm: 2, focalLengthMm: 30 }, camera: { zMm: 40 } },
});
const fingerprint = document => JSON.stringify(document?.model);
const savedResultFormat = 'fullmeta-raytracing-result/1';

function restoreSavedResult(document) {
  const saved = document?.raytracingResult;
  if (saved === undefined) return { result: null, error: null };
  try {
    if (!saved || saved.format !== savedResultFormat
      || !saved.model || !Array.isArray(saved.rays) || typeof saved.completedAt !== 'string') {
      throw new Error('The saved result record is incomplete.');
    }
    const snapshot = { model: structuredClone(saved.model) };
    const issues = raytracingIssues(snapshot);
    if (issues.length) throw new Error(issues[0]);
    const isPoint = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    for (const ray of saved.rays) {
      if (!ray || !isPoint(ray.start) || !isPoint(ray.lens) || typeof ray.blocked !== 'boolean'
        || !(ray.hit === null || isPoint(ray.hit)) || (ray.blocked && ray.hit !== null) || (!ray.blocked && ray.hit === null)) {
        throw new Error('A saved ray has invalid coordinates or status.');
      }
    }
    rayScene(snapshot.model, saved.rays);
    return {
      result: {
        snapshot, fingerprint: fingerprint(snapshot), rays: structuredClone(saved.rays), completedAt: saved.completedAt,
      },
      error: null,
    };
  } catch (error) {
    return { result: null, error: error.message };
  }
}

export async function createApplicationPackage(options = {}) {
  if (options.model && options.modelLocation) await activateModelSchema(options.model, options.modelLocation);
  else if (options.schemaUrl) await loadModelSchema(options.schemaUrl, 'raytracing');
  const { schema, sources } = activeModelSchema();
  const schemaPath = decodeURIComponent(sources[0].url.pathname.slice(workspaceUrl.pathname.length));
  const modelLocation = options.modelLocation || new URL('projects/raytracing-draft/raytracing.json', workspaceUrl);
  const base = await createSchemaProjectPackage({ model: options.model || defaultDocument(), modelLocation });
  if (base.id !== 'raytracing' || base.schemaPath !== schemaPath) throw new Error('The opened model and raytracing schema do not match.');

  const restored = restoreSavedResult(options.model || defaultDocument());
  let result = restored.result, lastPreview = null, services = null, running = false;
  const modelEditorSchema = {
    ...base.modelEditorSchema,
    validateFullMetaModelWithRules(value) {
      const structural = base.modelEditorSchema.validateFullMetaModelWithRules(value);
      return structural.length ? structural : raytracingIssues(value);
    },
  };
  const ui = structuredClone(base.modelEditorUi);
  ui.projectRootFolder = 'projects';
  ui.panels = structuredClone(schema['x-fullmeta-ui-modelEditor'].panels);
  ui.emptyState = { canvasLabel: '3D ray paths', resolvedValues: 'Select an input or Study.' };

  function renderPreview(args = {}) {
    const { previewCanvas, previewContext, model: current, camera } = args;
    if (!previewCanvas || !previewContext) return;
    lastPreview = args;
    const stale = result && fingerprint(current) !== result.fingerprint;
    const shown = result ? result.snapshot.model : current?.model;
    const issues = raytracingIssues({ model: shown });
    const summary = document.querySelector('#preview-summary');
    if (summary) summary.textContent = result ? stale ? 'Previous ray paths · stale' : `${result.rays.length} rays traced · saved` : 'Ray tracing · not yet run';
    const note = document.querySelector('#geometry-note');
    if (note) note.textContent = `${stale ? 'Inputs changed; showing the previous run. Run Study again. ' : ''}Source: blue · lens: purple · camera: green · rays: gold · blocked: coral. Drag to rotate; scroll to zoom.`;
    previewCanvas.setAttribute('aria-label', stale ? '3D ray paths from previous run, stale' : '3D source, lens, camera and ray paths');
    if (issues.length) {
      const width = previewCanvas.clientWidth || 640, height = previewCanvas.clientHeight || 360;
      previewContext.clearRect(0, 0, width, height);
      previewContext.fillStyle = '#c7d9e8'; previewContext.font = '14px sans-serif';
      previewContext.fillText(issues[0], 16, 28, width - 32);
      return;
    }
    try {
      drawSceneView({ canvas: previewCanvas, context: previewContext, scene: rayScene(shown, result?.rays || []), view: camera || {} });
      if (!result || stale) {
        previewContext.fillStyle = stale ? '#ffbb78' : '#d6e4f1';
        previewContext.font = '13px sans-serif';
        previewContext.fillText(stale ? 'Previous result · stale. Run Study again.' : 'No result yet. Select Study and run it.', 14, 22);
      }
    } catch (error) {
      previewContext.fillStyle = '#ff9a86'; previewContext.font = '13px sans-serif'; previewContext.fillText(error.message, 14, 22);
    }
  }

  function mountEditorPanels({ settingsView }) {
    const panel = document.createElement('section');
    panel.id = 'raytracing-study-panel'; panel.dataset.modelEditorPanel = ''; panel.className = 'settings-panel'; panel.hidden = true;
    panel.innerHTML = '<h3 data-model-editor-panel-heading></h3><p data-model-editor-panel-note></p><div class="raytracing-study-actions" style="display:flex;gap:.5rem;flex-wrap:wrap"><button type="button" class="button primary" data-run-study>Run Study</button><button type="button" class="button" data-clear-results>Clear Results</button></div>';
    const button = panel.querySelector('[data-run-study]');
    const clearButton = panel.querySelector('[data-clear-results]');
    clearButton.disabled = !result && !restored.error;
    button.addEventListener('click', async () => {
      if (!services || running) return;
      running = true; button.disabled = true; clearButton.disabled = true;
      try {
        services.draft.commit();
        let { model, folder, file, path } = services.resolveInputs({ model: 'document.model', folder: 'document.folder', file: 'document.file', path: 'selection.path' });
        if (!Array.isArray(path) || path.length !== 1 || path[0] !== 'model') throw new Error('Select Study before running.');
        const errors = services.validation.model(model);
        services.validation.record(errors);
        if (errors.length) throw new Error(`Correct the project before running: ${errors[0]}`);
        const identity = `${folder}/${file}`, documentSnapshot = JSON.stringify(model);
        if (services.document.hasUnsavedChanges()) await services.document.save();
        ({ model, folder, file, path } = services.resolveInputs({ model: 'document.model', folder: 'document.folder', file: 'document.file', path: 'selection.path' }));
        if (`${folder}/${file}` !== identity || JSON.stringify(model) !== documentSnapshot || services.document.hasUnsavedChanges() || path?.length !== 1 || path[0] !== 'model') throw new Error('The project or selection changed while saving. Run Study again.');
        const savedModel = structuredClone(model.model), snapshot = { model: savedModel };
        const inputFingerprint = fingerprint(snapshot), rays = traceRays(snapshot);
        rayScene(savedModel, rays); // Reject non-finite display geometry before replacing a previous result.
        const completedAt = new Date().toISOString();
        const previousSavedResult = model.raytracingResult;
        model.raytracingResult = { format: savedResultFormat, completedAt, model: savedModel, rays };
        try {
          await services.document.save();
        } catch (error) {
          if (previousSavedResult === undefined) delete model.raytracingResult;
          else model.raytracingResult = previousSavedResult;
          throw new Error(`The ray trace completed, but its result could not be saved: ${error.message}`);
        }
        const current = services.resolveInputs({ model: 'document.model', folder: 'document.folder', file: 'document.file', path: 'selection.path' });
        if (`${current.folder}/${current.file}` !== identity || fingerprint(current.model) !== inputFingerprint
          || services.document.hasUnsavedChanges() || current.path?.length !== 1 || current.path[0] !== 'model') {
          throw new Error('The project or selection changed while saving the result. Run Study again.');
        }
        result = { snapshot, fingerprint: inputFingerprint, rays, completedAt };
        clearButton.disabled = false;
        services.ui.setStatus(`Ray tracing complete: ${rays.length} rays, ${rays.filter(ray => !ray.blocked).length} camera hits. Result saved with the project.`, 'good');
        if (lastPreview) renderPreview({ ...lastPreview, model });
      } catch (error) {
        services.ui.setStatus(error.message, 'error');
      } finally { running = false; button.disabled = false; clearButton.disabled = !result && !restored.error; }
    });
    clearButton.addEventListener('click', async () => {
      if (!services || running) return;
      running = true; button.disabled = true; clearButton.disabled = true;
      try {
        services.draft.commit();
        const { model, folder, file, path } = services.resolveInputs({ model: 'document.model', folder: 'document.folder', file: 'document.file', path: 'selection.path' });
        if (!Array.isArray(path) || path.length !== 1 || path[0] !== 'model') throw new Error('Select Study before clearing results.');
        if (!Object.hasOwn(model || {}, 'raytracingResult')) {
          result = null;
          clearButton.disabled = true;
          if (lastPreview) renderPreview({ ...lastPreview, model });
          return;
        }
        if (!folder || !file) throw new Error('Save the project before clearing results.');
        if (!window.confirm(`Clear the saved ray tracing result for ${folder}/${file}?`)) return;
        const identity = `${folder}/${file}`, previousSavedResult = model.raytracingResult;
        delete model.raytracingResult;
        try {
          await services.document.save();
        } catch (error) {
          model.raytracingResult = previousSavedResult;
          throw new Error(`The saved result could not be cleared: ${error.message}`);
        }
        const current = services.resolveInputs({ model: 'document.model', folder: 'document.folder', file: 'document.file', path: 'selection.path' });
        if (`${current.folder}/${current.file}` !== identity || current.path?.length !== 1 || current.path[0] !== 'model') {
          model.raytracingResult = previousSavedResult;
          throw new Error('The project or selection changed while clearing results.');
        }
        result = null;
        clearButton.disabled = true;
        services.ui.setStatus('Saved ray tracing result cleared. Project inputs are unchanged.', 'good');
        if (lastPreview) renderPreview({ ...lastPreview, model: current.model });
      } catch (error) {
        services.ui.setStatus(error.message, 'error');
      } finally {
        running = false; button.disabled = false;
        if (services) {
          const current = services.resolveInputs({ model: 'document.model' });
          clearButton.disabled = !result && !Object.hasOwn(current.model || {}, 'raytracingResult');
        } else clearButton.disabled = true;
      }
    });
    settingsView.append(panel);
    return () => { panel.remove(); services = null; result = null; lastPreview = null; };
  }

  return {
    ...base, kind: 'application', schemaPath, modelEditorUi: ui, modelEditorSchema,
    validateDocument({ value } = {}) { return modelEditorSchema.validateFullMetaModelWithRules(value); },
    scenarioDimensionForModel: () => 3,
    rootLabel: document => document?.metadata?.name || 'Raytracing',
    mountEditorPanels, renderPreview,
    actions(actionServices, bindings) {
      services = actionServices;
      const actionResult = base.actions(actionServices, bindings);
      if (restored.error) services.ui.setStatus(`Could not restore the saved ray result: ${restored.error}`, 'error');
      return actionResult;
    },
  };
}
