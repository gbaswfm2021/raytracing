// Self-contained WebGL viewer for the 3D tracer: shaded semi-transparent solids, rays, axes, orbit camera.
// It renders into its own offscreen canvas; the caller copies the image onto the editor's 2D preview canvas.

const VERTEX = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec4 aColor;
uniform mat4 uMvp; uniform vec3 uView; uniform float uLit;
varying vec4 vColor;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  float shade = uLit > 0.5 ? 0.35 + 0.65 * abs(dot(normalize(aNormal), uView)) : 1.0;
  vColor = vec4(aColor.rgb * shade, aColor.a);
}`;
const FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;

// ---- column-major 4x4 matrices ----
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = nrm(sub(eye, target)), x = nrm(crs(up, z)), y = crs(z, x);
  return { m: [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, eye), -dt(y, eye), -dt(z, eye), 1], x, y, z };
}
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

export function createViewer() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: true, premultipliedAlpha: false, alpha: false });
  if (!gl) return null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  const loc = {
    pos: gl.getAttribLocation(program, "aPos"), normal: gl.getAttribLocation(program, "aNormal"), color: gl.getAttribLocation(program, "aColor"),
    mvp: gl.getUniformLocation(program, "uMvp"), view: gl.getUniformLocation(program, "uView"), lit: gl.getUniformLocation(program, "uLit"),
  };
  const buffers = { pos: gl.createBuffer(), normal: gl.createBuffer(), color: gl.createBuffer() };

  const camera = { yaw: -0.85, pitch: 0.38, zoom: 1, pan: [0, 0, 0] };
  let lastBounds = null;

  function draw(positions, normals, colors, mode, count, lit) {
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(loc.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal); gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(loc.normal);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(loc.color);
    gl.uniform1f(loc.lit, lit ? 1 : 0);
    gl.drawArrays(mode, 0, count);
  }

  /**
   * meshes: [{ positions, normals, rgba }] (triangles, world mm); lines: [{ points: [[x,y,z]...], rgba }];
   * bounds: { min, max } of everything worth framing.
   */
  function render({ width, height, ratio = 1, meshes = [], lines = [], bounds, background = "#0c141e" }) {
    const w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    lastBounds = bounds;
    const center = bounds ? bounds.min.map((m, i) => (m + bounds.max[i]) / 2) : [0, 0, 0];
    const radius = bounds ? Math.max(1, Math.hypot(...bounds.max.map((m, i) => m - bounds.min[i])) / 2) : 50;
    const target = center.map((c, i) => c + camera.pan[i]);
    const dist = radius * 2.8 / camera.zoom;
    const eye = [target[0] + dist * Math.cos(camera.pitch) * Math.sin(camera.yaw), target[1] + dist * Math.sin(camera.pitch),
      target[2] + dist * Math.cos(camera.pitch) * Math.cos(camera.yaw)];
    const view = lookAt(eye, target, [0, 1, 0]);
    camera.axes = { x: view.x, y: view.y, dist, radius };
    camera.pick = { eye, x: view.x, y: view.y, z: view.z, tanHalf: Math.tan(35 * Math.PI / 360), aspect: w / h };
    const mvp = multiply(perspective(35 * Math.PI / 180, w / h, dist / 100, dist * 10), view.m);

    gl.viewport(0, 0, w, h);
    const [br, bg, bb] = hexToRgb(background);
    gl.clearColor(br, bg, bb, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
    gl.uniform3fv(loc.view, new Float32Array(view.z));
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // axes (x red, y green, z blue) at the origin, then rays, with depth writes on
    const L = radius * 0.25;
    const axisLines = [[[0, 0, 0], [L, 0, 0], [0.89, 0.41, 0.46, 1]], [[0, 0, 0], [0, L, 0], [0.33, 0.8, 0.72, 1]], [[0, 0, 0], [0, 0, L], [0.45, 0.62, 1, 1]]];
    let segs = axisLines.length;
    for (const line of lines) segs += Math.max(0, line.points.length - 1);
    const lp = new Float32Array(segs * 6), ln = new Float32Array(segs * 6), lc = new Float32Array(segs * 8);
    let k = 0;
    const pushSeg = (a, b, c) => { lp.set(a, k * 6); lp.set(b, k * 6 + 3); lc.set(c, k * 8); lc.set(c, k * 8 + 4); k++; };
    for (const [a, b, c] of axisLines) pushSeg(a, b, c);
    for (const line of lines) for (let i = 1; i < line.points.length; i++) pushSeg(line.points[i - 1], line.points[i], line.rgba);
    draw(lp, ln, lc, gl.LINES, k * 2, false);

    // solids: blended, no depth writes, far meshes first
    const dist2 = m => { const c = m.center; return (c[0] - eye[0]) ** 2 + (c[1] - eye[1]) ** 2 + (c[2] - eye[2]) ** 2; };
    const sorted = [...meshes].sort((a, b) => dist2(b) - dist2(a));
    gl.depthMask(false);
    for (const m of sorted) {
      const count = m.positions.length / 3;
      const colors = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) colors.set(m.rgba, i * 4);
      draw(m.positions, m.normals, colors, gl.TRIANGLES, count, true);
    }
    gl.depthMask(true);
    return canvas;
  }

  /** World-space ray { origin, dir } through a point of the element (client coordinates), for picking. */
  function rayAt(element, clientX, clientY) {
    const c = camera.pick;
    if (!c) return null;
    const rect = element.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width * 2 - 1) * c.tanHalf * c.aspect;
    const sy = (1 - (clientY - rect.top) / rect.height * 2) * c.tanHalf;
    const d = [0, 1, 2].map(i => -c.z[i] + sx * c.x[i] + sy * c.y[i]);
    const l = Math.hypot(...d);
    return { origin: c.eye, dir: d.map(v => v / l) };
  }

  /**
   * Orbit (drag), pan (shift/right drag), zoom (wheel), reset (double-click) on the given element; a click without
   * dragging calls onPick(ray).
   */
  function attach(element, redraw, onPick) {
    let drag = null;
    element.addEventListener("pointerdown", event => {
      drag = { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, pan: event.shiftKey || event.button === 2 };
      try { element.setPointerCapture?.(event.pointerId); } catch { /* synthetic or unknown pointer */ }
    });
    element.addEventListener("pointerup", event => {
      if (drag && !drag.pan && event.button === 0 && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < 4) {
        const ray = rayAt(element, event.clientX, event.clientY);
        if (ray) onPick?.(ray);
      }
    });
    element.addEventListener("pointermove", event => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      drag.x = event.clientX; drag.y = event.clientY;
      if (drag.pan && camera.axes) {
        const s = camera.axes.dist / Math.max(200, element.clientHeight) * 0.75;
        camera.pan = camera.pan.map((p, i) => p - (camera.axes.x[i] * dx - camera.axes.y[i] * dy) * s);
      } else {
        camera.yaw -= dx * 0.008;
        camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + dy * 0.008));
      }
      redraw();
    });
    const end = () => { drag = null; };
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("contextmenu", event => event.preventDefault());
    element.addEventListener("wheel", event => {
      event.preventDefault();
      camera.zoom = Math.max(0.05, Math.min(200, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
      redraw();
    }, { passive: false });
    element.addEventListener("dblclick", () => { Object.assign(camera, { yaw: -0.85, pitch: 0.38, zoom: 1, pan: [0, 0, 0] }); redraw(); });
  }

  return { render, attach, rayAt, camera, get bounds() { return lastBounds; } };
}
