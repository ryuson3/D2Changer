/* The hero preview: a panel that stays on the hero screen, with a small WebGL2 viewer in it. It draws
 * what src/preview.ts built (the hero's meshes with the colour map of each material) with a head light,
 * and plays the particle systems of what the hero wears (src/particle-def.ts specs) on top: run on the
 * CPU and drawn as sprites, additive where the game adds them. Drag to turn, wheel to come closer,
 * double-click to start over. No library: the scene is a few dozen triangle lists and point clouds.
 * Models are Z-up in Source units and the hero faces +X; particle specs are in the same space.
 *
 * The particle runtime is ported from Dota 2 Mod Manager (github.com/dota2modmanager/dota2-mod-manager,
 * renderer/catalog/preview3d/particles.ts), GPL-3.0-or-later. */
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
  const FX_VERT = `#version 300 es
    in vec3 aPos; in vec4 aTint; in float aSize;
    uniform mat4 uView; uniform mat4 uProj; uniform float uPx;
    out vec4 vTint;
    void main() {
      vTint = aTint;
      vec4 mv = uView * vec4(aPos, 1.0);
      gl_PointSize = max(1.0, aSize * uPx / max(-mv.z, 0.001));
      gl_Position = uProj * mv;
    }`;
  const FX_FRAG = `#version 300 es
    precision mediump float;
    in vec4 vTint;
    uniform float uBright, uHasTex, uGrey;
    uniform sampler2D uTex;
    out vec4 outColor;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (uHasTex > 0.5) {
        // a texture with no alpha of its own: its edge fades, never a square
        vec4 t = texture(uTex, gl_PointCoord) * smoothstep(1.0, 0.6, r);
        vec3 c = mix(t.rgb, vec3(dot(t.rgb, vec3(0.299, 0.587, 0.114))), uGrey);
        outColor = vec4(vTint.rgb * c * uBright, vTint.a * t.a);
        return;
      }
      float soft = exp(-r * r * 5.0) * step(r, 1.0);
      outColor = vec4(vTint.rgb * uBright, vTint.a * soft);
    }`;

  const FOV = 0.62;
  /** A solid soft dot carries more light than the game's mostly empty sprites: an additive one gives back this share. */
  const ADD_GAIN = 0.5;
  /** A sprite whose picture did not come is drawn as a dot with this share of the light. */
  const SPECK_GAIN = 0.35;

  // ----- 4x4 matrices, column-major -----
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
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program');
    return p;
  }

  // ----- particles -----
  const rand = (r) => r[0] + Math.random() * (r[1] - r[0]);
  const randV = (a, b) => [rand([a[0], b[0]]), rand([a[1], b[1]]), rand([a[2], b[2]])];
  const randomDirection = () => {
    const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  /** A point inside the ellipsoid these corners bound: the game's velocity noise is smooth, and drawn in a box it grew a box of snow. */
  const randIn = (a, b) => {
    const d = randomDirection(), k = Math.cbrt(Math.random());
    return [0, 1, 2].map((i) => (a[i] + b[i]) / 2 + d[i] * k * (b[i] - a[i]) / 2);
  };

  /** One system: its particles in flat arrays, and the buffers they are drawn from. */
  class System {
    constructor(gl, loc, s, cp, surface, tex) {
      this.s = s; this.cp = cp; this.surface = surface; this.tex = tex;
      this.gain = s.gain * (s.texture && !tex ? SPECK_GAIN : 1);
      const n = s.max;
      this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
      this.tint = new Float32Array(n * 4); this.size = new Float32Array(n);
      this.age = new Float32Array(n); this.life = new Float32Array(n);
      // per particle: diameter, alpha, r, g, b
      this.base = new Float32Array(n * 5);
      this.alive = 0; this.acc = 0; this.time = 0; this.burst = false;
      this.lockAt = null;
      const lives = Math.max(s.life[0], s.life[1]);
      // the preview plays for ever: a one-shot or timed effect starts again once it is over (a glow whose particles never die just stays)
      this.period = !s.mortal ? Infinity : s.duration > 0 ? s.start + s.duration + lives : (s.rate <= 0 && s.burst > 0 ? s.start + lives + 0.6 : Infinity);
      this.gl = gl;
      if (s.draw === 'none') return;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const attr = (index, data, size) => {
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
        return b;
      };
      this.bPos = attr(loc.pos, this.pos, 3); this.bTint = attr(loc.tint, this.tint, 4); this.bSize = attr(loc.size, this.size, 1);
      gl.bindVertexArray(null);
    }

    spawn() {
      const s = this.s, sp = s.spawn;
      if (this.alive >= s.max) return;
      const i = this.alive++;
      const at = this.cp(sp.cp);
      const p = [at[0], at[1], at[2]], v = [0, 0, 0];
      const add = (o, d, k) => { o[0] += d[0] * k; o[1] += d[1] * k; o[2] += d[2] * k; };
      if (sp.onModel) { const on = this.surface(); if (on) { p[0] = on[0]; p[1] = on[1]; p[2] = on[2]; } }
      if (sp.ring) {
        const a = Math.random() * Math.PI * 2, d = [Math.cos(a), Math.sin(a), 0];
        add(p, d, sp.ring.radius); add(v, d, rand(sp.ring.speed));
      }
      if (sp.sphere[1] > 0 || sp.speed[1] !== 0) {
        let d = randomDirection().map((x, k) => x * sp.bias[k]);
        const l = Math.hypot(...d) || 1; d = d.map((x) => x / l);
        add(p, d, rand(sp.sphere)); add(v, d, rand(sp.speed));
      }
      if (sp.offset) add(p, randV(sp.offset[0], sp.offset[1]), 1);
      if (sp.local) add(v, randV(sp.local[0], sp.local[1]), 1);
      if (sp.noise) add(v, randIn(sp.noise[0], sp.noise[1]), 1);
      this.pos.set(p, i * 3); this.vel.set(v, i * 3);
      this.age[i] = 0;
      this.life[i] = Math.max(0.05, rand(s.life));
      const k = Math.random(), c0 = s.colors[0], c1 = s.colors[1];
      this.base.set([rand(s.radius) * 2, rand(s.alpha) * this.gain,
        c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k], i * 5);
    }

    kill(i) {
      const last = --this.alive;
      if (i === last) return;
      for (const [arr, w] of [[this.pos, 3], [this.vel, 3], [this.base, 5]]) arr.copyWithin(i * w, last * w, last * w + w);
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
    }

    update(dt) {
      const s = this.s;
      this.time += dt;
      if (this.time >= this.period && (s.rate > 0 || this.alive === 0)) { this.time = 0; this.burst = false; }
      if (this.time >= s.start) {
        if (!this.burst) { this.burst = true; for (let k = 0; k < s.burst; k++) this.spawn(); }
        if (s.rate > 0 && (s.duration <= 0 || this.time - s.start < s.duration)) {
          this.acc += s.rate * dt;
          for (; this.acc >= 1; this.acc--) this.spawn();
        }
      }
      const g = s.gravity.map((x) => x * dt);
      const jitter = s.jitter * dt * 20;
      const keep = s.drag > 0 ? Math.pow(Math.max(0, 1 - s.drag), dt * 30) : 1;
      let shift = null;
      if (s.lock !== null) {
        const now = this.cp(s.lock);
        if (this.lockAt) shift = [now[0] - this.lockAt[0], now[1] - this.lockAt[1], now[2] - this.lockAt[2]];
        this.lockAt = now;
      }
      for (let i = this.alive - 1; i >= 0; i--) {
        this.age[i] += dt;
        if (this.age[i] >= this.life[i] && s.mortal) { this.kill(i); continue; }
        const j = i * 3;
        for (let d = 0; d < 3; d++) {
          this.vel[j + d] = (this.vel[j + d] + g[d] + (Math.random() - 0.5) * jitter) * keep;
          this.pos[j + d] += this.vel[j + d] * dt + (shift ? shift[d] : 0);
        }
      }
      if (s.draw === 'none') return;
      for (let i = 0; i < this.alive; i++) {
        const t = Math.min(1, this.age[i] / this.life[i]);
        const b = i * 5;
        let a = this.base[b + 1];
        if (s.fadeIn > 0 && t < s.fadeIn) a *= t / s.fadeIn;
        if (s.fadeOut > 0 && t > 1 - s.fadeOut) a *= (1 - t) / s.fadeOut;
        const z = s.size;
        const st = Math.min(1, Math.max(0, (t - z.start) / Math.max(1e-3, z.end - z.start)));
        this.size[i] = this.base[b] * (z.from + (z.to - z.from) * st);
        let r = this.base[b + 2], gg = this.base[b + 3], bb = this.base[b + 4];
        if (s.fade) {
          const f = Math.min(1, Math.max(0, (t - s.fade.start) / Math.max(1e-3, s.fade.end - s.fade.start)));
          r += (s.fade.color[0] - r) * f; gg += (s.fade.color[1] - gg) * f; bb += (s.fade.color[2] - bb) * f;
        }
        this.tint[i * 4] = r; this.tint[i * 4 + 1] = gg; this.tint[i * 4 + 2] = bb; this.tint[i * 4 + 3] = a;
      }
    }

    draw(loc) {
      const gl = this.gl, s = this.s;
      if (s.draw === 'none' || !this.alive) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pos, 0, this.alive * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bTint); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.tint, 0, this.alive * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bSize); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.size, 0, this.alive);
      // added light leaves the canvas's alpha alone: the picture behind it shows through, not a black square
      if (s.draw === 'add') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(loc.bright, s.draw === 'add' ? Math.min(2, s.bright) * (this.tex ? 1 : ADD_GAIN) : 1);
      gl.uniform1f(loc.hasTex, this.tex ? 1 : 0);
      gl.uniform1f(loc.grey, s.grey);
      if (this.tex) gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, this.alive);
    }

    dispose() {
      const gl = this.gl;
      if (this.vao) { gl.deleteVertexArray(this.vao); [this.bPos, this.bTint, this.bSize].forEach((b) => gl.deleteBuffer(b)); }
    }
  }

  /** Where control point `n` of a system stands: an attachment of its item ("self") or of the hero, a point set off another, or the origin. */
  function controlPoints(spec, owner, attachments) {
    const cps = new Map(spec.cps);
    const memo = new Map();
    const at = (n, depth = 0) => {
      if (memo.has(n)) return memo.get(n);
      const c = cps.get(n) || cps.get(0);
      let p = [0, 0, 0];
      if (c && c.world) {
        const from = c.from !== undefined && c.from !== n && depth < 4 ? at(c.from, depth + 1) : [0, 0, 0];
        p = [from[0] + c.world[0], from[1] + c.world[1], from[2] + c.world[2]];
      } else if (c && c.attachment) {
        const self = attachments[owner] || {}, hero = attachments[0] || {};
        const [first, second] = c.entity === 'self' ? [self, hero] : [hero, self];
        p = first[c.attachment] || second[c.attachment] || p;
      }
      memo.set(n, p);
      return p;
    };
    return at;
  }

  function texture(gl, t, mip) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.width, t.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(t.rgba));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mip ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mip ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** The viewer on one canvas; `show` puts a new scene in it (the camera stays when `keepCamera`). */
  function createViewer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL недоступен');
    const prog = program(gl, VERT, FRAG);
    const fxProg = program(gl, FX_VERT, FX_FRAG);
    const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNormal'), uv: gl.getAttribLocation(prog, 'aUv'),
      view: gl.getUniformLocation(prog, 'uView'), proj: gl.getUniformLocation(prog, 'uProj'), tex: gl.getUniformLocation(prog, 'uTex'), has: gl.getUniformLocation(prog, 'uHasTex') };
    const fxLoc = { pos: gl.getAttribLocation(fxProg, 'aPos'), tint: gl.getAttribLocation(fxProg, 'aTint'), size: gl.getAttribLocation(fxProg, 'aSize'),
      view: gl.getUniformLocation(fxProg, 'uView'), proj: gl.getUniformLocation(fxProg, 'uProj'), px: gl.getUniformLocation(fxProg, 'uPx'),
      bright: gl.getUniformLocation(fxProg, 'uBright'), hasTex: gl.getUniformLocation(fxProg, 'uHasTex'), grey: gl.getUniformLocation(fxProg, 'uGrey'), tex: gl.getUniformLocation(fxProg, 'uTex') };

    let parts = [], textures = [], buffers = [], systems = [], fxTextures = [];
    let centre = [0, 0, 0], size = 100, home = { yaw: 0.45, pitch: 0.12, dist: 190 };
    const cam = { ...home };
    let raf = 0, alive = true, last = 0;

    function clear() {
      for (const p of parts) gl.deleteVertexArray(p.vao);
      buffers.forEach((b) => gl.deleteBuffer(b));
      textures.forEach((t) => gl.deleteTexture(t));
      fxTextures.forEach((t) => gl.deleteTexture(t));
      systems.forEach((s) => s.dispose());
      parts = []; textures = []; buffers = []; systems = []; fxTextures = [];
    }

    function show(scene, keepCamera) {
      clear();
      textures = scene.textures.map((t) => texture(gl, t, true));
      const buf = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); buffers.push(b); return b; };
      parts = scene.parts.map((p) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const attr = (index, data, n) => { buf(gl.ARRAY_BUFFER, new Float32Array(data)); gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, n, gl.FLOAT, false, 0, 0); };
        attr(loc.pos, p.positions, 3); attr(loc.nor, p.normals, 3); attr(loc.uv, p.uvs, 2);
        buf(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(p.indices));
        return { vao, count: p.indices.length, texture: p.texture };
      });
      gl.bindVertexArray(null);

      const sprites = new Map();
      for (const [path, t] of Object.entries(scene.fxTextures || {})) { const tex = texture(gl, t, false); fxTextures.push(tex); sprites.set(path, tex); }
      const surface = scene.surface && scene.surface.length ? scene.surface : null;
      const onBody = () => { if (!surface) return null; const i = Math.floor(Math.random() * (surface.length / 3)) * 3; return [surface[i], surface[i + 1], surface[i + 2]]; };
      const attachments = scene.attachments || [];
      for (const fx of scene.fx || []) {
        const add = (s) => {
          systems.push(new System(gl, fxLoc, s, controlPoints(s, fx.owner, attachments), onBody, (s.texture && sprites.get(s.texture)) || null));
          s.children.forEach(add);
        };
        add(fx.spec);
      }
      // the effects already running when the picture shows, not starting from nothing
      for (let t = 0; t < 1.5; t += 1 / 30) systems.forEach((s) => s.update(1 / 30));

      if (!keepCamera) {
        centre = [0, 1, 2].map((i) => (scene.min[i] + scene.max[i]) / 2);
        size = Math.max(scene.max[0] - scene.min[0], scene.max[1] - scene.min[1], scene.max[2] - scene.min[2]) || 100;
        home = { yaw: 0.45, pitch: 0.12, dist: size * 1.9 };
        Object.assign(cam, home);
      }
      redraw();
    }

    const visible = () => alive && canvas.isConnected && !document.hidden && canvas.clientWidth > 0;

    function draw(now) {
      raf = 0;
      if (!visible()) { last = 0; return; }
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      const w = canvas.clientWidth, h = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      // cleared to nothing: the picture behind the canvas (app.css) shows through
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
      const eye = [centre[0] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw), centre[1] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), centre[2] + cam.dist * Math.sin(cam.pitch)];
      const view = lookAt(eye, centre, [0, 0, 1]);
      const proj = perspective(FOV, canvas.width / Math.max(1, canvas.height), size * 0.05, size * 12);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.view, false, view);
      gl.uniformMatrix4fv(loc.proj, false, proj);
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc.tex, 0);
      for (const p of parts) {
        gl.uniform1f(loc.has, p.texture >= 0 ? 1 : 0);
        if (p.texture >= 0) gl.bindTexture(gl.TEXTURE_2D, textures[p.texture]);
        gl.bindVertexArray(p.vao);
        gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
      }
      if (systems.length) {
        for (const s of systems) s.update(dt);
        gl.useProgram(fxProg);
        gl.uniformMatrix4fv(fxLoc.view, false, view);
        gl.uniformMatrix4fv(fxLoc.proj, false, proj);
        gl.uniform1f(fxLoc.px, canvas.height / (2 * Math.tan(FOV / 2)));
        gl.uniform1i(fxLoc.tex, 0);
        gl.enable(gl.BLEND); gl.depthMask(false);
        for (const s of systems) s.draw(fxLoc);
        gl.depthMask(true); gl.disable(gl.BLEND);
        redraw();   // particles move on their own: the next frame is asked for at once
      }
      gl.bindVertexArray(null);
    }
    const redraw = () => { if (!raf && visible()) raf = requestAnimationFrame(draw); };

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
    // a panel taken off the page and put back (the hero screen redraws) resizes, and that starts it again
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    document.addEventListener('visibilitychange', redraw);

    return {
      show, redraw,
      destroy() {
        alive = false; resize.disconnect(); document.removeEventListener('visibilitychange', redraw);
        if (raf) cancelAnimationFrame(raf);
        clear();
      },
    };
  }

  /** The panel the hero screen keeps: canvas, a line of status over it, and what is not shown. */
  function createStage() {
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    const root = el('div', 'pv-stage');
    const canvas = el('canvas', 'preview-canvas');
    const status = el('div', 'pv-status');
    const hint = el('div', 'pv-hint', 'Тяни, чтобы повернуть · колесо: ближе · двойной клик: сброс');
    const notes = el('details', 'pv-notes');
    notes.hidden = true;
    root.append(canvas, status, hint, notes);
    let viewer = null, hero = null;
    try { viewer = createViewer(canvas); } catch (e) { canvas.replaceWith(el('p', 'pv-error', 'Не удалось показать: ' + (e && e.message ? e.message : e))); }

    const setStatus = (text) => { status.textContent = text || ''; status.hidden = !text; };
    setStatus('');
    return {
      el: root,
      status: setStatus,
      /** @param data {scene, hero} what the main process built for one hero */
      show(data) {
        setStatus('');
        const list = (data.scene.notes || []);
        notes.replaceChildren();
        notes.hidden = !list.length;
        if (list.length) {
          const ul = el('ul');
          for (const n of list) ul.append(el('li', '', n));
          notes.append(el('summary', '', `Заметки · ${list.length}`), ul);
        }
        if (!viewer) return;
        try { viewer.show(data.scene, hero === data.hero); hero = data.hero; }
        catch (e) { setStatus('Не удалось показать: ' + (e && e.message ? e.message : e)); }
      },
    };
  }

  window.HeroPreview = { createStage };
})();
