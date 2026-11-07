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

  function render(state) {
    if (!panel) return;
    const { status = "", tone = "", result = null } = state;
    const statsRows = result?.stats ? [
      ["Solver", result.solver || ""],
      ["Rays on screen", `${result.stats.raysOnScreen} / ${result.stats.rayCount}`],
      ["Screen centroid (mm)", fmt(result.stats.screenCentroidMm)],
      ["RMS spot on screen (mm)", fmt(result.stats.screenRmsSpotMm)],
      ["Best focus x (mm)", fmt(result.stats.bestFocusXmm, 3)],
      ["RMS spot at best focus (mm)", fmt(result.stats.bestFocusRmsMm)],
    ] : [];
    panel.querySelector("[data-rt-status]").textContent = status;
    panel.querySelector("[data-rt-status]").style.color = tone === "error" ? "#e26976" : tone === "good" ? "#55cbb7" : "";
    const table = panel.querySelector("[data-rt-stats]");
    table.replaceChildren(...statsRows.map(([label, value]) => {
      const row = document.createElement("tr");
      const th = document.createElement("th"); th.textContent = label; th.style.textAlign = "left"; th.style.fontWeight = "500"; th.style.paddingRight = "12px";
      const td = document.createElement("td"); td.textContent = value;
      row.append(th, td); return row;
    }));
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
      const result = body?.schema === "raytrace-result/1" ? body : body?.result || body;
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
        <table data-rt-stats style="margin-top:8px;font-size:12px;border-collapse:collapse"></table>`;
      panel.querySelector("button").addEventListener("click", run);
      settingsView?.prepend(panel);
    },
  };
}
