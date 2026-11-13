# Requirements

- **RT-01:** Edit and save a project containing one source, one ideal thin lens and one camera plane as defined in the [model standard](../docs/README.md).
- **RT-02:** Set source radius and ray density, lens position, radius and focal length, and source and camera positions.
- **RT-03:** Run a Study that traces the rays according to the standard and identifies blocked rays and camera intersections.
- **RT-04:** Display the source, lens, camera plane and traced ray paths in a rotatable 3D view. Show blocked rays ending at the lens plane.
- **RT-05:** Include the example project from the standard at `projects/raytracing-lens-example/raytracing.json` and report invalid inputs without running.
- **RT-06:** Create and maintain the application schema with FullMeta's Schema Editor, using its structured controls for the model and editor declarations. Use the shared Model Editor for project editing.
- **RT-07:** Save the latest successful result with the project, restore it when the project opens, mark it stale when inputs change, and provide **Clear Results** beside **Run Study**.

One centred, axis-aligned lens and parallel source are sufficient. Metasurfaces, index gradients, multiple optical elements and rendered camera images are out of scope.
