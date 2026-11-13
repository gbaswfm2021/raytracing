# Architecture

The application owns its schema, runtime package, ray calculation and mapping to the shared graphics interface. FullMeta owns project loading, saving, the Model Editor, Settings, and the shared graphics presentation. Reuse shared services rather than building a separate editor. The calculation may be a small application-local JavaScript module; save its latest result through the normal project document workflow. No native executable is required for this example.
