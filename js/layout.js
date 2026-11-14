// Ray-tracing editor layout (app-side; platform files are untouched):
//
//   [ tree ] | [ Settings ] | [ Graphics          ]
//                           |---------------------|
//                           | [ Results panel     ]
//
// The platform puts Settings under the graphics area, which wastes the width on the right and needs a lot of
// scrolling. This module moves the Settings panel into its own column between the tree and the graphics, adds a
// draggable splitter for its width (remembered in localStorage), and puts the application's results panel in
// the slot under the graphics, where the platform's own graphics/bottom splitter keeps resizing it.
// Everything is scoped to the `rt-layout` class; below 901 px wide the platform's stacked layout applies.

const STYLE_ID = "raytrace-layout-css";
const WIDTH_KEY = "raytrace.layout.settingsWidth";
const CSS = `
@media (min-width: 901px) {
  .fullmeta-model-editor > .wrap > .workspace.rt-layout {
    grid-template-columns: minmax(190px, var(--tree-width, 260px)) 12px minmax(260px, var(--rt-settings-width, 420px)) 12px minmax(0, 1fr);
  }
  .fullmeta-model-editor > .wrap > .workspace.rt-layout > .editor { grid-column: 3; grid-row: 1; min-height: 0; }
  .fullmeta-model-editor > .wrap > .workspace.rt-layout > .rt-settings-splitter { grid-column: 4; grid-row: 1; }
  .fullmeta-model-editor > .wrap > .workspace.rt-layout > .right-workspace { grid-column: 5; grid-row: 1; }
}
.workspace.rt-layout > .editor .settings-table-wrap { flex: 1 1 auto; min-height: 0; overflow: auto; }
.rt-results-panel { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.rt-results-panel > .rt-results-head { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--border, #24364a); font-size: 13px; font-weight: 600; }
.rt-results-panel > .rt-results-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 12px 8px; }
.rt-results-panel > .rt-results-body > section { margin: 8px 0 !important; }
`;

function readWidth(fallback) {
  try { const v = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; }
}
function saveWidth(value) { try { localStorage.setItem(WIDTH_KEY, String(Math.round(value))); } catch { /* storage blocked */ } }

/**
 * Apply the layout once per editor page and return the results container (its body element) for the
 * application's panel. Calling it again (another project of this app opened in the same page) clears and
 * reuses the same container.
 */
export function applyRaytraceLayout(settingsView, title = "Results") {
  const editor = settingsView?.closest?.(".editor");
  const workspace = editor?.closest?.(".workspace");
  const right = workspace?.querySelector?.("#right-workspace");
  const treeSplitter = workspace?.querySelector?.("#tree-splitter");
  if (!editor || !workspace || !right || !treeSplitter) return settingsView;     // unknown layout: keep the platform's
  const doc = workspace.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID; style.textContent = CSS;
    doc.head.append(style);
  }

  let results = right.querySelector(":scope > .rt-results-panel");
  if (!workspace.classList.contains("rt-layout")) {
    // Settings column + its splitter go between the tree splitter and the graphics/results column.
    const splitter = doc.createElement("div");
    splitter.className = "panel-splitter rt-settings-splitter";
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.setAttribute("aria-label", "Resize the Settings panel");
    splitter.tabIndex = 0;
    treeSplitter.after(editor, splitter);

    // Results panel takes the old Settings slot under the graphics (third row of the right column).
    results = doc.createElement("section");
    results.className = "panel rt-results-panel";
    results.setAttribute("aria-label", title);
    results.innerHTML = `<div class="rt-results-head"></div><div class="rt-results-body"></div>`;
    right.append(results);
    workspace.classList.add("rt-layout");

    const setWidth = (value, persist = true) => {
      const treeWidth = workspace.querySelector(".tree")?.getBoundingClientRect().width || 260;
      const max = Math.max(260, workspace.clientWidth - treeWidth - 24 - 360);         // keep ≥ 360 px for graphics
      const width = Math.max(260, Math.min(max, value));
      workspace.style.setProperty("--rt-settings-width", `${width}px`);
      splitter.setAttribute("aria-valuenow", String(Math.round(width)));
      if (persist) saveWidth(width);
      doc.defaultView?.dispatchEvent(new Event("resize"));                            // let the graphics redraw
    };
    setWidth(readWidth(420), false);
    let drag = null;
    splitter.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, width: editor.getBoundingClientRect().width };
      splitter.classList.add("dragging");
      try { splitter.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    });
    splitter.addEventListener("pointermove", event => { if (drag && event.pointerId === drag.id) setWidth(drag.width + event.clientX - drag.x); });
    const finish = event => { if (!drag || event.pointerId !== drag.id) return; drag = null; splitter.classList.remove("dragging"); };
    splitter.addEventListener("pointerup", finish);
    splitter.addEventListener("pointercancel", finish);
    splitter.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      setWidth(editor.getBoundingClientRect().width + (event.key === "ArrowRight" ? 16 : -16));
    });
  }
  results.querySelector(".rt-results-head").textContent = title;
  const body = results.querySelector(".rt-results-body");
  body.replaceChildren();
  return body;
}
