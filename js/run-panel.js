// Settings-side panel with a "Run native solver" button. The request goes to the schema-declared
// editorApi route (x-fullmeta-runtime.editorApi.traceRun). The FullMeta kernel launches
// .runtime/raytrace2d.exe --trace, pipes the model JSON to stdin and returns its stdout JSON.

const fmt = (value, digits = 4) => (Number.isFinite(value) ? value.toFixed(digits) : "–");

export function createRunPanel({ route, applicationId, schemaPath, getModel, onResult }) {
  let panel = null;

  function documentPath() {
    const param = new URLSearchParams(location.search).get("model");
    return param || "";
  }

  function table(header, rows, color) {
    const element = document.createElement("table");
    element.style.cssText = "margin-top:8px;font-size:12px;border-collapse:collapse";
    const cell = (tag, text, css = "") => { const c = document.createElement(tag); c.textContent = text; c.style.cssText = `text-align:left;padding:1px 10px 1px 0;${css}`; return c; };
    if (header) { const tr = document.createElement("tr"); tr.append(...header.map(h => cell("th", h, "font-weight:500;opacity:.8"))); element.append(tr); }
    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      tr.append(...row.map((value, k) => cell(k === 0 && !header ? "th" : "td", value, k === 0 && color?.[i] ? `color:${color[i]}` : "")));
      element.append(tr);
    });
    return element;
  }

  function render(state) {
    if (!panel) return;
    const { status = "", tone = "", result = null } = state;
    panel.querySelector("[data-rt-status]").textContent = status;
    panel.querySelector("[data-rt-status]").style.color = tone === "error" ? "#e26976" : tone === "good" ? "#55cbb7" : "";
    const host = panel.querySelector("[data-rt-stats]");
    if (!result?.wavelengths) { host.replaceChildren(); return; }
    const waves = result.wavelengths;
    const shift = result.stats?.chromaticFocalShiftMm || {};
    host.replaceChildren(
      table(["λ", "nm", "on screen", "RMS on screen (mm)", "best focus x (mm)", "RMS at best focus (mm)", "paraxial focus x (mm)"],
        waves.map(w => [w.label || w.id, fmt(w.lambdaNm, 2), `${w.stats.raysOnScreen} / ${w.stats.rayCount}`, fmt(w.stats.screenRmsSpotMm),
          fmt(w.stats.bestFocusXmm, 3), fmt(w.stats.bestFocusRmsMm), fmt(w.stats.paraxialFocusXmm, 3)]),
        waves.map(w => w.color)),
      table(["material", "nF", "nd", "nC", "νd"],
        (result.materials || []).map(m => [m.id, fmt(m.nF, 5), fmt(m.nd, 5), fmt(m.nC, 5), m.abbeVd === null ? "∞" : fmt(m.abbeVd, 2)])),
      table(null, [
        ["Solver", result.solver || ""],
        ["F–C focal shift, paraxial (mm)", fmt(shift.paraxialFC)],
        ["F–C focal shift, best focus (mm)", fmt(shift.bestFocusFC)],
        ["Paraxial focus range, all λ (mm)", fmt(shift.rangeAll)],
        ["Polychromatic RMS on screen (mm)", fmt(result.stats?.polychromaticRmsSpotMm)],
        ["Polychromatic best focus x (mm)", fmt(result.stats?.polychromaticBestFocusXmm, 3)],
        ...(result.warnings || []).map(w => ["Warning", w]),
      ]),
    );
  }

  async function run() {
    const document_ = getModel();
    if (!document_) { render({ status: "Open a ray tracing model first.", tone: "error" }); return; }
    const button = panel.querySelector("button");
    button.disabled = true;
    render({ status: "Running raytrace2d.exe through the FullMeta kernel…" });
    try {
      const headers = { "content-type": "application/json", "x-fullmeta-application": applicationId,
        "x-fullmeta-model-schema": encodeURIComponent(schemaPath) };
      if (documentPath()) headers["x-fullmeta-document"] = encodeURIComponent(documentPath());
      const response = await fetch(`${route}?application=${encodeURIComponent(applicationId)}`, {
        method: "POST", headers, body: JSON.stringify({ model: document_ }),
      });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
      if (!response.ok) throw new Error(body.error || `Solver request failed (${response.status}).`);
      const result = /^raytrace-result\//.test(body?.schema || "") ? body : body?.result || body;
      onResult?.(result);
      render({ status: `Native solver finished: ${result.rays?.length ?? 0} rays traced.`, tone: "good", result });
    } catch (error) {
      render({ status: error.message, tone: "error" });
    } finally {
      button.disabled = false;
    }
  }

  return {
    mount(settingsView) {
      panel = document.createElement("section");
      panel.dataset.applicationPanel = "raytrace";
      panel.style.cssText = "margin:12px 0;padding:12px;border:1px solid #24364a;border-radius:8px;background:#0f1a26";
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <strong style="font-size:13px">Ray tracing solver</strong>
          <button type="button" class="primary">Run native solver</button>
          <span data-rt-status style="font-size:12px;opacity:.85"></span>
        </div>
        <div data-rt-stats style="overflow-x:auto"></div>`;
      panel.querySelector("button").addEventListener("click", run);
      settingsView?.prepend(panel);
    },
  };
}
