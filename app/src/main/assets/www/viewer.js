// Minimal WebGL viewer for binary STL. Drag to rotate, pinch or wheel to zoom.
"use strict";
function StlViewer(canvas) {
  const gl = canvas.getContext("webgl", { antialias: true });
  this.ok = !!gl;
  if (!gl) return;

  const VS =
    "attribute vec3 aPos; attribute vec3 aN;" +
    "uniform mat3 uR; uniform vec3 uC; uniform float uRad, uZoom, uAspect;" +
    "varying vec3 vN;" +
    "void main(){ vec3 r = uR * ((aPos - uC) / uRad); vN = uR * aN;" +
    "gl_Position = vec4(r.x * uZoom / uAspect, r.y * uZoom, -r.z * 0.9, 1.0); }";
  const FS =
    "precision mediump float; varying vec3 vN;" +
    "void main(){ float d = abs(dot(normalize(vN), normalize(vec3(0.35, 0.55, 1.0))));" +
    "gl_FragColor = vec4(vec3(0.96, 0.70, 0.0) * (0.22 + 0.78 * d), 1.0); }";

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const aPos = gl.getAttribLocation(prog, "aPos"), aN = gl.getAttribLocation(prog, "aN");
  const U = {};
  ["uR", "uC", "uRad", "uZoom", "uAspect"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
  const buf = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.05, 0.06, 0.07, 1);

  let count = 0, center = [0, 0, 0], radius = 1;
  let yaw = -0.6, pitch = 0.5, zoom = 0.85, dirty = false;

  const draw = () => {
    dirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!count) return;
    // View = Rx(pitch - 90deg) * Rz(yaw): OpenSCAD's Z axis points up on screen.
    const c = Math.cos(yaw), s = Math.sin(yaw), b = pitch - Math.PI / 2;
    const cb = Math.cos(b), sb = Math.sin(b);
    gl.uniformMatrix3fv(U.uR, false, [c, cb * s, sb * s, -s, cb * c, sb * c, 0, -sb, cb]);
    gl.uniform3fv(U.uC, center);
    gl.uniform1f(U.uRad, radius);
    gl.uniform1f(U.uZoom, zoom);
    gl.uniform1f(U.uAspect, w / h);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  };
  const invalidate = () => { if (!dirty) { dirty = true; requestAnimationFrame(draw); } };
  this.redraw = invalidate;

  // bytes: Uint8Array holding a binary STL file.
  this.setMesh = (bytes) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.min(dv.getUint32(80, true), Math.floor((bytes.byteLength - 84) / 50));
    const data = new Float32Array(n * 18);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const v = new Float32Array(9);
    for (let i = 0, o = 84, p = 0; i < n; i++, o += 50) {
      for (let k = 0; k < 9; k++) {
        const x = dv.getFloat32(o + 12 + k * 4, true);
        v[k] = x;
        if (x < lo[k % 3]) lo[k % 3] = x;
        if (x > hi[k % 3]) hi[k % 3] = x;
      }
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
      const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let k = 0; k < 3; k++) {
        data[p++] = v[k * 3]; data[p++] = v[k * 3 + 1]; data[p++] = v[k * 3 + 2];
        data[p++] = nx; data[p++] = ny; data[p++] = nz;
      }
    }
    count = n * 3;
    if (n) {
      center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 24, 12);
    zoom = 0.85;
    invalidate();
    return { triangles: n, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  };

  // Gestures
  const pts = new Map();
  let pinch = 0;
  const dist = () => { const a = [...pts.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) pinch = dist();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) {
      yaw += dx * 0.01;
      pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + dy * 0.01));
    } else if (pts.size === 2) {
      const d = dist();
      if (pinch > 0) zoom = Math.max(0.1, Math.min(20, (zoom * d) / pinch));
      pinch = d;
    }
    invalidate();
  });
  const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom = Math.max(0.1, Math.min(20, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    invalidate();
  }, { passive: false });
  if (window.ResizeObserver) new ResizeObserver(invalidate).observe(canvas);
  window.addEventListener("resize", invalidate);
  invalidate();
}
