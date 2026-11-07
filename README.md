# Ray Tracing application (skeleton)

A FullMeta application package for 2D geometric (sequential) ray tracing through lenses.
It plugs into the existing platform **without kernel source changes**: the kernel launches the
solver through the generic `kernel.program.json` handler declared in the schema.

## Files

| File | Role |
|---|---|
| `raytrace.schema.json` | Model definition (source, surfaces, screen, settings), model tree, runtime contract: storage, registered solver exe, editor API routes |
| `package.js` | Application package. Wraps the platform's generic schema-project editor and adds the preview, Run panel and launcher profile |
| `schema-documents.js` | Schema loader required by the catalog (records the active schema URL) |
| `js/trace2d.js` | In-browser tracer used for the live preview (same algorithm as the solver) |
| `js/preview.js` | Graphics pane: lens bodies, surfaces, screen, rays, best-focus marker |
| `js/run-panel.js` | "Run native solver" panel → `POST /api/raytrace/trace` → kernel → `raytrace2d.exe --trace` |
| `solver/RayTrace2D.cs` | Native solver (C#). Reads model JSON on stdin and writes `raytrace-result/1` JSON on stdout |
| `solver/build.ps1` | Builds `.runtime/raytrace2d.exe` with the csc.exe that ships with Windows |
| `templates/lens-2d.json` | Starting model for Workspace → Create project |

Registered in `applications/catalog.json` as `{"id": "raytrace", "runtimePackage": true, ...}`.
Sample project: `projects/raytrace_biconvex_lens/raytrace_model.json`.

## Physics (current stub)

- 2D, sequential: each ray meets the surfaces in x order. Spherical (radius R) or flat (R = 0) surfaces,
  each with a semi-aperture and the refractive index *after* it.
- Vector Snell's law. Rays that miss an aperture end as `blocked`; total internal reflection ends as `tir`.
- Outputs per ray: polyline points, status, screen height. Stats: rays on screen, centroid, RMS spot,
  least-squares best-focus position and RMS spot there.

## Build / test the solver

```
powershell -ExecutionPolicy Bypass -File applications\raytrace\solver\build.ps1
applications\raytrace\.runtime\raytrace2d.exe --trace projects\raytrace_biconvex_lens\raytrace_model.json
```

## Workarounds for platform bugs in this build

The generic schema-project editor (`platform/ui/widgets/model-editor/schema-project-package.js`) has two bugs.
Both are patched from `package.js`; the platform files are untouched.
1. Line 138 calls an undefined `isRecord`, so every schema-only project fails with "isRecord is not defined".
2. It returns `uiProfileSchema: {}`, but `runtime.js` `treeUiSetting` reads `uiProfileSchema.properties.behavior...`.

## Ideas for next steps

- Wavelength-dependent index (Sellmeier/Cauchy) and colour-by-wavelength rays
- Aspheric surfaces, mirrors (reflection), non-sequential tracing
- Spot diagram / ray-fan plots in the Results area; write run records to `raytrace_runs/`
- 3D (rotationally symmetric) tracing; port the solver to Rust to match the FEM app's toolchain
- Metalens phase profile as a surface type (generalised Snell's law), to tie in with the METALENS draft
