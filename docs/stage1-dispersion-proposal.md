# Stage 1 proposal: full dispersion

Status: **approved 2026-11-07 (all three recommendations accepted) and implemented the same day. JS tracer verified;
C# solver ported and compiles, but not run yet (Smart App Control).** See "Implementation notes" at the end for where
the implementation differs from this proposal.

## Goal (from CLAUDE.md)
Materials library (Sellmeier/Cauchy/constant; N-BK7, N-SF11, fused silica, CaF2, air from published data), source
wavelength list (F/d/C + custom, weights), colour rays by wavelength, per-wavelength focus and RMS spot, chromatic focal
shift, Abbe numbers. Achromatic doublet sample whose focal shift is much smaller than a singlet's.

## Model: `raytrace-model/2`

```jsonc
"model": {
  "materials": [                       // new collection: the project keeps its own copies, so it's reproducible
    { "id": "N-BK7", "name": "SCHOTT N-BK7", "formula": "sellmeier",   // n²−1 = Σ B λ²/(λ² − C)
      "B": [1.03961212, 0.231792344, 1.01046945],
      "C": [0.00600069867, 0.0200179144, 103.560653],   // µm²
      "validRangeUm": [0.3, 2.5], "reference": "SCHOTT datasheet" },
    { "id": "air", "name": "Air (Ciddor 1996)", "formula": "gas",       // n−1 = Σ B/(C − λ⁻²), λ in µm
      "B": [0.05792105, 0.00167917], "C": [238.0185, 57.362] },
    { "id": "custom", "formula": "cauchy", "A": 1.5046, "B": 0.0042, "C": 0 },  // n = A + B/λ² + C/λ⁴
    { "id": "n15", "formula": "constant", "n": 1.5 }
  ],
  "wavelengths": [                     // new collection (top-level, so a future 2nd source can share it)
    { "id": "F", "label": "F", "lambdaNm": 486.1327, "weight": 1 },
    { "id": "d", "label": "d", "lambdaNm": 587.5618, "weight": 1 },
    { "id": "C", "label": "C", "lambdaNm": 656.2725, "weight": 1 }
    // optional "color": "#rrggbb" override; otherwise the colour comes from λ
  ],
  "source":   { "...": "...", "rayCount": 11 },     // now counts rays per wavelength (cap 500 each)
  "surfaces": [ { "id": "s1", "name": "...", "x": 0, "radius": 50, "semiAperture": 12,
                  "materialAfter": "N-BK7" } ],     // replaces nAfter
  "screen":   { "...": "..." },
  "settings": { "ambientMaterial": "air", "primaryWavelength": "d" }  // replaces ambientIndex
}
```

- **Surface → material link:** `materialAfter` and `ambientMaterial` use `x-fullmeta-modelReference`
  (`scope: "model"`, `targetPath: ["model","materials"]`, `targetProperty: "id"`). FEM's schema uses the same
  annotation (`applications/fem/fem.schema.json`). Still to check: does the generic schema-project editor show it as a
  dropdown? If not, it falls back to an id text field.
- **Built-in library:** ship `materials/library.json` with N-BK7, N-SF11, fused silica (Malitson 1965), CaF2
  (Malitson 1963) and air (Ciddor 1996), each with its source cited. A tree action, "Add material from library",
  copies one into the project. The template and samples start with the materials they use.
  Check every coefficient set against the catalogue nd before relying on it
  (N-BK7 1.5168, N-SF11 1.78472, fused silica 1.4585, CaF2 1.4338).
- **Old projects:** both tracers still read `raytrace-model/1`. They turn `nAfter` and `ambientIndex` into constant
  materials and use a single wavelength.
- **Tree:** adds Materials and Wavelengths collection nodes with Add actions, alongside the existing four nodes.

## Result: `raytrace-result/2`

```jsonc
{
  "schema": "raytrace-result/2",
  "rays": [ { "wavelength": "F", "status": "screen", "points": [], "screenY": 0, "stoppedAt": null } ],
  "wavelengths": [ { "id": "F", "lambdaNm": 486.1327, "weight": 1, "color": "#...",
      "indices": { "<surfaceId>": 1.5224 },        // n after each surface at this λ
      "stats": { "raysOnScreen": 0, "screenCentroidMm": 0, "screenRmsSpotMm": 0,
                 "bestFocusXmm": 0, "bestFocusRmsMm": 0,   // least-squares waist, as now
                 "paraxialFocusXmm": 0 } } ],               // from a near-axis ray, h = 0.01 mm
  "materials": [ { "id": "N-BK7", "nF": 0, "nd": 0, "nC": 0, "abbeVd": 0 } ],  // νd = (nd−1)/(nF−nC), always F/d/C lines
  "stats": { "polychromaticRmsSpotMm": 0,          // weighted
             "polychromaticBestFocusXmm": 0,
             "chromaticFocalShiftMm": { "paraxialFC": 0, "bestFocusFC": 0, "rangeAll": 0 } },
  "warnings": [ "λ = 300 nm outside the N-SF11 valid range" ]
}
```

The chromatic focal shift is reported **paraxially** (the textbook definition, without spherical aberration mixed in)
and at **best focus** (what you'd actually see on the screen).

## Preview, samples and checks
- **Preview:** rays coloured by wavelength, a focus marker per wavelength, a stats line per wavelength.
- **Run panel:** a table with one row per wavelength, plus the materials and their Abbe numbers.
- **Samples:**
  - `raytrace_singlet_bk7`: singlet, f ≈ 100 mm.
  - `raytrace_achromat_doublet`: cemented N-BK7/N-SF11 doublet, f ≈ 100 mm, designed from the thin-lens achromat
    equations.
- **Acceptance checks:**
  - Singlet F–C paraxial focal shift ≈ f/νd ≈ 1.6 mm.
  - Doublet shift < 1/10 of the singlet's.
  - `js/trace2d.js` and `solver/RayTrace2D.cs` agree to ~1e-9 (needs the exe to run; see Smart App Control in
    CLAUDE.md).

## Open decisions (ask Armin before coding)
1. Bump the model format to `raytrace-model/2` with /1 back-compatibility (recommended), or keep /1 and add fields?
2. Copy library materials into each project (recommended), or reference the shipped library directly?
3. Wavelengths as a top-level `model.wavelengths` collection (recommended), or nested under `model.source`?

**Decisions (Armin, 2026-11-07):** 1. `raytrace-model/2` with /1 back-compat. 2. Copy library materials into each
project. 3. Top-level `model.wavelengths`. Smart App Control left on: JS-only testing for now.

## Implementation notes (2026-11-07)

Differences from the proposal above:
- **Cauchy coefficients:** `A` (number) plus a `B` array, n = A + B1/λ² + B2/λ⁴ + …, instead of scalar `B` and `C`.
  This keeps `B` an array for every formula, so the schema needs no per-formula variants.
- **Air:** the library has `air` (constant n = 1, the glass-catalogue convention) and `air-ciddor` (absolute,
  Ciddor 1996). SCHOTT indices are relative to air, so pairing them with absolute air would put the air/glass index
  ratio off by ≈3×10⁻⁴. The template and samples use `air`.
- **Schema accepts both formats:** `modelFormat` is an enum of /2 and /1. `nAfter` and `ambientIndex` stay declared
  (marked "raytrace-model/1") so old projects remain editable. The tracers don't branch on `modelFormat`. For each
  surface, a non-empty `materialAfter` wins, else a numeric `nAfter`, else the ambient medium. An empty
  `materialAfter` therefore means "ambient", which is what Add Surface creates.
- **Extra result fields:** `primaryWavelength`, `wavelengths[].label`, `stats.rayCount` per wavelength,
  `stats.polychromaticCentroidMm`, `stats.polychromaticBestFocusRmsMm`.
- **Chromatic shift sign and lines:** values are F minus C (negative for a positive singlet). `paraxialFC` and
  `bestFocusFC` are always traced at the F and C lines, whatever the model's wavelength list. `rangeAll` uses the
  model's own wavelengths.
- **Paraxial focus:** the intersection of the final central ray and a near ray (h = 0.01 mm for collimated sources,
  1e-4 rad for point sources). This also works for tilted beams and gives a virtual focus for negative lenses.
- **Tree:** right-click Materials → one "Add … (library)" entry per library material plus "Add custom material".
  Right-click Wavelengths → h/g/F/e/d/C/r spectral lines plus "Add custom wavelength". A library copy whose id is
  already taken gets `-2`, `-3`, …
- **Preview:** additive blending, so coincident wavelengths draw white and separated ones show colour. Selecting a
  wavelength in the tree fades the others.

Results (JS tracer, `tests/run.html`, 27/27 checks pass):
- Library nd and νd match the catalogues: N-BK7 1.51680 / 64.17, N-SF11 1.78472 / 25.68,
  fused silica 1.45846 / 67.82, CaF2 1.43385 / 95.00. Ciddor air (n − 1)·10⁴ = 2.77.
- Singlet (R = ±103.4 mm, 5 mm): paraxial F–C shift −1.545 mm vs f/νd = 1.558 mm.
- Doublet (R = 62 / −62 / −131.1 mm, 6 + 3 mm): −0.035 mm, about 44× smaller than the singlet.
- The /1 biconvex sample is unchanged (best focus 51.901 mm). Its paraxial focus, 53.365 mm, matches the hand
  value of ≈53.4 mm.
- Still to do: JS ↔ C# agreement (~1e-9) once `raytrace2d.exe` can run; CLI and kernel-route checks; clicking
  through the dropdown and context menus by hand (only their wiring is tested, via `tests/editor-checks.js`).
