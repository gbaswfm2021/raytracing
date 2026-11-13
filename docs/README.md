# 3D raytracing: example model standard

This is the model format for the FullMeta 3D raytracing example.

The example traces parallel rays from a circular source through one ideal thin lens to a camera plane, and displays the paths in 3D. All positions and lengths are in millimetres. The optical axis is the positive z-axis; the source, lens and camera are centred on it and lie in planes perpendicular to it.

## Use the application

Open `projects/raytracing-lens-example/raytracing.json` in FullMeta. Select **Source**, **Lens** or **Camera** in the project tree to edit its settings. Select **Study** and click **Run Study** to save valid changes and trace the rays. Drag the Graphics Console to rotate the scene and scroll to zoom. Blue marks the source, purple the lens, green the camera plane, gold the transmitted rays and coral the blocked rays. The camera outline is a visual aid; it does not limit the plane's extent.

The latest successful result is saved in the project file. Reopening the project restores its ray paths and the geometry used for that run. After an input changes, the previous result remains visible with its original geometry and is marked stale until the next successful run. Select **Clear Results** beside **Run Study** and confirm to remove the saved result while keeping the project inputs.

## Project document

```json
{
  "application": "raytracing",
  "x-fullmeta-schema": "../../applications/raytracing/raytracing.schema.json",
  "format": "fullmeta-raytracing/1",
  "metadata": { "id": "lens-example", "name": "Lens example" },
  "model": {
    "source": { "zMm": 0, "radiusMm": 1, "samplesPerAxis": 5 },
    "lens": { "zMm": 10, "radiusMm": 2, "focalLengthMm": 30 },
    "camera": { "zMm": 40 }
  }
}
```

The schema path is relative to a project file directly inside `projects/<project-name>/`. `samplesPerAxis` controls ray density: it is the number of grid cells on each axis of the source's bounding square, not a promise of the total number of rays. Lengths and positions must be finite; both radii and the focal length must be positive. `samplesPerAxis` is an integer from 1 to 101, and source z < lens z < camera z. The metadata ID and name are nonempty strings.

## Ray definition

For `N = samplesPerAxis`, sample cell centres at `x = -r + (i + 0.5) 2r/N` and `y = -r + (j + 0.5) 2r/N`, with `i` and `j` from 0 to `N-1`. Emit a ray in the +z direction for each centre satisfying `x² + y² ≤ r²`. Process samples in increasing `j`, then increasing `i`.

The source-to-lens segment ends at `(x, y, lens.zMm)`. If `x² + y²` exceeds the squared lens radius, the ray is blocked there and has no camera hit. For a ray inside the lens aperture, use the paraxial thin-lens slopes `dx/dz = -x/f` and `dy/dz = -y/f`, where `f` is the focal length. Its camera hit is `(x - x Δz/f, y - y Δz/f, camera.zMm)`, with `Δz = camera.zMm - lens.zMm`. A boundary point belongs to the aperture. The example emits 21 rays; its camera lies at the focal plane, so every ray reaches `(0, 0, 40)`, within numerical tolerance.

## Saved result

The optional root field `raytracingResult` stores the latest successful run with the project. Its `format` is `fullmeta-raytracing-result/1`; it contains the completion time, the input `model` snapshot, and ordered `rays`. Each ray stores `start`, `lens`, `blocked` and `hit` (null for a blocked ray). The application validates the record when opening a project and restores valid ray paths in the 3D view. A new successful run replaces the saved result; **Clear Results** removes it. Run history and result export are not part of this example.

This is an ideal paraxial approximation: it does not model a lens shape, material, reflections, diffraction, polarization, intensity or wavelength. The camera is an infinite plane that records ray intersection positions, not an image sensor. Metasurfaces and spatially varying refractive-index regions are outside this first example.
