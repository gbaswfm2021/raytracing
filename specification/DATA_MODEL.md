# Data model

The [public model standard](../docs/README.md) owns the project format, units, sample generation and equations. Persist the project inputs in the normal FullMeta project JSON and preserve them on save and reopen. A project has exactly one source, lens and camera.

The single Study is a fixed UI action bound to `/model`; it has no separate stored settings or identity. Ray paths, blocked status and camera hits are calculated state, not optical inputs. The optional root `raytracingResult` field stores the latest successful result in `fullmeta-raytracing-result/1` format: `completedAt`, the exact input `model` snapshot, and ordered ray records (`start`, `lens`, `blocked`, and `hit`). It is restored when the project opens. Clearing results removes this field; a new successful run replaces it. No run history is required.
