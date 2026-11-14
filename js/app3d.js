// 3D editor integration: live preview (capped ray count) and full traces in a worker, the WebGL view in the
// graphics pane, and a results panel (totals, irradiance maps, flux report) in the settings pane.
import { compileScene, pickObject, tessellateScene, traceScene } from "./trace3d.js";
import { createViewer } from "./view3d.js";
import { srgbByte, xyzToLinearSrgb } from "./spectra.js";

const fmt = (value, digits = 4) => (Number.isFinite(value) ? (Math.abs(value) >= 1e4 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(3) : value.toFixed(digits)) : "–");
const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// Display colours by surface property kind (RGBA, 0–1).
const MESH_COLORS = {
  glass: [0.47, 0.75, 1, 0.22], mirror: [0.85, 0.87, 0.9, 0.85], absorber: [0.24, 0.25, 0.28, 0.9],
  table: [0.7, 0.55, 1, 0.45], detector: [1, 0.55, 0.35, 0.85], selected: [1, 0.82, 0.4, 0.75],
};

/** Perceptual-ish false colour (dark blue → magenta → orange → light yellow) for t in [0, 1]. */
function falseColor(t) {
  const stops = [[0, [13, 8, 40]], [0.25, [84, 15, 109]], [0.5, [187, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]]];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], f = (t - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return stops.at(-1)[1];
}

/**
 * One background tracer: a module worker with a fallback to the main thread if it cannot start (no handshake
 * within 2.5 s, or an error). Requests wait until the worker's ready message, because a module worker sets its
 * message handler only after its imports load and earlier messages are lost. cancel() terminates the worker
 * (answering the running request with an error) and starts a fresh one.
 */
function createTracer(disabled) {
  let worker = null, mode = "starting", requestId = 0;
  const pending = new Map(), queued = [];
  const onMainThread = (document, options) => new Promise(resolve => setTimeout(() => {
    try { resolve({ result: traceScene(document, { ...options, progress: undefined }) }); } catch (error) { resolve({ error: error.message }); }
  }, 0));
  const fallBack = () => {
    if (mode === "main") return;
    mode = "main";
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    for (const [id, p] of pending) { pending.delete(id); onMainThread(p.document, p.options).then(p.resolve); }
  };
  const start = () => {
    mode = "starting";
    try {
      if (disabled) throw new Error("worker disabled");
      worker = new Worker(new URL("./trace3d-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = event => {
        const data = event.data || {};
        if (data.ready) { mode = "worker"; for (const message of queued.splice(0)) worker.postMessage(message); return; }
        const p = pending.get(data.id);
        if (!p) return;
        if (data.progress !== undefined) { p.onProgress?.(data.progress); return; }
        pending.delete(data.id); p.resolve(data);
      };
      worker.onerror = fallBack;
      setTimeout(() => { if (mode === "starting") fallBack(); }, 2500);
    } catch { fallBack(); }
  };
  start();
  return {
    get mode() { return mode; },
    run(document, options = {}, onProgress) {
      return new Promise(resolve => {
        if (mode === "main") { onMainThread(document, options).then(resolve); return; }
        const id = ++requestId, message = { id, document, options: { ...options, progress: Boolean(onProgress) } };
        pending.set(id, { resolve, onProgress, document, options });
        if (mode === "worker") worker.postMessage(message); else queued.push(message);
      });
    },
    cancel() {
      if (mode === "main") return false;                        // a main-thread trace cannot be interrupted
      try { worker?.terminate(); } catch { /* already gone */ }
      for (const [id, p] of pending) { pending.delete(id); p.resolve({ error: "Trace cancelled." }); }
      queued.length = 0;
      start();
      return true;
    },
  };
}

export function createApp3D() {
  // Background tracing with a main-thread fallback (see createTracer).
  // Diagnostic switch: localStorage "raytraceWorker" = "off" traces on the main thread. tests/open-main-thread.html
  // sets it; it is used for headless screenshots, whose virtual clock runs out before a worker finishes.
  // (A URL parameter can't be used: the editor loader drops unknown query parameters.)
  let workerDisabled = false;
  try { workerDisabled = globalThis.localStorage?.getItem("raytraceWorker") === "off"; } catch { /* storage blocked */ }
  // Two workers: live previews never wait behind a long full trace, and Cancel restarts only the full-trace one.
  const previewTracer = createTracer(workerDisabled), fullTracer = createTracer(workerDisabled);
  const runTrace = (document, options) => previewTracer.run(document, options);

  const viewer = createViewer();
  const attached = new WeakSet();
  let lastArgs = null, latestDocument = null;
  let sceneCache = { key: null, scene: null, meshes: null, error: null };
  const results = { preview: null, previewKey: null, full: null, fullKey: null, error: null, running: false };
  let previewTimer = null, requestedKey = null;
  let panel = null, lastPick = null;
  const keyOf = document => JSON.stringify(document?.model ?? null);

  function sceneFor(document) {
    const key = keyOf(document);
    if (sceneCache.key === key) return sceneCache;
    try {
      const scene = compileScene(document);
      const detectors = new Set(scene.analyses.map(a => a.objectId));
      const meshes = tessellateScene(scene).map(m => {
        const kind = m.property.kind === "fresnel" ? "glass" : m.property.kind;
        const color = !m.solid && detectors.has(m.objectId) ? MESH_COLORS.detector : MESH_COLORS[kind] || MESH_COLORS.glass;
        let cx = 0, cy = 0, cz = 0; const n = m.positions.length / 3;
        for (let i = 0; i < m.positions.length; i += 3) { cx += m.positions[i]; cy += m.positions[i + 1]; cz += m.positions[i + 2]; }
        return { ...m, rgba: color, center: [cx / n, cy / n, cz / n] };
      });
      sceneCache = { key, scene, meshes, error: null };
    } catch (error) {
      sceneCache = { key, scene: null, meshes: null, error: error.message };
    }
    return sceneCache;
  }

  function current() {
    const key = keyOf(latestDocument);
    if (results.full && results.fullKey === key) return { result: results.full, kind: "full" };
    if (results.preview) return { result: results.preview, kind: results.previewKey === key ? "preview" : "stale" };
    return { result: null, kind: "none" };
  }

  function schedulePreview(document) {
    const key = keyOf(document);
    if (key === requestedKey) return;
    requestedKey = key;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const cache = sceneFor(document);
      if (cache.error) { results.error = cache.error; refresh(); return; }
      const reply = await runTrace(document, { rayCountCap: cache.scene.settings.previewRayCap });
      if (requestedKey !== key) return;                     // superseded by a newer edit
      if (reply.error) results.error = reply.error;
      else { results.error = null; results.preview = reply.result; results.previewKey = key; }
      refresh();
    }, 150);
  }

  async function runFull() {
    if (!latestDocument || results.running) return;
    const document = latestDocument, key = keyOf(document);
    results.running = true; renderPanel();
    results.progress = 0;
    const reply = await fullTracer.run(document, {}, fraction => { results.progress = fraction; renderPanel(); });
    results.running = false;
    if (reply.error) results.error = reply.error;
    else { results.error = null; results.full = reply.result; results.fullKey = key; }
    refresh();
  }

  /** Click in the 3D view: select the object under the cursor in the model tree (expanding Objects if needed). */
  function pick(ray) {
    const scene = sceneCache.scene;
    if (!scene) return;
    const hit = pickObject(scene, ray.origin, ray.dir);
    if (!hit) return;
    const path = ["model", "objects", hit.index];
    const root = lastArgs?.previewCanvas?.ownerDocument || document;
    const find = () => [...root.querySelectorAll("[data-model-path]")].find(n => n.dataset.modelPath === JSON.stringify(path));
    let node = find();
    if (!node || !node.offsetParent) {
      // Collapsed branch: click the Objects section's expand toggle, then look again.
      const heading = [...root.querySelectorAll("[data-array-path]")].find(n => n.dataset.arrayPath === JSON.stringify(path.slice(0, -1)));
      const toggle = heading?.parentElement?.querySelector('[aria-expanded="false"]') || heading?.closest("li,div")?.querySelector('[aria-expanded="false"]');
      toggle?.click();
      node = find();
    }
    if (node) node.click();
    lastPick = { name: scene.objects[hit.index].name, face: hit.face, selected: Boolean(node) };
    refresh();
  }

  function refresh() { if (lastArgs) renderPreview(lastArgs); renderPanel(); }

  function renderPreview(args) {
    lastArgs = args;
    const { previewCanvas: canvas, previewContext: ctx, model: document } = args;
    const selectedPath = Array.isArray(args.selectedPath) ? args.selectedPath : [];
    if (!canvas || !ctx) return;
    latestDocument = document;
    if (viewer && !attached.has(canvas)) { attached.add(canvas); viewer.attach(canvas, () => lastArgs && renderPreview(lastArgs), pick); }
    schedulePreview(document);

    const width = canvas.getBoundingClientRect().width || canvas.clientWidth || 1;
    const height = canvas.getBoundingClientRect().height || canvas.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(width * ratio)) canvas.width = Math.floor(width * ratio);
    if (canvas.height !== Math.floor(height * ratio)) canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#0c141e"; ctx.fillRect(0, 0, width, height);
    ctx.font = "12px system-ui, sans-serif";

    const cache = sceneFor(document);
    if (cache.error || !viewer) {
      ctx.fillStyle = "#e26976"; ctx.textAlign = "center";
      ctx.fillText(cache.error ? `Cannot trace: ${cache.error}` : "WebGL is not available in this browser.", width / 2, height / 2, width - 32);
      return;
    }
    const { result, kind } = current();
    const selectedObject = selectedPath[1] === "objects" ? document.model.objects?.[Number(selectedPath[2])]?.id : null;
    const meshes = cache.meshes.map(m => (m.objectId === selectedObject ? { ...m, rgba: MESH_COLORS.selected } : m));

    // rays: wavelength colour, opacity by flux relative to the brightest drawn ray of that wavelength
    const lines = [];
    if (result?.displayRays?.length) {
      const colorOf = Object.fromEntries(result.wavelengths.filter(w => w.color).map(w => [w.id, hexToRgb(w.color)]));
      const maxFlux = {};
      for (const r of result.displayRays) maxFlux[r.wavelength] = Math.max(maxFlux[r.wavelength] || 0, r.fluxW);
      for (const r of result.displayRays) {
        const a = 0.12 + 0.78 * Math.sqrt(r.fluxW / (maxFlux[r.wavelength] || 1));
        lines.push({ points: r.points, rgba: [...(r.color ? hexToRgb(r.color) : colorOf[r.wavelength] || [1, 1, 1]), a] });
      }
    }
    // frame objects and sources
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const grow = p => { for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); } };
    for (const m of cache.meshes) for (let i = 0; i < m.positions.length; i += 3) grow([m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    for (const s of cache.scene.sources) grow(s.position);
    const bounds = Number.isFinite(min[0]) ? { min, max } : null;

    const glCanvas = viewer.render({ width, height, ratio, meshes, lines, bounds });
    ctx.drawImage(glCanvas, 0, 0, width, height);

    // source markers (small circles) drawn in 2D would need the camera projection; the axes triad marks the origin.
    ctx.textAlign = "left";
    let y = 18;
    const line = (text, color = "#86a4bc") => { ctx.fillStyle = color; ctx.fillText(text, 12, y, width - 24); y += 15; };
    if (result) {
      const t = result.totals;
      const rays = result.raysPerSource.map(s => s.rays).reduce((a, b) => a + b, 0);
      line(`${kind === "full" ? "Full trace" : kind === "preview" ? "Live preview" : "Previous result (updating…)"}: ${rays} ray positions  ·  ${result.wavelengths.map(w => w.spectrum ? w.label.replace(/^[^:]*: /, "") : w.label).join(", ")}  ·  ${result.rayHandling}  ·  ${result.elapsedMs} ms (${(kind === "full" ? fullTracer : previewTracer).mode === "worker" ? "background worker" : "main thread"})`,
        kind === "full" ? "#55cbb7" : "#86a4bc");
      line(`emitted ${fmt(t.emittedW)} W  ·  absorbed ${fmt(t.absorbedW)} W  ·  escaped ${fmt(t.escapedW)} W  ·  lost ${fmt(t.lostW)} W`);
      for (const a of result.analyses) line(`${a.name}: ${fmt(a.totalW)} W, peak ${fmt(a.peakWPerMm2)} W/mm²`, "#ffb38a");
      for (const w of result.warnings.slice(0, 2)) line(`⚠ ${w}`, "#ffd166");
      if (lastPick) line(`Picked: ${lastPick.name} (face ${lastPick.face})${lastPick.selected ? "" : " — not found in the tree"}`, "#ffd166");
    } else line("Tracing…");
    ctx.fillStyle = "#86a4bc"; ctx.textAlign = "right";
    ctx.fillText("click: select · drag: rotate · shift/right-drag: pan · wheel: zoom · double-click: reset · axes x red, y green, z blue", width - 12, height - 10, width - 24);
  }

  // ---- results panel ----
  // Map display mode per analysis id ("power" false colour or "color" = true colour from CIE XYZ), kept across redraws.
  const mapModes = new Map();

  function paintMap(map, a, mode) {
    const [nx, ny] = a.pixels;
    const mctx = map.getContext("2d"), img = mctx.createImageData(nx, ny);
    let rgb = null, scaleRgb = 1;
    if (mode === "color" && Array.isArray(a.xyz)) {
      rgb = new Float64Array(nx * ny * 3);
      let max = 0;
      for (let k = 0; k < nx * ny; k++) {
        const c = xyzToLinearSrgb([a.xyz[3 * k], a.xyz[3 * k + 1], a.xyz[3 * k + 2]]).map(v => Math.max(0, v));   // clip out-of-gamut negatives
        rgb.set(c, 3 * k); max = Math.max(max, c[0], c[1], c[2]);
      }
      scaleRgb = max > 0 ? 1 / max : 1;                                                      // brightest pixel at full scale
    }
    const peak = a.peakWPerMm2 || 1;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const k = iy * nx + ix, o = ((ny - 1 - iy) * nx + ix) * 4;                              // +v up
      const c = rgb ? [srgbByte(rgb[3 * k] * scaleRgb), srgbByte(rgb[3 * k + 1] * scaleRgb), srgbByte(rgb[3 * k + 2] * scaleRgb)]
        : falseColor(a.wPerMm2[k] / peak);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    mctx.putImageData(img, 0, 0);
  }

  function irradianceFigure(a) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:inline-block;margin:8px 16px 8px 0;vertical-align:top;font-size:12px";
    const [nx, ny] = a.pixels, [u0, u1, v0, v1] = a.extentMm;
    const aspect = (u1 - u0) / (v1 - v0) || 1;
    const H = 200, W = Math.round(Math.max(80, Math.min(320, H * aspect)));
    const map = document.createElement("canvas"); map.width = nx; map.height = ny;
    map.style.cssText = `width:${W}px;height:${H}px;image-rendering:pixelated;border:1px solid #24364a;background:#0d0828`;
    const mode = mapModes.get(a.id) || a.display || "power";
    paintMap(map, a, mode);
    const peak = a.peakWPerMm2 || 1;
    const bar = document.createElement("canvas"); bar.width = 12; bar.height = H;
    bar.style.cssText = `width:12px;height:${H}px;margin-left:6px;border:1px solid #24364a`;
    const bctx = bar.getContext("2d");
    for (let i = 0; i < H; i++) { const c = falseColor(1 - i / (H - 1)); bctx.fillStyle = `rgb(${c})`; bctx.fillRect(0, i, 12, 1); }
    const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:stretch";
    const scaleLabels = document.createElement("div");
    scaleLabels.style.cssText = `display:flex;flex-direction:column;justify-content:space-between;margin-left:4px;height:${H}px;opacity:.8`;
    scaleLabels.innerHTML = `<span>${fmt(peak)} W/mm²</span><span>0</span>`;
    const colorNote = document.createElement("div");
    colorNote.style.cssText = `margin-left:6px;height:${H}px;width:110px;opacity:.8;display:flex;align-items:center`;
    colorNote.textContent = "True colour (CIE 1931 → sRGB), brightest pixel at full scale; infrared and ultraviolet are invisible.";
    const setMode = m => {
      mapModes.set(a.id, m); paintMap(map, a, m);
      // style.display, not the hidden attribute: these elements set display inline, which overrides [hidden]
      bar.style.display = m === "color" ? "none" : ""; scaleLabels.style.display = m === "color" ? "none" : "flex";
      colorNote.style.display = m === "color" ? "flex" : "none";
      for (const b of toggle.querySelectorAll("button")) b.classList.toggle("primary", b.dataset.mode === m);
    };
    row.append(map, bar, scaleLabels, colorNote);
    const title = document.createElement("div");
    title.style.cssText = "font-weight:500;margin-bottom:4px;display:flex;gap:8px;align-items:center";
    const name = document.createElement("span"); name.textContent = `${a.name} — ${a.object} / ${a.face}`;
    const toggle = document.createElement("span");
    toggle.innerHTML = `<button type="button" data-mode="power">Power</button> <button type="button" data-mode="color">True colour</button>`;
    for (const b of toggle.querySelectorAll("button")) { b.style.cssText = "font-size:11px;padding:1px 6px"; b.addEventListener("click", () => setMode(b.dataset.mode)); }
    title.append(name, toggle);
    const stats = document.createElement("div");
    stats.style.cssText = "margin-top:4px;opacity:.85";
    stats.textContent = `${fmt(u1 - u0, 3)} × ${fmt(v1 - v0, 3)} mm, ${nx}×${ny} px · total ${fmt(a.totalW)} W · peak ${fmt(a.peakWPerMm2)} W/mm² · centroid ${a.centroidMm ? a.centroidMm.map(c => fmt(c, 4)).join(", ") : "–"} mm · ${a.hits} hits`;
    wrap.append(title, row, stats);
    setMode(mode);
    return wrap;
  }

  function table(header, rows) {
    const element = document.createElement("table");
    element.style.cssText = "margin-top:8px;font-size:12px;border-collapse:collapse";
    const cell = (tag, text) => { const c = document.createElement(tag); c.textContent = text; c.style.cssText = `text-align:${tag === "th" ? "left" : "right"};padding:1px 10px 1px 0;${tag === "th" ? "font-weight:500;opacity:.8" : ""}`; return c; };
    const tr = document.createElement("tr"); tr.append(...header.map(h => cell("th", h))); element.append(tr);
    for (const row of rows) { const r = document.createElement("tr"); r.append(...row.map((v, i) => { const c = cell("td", v); if (i === 0) c.style.textAlign = "left"; return c; })); element.append(r); }
    return element;
  }

  function renderPanel() {
    if (!panel) return;
    const status = panel.querySelector("[data-rt3-status]"), body = panel.querySelector("[data-rt3-body]");
    const button = panel.querySelector("[data-rt3-run]"), cancel = panel.querySelector("[data-rt3-cancel]");
    cancel.hidden = !results.running || fullTracer.mode === "main";
    button.disabled = results.running;
    const { result, kind } = current();
    status.style.color = results.error ? "#e26976" : kind === "full" ? "#55cbb7" : "";
    status.textContent = results.running ? `Full trace running${fullTracer.mode === "main" ? " on the main thread" : " in a background worker"}… ${Math.round(100 * (results.progress || 0))} %`
      : results.error ? results.error
        : kind === "full" ? `Full trace: ${result.totals.raysTraced} rays, ${result.totals.segments} segments, ${result.elapsedMs} ms.`
          : result ? `Showing the live preview (≤ ${result.rayCountCap} rays per source and wavelength). Run the full trace for final numbers.` : "";
    if (!result) { body.replaceChildren(); return; }
    const t = result.totals;
    const faceRows = [];
    for (const o of result.objects) for (const [face, s] of Object.entries(o.faces)) {
      if (s.hits) faceRows.push([`${o.name} / ${face}`, fmt(s.incidentW), fmt(s.absorbedW), fmt(s.reflectedW), fmt(s.transmittedW), String(s.hits)]);
    }
    body.replaceChildren(
      table(["Totals", "W"], [["Emitted", fmt(t.emittedW)], ["Absorbed", fmt(t.absorbedW)], ["Escaped", fmt(t.escapedW)], ["Lost (threshold / max intersections)", fmt(t.lostW)],
        ["Balance (emitted − absorbed − escaped − lost)", (t.emittedW - t.absorbedW - t.escapedW - t.lostW).toExponential(2)]]),
      ...result.analyses.map(irradianceFigure),
      table(["Flux report: object / face", "incident W", "absorbed W", "reflected W", "transmitted W", "hits"], faceRows),
      ...(result.warnings.length ? [table(["Warnings"], result.warnings.map(w => [w]))] : []),
    );
  }

  function mountPanel(settingsView) {
    panel = document.createElement("section");
    panel.dataset.applicationPanel = "raytrace3d";
    panel.style.cssText = "margin:12px 0;padding:12px;border:1px solid #24364a;border-radius:8px;background:#0f1a26;overflow-x:auto";
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <strong style="font-size:13px">3D ray trace</strong>
        <button type="button" class="primary" data-rt3-run>Run full trace</button>
        <button type="button" data-rt3-cancel hidden>Cancel</button>
        <span data-rt3-status style="font-size:12px;opacity:.85"></span>
      </div>
      <div data-rt3-body></div>`;
    panel.querySelector("[data-rt3-run]").addEventListener("click", runFull);
    panel.querySelector("[data-rt3-cancel]").addEventListener("click", () => fullTracer.cancel());
    settingsView?.prepend(panel);
    renderPanel();
  }

  return { renderPreview, mountPanel, runFull };
}
