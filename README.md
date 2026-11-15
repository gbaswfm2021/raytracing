# Ray Tracing application

A FullMeta application package for 2D geometric (sequential) ray tracing through lenses, with dispersive
materials and multiple wavelengths (Stage 1). It plugs into the existing platform **without kernel source
changes**: the kernel launches the solver through the generic `kernel.program.json` handler declared in the schema.

## Authors

Developed by **Armin Hosseinghorbani** ([@arminhgh](https://github.com/arminhgh)), University of Exeter, as the
ray-tracing application for [FullMeta](https://github.com/FullMeta-Project). FullMeta platform by Jensen Li
([@gbaswfm2021](https://github.com/gbaswfm2021)).

Released under the MIT License (see `LICENSE`).

## Files

| File | Role |
|---|---|
| `raytracing.schema.json` | Model definition (materials, wavelengths, source, surfaces, screen, settings), model tree and context menus, runtime contract: storage, registered solver exe, editor API routes |
| `package.js` | Application package. Wraps the platform's generic schema-project editor and adds the preview, Run panel, launcher profile and the "Add material from library" / spectral-line tree catalogs |
| `schema-documents.js` | Schema loader required by the catalog (records the active schema URL) |
| `materials/library.json` | Shipped material library (air, Ciddor air, N-BK7, N-SF11, fused silica, CaF2), each with its data source |
| `js/materials.js` | Dispersion formulas, Abbe numbers, wavelength → display colour |
| `js/trace2d.js` | In-browser tracer used for the live preview (same algorithm and output as the solver) |
| `js/preview.js` | Graphics pane: lens bodies, surfaces, screen, rays coloured by wavelength, a focus marker and a stats line per wavelength |
| `js/run-panel.js` | "Run native solver" panel → `POST /api/raytracing/trace` → kernel → `raytrace2d.exe --trace`; per-wavelength table, materials with Abbe numbers, chromatic focal shift |
| `solver/RayTrace2D.cs` | Native solver (C#). Reads model JSON on stdin and writes `raytrace-result/2` JSON on stdout |
| `solver/build.ps1` | Builds `.runtime/raytrace2d.exe` with the csc.exe that ships with Windows |
| `templates/lens-2d.json` | Starting model for Workspace → Create project (N-BK7 biconvex lens, F/d/C) |
| `LICENSE` | MIT License, (c) 2026 Armin Hosseinghorbani |
| `catalog.json` | Application descriptor (`fullmeta-application/1`) that makes FullMeta discover the app |
| `examples/` | Example projects, offered by the app card's **Examples** button (copied into `projects/<name>/`) |
| `tests/run.html`, `tests/*.js` | Browser checks: library data, tracer acceptance checks, editor wiring |

## Install

Copy (or clone) this folder to `applications/raytracing/` in a FullMeta workspace and refresh the launcher. The folder
name must stay `raytracing` (it must match `id` in `catalog.json`). Use **Examples** on the Ray Tracing card to create
a project from one of the examples.

Examples:
- `raytrace_biconvex_lens`: the original `raytrace-model/1` project (kept on /1 to exercise back-compatibility).
- `raytrace_singlet_bk7`: equiconvex N-BK7 singlet, f ≈ 100 mm, F/d/C.
- `raytrace_achromat_doublet`: cemented N-BK7 / N-SF11 achromat, f ≈ 100 mm, from the thin-lens achromat equations.

## Model (`raytrace-model/2`)

- `model.materials[]`: `{ id, name, formula, … }`. Formulas (λ = vacuum wavelength in µm):
  `constant` (`n`), `cauchy` (`A`, `B[]`: n = A + B1/λ² + B2/λ⁴ + …), `sellmeier` (`B[]`, `C[]` in µm²:
  n² − 1 = Σ Bi λ²/(λ² − Ci)), `gas` (`B[]`, `C[]` in µm⁻²: n − 1 = Σ Bi/(Ci − λ⁻²)). Optional `validRangeUm`
  (the tracer warns outside it) and `reference`. Library materials are **copied** into the project.
- `model.wavelengths[]`: `{ id, label, lambdaNm, weight, color? }`. Empty means the d line only.
- `surfaces[].materialAfter`: id of the material to the right of the surface; empty means the ambient medium.
- `settings.ambientMaterial`, `settings.primaryWavelength` (glass shading and headline numbers).
- `source.rayCount` is rays **per wavelength** (max 500).

**Air convention.** Glass-catalogue indices (SCHOTT) are relative to air, so the template and samples use the
library's `air` (constant n = 1). `air-ciddor` is the absolute index of standard air. Use it only with absolute
glass data, or the air/glass index ratio is off by ≈3×10⁻⁴.

**raytrace-model/1** projects still open and trace: `nAfter` and `ambientIndex` become constant materials,
and they trace at the d line only.

## Result (`raytrace-result/2`)

`rays[]` (each with `wavelength`, `status`, `points`, `screenY`, `stoppedAt`), `wavelengths[]` (refractive index after
each surface, `stats`: rays on screen, centroid, RMS spot, least-squares best focus and its RMS, paraxial focus
from a near-axis ray pair), `materials[]` (nF, nd, nC, νd), `stats` (weighted polychromatic spot and focus,
`chromaticFocalShiftMm` with `paraxialFC` and `bestFocusFC`, both F minus C and always computed at the F and C lines,
plus `rangeAll` across the model's wavelengths), `warnings[]`. All x positions are in model coordinates (mm), not
distances from a lens.

## Physics

- 2D, sequential: each ray meets the surfaces in x order. Spherical (radius R) or flat (R = 0) surfaces,
  each with a semi-aperture and the material *after* it.
- Vector Snell's law with the index of each medium evaluated at the ray's wavelength. Rays that miss an
  aperture end as `blocked`; total internal reflection ends as `tir`.

## Build / test

```
powershell -ExecutionPolicy Bypass -File applications\raytracing\solver\build.ps1
applications\raytracing\.runtime\raytrace2d.exe --trace projects\raytrace_achromat_doublet\raytrace_model.json
```

The JS checks run in any browser at http://127.0.0.1:8766/applications/raytracing/tests/run.html, or headless:

```
msedge --headless=new --user-data-dir=<temp dir> --virtual-time-budget=40000 --dump-dom http://127.0.0.1:8766/applications/raytracing/tests/run.html
```

`#summary` reads `PASS n/n`. Stage 1 numbers (JS tracer): singlet F–C paraxial focal shift −1.545 mm
(f/νd ≈ 1.56 mm), doublet −0.035 mm (≈ 44× smaller). The `/1` biconvex sample is unchanged: best focus
51.901 mm, paraxial focus 53.365 mm.

## 3D non-sequential ray tracing (`raytrace3d-model/1`)

The same app opens 3D projects whose `modelFormat` is `raytrace3d-model/1` (schema `raytracing3d.schema.json`).
Workspace → Create project → profile "3D non-sequential".

| File | Role |
|---|---|
| `raytracing3d.schema.json` | 3D model: materials, wavelengths, surface properties, objects, sources, analyses, settings; tree menus (Add Lens / Block / Cylinder / Sphere / Plate, sources, irradiance maps, surface properties, library materials) |
| `js/trace3d.js` | Engine: exact analytic faces (conic caps, cylinders, planes, spheres, convex polygons for prisms), continuous source spectra (blackbody / table, per-ray wavelength) and beam divergence, object placement (position + rotation X→Y→Z), Fresnel / mirror / absorber / A-R-T table surfaces, split or Monte Carlo ray handling, seeded RNG (xoshiro128**), irradiance maps, flux report |
| `js/trace3d-worker.js` | Runs the engine in a background worker |
| `js/view3d.js` | Self-contained WebGL viewer: semi-transparent shaded solids, rays coloured by wavelength (opacity by flux), orbit / pan / zoom |
| `js/app3d.js` | Editor integration: live preview (capped ray count) and full traces in separate workers (progress, Cancel), click-to-select, results panel with irradiance maps (power or true colour) and flux report |
| `js/layout.js` | Editor layout (app-side, platform untouched): Settings in its own resizable column next to the tree, results panel under the graphics (resized by the platform splitter). Check: `tests/ui-layout.html` |
| `js/spectra.js` | Blackbody / tabulated spectra (sampling for 3D, weighted bins for 2D), CIE 1931 colour matching → sRGB |
| `templates/nonseq-3d.json` | Starting 3D project |

Samples: `raytrace3d_singlet` (the Stage 1 singlet as a solid, with a detector at focus), `raytrace3d_parabolic_mirror`, `raytrace3d_sunlight_prism` (sunlight → rainbow),
`raytrace3d_beam_splitter`. Conventions: mm, optical axis +z, every watt ends up absorbed, escaped or lost
(below `fluxThreshold` or past `maxIntersections`). Details and check results: `docs/stage2-3d-proposal.md`.

2D projects can also use `source.spectrum` (blackbody or table), split into weighted wavelength bins.
Throughput: `tests/perf.html` (≈380,000 rays/s for the singlet). Click-to-select check: `tests/ui-click.html`.

For headless screenshots of a 3D project use `tests/open-main-thread.html?model=projects%2F<folder>%2Fraytrace_model.json`
(a throwaway browser profile only: it sets a localStorage flag that traces on the main thread).

## Workarounds for platform bugs in this build

The generic schema-project editor (`platform/ui/widgets/model-editor/schema-project-package.js`) has two bugs.
Both are patched from `package.js`; the platform files are untouched.
1. Line 138 calls an undefined `isRecord`, so every schema-only project fails with "isRecord is not defined".
   (Fixed in the Store platform 0.1.1.0; the workaround stays for older installs.)
2. It returns `uiProfileSchema: {}`, but `runtime.js` `treeUiSetting` reads `uiProfileSchema.properties.behavior...`.

## Ideas for next steps

- Stage 2 phase 3b: Lambertian / ABg scatter, surface sources, intensity plots, ray sorting, spot diagrams, STL import, polarisation
- Aspheric surfaces, mirrors (reflection), non-sequential tracing
- Spot diagram / ray-fan plots in the Results area; write run records to `raytrace_runs/`
- Port the solver to Rust to match the FEM app's toolchain
- Metalens phase profile as a surface type (generalised Snell's law), to tie in with the METALENS draft
