# Stage 2 proposal: 3D non-sequential ray tracing

Status: **approved 2026-11-07, all four recommendations accepted.** Non-sequential engine, inside the `raytrace`
app (second schema), JS engine only for now, own WebGL viewer. Phase 3a in progress.

## What changes compared with the earlier Stage 2 plan
CLAUDE.md planned Stage 2 as *sequential* 3D lens design: surfaces met in a fixed order, conics, spot diagrams.
Armin has now asked for an illumination/stray-light tracer in the style of commercial tools such as TracePro. That
means a **non-sequential** engine:
- Rays hit **solid objects** in whatever order the geometry dictates.
- Rays can reflect, refract, split (Fresnel) and scatter.
- Results are **flux** at detectors (irradiance maps, intensity, a flux report per object), not only focus and
  spot size.

A sequential lens is a special case of this: a few solids in a row. So the 3D engine also covers the Stage 2 lens
checks (lensmaker's equation, parabolic mirror). The 2D app stays as it is.

## Engine (phase 3a)
- **Geometry:** solid objects, each made of exact analytic faces, so lenses don't need tessellating.
  - `lens`: two conic caps (radius + conic constant, 0 = flat) + a cylindrical edge, centre thickness, diameter.
  - `block` (box), `cylinder`, `sphere`, `plate` (thin rectangle or disk: a mirror, a detector or a stop with no
    volume).
  - Each object has a `position` [x, y, z] (mm) and `rotationDeg` [rx, ry, rz] (applied X then Y then Z, about the
    object's own origin).
  - Later: torus, extruded and revolved profiles, STL/OBJ mesh import. CAD (STEP) import isn't feasible without a
    CAD kernel.
- **Media:** each solid has a material from the Stage 1 material system (the same formulas and library, copied into
  the project). The space between objects is `settings.ambientMaterial`. Objects must not overlap (checked, with a
  warning).
- **Surface properties:** a named list. Each object has a default, and individual faces can override it:
  - `fresnel` (default for glass): uncoated dielectric, unpolarised Fresnel R/T, with total internal reflection.
  - `mirror`: specular reflectance R, absorbs the rest.
  - `absorber`: absorbs everything.
  - `table`: fixed absorptance A, specular reflectance R and specular transmittance T (A + R + T = 1). Useful for
    coatings or a beam splitter.
  - Phase 3b: `lambertian` and `abg` (Harvey ABg) scatter, angle-dependent coatings, polarisation.
- **Ray handling:** each ray carries a flux in W and a wavelength. At a face, choose one of:
  - **Split:** the reflected and transmitted children both continue (TracePro-style). Exact, but more rays.
  - **Monte Carlo:** pick one branch with probability R or T. Faster, noisier.

  The setting is `settings.rayHandling: "split" | "monteCarlo"`. Rays stop below `settings.fluxThreshold`
  (a fraction of the starting flux) or after `settings.maxIntersections`. Their flux is booked as "lost", so the
  energy balance stays exact.
- **Sources:**
  - `grid`: a collimated beam over a rectangle or circle, regular or random sampling.
  - `point`: isotropic or into a cone.
  - `surface`: Lambertian emission from an object face (phase 3b).

  Each source has a power in W, a ray count, and the project's wavelength list with its weights. A **seeded random
  generator** (xorshift128+) makes every run reproducible, so two solvers can compare results exactly.
- **Detectors and analysis:**
  - Any face can be a detector. An `analyses` list declares an **irradiance map**: object + face, pixel grid
    nx × ny, area, smoothing off. The output is W/mm² per pixel, total flux, peak and centroid.
  - A **flux report** for every object and face: incident, absorbed, reflected, transmitted.
  - Run totals: emitted = absorbed + escaped + lost.
  - Phase 3b: polar **intensity** (candela-style, W/sr) for rays leaving the system, ray sorting ("rays that hit
    object A then B"), spot diagram per wavelength for imaging systems.

## Model: `raytrace3d-model/1`

```jsonc
"model": {
  "materials":   [ /* same as raytrace-model/2 */ ],
  "wavelengths": [ /* same as raytrace-model/2 */ ],
  "surfaceProperties": [
    { "id": "glass",  "kind": "fresnel" },
    { "id": "silver", "kind": "mirror", "reflectance": 0.96 },
    { "id": "black",  "kind": "absorber" },
    { "id": "split",  "kind": "table", "absorptance": 0.02, "reflectance": 0.49, "transmittance": 0.49 }
  ],
  "objects": [
    { "id": "lens1", "name": "Singlet", "kind": "lens",
      "position": [0, 0, 0], "rotationDeg": [0, 0, 0],
      "material": "N-BK7", "surfaceProperty": "glass",
      "lens": { "radius1": 103.4, "conic1": 0, "radius2": -103.4, "conic2": 0, "thickness": 5, "diameter": 25 },
      "faceProperties": { "edge": "black" } },
    { "id": "det", "name": "Detector", "kind": "plate", "position": [0, 0, 103], "rotationDeg": [0, 0, 0],
      "plate": { "shape": "rectangle", "width": 10, "height": 10 }, "surfaceProperty": "black" }
  ],
  "sources": [
    { "id": "src1", "name": "Collimated beam", "kind": "grid", "position": [0, 0, -20], "direction": [0, 0, 1],
      "grid": { "shape": "circle", "diameter": 20, "sampling": "random" }, "powerW": 1, "rayCount": 10000 }
  ],
  "analyses": [
    { "id": "irr1", "kind": "irradiance", "object": "det", "face": "front", "pixels": [101, 101] }
  ],
  "settings": { "ambientMaterial": "air", "rayHandling": "split", "fluxThreshold": 1e-4,
                "maxIntersections": 200, "randomSeed": 1, "displayRays": 300 }
}
```
- The optical axis is **+z** (the usual 3D optics convention). The 2D app's x axis maps to z.
- Every id reference (material, surface property, object in an analysis) uses `x-fullmeta-modelReference`, as in
  Stage 1, so each shows as a dropdown.
- Tree: Materials, Wavelengths, Surface properties, Objects, Sources, Analyses, Settings. Right-click Objects →
  Add Lens / Block / Cylinder / Sphere / Plate. Right-click Materials → library, as in Stage 1.

## Result: `raytrace3d-result/1`

```jsonc
{
  "schema": "raytrace3d-result/1",
  "totals": { "emittedW": 1, "absorbedW": 0, "escapedW": 0, "lostW": 0, "raysTraced": 0, "segments": 0 },
  "objects": [ { "id": "lens1", "faces": { "front": { "incidentW": 0, "absorbedW": 0 } } } ],
  "analyses": [ { "id": "irr1", "kind": "irradiance", "pixels": [101, 101], "extentMm": [-5, 5, -5, 5],
                  "wPerMm2": [/* nx*ny, row-major */], "totalW": 0, "peakWPerMm2": 0, "centroidMm": [0, 0] } ],
  "displayRays": [ { "wavelength": "d", "fluxW": 0, "points": [[0, 0, -20], "…"], "fate": "absorbed:det" } ],
  "warnings": []
}
```
Only `settings.displayRays` paths are returned for drawing. Analyses use every ray.

## Solver and viewer
- **Engine in JS**, run in a **Web Worker** so the editor stays responsive. With 10⁴–10⁶ rays a Monte Carlo
  trace takes seconds in the browser, and it works now despite Smart App Control.
- Native solver: the C# port (same seeded RNG, same output) to be decided below. Keeping two engines in sync at this
  size roughly doubles the work.
- **3D viewer:** a self-contained WebGL renderer with no CDN (loads offline): shaded, semi-transparent solids from the
  analytic faces, rays coloured by wavelength or flux, orbit/pan/zoom, click to select (highlights the tree item).
  Irradiance maps as a false-colour image with a colour bar and x/y profiles, drawn in a results panel.
  The platform's `scene-view` (Canvas 2D, orthographic, no shading or depth buffer) isn't enough for shaded solids,
  so it isn't used here.

## Checks (acceptance for phase 3a)
- **2D ↔ 3D:** the Stage 1 singlet built in 3D. Meridional rays reproduce the 2D tracer's focus (paraxial and best
  focus per wavelength) to ~1e-9 mm.
- **Lensmaker:** thin lens f within 0.1 % of 1/f = (n − 1)(1/R1 − 1/R2) (thick-lens formula for a real
  thickness).
- **Parabolic mirror** (conic −1): a collimated on-axis beam focuses to a point; RMS spot < 1e-9 mm at f = R/2.
- **Fresnel:** normal incidence on glass reflects ((n − 1)/(n + 1))² (4.21 % for n = 1.5168). Total internal
  reflection beyond the critical angle.
- **Energy:** emitted = absorbed + escaped + lost, to 1e-12 relative, in split and Monte Carlo modes.
- **Irradiance:** a uniform collimated beam on a detector gives the expected W/mm² within Monte Carlo noise
  (∝ 1/√N). Inverse-square law for a point source.

## Phasing
- **3a (this proposal):** engine core, lens/block/cylinder/sphere/plate, fresnel/mirror/absorber/table, grid and
  point sources, irradiance maps, flux report, WebGL viewer, samples (3D singlet, parabolic mirror, beam splitter
  and two detectors), checks above.
- **3b:** Lambertian/ABg scatter, surface sources, intensity plots, ray sorting, spot diagrams, STL import,
  polarisation.

## Open decisions (ask Armin before coding)
1. **Scope:** a non-sequential engine (this proposal, recommended), or the original sequential 3D lens-design Stage 2?
2. **Where it lives:** the catalog maps one app id to one schema, and a runtime package is loaded from
   `applications/<id>/`. Options:
   - (a) Stay in the `raytrace` app and this repo (recommended). Add a second schema file
     `raytrace3d.schema.json`, which 3D projects point to. `package.js` switches on `modelFormat`, the launcher
     offers "2D lens system" and "3D non-sequential", and `materials.js` is shared.
   - (b) A separate app id `raytrace3d` in `applications/raytrace3d/`: its own folder and repo, plus a catalog entry.
3. **Native solver:** JS engine only for now and a C# port later (recommended while Smart App Control blocks the
   exe), or JS and C# kept in sync from the start?
4. **Viewer:** a self-contained WebGL renderer written here (recommended), or vendor three.js (MIT licence,
   about 600 kB, faster to build with)?

## Implementation notes, phase 3a (2026-11-07)

Files: `raytrace3d.schema.json`, `js/trace3d.js` (engine), `js/trace3d-worker.js`, `js/view3d.js` (WebGL),
`js/app3d.js` (editor integration), `templates/nonseq-3d.json`, samples `raytrace3d_singlet`,
`raytrace3d_parabolic_mirror` and `raytrace3d_beam_splitter`, plus `tests/checks3d.js`. `package.js` switches on
`modelFormat`, and Workspace → Create project offers "2D lens system" and "3D non-sequential".

Differences from the proposal and other notes:
- **Wavelengths:** `rayCount` is rays per source **per wavelength** (as in 2D). Each ray position is traced at
  every wavelength with flux = power × weight / Σweights / rays.
- **Overlap check:** not implemented. A cheap bounding-box check gives false alarms on cemented lenses, whose
  curved faces make the boxes overlap. Nested solids aren't supported either: leaving a solid always enters the
  ambient medium unless another solid's face coincides (within 1e-7 mm), which is how cemented interfaces work.
- **Plates** are two-sided and have no volume. `fresnel` on a plate passes light unchanged; `table` transmission
  through a plate keeps the direction.
- **Irradiance** counts every ray meeting the face, from either side (the flux report has the same convention).
  Lens caps are mapped by their projected x, y. A face with no flat chart (sphere) needs `sizeMm`.
- **Click to select** in the 3D view isn't done yet. Selecting an object in the tree highlights it in the view.
- **Worker:** the main thread waits for the worker's `ready` message before posting. Messages sent while a module
  worker is still loading its imports are lost (found while testing). If the worker doesn't start within 2.5 s,
  tracing falls back to the main thread. The overlay says which one ran.
- **Testing headless:** Edge's virtual clock runs out before a worker finishes, so screenshots use
  `tests/open-main-thread.html?model=…`. It sets `localStorage.raytraceWorker = "off"`, because the editor
  loader drops unknown URL parameters. Use it only in a throwaway browser profile.

Results (`tests/run.html`, 51/51 checks pass):
- **3D singlet vs the 2D tracer:** 33 rays at F, d and C agree to 3.9e-15 mm at the screen.
- **Lensmaker (thick lens, d line):** EFL 100.86964 mm, 1.4e-10 relative to the formula.
- **Parabolic mirror:** axis crossings at z = −100 mm within 4.3e-14 mm; a skew ray misses the focus by 4e-15 mm.
- **Fresnel:** at normal incidence R = ((n−1)/(n+1))² exactly. Total internal reflection beyond the critical angle.
- **Energy balance:** split and Monte Carlo, for all three samples, to 1e-12 relative.
- **Beam splitter:** 0.49 / 0.49 W at the two detectors and 0.02 W absorbed, exactly in split mode.
- **Uniform beam irradiance:** 1/(100π) W/mm² within 1 %.
- **Inverse-square law:** E(100 mm)/E(200 mm) = 4.003.
- **Reproducibility:** seeded runs repeat exactly.
- **Singlet as a system:** about 8.3 % of the light escapes backwards as Fresnel ghosts (two uncoated surfaces
  at ≈4.2 % each), which the split mode shows directly.

Still to do in 3a: click-to-select in the view, the overlap warning, a manual check of the 3D tree menus in the
browser (their wiring is tested in `tests/editor-checks.js`), and a check of large runs (10⁶ rays) in the worker.

## Additions after Armin's feedback (2026-11-07)

- **Continuous spectra (sunlight).** `source.spectrum` is one of:
  - `{ kind: "wavelengths" }` (default): the project's wavelength list, now up to 64 entries.
  - `{ kind: "blackbody", temperatureK, minNm, maxNm }`: Planck's law.
  - `{ kind: "table", points: [[nm, value], …] }`: e.g. measured AM1.5 data.

  For blackbody and table, each ray draws its own wavelength from the spectrum (inverse CDF on 4096 points, seeded
  RNG, equal flux per ray). Every refraction uses that wavelength's index, and the ray is drawn in its own colour.
  Valid-range warnings cover the whole spectral range. The Sources menu has "Add sunlight (5778 K blackbody,
  ±0.27°)", covering 300–2500 nm.
- **Divergence:** `grid.divergenceHalfAngleDeg` tilts each collimated ray at random within a cone (the sun's disc
  is ±0.267°).
- **Prism object kind:** an isosceles triangular prism (apex angle, face length, height) with faces entrance, exit,
  base, top and bottom (general convex polygon faces). New sample `raytrace3d_sunlight_prism`: visible sunlight
  (380–780 nm) through a 60° N-SF11 prism at minimum deviation, giving a continuous spectrum on a screen.
- **Tree right-click on items:** Duplicate, Rename and Delete in both 2D and 3D. Wavelengths have no Rename,
  because they use `label`. The menus use the editor's built-in `delete`/`rename` and an insertion with
  `$copy: item` (the editor assigns new ids). Item rules come before collection rules (first match wins); before
  this, right-clicking an item showed the collection's "Add …" menu. Deleting a material or surface property that
  something still uses makes the preview report "refers to unknown …" until the reference is changed.
- **Checks (59/59):**
  - Blackbody sampler: peak at Wien's λmax ± 15 nm; visible-band fraction 0.4989 sampled vs 0.4982 by Simpson
    integration of Planck's law.
  - Flat table spectrum: mean 550.3 nm.
  - Prism: deviation matches 2·asin(n sin(α/2)) − α to 3e-6°, and F > d > C.
  - Prism energy balance, item menus, sunlight and prism templates.
- **Not done:** the irradiance map shows power, not colour (a true-colour map via CIE colour matching would be
  next). No AM1.5 table ships yet (ASTM G173 data could be added as a library spectrum). The 2D app still uses
  discrete wavelengths only.

## Follow-up items done (2026-11-07)

- **True-colour irradiance maps.** Each map also accumulates CIE 1931 XYZ per pixel (flux × colour-matching
  functions, using the analytic fit of Wyman, Sloan & Shirley, JCGT 2013). The panel has a Power / True colour
  switch (XYZ → linear sRGB, negatives clipped, brightest pixel at full scale, sRGB gamma). `analyses[].display:
  "color"` opens a map in true colour; the prism sample does.
- **2D spectra.** `source.spectrum` (blackbody / table, `bins`) replaces the Wavelengths list with equal-width
  bins weighted by band power (Simpson integration), so per-wavelength focus, RMS spot and F–C shift still apply.
  The strongest band becomes primary. Shared code is in `js/spectra.js`, mirrored in C# (`Spectra.Bin`; it
  compiles but can't run yet). The 2D preview caption shows at most 6 wavelengths.
- **Click-to-select in the 3D view.** A click without dragging casts a ray from the camera (`pickObject` in the
  engine) and clicks the matching tree item, expanding the Objects branch if it's collapsed. The overlay names
  the picked object and face. Checked in the real editor with `tests/ui-click.html`.
- **Overlap warning.** Triangle centres of each solid are projected onto the exact analytic surface (a flat
  triangle's centre sits ~0.003 mm off a curved face, which caused false alarms on a cemented doublet), moved
  1e-4 mm inwards, and tested against the other solids by crossing parity.
- **Large runs.**
  - `tests/perf.html` (real time): ≈380,000 launched rays/s (1.9 million surface interactions/s) for the singlet,
    ≈200,000 rays/s for the prism. So 10⁶ rays × 3 wavelengths takes about 8 s.
  - Full traces run in their own worker, so editing and the preview stay live, with progress (%) and Cancel
    (which restarts the worker).
- **AM1.5 (ASTM G173): not shipped.** The official tables are sold by ASTM, and NREL's free copy is offline.
  Whether a copy may go into an open-source repo is for Armin and the supervisor to decide. Any table can be
  used as a `table` spectrum.
- **Checks: 65/65.** CIE/sRGB sanity; true-colour map puts blue where the F line lands; 2D bin weights match
  Planck band integrals (1e-6); overlap warning yes/no; picking; 300,000-ray run.
