# FullMeta + Ray Tracing: project context for Claude

**Claude: read this whole file before working on this module.** It summarises a long earlier chat on my previous PC.

## Who / what
- I'm a researcher at the University of Exeter. My supervisor is building **FullMeta**, an open-source scientific
  simulation platform meant to replace paid tools (COMSOL, Ansys, Zemax-style ray tracing). It started after COMSOL
  quoted us $7000 for an extra module. I'm helping by building new physics modules, starting with **ray tracing**.
- GitHub user: `arminhgh`. This folder (`applications\raytracing`) is a git repo for my module only
  (private repo `arminhgh/fullmeta-raytrace`).
- **Supervisor's repos (2026-11-14)**, cloned read-only into `C:\Users\armin\source\fullmeta\`: GitHub org
  `FullMeta-Project` (public `platform` snapshot = Store package JS + docs; kernel/WASM still compiled only) and private
  `gbaswfm2021/FullMeta` (workspace root, `applications/inventory.json`), `gbaswfm2021/fem`,
  `gbaswfm2021/raytracing`. **The `raytracing` repo is only a simple thin-lens demo** the supervisor made to show how an
  app folder is downloaded and dropped into `applications/`. **He wants this module to be the ray-tracing
  app in FullMeta.**
- **App id is `raytracing` since 2026-11-14 (Armin's choice; was `raytrace`)**, so this module replaces the demo.
  Renamed: folder, `catalog.json` id, `application` field/const, schema files (`raytracing.schema.json`,
  `raytracing3d.schema.json`) and their `$id`, schema paths, route `/api/raytracing/trace`. Deliberately kept: the
  data-format names (`raytrace-model/2`, `raytrace3d-model/1`, `raytrace-result/2`, `raytrace3d-result/1`,
  `raytrace-material-library/1`), `raytrace_model.json`, `raytrace2d.exe`, example ids, internal JS names, and the
  GitHub repo name `arminhgh/fullmeta-raytrace`. Still to agree with the supervisor: how this gets into
  `gbaswfm2021/raytracing` (push access, or he pulls from this repo).
- The demo app and its example project were moved (not deleted) to
  `C:\Users\armin\source\fullmeta-workspace-backup\` (`raytracing-demo-app`, `raytracing-lens-example-project`).
  The demo's source is also in `gbaswfm2021/raytracing` and the read-only clone.

## Setup on this PC (since 2026-11-14)
- FullMeta is the **Microsoft Store app**. Its workspace is `C:\Users\armin\OneDrive\Documents\FullMeta`, served at
  http://127.0.0.1:8766/ (kernel `--root` is that folder). Platform files live in its `platform\`.
- **This repo now lives in `OneDrive\Documents\FullMeta\applications\raytracing\`** (cloned from GitHub; the kernel
  refuses links, so it must physically be there). The old copy in `C:\Users\armin\AppData\Local\Programs\FullMeta`
  (pre-Store install, no `platform\` any more) is obsolete; don't work there.
- New app packaging: no central catalog. Each app folder has its own `catalog.json` (`fullmeta-application/1`, folder
  name = `id`). Examples are discovered from `examples/<name>/*.json` and shown under the app card's **Examples**
  button, which copies one into `projects/<name>/`.
- Example projects copied into `projects/`: `raytrace_biconvex_lens`, `raytrace_achromat_doublet`,
  `raytrace3d_sunlight_prism`.
- Project folders must sit directly in `projects\<name>\`, never `projects\projects\...`, because model files point
  to their schema with a relative path.
- The solver exe is a build output, not stored in git. Rebuild it with:
  `powershell -ExecutionPolicy Bypass -File solver\build.ps1`  (creates `.runtime\raytrace2d.exe`)
- **Blocker found 2026-11-07: Windows Smart App Control (enforce mode) blocks `raytrace2d.exe`.** The build works, but
  the unsigned exe won't run, either from the command line or through the kernel (`POST /api/raytracing/trace` → 503
  "An Application Control policy has blocked this file (os error 4551)"). The "Run native solver" panel shows the same
  error. The app, tree and live JS preview work (sample best focus 51.901 mm). Fixes are Armin's call: turn off Smart
  App Control (Windows Security → App & browser control; it can't be turned back on without a Windows reset) or sign
  the exe with a trusted certificate (self-signed won't do). Don't try to get around the policy (e.g. loading the C#
  through PowerShell `Add-Type`). Until it's fixed, only the JS tracer can be tested.

## How FullMeta is built (findings)
- A local Rust **kernel** (`platform/.runtime/native/release/fullmeta-kernel.exe`) serves a browser UI.
- Applications are plug-ins under `applications/<id>/`, each with its own `catalog.json`. Each declares a JSON
  **schema** (model tree, UI, `x-fullmeta-runtime`: storage, external programs and editor API routes). The kernel runs
  solver exes through **generic handlers** (`kernel.program.json`, `kernel.program.ndjson`, `kernel.command.run`), so
  **new physics modules need no kernel source**.
- Source availability in the install: ✅ all JavaScript; ✅ FEM solver Rust source (`applications/fem/fem-rust/src`).
  ❌ kernel, core/model WASM, mesher source, tests and build scripts (compiled only). Those are needed only for platform
  work, so ask the supervisor for the repo.
- No licence file for FullMeta itself yet. The bundled mesher Gmsh is GPL, which affects the licence choice.

## The ray-tracing module (current state: 2D with full dispersion, Stage 1 implemented 2026-11-07)
- `raytracing.schema.json`: `raytrace-model/2` = materials, wavelengths, source (collimated/point, rays per
  wavelength), surfaces (vertex x, radius, semi-aperture, `materialAfter`), screen, settings (`ambientMaterial`,
  `primaryWavelength`). It still accepts `raytrace-model/1` (`nAfter`, `ambientIndex`). Surface → material and
  settings → wavelength use `x-fullmeta-modelReference` (renders as a dropdown). Tree context menus use `catalog`
  entries that `package.js` supplies (`treeActionCatalogs` and its own `treeActionPlans` with the `libraryMaterial` and
  `spectralLine` factories). Runtime: `modelFile raytrace_model.json`, external program `raytraceSolver` →
  `.runtime/raytrace2d.exe --trace`, routes `projectCreate` and `traceRun` (POST `/api/raytracing/trace`,
  `kernel.program.json`, json-stdio). Result format `raytrace-result/2`. Details in README and
  `docs/stage1-dispersion-proposal.md` (see "Implementation notes").
- `materials/library.json` + `js/materials.js`: dispersion formulas and the material library.
- `package.js` wraps the platform's generic `createSchemaProjectPackage` and adds the live preview (`js/preview.js` +
  the `js/trace2d.js` tracer), the "Run native solver" panel (`js/run-panel.js`) and a launcher profile/template
  (`templates/lens-2d.json`).
- `solver/RayTrace2D.cs`: native C# solver, built with the .NET Framework `csc.exe` built into Windows. The old PC had
  no Rust, Python or Node.
- Registered by its own `catalog.json` (`id: raytracing`, renamed from `raytrace` on 2026-11-14, `runtimePackage: true`, version 0.3.0). Example projects in
  `examples/`.
- **Verified on the Store platform (2026-11-14):** app card with both profiles and 7 examples; creating projects from
  examples works; 2D biconvex (best focus 51.901 mm) and 3D sunlight prism (full trace 30,000 rays, energy balance
  ~1e-13) work in the editor; `tests/run.html` PASS 65/65; no console errors. Not re-tested there: Create Project dialog,
  native solver (still blocked by Smart App Control).
- Verified: the app loads, the tree and forms work, live preview updates when you edit, the native solver runs through
  the kernel and matches the preview, and Workspace → Create project works. For the biconvex sample the best focus is
  x = 51.9 mm vs a paraxial back focus of ≈53.4 mm by hand (spherical aberration).
  **Not tested yet:** right-click → Add Surface.

## Rules / gotchas
- Don't edit `platform\` or `applications\fem\`: a reinstall replaces platform files, and they belong upstream.
- Two **platform bugs** are worked around in `package.js` (report them to the supervisor):
  1. `platform/ui/widgets/model-editor/schema-project-package.js:138` uses an undefined `isRecord`, so every
     schema-only project crashes. **Fixed in the Store platform 0.1.1.0**; the workaround is harmless, keep it for
     older installs.
  2. The generic package returns `uiProfileSchema: {}`, but `runtime.js` `treeUiSetting` reads
     `.properties.behavior...`.
- Write JSON as UTF-8 **without BOM** (PowerShell 5's `Set-Content -Encoding utf8` adds one).
- Keep `js/trace2d.js` + `js/materials.js` and `solver/RayTrace2D.cs` in sync (same algorithm, same
  `raytrace-result/2` output).
- No Node or Python on this PC. Run JS tests in headless Edge against the FullMeta server (command in the README):
  `tests/run.html` → `#summary` reads `PASS n/n`. Use a fresh `--user-data-dir` per run (a leftover instance
  holds the profile lock). Screenshots of the editor: `--screenshot=<png> --window-size=1500,900
  --virtual-time-budget=40000 <loader URL>`.
- Kernel requests from outside the editor need headers `x-fullmeta-application: raytrace`,
  `x-fullmeta-model-schema` and `x-fullmeta-document` (URL-encoded workspace paths).
- Open a project directly at `/platform/loader.html?model=projects%2F<folder>%2Fraytrace_model.json`.
- Ask me before git commits and pushes. Don't publish the supervisor's platform code: it has no licence yet.

## Next steps (agreed)
1. **Stage 1 – full dispersion: implemented 2026-11-07** (decisions: model/2 with /1 back-compat, library materials
   copied into projects, top-level `model.wavelengths`). JS verified: 27/27 checks, singlet F–C shift −1.545 mm,
   doublet −0.035 mm. Samples `raytrace_singlet_bk7` and `raytrace_achromat_doublet` copied into `projects/`.
   **Still open:** run `raytrace2d.exe` (blocked by Smart App Control): CLI on the three samples, the kernel route,
   and JS ↔ C# agreement to ~1e-9. Click through the material dropdown and the context menus by hand (only their
   wiring is tested). Not committed yet (Stage 1 and Stage 2 phase 3a are both uncommitted).
2. **Stage 2 – 3D non-sequential (TracePro-style), phase 3a implemented 2026-11-07.** Armin chose: non-sequential
   engine, inside this app (second schema `raytracing3d.schema.json`, `package.js` switches on `modelFormat`), JS engine
   only for now (C# later), own WebGL viewer (`scene-view` is Canvas 2D only). See `docs/stage2-3d-proposal.md`
   (implementation notes at the end). 51/51 checks pass: 3D ↔ 2D agree to 4e-15 mm, lensmaker, parabolic mirror,
   Fresnel/TIR, energy balance, irradiance, inverse-square law. Three 3D samples copied into `projects/`.
   **Gotchas:** a module worker loses messages sent before its imports load, so wait for its `ready` message.
   Headless Edge's virtual clock doesn't wait for workers, so use `tests/open-main-thread.html` for screenshots.
   The editor loader drops unknown URL query parameters.
   **Next (3b):** Lambertian/ABg scatter, surface sources, intensity plots, ray sorting, spot diagrams, STL import,
   polarisation; also click-to-select in the 3D view and the overlap warning. Done after feedback: continuous spectra
   (blackbody / table, sunlight preset), beam divergence, prism kind, right-click Duplicate / Rename / Delete; then
   true-colour maps, 2D spectra (bins), click-to-select, overlap warning, progress/Cancel, perf test (65/65).
   ASTM G173 not shipped (licence question for Armin/supervisor).
   **Layout (Armin asked, 2026-11-07):** `js/layout.js` moves Settings into a resizable column right of the tree and
   puts the results panels under the graphics (DOM moves + CSS scoped to `.rt-layout`; no platform edits). If a
   platform update changes the editor markup it falls back to the platform layout. Check: `tests/ui-layout.html`.
3. Workflow: propose the schema and result-format changes before coding. After each stage, rebuild, run the CLI on
   the samples, check the kernel route, check in the browser, and update the README.
