type ParticlePoint = {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  seed: number;
};

// A single WebGL draw call keeps this comfortably below Da7em's mobile
// particle budget while giving the firework artwork enough definition.
const PARTICLE_COUNT = 6200;

export class LoadingParticleScene {
  private readonly gl: WebGL2RenderingContext | null;
  private readonly program: WebGLProgram | null;
  private readonly buffer: WebGLBuffer | null;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private animationFrame = 0;
  private startedAt = 0;
  private shockAt = -10;
  private active = false;
  private ready = false;
  private readyMix = 0;
  private pointCount = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerActive = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
      premultipliedAlpha: true,
    });
    this.program = this.gl ? createProgram(this.gl, VERTEX_SHADER, FRAGMENT_SHADER) : null;
    this.buffer = this.gl?.createBuffer() ?? null;
    if (!this.gl || !this.program || !this.buffer) return;

    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    const target = this.gl.getAttribLocation(this.program, 'aTarget');
    const color = this.gl.getAttribLocation(this.program, 'aColor');
    const seed = this.gl.getAttribLocation(this.program, 'aSeed');
    this.gl.enableVertexAttribArray(target);
    this.gl.vertexAttribPointer(target, 2, this.gl.FLOAT, false, stride, 0);
    this.gl.enableVertexAttribArray(color);
    this.gl.vertexAttribPointer(color, 3, this.gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    this.gl.enableVertexAttribArray(seed);
    this.gl.vertexAttribPointer(seed, 1, this.gl.FLOAT, false, stride, 5 * Float32Array.BYTES_PER_ELEMENT);

    for (const name of ['uTime', 'uPointer', 'uPointerActive', 'uShockAge', 'uReady', 'uScale']) {
      this.uniforms[name] = this.gl.getUniformLocation(this.program, name);
    }

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerUp);
    window.addEventListener('resize', this.resize);
    this.setPoints(makeFallbackFirework(PARTICLE_COUNT));
  }

  start() {
    if (!this.gl || !this.program || this.active) return;
    this.active = true;
    this.ready = false;
    this.readyMix = 0;
    this.startedAt = performance.now();
    this.canvas.classList.add('is-active');
    this.canvas.classList.remove('is-ready');
    this.resize();
    void this.loadFireworkMask();
    this.animationFrame = requestAnimationFrame(this.render);
  }

  setReady() {
    this.ready = true;
    this.canvas.classList.add('is-ready');
  }

  stop() {
    this.active = false;
    this.pointerActive = 0;
    this.canvas.classList.remove('is-active', 'is-ready');
    cancelAnimationFrame(this.animationFrame);
  }

  destroy() {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerUp);
    window.removeEventListener('resize', this.resize);
    if (this.gl && this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
  }

  private resize = () => {
    if (!this.gl) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  };

  private onPointerDown = (event: PointerEvent) => {
    this.updatePointer(event);
    this.pointerActive = 1;
    this.shockAt = (performance.now() - this.startedAt) / 1000;
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    this.updatePointer(event);
    if (event.pointerType === 'mouse' || event.buttons > 0) this.pointerActive = 1;
  };

  private onPointerUp = (event: PointerEvent) => {
    this.updatePointer(event);
    this.pointerActive = event.pointerType === 'mouse' ? 1 : 0;
  };

  private updatePointer(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.pointerY = 1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2;
  }

  private render = (now: number) => {
    if (!this.active || !this.gl || !this.program) return;
    const gl = this.gl;
    const time = (now - this.startedAt) / 1000;
    this.readyMix += ((this.ready ? 1 : 0) - this.readyMix) * 0.075;
    const minDimension = Math.max(1, Math.min(this.canvas.width, this.canvas.height));
    const scaleX = (minDimension / Math.max(1, this.canvas.width)) * 0.96;
    const scaleY = (minDimension / Math.max(1, this.canvas.height)) * 0.96;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Normal alpha composition preserves pink/gold/teal when particles overlap.
    // Additive blending made the dense artwork converge into a white cloud.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.uniform1f(this.uniforms.uTime, time);
    gl.uniform2f(this.uniforms.uPointer, this.pointerX, this.pointerY);
    gl.uniform1f(this.uniforms.uPointerActive, this.pointerActive);
    gl.uniform1f(this.uniforms.uShockAge, time - this.shockAt);
    gl.uniform1f(this.uniforms.uReady, this.readyMix);
    gl.uniform2f(this.uniforms.uScale, scaleX, scaleY);
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
    this.animationFrame = requestAnimationFrame(this.render);
  };

  private setPoints(points: ParticlePoint[]) {
    if (!this.gl || !this.buffer) return;
    const data = new Float32Array(points.length * 6);
    points.forEach((point, index) => {
      const offset = index * 6;
      data[offset] = point.x;
      data[offset + 1] = point.y;
      data[offset + 2] = point.r;
      data[offset + 3] = point.g;
      data[offset + 4] = point.b;
      data[offset + 5] = point.seed;
    });
    this.pointCount = points.length;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.STATIC_DRAW);
  }

  private async loadFireworkMask() {
    const image = new Image();
    image.decoding = 'async';
    image.src = '/effects/loading-firework.png';
    try {
      await image.decode();
    } catch {
      return;
    }
    if (!this.active) return;
    const sampler = document.createElement('canvas');
    sampler.width = image.naturalWidth;
    sampler.height = image.naturalHeight;
    const context = sampler.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    const candidates: ParticlePoint[] = [];
    let seed = 0x71da7e;
    for (let y = 0; y < sampler.height; y += 1) {
      for (let x = 0; x < sampler.width; x += 1) {
        const offset = (y * sampler.width + x) * 4;
        const r = pixels[offset] / 255;
        const g = pixels[offset + 1] / 255;
        const b = pixels[offset + 2] / 255;
        const brightness = Math.max(r, g, b);
        if (pixels[offset + 3] < 90 || brightness < 0.22) continue;
        seed = xorshift(seed);
        if ((seed & 1023) / 1023 > 0.58 + brightness * 0.28) continue;
        const [particleR, particleG, particleB] = boostFireworkColor(
          r,
          g,
          b,
          x / Math.max(1, sampler.width - 1),
          y / Math.max(1, sampler.height - 1),
        );
        candidates.push({
          x: (x / Math.max(1, sampler.width - 1)) * 2 - 1,
          y: 1 - (y / Math.max(1, sampler.height - 1)) * 2,
          r: particleR,
          g: particleG,
          b: particleB,
          seed: (seed >>> 0) / 4294967295,
        });
      }
    }
    if (candidates.length < 200) return;
    const points: ParticlePoint[] = [];
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      seed = xorshift(seed);
      const point = candidates[(seed >>> 0) % candidates.length];
      seed = xorshift(seed);
      const jitterX = (((seed & 255) / 255) - 0.5) * 0.012;
      seed = xorshift(seed);
      const jitterY = (((seed & 255) / 255) - 0.5) * 0.012;
      points.push({ ...point, x: point.x + jitterX, y: point.y + jitterY, seed: (seed >>> 0) / 4294967295 });
    }
    this.setPoints(points);
  }
}

function boostFireworkColor(r: number, g: number, b: number, x: number, y: number) {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const chroma = maximum - minimum;
  const pink = [1, 0.28, 0.58] as const;
  const gold = [1, 0.7, 0.18] as const;
  const teal = [0.16, 0.94, 0.84] as const;

  // The source artwork intentionally contains white-hot highlights. Keep the
  // silhouette, but give low-chroma samples a nearby firework hue so the
  // loading scene reads as a coloured particle drawing rather than grey dust.
  if (chroma < 0.16) {
    const sector = Math.floor(((Math.atan2(y - 0.5, x - 0.5) + Math.PI) / (Math.PI * 2)) * 12);
    return [pink, gold, teal][Math.abs(sector) % 3];
  }

  // Quantising the sampled hue avoids pale near-white pixels taking over on
  // high-DPI phones. A small source-colour mix retains variation and detail.
  const palette = b > r * 0.82 && g > r * 0.72
    ? teal
    : r > g * 1.18
      ? pink
      : gold;
  const sourceMix = 0.16;
  return [
    palette[0] * (1 - sourceMix) + r * sourceMix,
    palette[1] * (1 - sourceMix) + g * sourceMix,
    palette[2] * (1 - sourceMix) + b * sourceMix,
  ];
}

function makeFallbackFirework(count: number) {
  const points: ParticlePoint[] = [];
  let seed = 0x5a17f1;
  const colors = [
    [1, 0.35, 0.6],
    [1, 0.72, 0.28],
    [0.32, 0.94, 0.93],
  ];
  for (let index = 0; index < count; index += 1) {
    seed = xorshift(seed);
    const randomA = (seed >>> 0) / 4294967295;
    seed = xorshift(seed);
    const randomB = (seed >>> 0) / 4294967295;
    const spoke = index % 16;
    const angle = (spoke / 16) * Math.PI * 2 + (randomA - 0.5) * 0.2;
    const radius = 0.11 + Math.pow(randomB, 0.72) * (0.66 + 0.12 * Math.sin(spoke * 2.4));
    const color = colors[spoke % colors.length];
    points.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      r: color[0],
      g: color[1],
      b: color[2],
      seed: randomA,
    });
  }
  return points;
}

function xorshift(value: number) {
  let next = value | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next | 0;
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Loading particle program unavailable.', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Loading particle shader unavailable.', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aTarget;
in vec3 aColor;
in float aSeed;
uniform float uTime;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uShockAge;
uniform float uReady;
uniform vec2 uScale;
out vec3 vColor;
out float vAlpha;
out float vSeed;

void main() {
  vec2 target = aTarget * uScale;
  float drift = mix(0.032, 0.006, uReady);
  vec2 p = target + vec2(
    sin(uTime * 0.72 + aSeed * 31.0),
    cos(uTime * 0.61 + aSeed * 27.0)
  ) * drift;
  vec2 delta = p - uPointer;
  float distanceToPointer = max(length(delta), 0.001);
  vec2 direction = delta / distanceToPointer;
  float influence = uPointerActive * smoothstep(0.34, 0.0, distanceToPointer);
  p += direction * influence * 0.16;
  p += vec2(-direction.y, direction.x) * influence * 0.075 * sin(uTime * 2.2 + aSeed * 12.0);

  float shockRadius = clamp(uShockAge * 0.62, 0.0, 1.5);
  float shock = exp(-abs(distanceToPointer - shockRadius) * 34.0) * step(uShockAge, 2.2);
  p += direction * shock * 0.13;

  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = (4.8 + fract(aSeed * 47.31) * 6.4) * (1.0 + influence * 0.55 + uReady * 0.18);
  vColor = aColor;
  vAlpha = 0.94 + fract(aSeed * 13.71) * 0.06;
  vSeed = aSeed;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
in float vSeed;
out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord - 0.5;
  float distanceFromCenter = length(point);
  if (distanceFromCenter > 0.5) discard;
  float glow = smoothstep(0.5, 0.02, distanceFromCenter);
  float paletteIndex = floor(fract(vSeed * 19.17) * 3.0);
  vec3 palette = paletteIndex < 1.0
    ? vec3(1.0, 0.3, 0.56)
    : paletteIndex < 2.0
      ? vec3(1.0, 0.72, 0.2)
      : vec3(0.2, 0.94, 0.84);
  vec3 tinted = mix(vColor, palette, 0.62);
  float luminance = dot(tinted, vec3(0.24, 0.67, 0.09));
  vec3 saturated = clamp(vec3(luminance) + (tinted - vec3(luminance)) * 1.42, 0.0, 1.0);
  outColor = vec4(saturated * (1.22 + glow * 1.82), glow * vAlpha);
}`;
