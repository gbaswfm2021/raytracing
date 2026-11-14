// Graphics-pane renderer: optical layout (lens bodies, surfaces, screen) plus traced rays, coloured by wavelength.
import { resizeCanvasForDisplay } from "../../../platform/ui/widgets/model-editor/canvas-size.js";
import { refractiveIndex } from "./materials.js";
import { resolveModel, surfaceSagX, traceModel } from "./trace2d.js";

const COLORS = {
  background: "#0c141e", axis: "#2b3d50", glass: "rgba(110, 180, 255, 0.16)",
  surface: "#8fc7ff", selected: "#ffd166", screen: "#e26976", text: "#86a4bc", error: "#e26976",
  blocked: "#6b7f93", native: "#ffd166",
};
const fmt = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : "–");

function boundsFor(document, surfaces) {
  const m = document?.model || {};
  const xs = [Number(m.source?.x) || 0, Number(m.screen?.x) || 0, ...surfaces.map(s => s.x)];
  const ys = [Math.abs(Number(m.source?.y) || 0) + (Number(m.source?.width) || 0) / 2,
    (Number(m.screen?.height) || 0) / 2, ...surfaces.map(s => s.semiAperture)];
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMax = Math.max(1, ...ys);
  const padX = Math.max(2, (xMax - xMin) * 0.06);
  return { xMin: xMin - padX, xMax: xMax + padX, yMin: -yMax * 1.25, yMax: yMax * 1.25 };
}

export function drawRaytracePreview({ previewCanvas, previewContext, model: document, selectedPath: rawPath, nativeResult = null } = {}) {
  if (!previewCanvas || !previewContext) return;
  const selectedPath = Array.isArray(rawPath) ? rawPath : [];
  const ctx = previewContext;
  const { width, height } = resizeCanvasForDisplay(previewCanvas, ctx);
  ctx.fillStyle = COLORS.background; ctx.fillRect(0, 0, width, height);
  if (!document?.model) return;

  let resolved, live;
  try {
    resolved = resolveModel(document);
    live = traceModel(document);
  } catch (error) {
    ctx.fillStyle = COLORS.error; ctx.font = "13px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`Cannot trace: ${error.message}`, width / 2, height / 2, width - 32);
    return;
  }
  const { surfaces, ambient } = resolved;
  const primary = resolved.wavelengths.find(w => w.id === resolved.primaryId);

  const b = boundsFor(document, surfaces);
  const scale = Math.min((width - 40) / (b.xMax - b.xMin), (height - 50) / (b.yMax - b.yMin));
  const ox = 20 + ((width - 40) - scale * (b.xMax - b.xMin)) / 2 - scale * b.xMin;
  const oy = height / 2 + 6;
  const X = x => ox + scale * x, Y = y => oy - scale * y;

  // optical axis
  ctx.strokeStyle = COLORS.axis; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(b.xMin), Y(0)); ctx.lineTo(X(b.xMax), Y(0)); ctx.stroke(); ctx.setLineDash([]);

  // glass between consecutive surfaces where the medium (at the primary wavelength) is denser than ambient
  const nAmbient = refractiveIndex(ambient, primary.lambdaNm);
  for (let i = 0; i < surfaces.length - 1; i++) {
    const a = surfaces[i], c = surfaces[i + 1];
    if (refractiveIndex(a.material, primary.lambdaNm) <= nAmbient) continue;
    const h = Math.min(a.semiAperture, c.semiAperture), steps = 40;
    ctx.beginPath();
    for (let k = 0; k <= steps; k++) { const y = -h + (2 * h * k) / steps; const x = surfaceSagX(a, y) ?? a.x; k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); }
    for (let k = steps; k >= 0; k--) { const y = -h + (2 * h * k) / steps; ctx.lineTo(X(surfaceSagX(c, y) ?? c.x), Y(y)); }
    ctx.closePath(); ctx.fillStyle = COLORS.glass; ctx.fill();
  }

  // surfaces
  const selectedIndex = selectedPath[0] === "model" && selectedPath[1] === "surfaces" ? Number(selectedPath[2]) : -1;
  for (const s of surfaces) {
    ctx.strokeStyle = s.index === selectedIndex ? COLORS.selected : COLORS.surface;
    ctx.lineWidth = s.index === selectedIndex ? 2.5 : 1.5;
    ctx.beginPath();
    const steps = 60;
    for (let k = 0; k <= steps; k++) {
      const y = -s.semiAperture + (2 * s.semiAperture * k) / steps;
      const x = surfaceSagX(s, y) ?? s.x;
      k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y));
    }
    ctx.stroke();
  }

  // screen
  const screenX = Number(document.model.screen?.x) || 0, half = (Number(document.model.screen?.height) || 0) / 2;
  const screenSelected = selectedPath[1] === "screen";
  ctx.strokeStyle = screenSelected ? COLORS.selected : COLORS.screen; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(screenX), Y(-half)); ctx.lineTo(X(screenX), Y(half)); ctx.stroke();

  // rays: live browser trace coloured by wavelength (blocked / TIR rays dimmed), plus a matching native result dashed.
  // A selected wavelength in the tree is drawn on top at full strength; the others fade.
  const colorOf = Object.fromEntries(live.wavelengths.map(w => [w.id, w.color]));
  const selectedWavelength = selectedPath[1] === "wavelengths" ? document.model.wavelengths?.[Number(selectedPath[2])]?.id : null;
  const order = [...live.rays].sort((r1, r2) => (r1.wavelength === selectedWavelength) - (r2.wavelength === selectedWavelength));
  ctx.lineWidth = 1;
  ctx.globalCompositeOperation = "lighter";   // additive: coincident F/d/C rays add towards white, separated ones show colour
  for (const ray of order) {
    const ok = ray.status === "screen";
    ctx.strokeStyle = ray.status === "blocked" ? COLORS.blocked : colorOf[ray.wavelength] || COLORS.text;
    ctx.globalAlpha = (selectedWavelength && ray.wavelength !== selectedWavelength ? 0.25 : 0.85) * (ok ? 1 : 0.6);
    ctx.beginPath();
    ray.points.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (nativeResult?.rays) {
    ctx.strokeStyle = COLORS.native; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    for (const ray of nativeResult.rays) {
      ctx.beginPath();
      ray.points.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // best-focus marker per wavelength
  for (const w of live.wavelengths) {
    const focus = w.stats.bestFocusXmm;
    if (!Number.isFinite(focus) || focus <= b.xMin || focus >= b.xMax) continue;
    ctx.fillStyle = w.color; ctx.strokeStyle = COLORS.background; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(X(focus), Y(w.stats.screenCentroidMm || 0), 3.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }

  // caption: one line per wavelength (at most 6; a spectrum split into bins can have many), then the chromatic summary
  ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left";
  let y = 18;
  const MAX_LINES = 6;
  const shown = live.wavelengths.length <= MAX_LINES ? live.wavelengths
    : [...live.wavelengths.filter(w => w.id === live.primaryWavelength), ...live.wavelengths.filter(w => w.id !== live.primaryWavelength)].slice(0, MAX_LINES - 1);
  for (const w of shown) {
    const s = w.stats;
    ctx.fillStyle = w.color;
    ctx.fillText(`${w.label} ${fmt(w.lambdaNm, 1)} nm${w.id === live.primaryWavelength ? " (primary)" : ""}  ·  ${s.raysOnScreen}/${s.rayCount} on screen  ·  RMS ${fmt(s.screenRmsSpotMm, 4)} mm  ·  best focus ${fmt(s.bestFocusXmm, 3)} mm  ·  paraxial ${fmt(s.paraxialFocusXmm, 3)} mm`, 12, y, width - 24);
    y += 15;
  }
  if (shown.length < live.wavelengths.length) {
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`… and ${live.wavelengths.length - shown.length} more wavelengths`, 12, y, width - 24);
    y += 15;
  }
  const shift = live.stats.chromaticFocalShiftMm || {};
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`F–C focal shift: paraxial ${fmt(shift.paraxialFC, 4)} mm, best focus ${fmt(shift.bestFocusFC, 4)} mm  ·  polychromatic RMS on screen ${fmt(live.stats.polychromaticRmsSpotMm, 4)} mm`, 12, y, width - 24);
  y += 15;
  ctx.fillStyle = COLORS.selected;
  for (const warning of live.warnings.slice(0, 3)) { ctx.fillText(`⚠ ${warning}`, 12, y, width - 24); y += 15; }
  ctx.fillStyle = COLORS.text; ctx.textAlign = "right";
  ctx.fillText(nativeResult ? "solid: live preview · dashed: native solver" : "live preview (units: mm)", width - 12, height - 10);
}
