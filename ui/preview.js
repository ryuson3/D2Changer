/* The hero preview window: a small WebGL2 viewer. It draws what src/preview.ts built (the hero's meshes
 * with the colour map of each material) with a head light, and turns with the mouse: drag to turn,
 * wheel to come closer, double-click to start over. No library: the scene is a few dozen triangle lists.
 * Models are Z-up and the hero faces +X. */
(function () {
  'use strict';

  const VERT = `#version 300 es
    in vec3 aPos; in vec3 aNormal; in vec2 aUv;
    uniform mat4 uView; uniform mat4 uProj;
    out vec3 vNormal; out vec2 vUv;
    void main() {
      vec4 p = uView * vec4(aPos, 1.0);
      vNormal = mat3(uView) * aNormal;
      vUv = aUv;
      gl_Position = uProj * p;
    }`;
  const FRAG = `#version 300 es
    precision mediump float;
    in vec3 vNormal; in vec2 vUv;
    uniform sampler2D uTex; uniform float uHasTex;
    out vec4 outColor;
    void main() {
      vec4 c = uHasTex > 0.5 ? texture(uTex, vUv) : vec4(0.72, 0.74, 0.78, 1.0);
      if (c.a < 0.5) discard;
      vec3 n = normalize(vNormal);
      float head = abs(n.z);                                   // view space: the light sits at the camera
      float key = abs(dot(n, normalize(vec3(-0.4, 0.6, 0.7))));
      float light = 0.38 + 0.42 * head + 0.3 * key;
      outColor = vec4(c.rgb * light, 1.0);
    }`;

  // ----- 4x4 matrices, column-major -----
  const mul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  };
  const perspective = (fov, aspect, near, far) => {
    const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  };
  const lookAt = (eye, target, up) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }

  function start(canvas, scene) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL недоступен');
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program');
    gl.useProgram(prog);
    const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNormal'), uv: gl.getAttribLocation(prog, 'aUv'),
      view: gl.getUniformLocation(prog, 'uView'), proj: gl.getUniformLocation(prog, 'uProj'), tex: gl.getUniformLocation(prog, 'uTex'), has: gl.getUniformLocation(prog, 'uHasTex') };

    const textures = scene.textures.map((t) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.width, t.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(t.rgba));
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      return tex;
    });
    const buf = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    const parts = scene.parts.map((p) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const attr = (index, data, size) => { buf(gl.ARRAY_BUFFER, new Float32Array(data)); gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0); };
      attr(loc.pos, p.positions, 3); attr(loc.nor, p.normals, 3); attr(loc.uv, p.uvs, 2);
      buf(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(p.indices));
      return { vao, count: p.indices.length, texture: p.texture };
    });
    gl.bindVertexArray(null);

    const centre = [0, 1, 2].map((i) => (scene.min[i] + scene.max[i]) / 2);
    const size = Math.max(scene.max[0] - scene.min[0], scene.max[1] - scene.min[1], scene.max[2] - scene.min[2]) || 100;
    const home = { yaw: 0.45, pitch: 0.12, dist: size * 1.9 };
    const cam = { ...home };
    let raf = 0, alive = true;

    function draw() {
      raf = 0;
      if (!alive) return;
      const w = canvas.clientWidth, h = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      // cleared to nothing: the picture behind the canvas (app.css) shows through
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const eye = [centre[0] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw), centre[1] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), centre[2] + cam.dist * Math.sin(cam.pitch)];
      gl.uniformMatrix4fv(loc.view, false, lookAt(eye, centre, [0, 0, 1]));
      gl.uniformMatrix4fv(loc.proj, false, perspective(0.62, canvas.width / Math.max(1, canvas.height), size * 0.05, size * 12));
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc.tex, 0);
      for (const p of parts) {
        gl.uniform1f(loc.has, p.texture >= 0 ? 1 : 0);
        if (p.texture >= 0) gl.bindTexture(gl.TEXTURE_2D, textures[p.texture]);
        gl.bindVertexArray(p.vao);
        gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
      }
    }
    const redraw = () => { if (!raf && alive) raf = requestAnimationFrame(draw); };

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      cam.yaw -= (e.clientX - drag.x) * 0.008;
      cam.pitch = Math.max(-1.3, Math.min(1.3, cam.pitch + (e.clientY - drag.y) * 0.008));
      drag = { x: e.clientX, y: e.clientY };
      redraw();
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.max(size * 0.4, Math.min(size * 6, cam.dist * Math.exp(e.deltaY * 0.001))); redraw(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { Object.assign(cam, home); redraw(); });
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    redraw();

    return () => {
      alive = false; resize.disconnect();
      if (raf) cancelAnimationFrame(raf);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    };
  }

  let close = null;

  /** @param data {scene, name} what the main process built for one hero */
  function open(data) {
    if (close) close();
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    const overlay = el('div', 'overlay');
    const box = el('div', 'sheet preview-box');
    const canvas = el('canvas', 'preview-canvas');
    const notes = data.scene.notes || [];
    const stop = { fn: null };
    close = () => { if (stop.fn) stop.fn(); overlay.remove(); document.removeEventListener('keydown', onKey, true); close = null; };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

    const btn = el('button', 'btn primary', 'Закрыть');
    btn.type = 'button'; btn.addEventListener('click', () => close());
    box.append(el('h2', '', data.scene.name || data.name || 'Превью'), canvas,
      el('p', 'tool-cost', 'Тяни мышью, чтобы повернуть, колесо - приблизить, двойной клик сбросить.'));
    const shown = [...new Set((data.scene.parts || []).map((p) => p.label))];
    if (shown.length) box.append(el('p', 'tool-cost', 'Показано: ' + shown.join(' · ')));
    if (notes.length) {
      const ul = el('ul', 'preview-notes');
      for (const n of notes) ul.append(el('li', '', n));
      box.append(ul);
    }
    const actions = el('div', 'actions'); actions.append(btn); box.append(actions);
    overlay.append(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    try { stop.fn = start(canvas, data.scene); }
    catch (e) { canvas.replaceWith(el('p', '', 'Не удалось показать: ' + (e && e.message ? e.message : e))); }
  }

  window.HeroPreview = { open };
})();
