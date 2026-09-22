import type { HeadCollider } from './types';
import {
  createLocalImpactSites,
} from './HeadInteraction';
import type { LocalImpactSite } from './HeadInteraction';
import { TDParticleSimulation, TD_GRID, TD_COUNT } from './TDParticleSimulation';
import type { ParticleState } from './TDParticleSimulation';

const GRID_SIZE = TD_GRID;
const PARTICLE_COUNT = TD_COUNT;
const BURST_SLOTS = 4;
const BURST_LIFETIME = 3.25;
const CURVE_FPS = 30;
const BURST_VISUAL_SCALE = 1.18;

// This shader mirrors the imported project's 300×300 TOP sampling and
// Noise-based point transform. The temporal persistence is implemented below
// with the same ping-pong feedback and display blur passes.
const pointVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec4 aState;
layout(location=1) in vec4 aContact;
layout(location=2) in vec4 aHistory;
uniform sampler2D uImage;
uniform vec2 uViewport;
uniform float uPixelRatio, uAlpha, uDispersion;
out vec4 vColor;
out vec2 vDirection;
out float vBounced;
out float vAspect;
void main() {
  vec2 uv=(vec2(float(gl_VertexID%300),float(gl_VertexID/300))+0.5)/float(300);
  vec4 source=texture(uImage,vec2(uv.x,1.0-uv.y));
  vBounced=step(0.0,aContact.z);
  float fade=aContact.z<0.0?1.0:1.0-smoothstep(1.6,2.2,aContact.z);
  if(aContact.z < -1.5 || fade<0.002) {
    gl_Position=vec4(2.0); gl_PointSize=0.0; vColor=vec4(0); vDirection=vec2(1,0); vAspect=1.0; return;
  }
  vec2 world=aState.xy*uPixelRatio;
  gl_Position=vec4(world.x/uViewport.x*2.0-1.0,1.0-world.y/uViewport.y*2.0,0,1);
  float speed=length(aState.zw);
  vDirection=speed>0.01?aState.zw/speed:vec2(1,0);
  gl_PointSize=mix(2.0,clamp(speed*0.017*uPixelRatio,2.4,9.0),vBounced);
  vAspect=mix(1.0,max(1.0,gl_PointSize/(1.6*uPixelRatio)),vBounced);
  float burst=pow(clamp(uDispersion,0.0,1.0),1.1);
  float core=1.0-0.50*burst*(1.0-smoothstep(30.0/390.0,105.0/390.0,length(uv-0.5)));
  vec3 color=source.rgb*mix(1.0,0.68,burst)*mix(core,1.05,vBounced);
  vColor=vec4(color,source.a*uAlpha*fade);
}`;

const pointFragmentShader = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vDirection;
in float vBounced;
in float vAspect;
out vec4 outColor;
void main() {
  float alpha=vColor.a;
  if(vBounced>0.5) {
    vec2 p=(gl_PointCoord-0.5)*2.0;
    vec2 d=vec2(vDirection.x,-vDirection.y);
    vec2 q=vec2(dot(p,d),dot(p,vec2(-d.y,d.x)));
    float shape=1.0-smoothstep(0.45,1.0,length(vec2(q.x,q.y*vAspect)));
    alpha*=shape;
  }
  outColor=vec4(vColor.rgb,alpha);
}`;

const quadVertexShader = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const feedbackFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uPrevious;
uniform float uDecay, uCutoff;
in vec2 vUv;
out vec4 outColor;
void main() {
  // Persistence contains light only. Particle positions live in the simulation
  // buffers and are never reconstructed from this picture.
  vec4 c=texture(uPrevious,vUv)*uDecay;
  float peak=max(max(c.r,c.g),max(c.b,c.a));
  outColor=peak<uCutoff?vec4(0):c;
}`;

const emissionFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uScene;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 c = texture(uScene, vUv);
  float peak = max(max(c.r, c.g), c.b);
  float bright = smoothstep(0.12, 0.58, peak);
  float coverage = smoothstep(0.055, 0.30, c.a) * bright;
  // Only the genuinely bright coloured edges enter bloom. Dark feedback is
  // exactly zero here, preventing a pale mandala-shaped fog after the burst.
  outColor = vec4(c.rgb * coverage * mix(1.15, 1.90, bright), coverage);
}`;

const blurFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uRadius;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 stepUv = uDirection * uTexel * uRadius;
  vec4 sum = texture(uSource, vUv) * 0.227027;
  sum += texture(uSource, vUv + stepUv * 1.384615) * 0.194595;
  sum += texture(uSource, vUv - stepUv * 1.384615) * 0.194595;
  sum += texture(uSource, vUv + stepUv * 3.230769) * 0.121622;
  sum += texture(uSource, vUv - stepUv * 3.230769) * 0.121622;
  outColor = sum;
}`;

const displayFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloomNear;
uniform sampler2D uBloomMid;
uniform sampler2D uBloomWide;
uniform float uGlow;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 c = texture(uScene, vUv);
  vec4 bloomNear = texture(uBloomNear, vUv);
  vec4 bloomMid = texture(uBloomMid, vUv);
  vec4 bloomWide = texture(uBloomWide, vUv);
  vec3 bloom = bloomNear.rgb * 0.86 + bloomMid.rgb * 0.42 + bloomWide.rgb * 0.16;
  vec3 energy = c.rgb * 1.02 + bloom * uGlow;

  // Tone-map the combined luminance with one shared multiplier. This keeps
  // palette ratios intact instead of clipping each channel towards white.
  float luminance = dot(energy, vec3(0.2126, 0.7152, 0.0722));
  float mappedLuminance = 1.0 - exp(-luminance * 1.02);
  vec3 mapped = energy * (mappedLuminance / max(luminance, 0.0001));
  float mappedGrey = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
  mapped = max(vec3(0.0), mix(vec3(mappedGrey), mapped, 1.16));
  float peak = max(max(mapped.r, mapped.g), mapped.b);
  if (peak > 0.965) mapped *= 0.965 / peak;

  // Raise coverage to contain the emissive halo rather than forcing the halo
  // down to the sparse particle alpha, which made the previous glow vanish.
  float bloomPeak = max(max(bloom.r, bloom.g), bloom.b);
  float bloomCoverage = (1.0 - exp(-bloomPeak * uGlow * 0.82)) * 0.84;
  float alpha = clamp(max(c.a, bloomCoverage), 0.0, 1.0);
  // The canvas is composited normally over the camera, so provide genuinely
  // premultiplied colour instead of depending on a page-wide screen blend.
  outColor = vec4(mapped * alpha, alpha);
}`;

interface BurstSlot {
  active: boolean;
  x: number;
  y: number;
  start: number;
  seed: number;
  palette: number;
  state: ParticleState | null;
  sites: LocalImpactSite[];
  siteHeadX: number;
  siteHeadY: number;
  planTime: number;
  countedBounces: number;
}
interface Target { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number; }

export class TDParticleBurstRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly pointProgram: WebGLProgram | null;
  private readonly feedbackProgram: WebGLProgram | null;
  private readonly emissionProgram: WebGLProgram | null;
  private readonly blurProgram: WebGLProgram | null;
  private readonly displayProgram: WebGLProgram | null;
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly fallbackTexture: WebGLTexture | null;
  private simulation: TDParticleSimulation | null = null;
  private readonly imageTextures: Array<WebGLTexture | null> = [null, null, null];
  private readonly slots: BurstSlot[] = Array.from({ length: BURST_SLOTS }, () => ({
    active: false, x: 0, y: 0, start: -1000, seed: 0, palette: 0,
    state: null, sites: [], siteHeadX: 0, siteHeadY: 0, planTime: -1, countedBounces: 0,
  }));
  private readonly targets: Target[] = [];
  private readonly bloomTargets: Target[] = [];
  private readonly pointUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly feedbackUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly emissionUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly blurUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly displayUniforms: Record<string, WebGLUniformLocation | null> = {};
  private curve: number[] | null = null;
  private curveMax = 972;
  private curveMin = 308;
  private cursor = 0;
  private previousTarget = 0;
  private width = 1;
  private height = 1;
  private supportsFloatBloom = false;
  private dpr = 1;
  private time = 0;
  private idleSince = -1;
  private accumulationCleared = true;
  private disposed = false;

  constructor(private readonly mount: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'td-burst-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.zIndex = '2';
    this.mount.appendChild(this.canvas);
    this.gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!this.gl) { this.pointProgram = null; this.feedbackProgram = null; this.emissionProgram = null; this.blurProgram = null; this.displayProgram = null; this.vao = null; this.fallbackTexture = null; return; }
    this.supportsFloatBloom = Boolean(
      this.gl.getExtension('EXT_color_buffer_float')
      && this.gl.getExtension('OES_texture_float_linear'),
    );
    try {
      this.simulation = new TDParticleSimulation(this.gl);
      this.pointProgram = createProgram(this.gl, pointVertexShader, pointFragmentShader);
      this.feedbackProgram = createProgram(this.gl, quadVertexShader, feedbackFragmentShader);
      this.emissionProgram = createProgram(this.gl, quadVertexShader, emissionFragmentShader);
      this.blurProgram = createProgram(this.gl, quadVertexShader, blurFragmentShader);
      this.displayProgram = createProgram(this.gl, quadVertexShader, displayFragmentShader);
    } catch (error) {
      console.warn('TouchDesigner particle shader unavailable; keeping Canvas2D fireworks.', error);
      this.pointProgram = null; this.feedbackProgram = null; this.emissionProgram = null; this.blurProgram = null; this.displayProgram = null; this.vao = null; this.fallbackTexture = null; return;
    }
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    for (const name of ['uImage', 'uViewport', 'uPixelRatio', 'uDispersion', 'uAlpha']) this.pointUniforms[name] = this.gl.getUniformLocation(this.pointProgram, name);
    for (const name of ['uPrevious', 'uDecay', 'uCutoff']) this.feedbackUniforms[name] = this.gl.getUniformLocation(this.feedbackProgram, name);
    for (const name of ['uScene']) this.emissionUniforms[name] = this.gl.getUniformLocation(this.emissionProgram, name);
    for (const name of ['uSource', 'uTexel', 'uDirection', 'uRadius']) this.blurUniforms[name] = this.gl.getUniformLocation(this.blurProgram, name);
    for (const name of ['uScene', 'uBloomNear', 'uBloomMid', 'uBloomWide', 'uGlow']) this.displayUniforms[name] = this.gl.getUniformLocation(this.displayProgram, name);
    this.fallbackTexture = this.createTexture(1, 1, new Uint8Array([0, 0, 0, 0]));
    this.loadTextures();
    void this.loadMotionCurve();
  }

  resize(width: number, height: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.width = Math.max(1, Math.round(width * this.dpr));
    this.height = Math.max(1, Math.round(height * this.dpr));
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.gl?.viewport(0, 0, this.width, this.height);
    this.rebuildTargets();
  }

  burst(x: number, y: number, palette: number) {
    if (!this.gl || !this.pointProgram) return;
    const slot = this.slots[this.cursor]; this.cursor = (this.cursor + 1) % BURST_SLOTS;
    slot.active = true; slot.x = x; slot.y = y; slot.start = this.time; slot.seed = Math.random() * 1000; slot.palette = Math.abs(palette) % 3;
    if (this.simulation) {
      slot.state ??= this.simulation.createState();
      this.simulation.reset(slot.state);
    }
    slot.sites = []; slot.planTime = -1; slot.countedBounces = 0;
    this.idleSince = -1;
    this.accumulationCleared = false;
  }

  update(time: number, head: HeadCollider | null, headVx = 0, headVy = 0, dt = 1 / 60): number {
    this.time = time;
    const gl = this.gl;
    if (!gl || !this.pointProgram || !this.feedbackProgram || !this.emissionProgram || !this.blurProgram || !this.displayProgram || this.disposed || this.targets.length !== 2 || this.bloomTargets.length !== 6) return 0;
    for (const slot of this.slots) {
      if (slot.active && time - slot.start > BURST_LIFETIME) slot.active = false;
    }
    const hasActiveBurst = this.slots.some((slot) => slot.active);
    if (hasActiveBurst) this.idleSince = -1;
    else if (this.idleSince < 0) this.idleSince = time;
    const idleAge = this.idleSince < 0 ? 0 : time - this.idleSince;
    if (!hasActiveBurst && idleAge > 0.21 && !this.accumulationCleared) {
      this.clearAccumulation();
      this.accumulationCleared = true;
    }
    let contactCount = 0;
    const safeDt = Math.min(0.034, Math.max(1 / 240, dt));
    for (const slot of this.slots) {
      if (!slot.active || !slot.state || !this.simulation) continue;
      const image = this.imageTextures[slot.palette];
      if (!image) continue;
      this.simulation.updateStats(slot.state, time);
      contactCount += Math.max(0, slot.state.stats.bounced - slot.countedBounces);
      slot.countedBounces = slot.state.stats.bounced;
      const contact = slot.state.stats.firstContact;
      if (head && contact && slot.planTime < 0) {
        // Contact is measured from actual source particles on the GPU.
        slot.sites = createLocalImpactSites(head, contact.x + contact.nx * 3, contact.y + contact.ny * 3, slot.seed);
        slot.planTime = time; slot.siteHeadX = head.cx; slot.siteHeadY = head.cy;
      }
      if (head && slot.planTime >= 0 && time - slot.planTime < 0.45) {
        const dx = head.cx - slot.siteHeadX, dy = head.cy - slot.siteHeadY;
        for (const site of slot.sites) { site.x += dx; site.y += dy; }
        slot.siteHeadX = head.cx; slot.siteHeadY = head.cy;
      }
      this.simulation.step(slot.state, {
        image, x: slot.x, y: slot.y, time, dt: safeDt,
        dispersion: this.dispersionAt(time - slot.start),
        scale: Math.min(this.width, this.height) / this.dpr / 1080 * BURST_VISUAL_SCALE,
        seed: slot.seed, head, headVx, headVy,
        sites: slot.planTime >= 0 && time - slot.planTime < 0.45 ? slot.sites : [],
      });
    }
    const nextTarget = 1 - this.previousTarget;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[nextTarget].framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND); gl.useProgram(this.feedbackProgram);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.targets[this.previousTarget].texture);
    gl.uniform1i(this.feedbackUniforms.uPrevious, 0);
    const decay = hasActiveBurst ? Math.pow(0.96, safeDt * 60) : Math.pow(0.82, safeDt * 60);
    gl.uniform1f(this.feedbackUniforms.uDecay, decay);
    gl.uniform1f(this.feedbackUniforms.uCutoff, hasActiveBurst ? 0.010 : 0.022);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Preserve the source palette in the feedback buffer. The display pass
    // supplies the additive-looking glow without repeatedly bleaching RGB.
    gl.useProgram(this.pointProgram); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.pointUniforms.uViewport, this.width, this.height);
    gl.uniform1f(this.pointUniforms.uPixelRatio, this.dpr);
    gl.uniform1i(this.pointUniforms.uImage, 0);
    for (const slot of this.slots) {
      if (!slot.active || !slot.state || slot.state.reset) continue;
      const age = time - slot.start;
      const dispersion = this.dispersionAt(age);
      const fade = 1.0 - smoothstep(2.55, BURST_LIFETIME, age);
      gl.uniform1f(this.pointUniforms.uDispersion, dispersion); gl.uniform1f(this.pointUniforms.uAlpha, fade);
      gl.bindVertexArray(slot.state.vaos[slot.state.current]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.imageTextures[slot.palette] ?? this.fallbackTexture);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    // Build three independent glow scales. The near layer keeps a crisp gold
    // rim, the middle layer gives body, and the very low-resolution layer adds
    // a weak atmospheric halo without turning the whole burst into white fog.
    for (const targetIndex of [0, 2, 4]) this.extractBloom(this.targets[nextTarget].texture, targetIndex);
    this.blurBloom(0, 1, 1, 0, 0.9); this.blurBloom(1, 0, 0, 1, 0.9);
    this.blurBloom(2, 3, 1, 0, 1.35); this.blurBloom(3, 2, 0, 1, 1.35);
    this.blurBloom(4, 5, 1, 0, 1.75); this.blurBloom(5, 4, 0, 1, 1.75);
    this.blurBloom(4, 5, 1, 0, 2.4); this.blurBloom(5, 4, 0, 1, 2.4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.width, this.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.displayProgram); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.targets[nextTarget].texture);
    gl.uniform1i(this.displayUniforms.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[0].texture);
    gl.uniform1i(this.displayUniforms.uBloomNear, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[2].texture);
    gl.uniform1i(this.displayUniforms.uBloomMid, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[4].texture);
    gl.uniform1i(this.displayUniforms.uBloomWide, 3);
    gl.uniform1f(this.displayUniforms.uGlow, this.supportsFloatBloom ? 1.18 : 0.98);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.previousTarget = nextTarget;
    return contactCount;
  }

  get activeCount() { return this.slots.reduce((n, slot) => n + (slot.active ? slot.state?.stats.active ?? 0 : 0), 0); }
  get bouncedCount() { return this.slots.reduce((n, slot) => n + (slot.active ? slot.state?.stats.bounced ?? 0 : 0), 0); }
  get available() { return Boolean(this.gl && this.simulation && this.pointProgram); }

  // Used only by the local render regression harness; never in the live loop.
  debugSnapshot() {
    return this.slots.filter((s) => s.active && s.state && !s.state.reset)
      .map((s) => this.simulation!.snapshot(s.state!));
  }

  dispose() {
    this.disposed = true; const gl = this.gl;
    for (const texture of this.imageTextures) if (texture) gl?.deleteTexture(texture);
    if (this.fallbackTexture) gl?.deleteTexture(this.fallbackTexture);
    for (const slot of this.slots) if (slot.state) this.simulation?.disposeState(slot.state);
    this.simulation?.dispose();
    for (const target of this.targets) { gl?.deleteTexture(target.texture); gl?.deleteFramebuffer(target.framebuffer); }
    for (const target of this.bloomTargets) { gl?.deleteTexture(target.texture); gl?.deleteFramebuffer(target.framebuffer); }
    if (this.pointProgram) gl?.deleteProgram(this.pointProgram); if (this.feedbackProgram) gl?.deleteProgram(this.feedbackProgram); if (this.emissionProgram) gl?.deleteProgram(this.emissionProgram); if (this.blurProgram) gl?.deleteProgram(this.blurProgram); if (this.displayProgram) gl?.deleteProgram(this.displayProgram); if (this.vao) gl?.deleteVertexArray(this.vao);
    this.canvas.remove();
  }

  private dispersionAt(age: number) {
    const revealT = Math.max(0, Math.min(1, (age - 0.10) / 0.62));
    const reveal = revealT * revealT * (3 - 2 * revealT);
    if (this.curve && this.curve.length) {
      const index = Math.min(this.curve.length - 1, Math.max(0, Math.floor(age * CURVE_FPS)));
      const sourceCurve = Math.max(0, Math.min(1, (this.curve[index] - this.curveMin) / Math.max(1, this.curveMax - this.curveMin)));
      return Math.max(sourceCurve, reveal);
    }
    return Math.max(reveal, Math.min(1, age / 3.2));
  }

  private extractBloom(sceneTexture: WebGLTexture, targetIndex: number) {
    const gl = this.gl;
    if (!gl || !this.emissionProgram) return;
    const target = this.bloomTargets[targetIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.emissionProgram);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.uniform1i(this.emissionUniforms.uScene, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blurBloom(sourceIndex: number, targetIndex: number, directionX: number, directionY: number, radius: number) {
    const gl = this.gl;
    if (!gl || !this.blurProgram) return;
    const source = this.bloomTargets[sourceIndex];
    const target = this.bloomTargets[targetIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(this.blurProgram);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(this.blurUniforms.uSource, 0);
    gl.uniform2f(this.blurUniforms.uTexel, 1 / source.width, 1 / source.height);
    gl.uniform2f(this.blurUniforms.uDirection, directionX, directionY);
    gl.uniform1f(this.blurUniforms.uRadius, radius);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private async loadMotionCurve() {
    try {
      const response = await fetch('/effects/video-motion.json'); if (!response.ok) return;
      const data = await response.json() as { widths?: number[] };
      if (!data.widths?.length) return;
      this.curve = data.widths.slice(0, Math.min(data.widths.length, 180));
      this.curveMin = Math.min(...this.curve); this.curveMax = Math.max(...this.curve);
    } catch { /* fallback curve keeps the burst functional offline */ }
  }

  private createTexture(width: number, height: number, data: ArrayBufferView | null = null, hdr = false) {
    const gl = this.gl!; const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA, width, height, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, data); return texture;
  }

  private createTarget(width: number, height: number, hdr = false): Target | null {
    const gl = this.gl!;
    const texture = this.createTexture(width, height, null, hdr);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) { gl.deleteTexture(texture); return null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); return null;
    }
    return { texture, framebuffer, width, height };
  }

  private clearAccumulation() {
    const gl = this.gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    for (const target of [...this.targets, ...this.bloomTargets]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private rebuildTargets() {
    const gl = this.gl; if (!gl || !this.width || !this.height) return;
    for (const target of this.targets) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
    for (const target of this.bloomTargets) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
    this.targets.length = 0;
    this.bloomTargets.length = 0;
    for (let index = 0; index < 2; index += 1) {
      const target = this.createTarget(this.width, this.height);
      if (target) this.targets.push(target);
    }
    for (const scale of [0.5, 0.25, 0.125]) {
      const bloomWidth = Math.max(1, Math.ceil(this.width * scale));
      const bloomHeight = Math.max(1, Math.ceil(this.height * scale));
      for (let index = 0; index < 2; index += 1) {
        const target = this.createTarget(bloomWidth, bloomHeight, this.supportsFloatBloom);
        if (target) this.bloomTargets.push(target);
      }
    }
    // Some mobile GPUs expose the float extension but reject a float colour
    // attachment at this size. Fall back to the same separated RGBA8 pipeline.
    if (this.bloomTargets.length !== 6 && this.supportsFloatBloom) {
      for (const target of this.bloomTargets) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
      this.bloomTargets.length = 0;
      this.supportsFloatBloom = false;
      for (const scale of [0.5, 0.25, 0.125]) {
        const bloomWidth = Math.max(1, Math.ceil(this.width * scale));
        const bloomHeight = Math.max(1, Math.ceil(this.height * scale));
        for (let index = 0; index < 2; index += 1) {
          const target = this.createTarget(bloomWidth, bloomHeight);
          if (target) this.bloomTargets.push(target);
        }
      }
    }
    gl.clearColor(0, 0, 0, 0);
    for (const target of [...this.targets, ...this.bloomTargets]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.previousTarget = 0; this.accumulationCleared = true;
  }

  private loadTextures() {
    ['/effects/td-mandala-1.png', '/effects/td-mandala-2.png', '/effects/td-mandala-3.png'].forEach((path, index) => {
      const image = new Image();
      image.onload = () => {
        if (!this.gl || this.disposed) return;
        const sample = document.createElement('canvas'); sample.width = GRID_SIZE; sample.height = GRID_SIZE;
        const context = sample.getContext('2d', { willReadFrequently: true }); if (!context) return;
        const ratio = Math.min(GRID_SIZE / image.width, GRID_SIZE / image.height);
        context.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
        context.drawImage(image, (GRID_SIZE - image.width * ratio) * 0.5, (GRID_SIZE - image.height * ratio) * 0.5, image.width * ratio, image.height * ratio);
        const pixels = context.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;
        const texture = this.createTexture(GRID_SIZE, GRID_SIZE, pixels);
        this.imageTextures[index] = texture;
      };
      image.src = path;
    });
  }
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) { const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource); const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource); const program = gl.createProgram(); if (!program) throw new Error('Unable to create particle program'); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Unable to link particle program'); return program; }
function compileShader(gl: WebGL2RenderingContext, type: number, source: string) { const shader = gl.createShader(type); if (!shader) throw new Error('Unable to create particle shader'); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Unable to compile particle shader'); return shader; }
function smoothstep(edge0: number, edge1: number, value: number) { const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.0001, edge1 - edge0))); return t * t * (3 - 2 * t); }
