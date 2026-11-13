// Millimetres and dimensionless slopes, as defined in docs/README.md.
export function raytracingIssues(document) {
  const issues = [];
  const { source, lens, camera } = document?.model || {};
  const finite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) issues.push(`${label} must be a finite number.`);
  };
  finite(source?.zMm, 'Source position');
  finite(source?.radiusMm, 'Source radius');
  finite(lens?.zMm, 'Lens position');
  finite(lens?.radiusMm, 'Lens radius');
  finite(lens?.focalLengthMm, 'Lens focal length');
  finite(camera?.zMm, 'Camera position');
  if (Number.isFinite(source?.radiusMm) && source.radiusMm <= 0) issues.push('Source radius must be greater than zero.');
  if (Number.isFinite(lens?.radiusMm) && lens.radiusMm <= 0) issues.push('Lens radius must be greater than zero.');
  if (Number.isFinite(lens?.focalLengthMm) && lens.focalLengthMm <= 0) issues.push('Lens focal length must be greater than zero.');
  if (!Number.isInteger(source?.samplesPerAxis) || source.samplesPerAxis < 1 || source.samplesPerAxis > 101) issues.push('Samples per axis must be an integer from 1 to 101.');
  if (Number.isFinite(source?.zMm) && Number.isFinite(lens?.zMm) && source.zMm >= lens.zMm) issues.push('Source position must be before the lens.');
  if (Number.isFinite(lens?.zMm) && Number.isFinite(camera?.zMm) && lens.zMm >= camera.zMm) issues.push('Camera position must be after the lens.');
  return issues;
}

export function traceRays(document) {
  const issues = raytracingIssues(document);
  if (issues.length) throw new Error(issues[0]);
  const { source, lens, camera } = document.model;
  const rays = [], n = source.samplesPerAxis, r = source.radiusMm;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -r + (i + 0.5) * 2 * r / n;
    const y = -r + (j + 0.5) * 2 * r / n;
    if (![x, y].every(Number.isFinite)) throw new Error('Ray coordinates are not finite. Reduce the source radius.');
    if (Math.hypot(x, y) > r) continue;
    const blocked = Math.hypot(x, y) > lens.radiusMm;
    const start = [x, y, source.zMm], atLens = [x, y, lens.zMm];
    const distance = camera.zMm - lens.zMm;
    const hit = blocked ? null : [x - x * distance / lens.focalLengthMm, y - y * distance / lens.focalLengthMm, camera.zMm];
    if (hit && !hit.every(Number.isFinite)) throw new Error('Camera coordinates are not finite. Check the plane positions and focal length.');
    rays.push({ start, lens: atLens, blocked, hit });
  }
  return rays;
}

export function rayScene(model, rays = []) {
  const { source, lens, camera } = model;
  const circle = (radius, z, stroke) => ({
    type: 'polyline', closed: true, stroke, lineWidth: 2,
    points: Array.from({ length: 64 }, (_, i) => [radius * Math.cos(i * 2 * Math.PI / 64), radius * Math.sin(i * 2 * Math.PI / 64), z]),
  });
  const half = 2 * Math.max(source.radiusMm, lens.radiusMm);
  const primitives = [
    circle(source.radiusMm, source.zMm, '#65d7fa'),
    circle(lens.radiusMm, lens.zMm, '#d3a6ff'),
    { type: 'polyline', closed: true, stroke: '#8fe7bd', lineWidth: 2, points: [[-half, -half, camera.zMm], [half, -half, camera.zMm], [half, half, camera.zMm], [-half, half, camera.zMm]] },
    ...rays.map(ray => ({ type: 'polyline', points: ray.hit ? [ray.start, ray.lens, ray.hit] : [ray.start, ray.lens], stroke: ray.blocked ? '#ff9a86' : '#ffd677', lineWidth: 1.2 })),
  ];
  if (primitives.some(primitive => primitive.points.some(point => point.some(value => !Number.isFinite(value))))) throw new Error('Scene coordinates are not finite. Reduce the model dimensions.');
  return { dimension: 3, primitives };
}
