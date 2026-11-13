# Acceptance

- **RT-01, RT-02:** Create or open the documented example, edit each input, save and reopen it, and confirm the values are preserved.
- **RT-03:** Run the documented example. Confirm it emits 21 rays, ordered by the specified sampling rule, and all hit `(0, 0, 40)` mm within `1e-9` mm.
- **RT-03:** Move the camera to z = 55 mm. The ray starting at `(0.8, 0, 0)` must hit `(-0.4, 0, 55)` mm within `1e-9` mm. This checks that rays are propagated beyond the focal plane.
- **RT-03:** Set the lens radius to 0.8 mm. Confirm a ray at `(0.8, 0)` passes through, while a ray at `(0.8, 0.4)` ends at the lens with no camera hit. Use the standard's inclusive aperture rule.
- **RT-04:** Inspect the source, lens, camera and ray paths in 3D; rotate and zoom the view. Edit an input and confirm the result is marked stale until rerun.
- **RT-05:** Try an invalid density, a non-positive focal length and a camera at or before the lens. Each must show a useful error and prevent the run.
- **RT-07:** Run Study, close and reopen the project, and confirm the saved rays and original geometry return in the 3D view. Change an input and confirm the restored result is marked stale until a successful rerun.
- **RT-07:** Select **Clear Results** and confirm the saved result and displayed rays are removed while source, lens and camera inputs remain. Reopen the project and confirm the result stays cleared.
- **RT-03, RT-07:** Cause tracing or result saving to fail and confirm the previous successful result remains available.
- **RT-06:** Open the raytracing application with **Edit app** in Schema Editor. Confirm the model fields and UI declarations can be inspected and edited with its structured controls, validate the schema, save it, and reopen it without losing those declarations. Record any blocking editor limitation.

Record the tested application version and observations when this example is implemented. These are target checks, not claims that it currently passes.
