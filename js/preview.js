// Graphics-pane renderer: optical layout (lens bodies, surfaces, screen) plus traced rays.
import { resizeCanvasForDisplay } from "../../../platform/ui/widgets/model-editor/canvas-size.js";
import { surfacesOf, surfaceSagX, traceModel } from "./trace2d.js";

const COLORS = {
  background: "#0c141e", grid: "#16222f", axis: "#2b3d50", glass: "rgba(110, 180, 255, 0.16)",
  surface: "#8fc7ff", selected: "#ffd166", screen: "#e26976", text: "#86a4bc",
  screenRay: "#55cbb7", blocked: "#6b7f93", tir: "#f4a261", missed: "#b08cd8", native: "#ffd166",
};

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

  const surfaces = surfacesOf(document);
  const b = boundsFor(document, surfaces);
  const scale = Math.min((width - 40) / (b.xMax - b.xMin), (height - 50) / (b.yMax - b.yMin));
  const ox = 20 + ((width - 40) - scale * (b.xMax - b.xMin)) / 2 - scale * b.xMin;
  const oy = height / 2 + 6;
  const X = x => ox + scale * x, Y = y => oy - scale * y;

  // optical axis
  ctx.strokeStyle = COLORS.axis; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(b.xMin), Y(0)); ctx.lineTo(X(b.xMax), Y(0)); ctx.stroke(); ctx.setLineDash([]);

  // glass between consecutive surfaces where the medium is denser than ambient
  const ambient = Number(document.model.settings?.ambientIndex) || 1;
  for (let i = 0; i < surfaces.length - 1; i++) {
    const a = surfaces[i], c = surfaces[i + 1];
    if (a.nAfter <= ambient) continue;
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

  // rays: live browser trace, plus the last native-solver result when it matches this model
  const live = traceModel(document);
  ctx.lineWidth = 1;
  for (const ray of live.rays) {
    ctx.strokeStyle = COLORS[ray.status === "screen" ? "screenRay" : ray.status] || COLORS.missed;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ray.points.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (nativeResult?.rays) {
    ctx.strokeStyle = COLORS.native; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    for (const ray of nativeResult.rays) {
      ctx.beginPath();
      ray.points.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // best-focus marker
  const focus = live.stats.bestFocusXmm;
  if (Number.isFinite(focus) && focus > b.xMin && focus < b.xMax) {
    ctx.fillStyle = COLORS.selected; ctx.beginPath(); ctx.arc(X(focus), Y(live.stats.screenCentroidMm || 0), 3.5, 0, 2 * Math.PI); ctx.fill();
  }

  // caption
  ctx.fillStyle = COLORS.text; ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left";
  const s = live.stats;
  const parts = [`${s.raysOnScreen}/${s.rayCount} rays on screen`];
  if (Number.isFinite(s.screenRmsSpotMm)) parts.push(`RMS spot on screen ${s.screenRmsSpotMm.toFixed(4)} mm`);
  if (Number.isFinite(focus)) parts.push(`best focus x = ${focus.toFixed(3)} mm (RMS ${s.bestFocusRmsMm.toFixed(4)} mm)`);
  ctx.fillText(parts.join("  ·  "), 12, 18, width - 24);
  ctx.textAlign = "right";
  ctx.fillText(nativeResult ? "solid: live preview · dashed: native solver" : "live preview (units: mm)", width - 12, height - 10);
}
