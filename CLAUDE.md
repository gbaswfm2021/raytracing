# FullMeta + Ray Tracing: project context for Claude

**Claude: read this whole file before working on this module.** It summarises a long earlier chat on my previous PC.

## Who / what
- I'm a researcher at the University of Exeter. My supervisor is building **FullMeta**, an open-source scientific
  simulation platform meant to replace paid tools (COMSOL, Ansys, Zemax-style ray tracing). It started after COMSOL
  quoted us $7000 for an extra module. I'm helping by building new physics modules, starting with **ray tracing**.
- GitHub user: `arminhgh`. This folder (`applications\raytrace`) is a git repo for my module only
  (private repo `arminhgh/fullmeta-raytrace`). There's no shared FullMeta repo yet; the plan is for my supervisor to
  create one (full source + licence) and add me as a collaborator.

## Setup on this PC (done)
- FullMeta installed at `C:\Users\armin\AppData\Local\Programs\FullMeta`, served at http://127.0.0.1:8766/
- This module lives physically in `FullMeta\applications\raytrace\` (required: the kernel refuses links).
- Sample project: `FullMeta\projects\raytrace_biconvex_lens\` (a copy is kept in `samples\` in this repo).
- Project folders must sit directly in `projects\<name>\`, never `projects\projects\...`, because model files point
  to their schema with a relative path.
- The solver exe is a build output, not stored in git. Rebuild it with:
  `powershell -ExecutionPolicy Bypass -File solver\build.ps1`  (creates `.runtime\raytrace2d.exe`)

## How FullMeta is built (findings)
- A local Rust **kernel** (`platform/.runtime/native/release/fullmeta-kernel.exe`) serves a browser UI.
- Applications are plug-ins under `applications/<id>/`, registered in `applications/catalog.json`. Each declares a JSON
  **schema** (model tree, UI, `x-fullmeta-runtime`: storage, external programs and editor API routes). The kernel runs
  solver exes through **generic handlers** (`kernel.program.json`, `kernel.program.ndjson`, `kernel.command.run`), so
  **new physics modules need no kernel source**.
- Source availability in the install: ✅ all JavaScript; ✅ FEM solver Rust source (`applications/fem/fem-rust/src`).
  ❌ kernel, core/model WASM, mesher source, tests and build scripts (compiled only). Those are needed only for platform
  work, so ask the supervisor for the repo.
- No licence file for FullMeta itself yet. The bundled mesher Gmsh is GPL, which affects the licence choice.

## The ray-tracing module (current state: working 2D skeleton)
- `raytrace.schema.json`: model = source (collimated/point), surfaces (vertex x, radius, semi-aperture, nAfter), screen,
  ambient index. Tree uses `objectRoot` / `collection` roles. Runtime: `modelFile raytrace_model.json`, `modelFormat
  raytrace-model/1`, external program `raytraceSolver` → `.runtime/raytrace2d.exe --trace`, routes `projectCreate`
  and `traceRun` (POST `/api/raytrace/trace`, `kernel.program.json`, json-stdio).
- `package.js` wraps the platform's generic `createSchemaProjectPackage` and adds the live preview (`js/preview.js` +
  the `js/trace2d.js` tracer), the "Run native solver" panel (`js/run-panel.js`) and a launcher profile/template
  (`templates/lens-2d.json`).
- `solver/RayTrace2D.cs`: native C# solver, built with the .NET Framework `csc.exe` built into Windows. The old PC had
  no Rust, Python or Node.
- Registered in `applications/catalog.json` with `"runtimePackage": true`.
- Verified: the app loads, the tree and forms work, live preview updates when you edit, the native solver runs through
  the kernel and matches the preview, and Workspace → Create project works. For the biconvex sample the best focus is
  x = 51.9 mm vs a paraxial back focus of ≈53.4 mm by hand (spherical aberration).
  **Not tested yet:** right-click → Add Surface.

## Rules / gotchas
- Don't edit `platform\` or `applications\fem\`: a reinstall replaces platform files, and they belong upstream.
- Two **platform bugs** are worked around in `package.js` (report them to the supervisor):
  1. `platform/ui/widgets/model-editor/schema-project-package.js:138` uses an undefined `isRecord`, so every
     schema-only project crashes.
  2. The generic package returns `uiProfileSchema: {}`, but `runtime.js` `treeUiSetting` reads
     `.properties.behavior...`.
- Write JSON as UTF-8 **without BOM** (PowerShell 5's `Set-Content -Encoding utf8` adds one).
- Keep `js/trace2d.js` and `solver/RayTrace2D.cs` in sync (same algorithm, same `raytrace-result/1` output).
- Kernel requests from outside the editor need headers `x-fullmeta-application: raytrace`,
  `x-fullmeta-model-schema` and `x-fullmeta-document` (URL-encoded workspace paths).
- Open a project directly at `/platform/loader.html?model=projects%2F<folder>%2Fraytrace_model.json`.
- Ask me before git commits and pushes. Don't publish the supervisor's platform code: it has no licence yet.

## Next steps (agreed)
1. **Stage 1 – full dispersion:** materials library (Sellmeier/Cauchy/constant; N-BK7, N-SF11, fused silica, CaF2,
   air from published data), source wavelength list (F/d/C + custom, weights), colour rays by wavelength,
   per-wavelength focus and RMS spot, chromatic focal shift, Abbe numbers. Add an achromatic doublet sample and check
   that its focal shift is much smaller than a singlet's.
2. **Stage 2 – 3D design:** 3D vector tracing, spheres/planes + conic constant, circular apertures (decentre/tilt
   later), 3D pupil sampling, 3D rotatable preview (try `platform/ui/widgets/scene-view`, else self-contained WebGL),
   spot diagrams per wavelength. Keep 2D working. Check against the lensmaker's equation and a parabolic mirror
   focusing to a point.
3. Workflow: propose the schema and result-format changes before coding. After each stage, rebuild, run the CLI on
   the samples, check the kernel route, check in the browser, and update the README.
