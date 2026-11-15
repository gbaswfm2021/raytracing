# Ray Tracing for FullMeta: developer notes for Claude

**Claude: read this whole file before working on this app.** If `CLAUDE.local.md` exists next to it, read that too
(local, untracked notes). This repository is public: keep personal details and machine-specific paths out of tracked
files.

## What this is
- The FullMeta ray-tracing application (`id: raytracing`, see `catalog.json`). Two engines in one app:
  - 2D sequential lens design with full dispersion (`raytracing.schema.json`, `raytrace-model/2`).
  - 3D non-sequential illumination tracing (`raytracing3d.schema.json`, `raytrace3d-model/1`); `package.js` switches on
    `modelFormat`.
- The app id was renamed from `raytrace` to `raytracing` (v2.0.0). Renamed: folder, `catalog.json` id, `application`
  field/const, schema files and their `$id`, schema paths, route `/api/raytracing/trace`. Deliberately kept: the
  data-format names (`raytrace-model/2`, `raytrace3d-model/1`, `raytrace-result/2`, `raytrace3d-result/1`,
  `raytrace-material-library/1`), `raytrace_model.json`, `raytrace2d.exe`, example ids and internal JS names, so
  existing projects keep working.

## How FullMeta is built (findings)
- A local Rust **kernel** (`platform/.runtime/native/release/fullmeta-kernel.exe`) serves a browser UI.
- Applications are plug-ins under `applications/<id>/`, each with its own `catalog.json` (`fullmeta-application/1`;
  folder name = `id`). Each declares a JSON **schema** (model tree, UI, `x-fullmeta-runtime`: storage, external
  programs and editor API routes). The kernel runs solver exes through **generic handlers** (`kernel.program.json`,
  `kernel.program.ndjson`, `kernel.command.run`), so **new physics modules need no kernel source**.
- Examples are discovered from `examples/<name>/*.json` and offered by the app card's **Examples** button, which copies
  one into `projects/<name>/`. Project folders must sit directly in `projects/<name>/`, because model files point to
  their schema with a relative path.
- Native engines follow the Gerchberg-Saxton app: a Rust crate plus `runtime-build.json`, with the prebuilt
  `.runtime/x86_64-pc-windows-gnu/release/<engine>.exe` committed and registered in `x-fullmeta-runtime.externalPrograms`.
- Platform source availability: all JavaScript and docs; the kernel and core/model WASM are compiled only.

## Releases
- FullMeta's Help → recommended applications reads `applications/inventory.json` in the FullMeta workspace repository,
  lists this repository's **GitHub Releases** (non-draft; a bare tag is not enough) and installs the release tag's
  source zip (top folder renamed to `raytracing`).
- New version: bump `version` in `catalog.json`, commit, push, push tag `vX.Y.Z`, then create the GitHub Release from
  that tag.

## The app in detail
- `raytracing.schema.json`: `raytrace-model/2` = materials, wavelengths, source (collimated/point, rays per
  wavelength), surfaces (vertex x, radius, semi-aperture, `materialAfter`), screen, settings (`ambientMaterial`,
  `primaryWavelength`). It still accepts `raytrace-model/1` (`nAfter`, `ambientIndex`). Surface → material and
  settings → wavelength use `x-fullmeta-modelReference` (renders as a dropdown). Tree context menus use `catalog`
  entries that `package.js` supplies (`treeActionCatalogs` and its own `treeActionPlans` with the `libraryMaterial` and
  `spectralLine` factories). Runtime: `modelFile raytrace_model.json`, external program `raytraceSolver` →
  `.runtime/raytrace2d.exe --trace`, routes `projectCreate` and `traceRun` (POST `/api/raytracing/trace`,
  `kernel.program.json`, json-stdio). Result format `raytrace-result/2`. Details in the README and
  `docs/stage1-dispersion-proposal.md` (see "Implementation notes").
- `materials/library.json` + `js/materials.js`: dispersion formulas and the material library.
- `package.js` wraps the platform's generic `createSchemaProjectPackage` and adds the live preview (`js/preview.js` +
  the `js/trace2d.js` tracer), the "Run native solver" panel (`js/run-panel.js`), the 3D integration (`js/app3d.js`,
  `js/trace3d.js` + worker, `js/view3d.js`) and launcher profiles/templates (`templates/`).
- `solver/RayTrace2D.cs`: native C# 2D solver, built with the .NET Framework `csc.exe` that ships with Windows:
  `powershell -ExecutionPolicy Bypass -File solver\build.ps1` (creates `.runtime\raytrace2d.exe`, not stored in git).
- Verified on the Store platform 0.1.1.0: app card with both profiles and 7 examples; creating projects from examples;
  2D biconvex (best focus 51.901 mm vs ≈53.4 mm paraxial, spherical aberration) and 3D sunlight prism (full trace
  30,000 rays, energy balance ~1e-13); `tests/run.html` PASS 65/65. Not yet verified: native solver runs and JS ↔ C#
  agreement to ~1e-9; right-click → Add Surface by hand.

## Rules / gotchas
- Don't edit `platform/` or other applications: a reinstall replaces platform files, and they belong upstream.
- Two **platform bugs** are worked around in `package.js`:
  1. `platform/ui/widgets/model-editor/schema-project-package.js:138` used an undefined `isRecord`, so every
     schema-only project crashed. Fixed in the Store platform 0.1.1.0; the workaround is harmless, keep it for older
     installs.
  2. The generic package returns `uiProfileSchema: {}`, but `runtime.js` `treeUiSetting` reads
     `.properties.behavior...`.
- Write JSON as UTF-8 **without BOM** (PowerShell 5's `Set-Content -Encoding utf8` adds one).
- Keep `js/trace2d.js` + `js/materials.js` and `solver/RayTrace2D.cs` in sync (same algorithm, same
  `raytrace-result/2` output).
- JS tests: open `tests/run.html` through the FullMeta server; `#summary` reads `PASS n/n`. Headless: see the README.
  Use a fresh `--user-data-dir` per headless Edge run (a leftover instance holds the profile lock). Screenshots:
  `--screenshot=<png> --window-size=1500,900 --virtual-time-budget=40000 <loader URL>`.
- Kernel requests from outside the editor need headers `x-fullmeta-application: raytracing`,
  `x-fullmeta-model-schema` and `x-fullmeta-document` (URL-encoded workspace paths).
- Open a project directly at `/platform/loader.html?model=projects%2F<folder>%2Fraytrace_model.json`.
- Module workers lose messages sent before their imports load: wait for the worker's `ready` message. Headless Edge's
  virtual clock doesn't wait for workers, so use `tests/open-main-thread.html` for screenshots. The editor loader drops
  unknown URL query parameters.
- `js/layout.js` moves Settings into a resizable column right of the tree and puts the results panels under the
  graphics (DOM moves + CSS scoped to `.rt-layout`; no platform edits). If a platform update changes the editor markup
  it falls back to the platform layout. Check: `tests/ui-layout.html`.

## Roadmap
1. **Stage 1 – full dispersion: done.** Decisions: model/2 with /1 back-compat, library materials copied into projects,
   top-level `model.wavelengths`. Singlet F–C focal shift −1.545 mm, doublet −0.035 mm.
2. **Stage 2 – 3D non-sequential, phase 3a: done.** JS engine, own WebGL viewer (`scene-view` is Canvas 2D only). See
   `docs/stage2-3d-proposal.md`. Checks: 3D ↔ 2D agree to 4e-15 mm, lensmaker, parabolic mirror, Fresnel/TIR, energy
   balance, irradiance, inverse-square law. Also done: continuous spectra (blackbody / table, sunlight preset), beam
   divergence, prism kind, right-click Duplicate / Rename / Delete, true-colour maps, 2D spectra, click-to-select,
   overlap warning, progress/Cancel, perf test.
   **Next (3b):** Lambertian/ABg scatter, surface sources, intensity plots, ray sorting, spot diagrams, STL import,
   polarisation.
3. **Native engine:** move the compute-heavy tracing into a native binary following the Gerchberg-Saxton pattern.
   Propose the design before coding.
4. Workflow: propose schema and result-format changes before coding. After each stage, rebuild, run the CLI on the
   examples, check the kernel route, check in the browser, and update the README.
