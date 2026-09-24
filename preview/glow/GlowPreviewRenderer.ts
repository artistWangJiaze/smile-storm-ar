// LOCAL-ONLY lighting study. Production does not import this renderer.
// Keeps production collision response; studies bloom choreography and HDR lighting.
import type { HeadCollider } from '../../src/types';
import {
  createLocalImpactSites,
} from '../../src/HeadInteraction';
import type { LocalImpactSite } from '../../src/HeadInteraction';
import { TDParticleSimulation, TD_GRID, TD_COUNT } from './GlowPreviewSimulation';
import type { ParticleState } from './GlowPreviewSimulation';
import { targetVertex } from './TargetFrame';
import { growthVertex } from './GrowthFrame';
import { continuousVertex } from './ContinuousFrame';
import { arCollisionVertex, arRenderVertex } from './ARMotion';
import { TDParticleSimulation as ARSimulation } from '../../src/TDParticleSimulation';
import type { ParticleState as ARState } from '../../src/TDParticleSimulation';
import { storyboardVertex as motionVertex, targetBodyFragment } from './FourthFrame';

const GRID_SIZE = TD_GRID;
const PARTICLE_COUNT = TD_COUNT;
const BURST_SLOTS = 4;
const BURST_LIFETIME = 3.25;
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
uniform float uPixelRatio,uAlpha,uDispersion,uAge,uDt;
out vec3 vEmission;
out vec2 vDirection;
out float vAspect;
out float vSpark;
out float vCoverage;
float hash(float x){return fract(sin(x*127.1+37.2)*43758.5453);}
void main(){
  float id=float(gl_VertexID);
  vec2 uv=(vec2(float(gl_VertexID%300),float(gl_VertexID/300))+0.5)/300.0;
  vec4 source=texture(uImage,vec2(uv.x,1.0-uv.y));
  float death=mix(2.05,3.12,hash(id));
  float fade=(1.0-smoothstep(death-0.72,death,uAge))*uAlpha;
  if(aContact.z>=0.0) fade*=1.0-smoothstep(1.45,2.1,aContact.z);
  // Coverage is independent from emission strength and colour luminance.
  // Reuse the accumulation target's previously unused alpha channel.
  vCoverage=fade*source.a*0.5*min(uDt*60.0,2.0);
  if(aContact.z < -1.5 || fade<0.001){
    gl_Position=vec4(2);gl_PointSize=1.0;vEmission=vec3(0);vDirection=vec2(1,0);vAspect=1.0;vSpark=0.0;return;
  }
  vec2 world=aState.xy*uPixelRatio;
  gl_Position=vec4(world.x/uViewport.x*2.0-1.0,1.0-world.y/uViewport.y*2.0,0,1);
  float speed=length(aState.zw);
  vDirection=speed>0.01?aState.zw/speed:vec2(1,0);
  vec3 linear=pow(source.rgb,vec3(2.2));
  float luma=dot(linear,vec3(0.2126,0.7152,0.0722));
  float edge=smoothstep(0.40,0.85,luma);
  float ignition=exp(-pow((uAge-1.12)/0.38,2.0));
  float rayRegion=smoothstep(0.06,0.18,length(uv-0.5));
  // A sparse, bright subset supplies hard spark fragments, not a uniformly
  // blurred zoom. Direction remains the actual simulated particle velocity.
  vSpark=step(0.90,hash(id+17.0))*smoothstep(0.18,0.58,luma)*rayRegion;
  float len=clamp(speed*0.004,0.0,2.8)*rayRegion+vSpark*ignition*13.0;
  gl_PointSize=(2.1+len)*uPixelRatio;
  vAspect=(2.1+len)/mix(1.65,1.05,vSpark);
  // Colour and radiance are different quantities: hot edges may exceed 1,
  // without bleaching the less emissive coloured petal interiors.
  float pulse=0.76+1.20*ignition;
  float shimmer=0.88+0.12*sin(uAge*19.0+hash(id+3.0)*6.283);
  vEmission=linear*mix(0.42,1.35,edge)*pulse*(1.0+vSpark*ignition*2.4)*fade*shimmer*source.a*min(uDt*60.0,2.0);
}`;

const pointFragmentShader = `#version 300 es
precision highp float;
in vec3 vEmission;
in vec2 vDirection;
in float vAspect;
in float vSpark;
in float vCoverage;
out vec4 outColor;
void main(){
  vec2 p=(gl_PointCoord-0.5)*2.0;
  vec2 d=vec2(vDirection.x,-vDirection.y);
  vec2 q=vec2(dot(p,d),dot(p,vec2(-d.y,d.x))*vAspect);
  float r2=dot(q,q);
  float soft=exp(-r2*3.8)*(1.0-smoothstep(0.7,1.0,r2));
  float core=(1.0-smoothstep(0.38,0.95,abs(q.x)))*exp(-q.y*q.y*7.0);
  float kernel=mix(soft,core,vSpark*0.85);
  vec3 light=vEmission*kernel;
  outColor=vec4(light,kernel*vCoverage);
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
void main(){
  vec3 light=texture(uScene,vUv).rgb;
  float luminance=dot(light,vec3(0.2126,0.7152,0.0722));
  float threshold=smoothstep(0.12,0.65,luminance);
  outColor=vec4(light*threshold,0.0);
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
uniform sampler2D uScene,uBloomNear,uBloomMid,uBloomWide;
uniform sampler2D uCamera;
uniform int uBackground;
uniform int uCompositeMode;
uniform vec2 uCameraScale;
uniform float uGlow,uSaturation,uHighlightDetail,uCoreTint,uInnerColourParticles,uColourParticleLight;
in vec2 vUv;
out vec4 outColor;
vec3 toLinear(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c));}
vec3 toDisplay(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}
float hash21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec3 body=texture(uScene,vUv).rgb;
  vec3 nearLight=texture(uBloomNear,vUv).rgb;
  vec3 midLight=texture(uBloomMid,vUv).rgb;
  vec3 wideLight=texture(uBloomWide,vUv).rgb;
  // Keep hot cores local to sharp sparks, not the entire blurred flower.
  vec3 sharp=max(body-nearLight*0.85,vec3(0));
  float core=max(max(sharp.r,sharp.g),sharp.b);
  float hot=min(core*smoothstep(0.65,2.8,core)*0.38,0.75);
  vec3 colour=max(body*0.72+uGlow*(nearLight*0.46+midLight*0.23+wideLight*0.09),vec3(0));
  float colourPeak=max(max(colour.r,colour.g),colour.b);
  // Bound broad coloured energy while preserving channel ratios. Unbounded
  // white-hot radiance is not spread over every dense patch of the pattern.
  vec3 energy=colour/(1.0+colourPeak*0.55)+vec3(1.0,0.91,0.74)*hot;
  vec3 background=vec3(0);
  if(uBackground==1) background=vec3(182.0,185.0,191.0)/255.0;
  if(uBackground==2){
    // Browser video uploads are top-down. Mirror the front camera, then crop
    // exactly like object-fit:cover, independently from the particle positions.
    vec2 uv=(vec2(1.0-vUv.x,1.0-vUv.y)-0.5)*uCameraScale+0.5;
    background=texture(uCamera,uv).rgb;
  }
  vec3 bg=toLinear(background);
  if(uCompositeMode==2){
    // Preserve the approved black-background light exactly. Hybrid coverage
    // retains saturated particle colours over video, while bloom adds light
    // without a rectangular matte or a global background dimmer.
    vec3 radiance=body+nearLight*0.22+midLight*0.12+wideLight*0.045;
    // Keep the proven bright additive mix for the full flower. Add white only
    // to the sharpest particle cores so the outer colours stay saturated.
    vec3 light=clamp(radiance*1.65,0.0,1.0);
    light=clamp(light+vec3(1.0,0.97,0.90)*hot*0.16,0.0,1.0);
    // Narrow the broad clipped-white plateau while leaving the sparse sharp
    // cores at the original peak. Peak brightness stays available, but centre
    // detail is no longer buried under a large flat area of white.
    float hardPeak=max(max(light.r,light.g),light.b);
    float whitePlateau=smoothstep(0.72,1.0,hardPeak);
    float sharpCore=smoothstep(0.10,0.34,hot);
    float plateauReduction=uHighlightDetail*whitePlateau*(1.0-sharpCore);
    light*=1.0-plateauReduction;
    // Local colour study: separate the RGB channels without changing the
    // brightest channel of any pixel. This preserves the approved peak light.
    float originalPeak=max(max(light.r,light.g),light.b);
    // Once RGB has clipped to white, ordinary saturation cannot recover hue.
    // Borrow only the channel ratio from the unclipped radiance, then restore
    // the exact original peak. 8/12/16 therefore remain visible even in the
    // white-hot area without making any pixel brighter or darker at its peak.
    vec3 hueSource=max(radiance+vec3(1.0,0.97,0.90)*hot*0.10,vec3(0));
    float huePeak=max(max(hueSource.r,hueSource.g),hueSource.b);
    vec3 clippedRatio=light/max(originalPeak,0.00001);
    vec3 hueRatio=hueSource/max(huePeak,0.00001);
    // Keep the white-hot centre optically neutral. Colour recovery belongs to
    // the shoulder and outer particles; tinting the peak creates pastel cyan /
    // pink shapes that read as colour distortion instead of emitted light.
    float highlightProtection=1.0-smoothstep(0.68,0.96,originalPeak);
    float recovery=clamp((uSaturation-1.0)*2.0*highlightProtection,0.0,1.0);
    light=mix(clippedRatio,hueRatio,recovery)*originalPeak;
    // Give the broad white centre one coherent warm blush instead of
    // reconstructing saturated source hues there. Red stays at 1.0, so the
    // peak is unchanged while green/blue recede by only a few percent.
    float tintMask=smoothstep(0.72,0.98,hardPeak)*(1.0-sharpCore*0.35);
    vec3 warmBlush=vec3(1.0,0.86,0.76);
    light=mix(light,light*warmBlush,uCoreTint*tintMask);
    // Restore source colour on a sparse subset of actual sharp particle pixels
    // inside the white centre. The white field stays neutral; colour appears as
    // individual sparks rather than a tint or reconstructed flower graphic.
    float radius=length(vUv-0.5);
    float innerZone=1.0-smoothstep(0.18,0.47,radius);
    float sourceFloor=min(min(hueRatio.r,hueRatio.g),hueRatio.b);
    float sourceChroma=1.0-sourceFloor;
    float sharpParticle=smoothstep(0.025,0.22,core);
    float selector=step(1.0-uInnerColourParticles,hash21(floor(vUv*520.0)));
    float colouredParticle=innerZone*sharpParticle*smoothstep(0.08,0.30,sourceChroma)*selector;
    // Raise coloured spark radiance by scaling its existing RGB ratio. No
    // white is added, so extra brightness does not desaturate the particle.
    float colourParticlePeak=min(1.0,originalPeak*(1.0+uColourParticleLight));
    light=mix(light,hueRatio*colourParticlePeak,colouredParticle*0.82);
    float density=texture(uScene,vUv).a;
    float bodyPeak=max(max(body.r,body.g),body.b);
    float coverage=clamp(max(1.0-exp(-density*2.0),min(bodyPeak*1.65,1.0)*0.98),0.0,1.0);
    if(uBackground==3){
      vec3 displayLight=toDisplay(light);
      float alpha=max(coverage,max(max(displayLight.r,displayLight.g),displayLight.b));
      outColor=vec4(displayLight,alpha);return;
    }
    outColor=vec4(toDisplay(clamp(bg*(1.0-coverage)+light,0.0,1.0)),1.0);return;
  }
  // Background-anchored highlight shoulder. Zero emission reproduces the
  // camera exactly; emission can only add light, never darken the background.
  // All body/core/bloom radiance is combined before this sole output transform.
  vec3 composite=bg+(1.0-bg)*(1.0-exp(-energy*1.12));
  if(uCompositeMode==1){
    // Minimal A/B study: same particles, geometry, time and HDR buffers.
    // First establish saturated particle colour using actual sample coverage;
    // then add luminous cores and halos. Only particle-covered pixels occlude
    // the camera. There is no darkened backdrop or separate decorative sprite.
    float density=texture(uScene,vUv).a;
    float coverage=(1.0-exp(-density*2.0))*0.94;
    float peak=max(max(body.r,body.g),body.b);
    vec3 pigment=pow(body/max(peak,0.00001),vec3(1.15))*0.65;
    vec3 base=mix(bg,pigment,coverage);
    vec3 light=sharp*0.10+nearLight*0.08+midLight*0.10+wideLight*0.03
      +vec3(1.0,0.91,0.74)*hot*0.80;
    composite=base+(1.0-base)*(1.0-exp(-light*1.35));
  }
  outColor=vec4(toDisplay(composite),1.0);
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

export class GlowPreviewRenderer {
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
  private backgroundMode: 'black' | 'light' | 'camera' | 'transparent' = 'black';
  private cameraVideo: HTMLVideoElement | null = null;
  private cameraTexture: WebGLTexture | null = null;
  private compositeMode: 'current' | 'colour-glow' = 'colour-glow';
  private saturation = 1;
  private highlightDetail = 0;
  private coreTint = 0;
  private innerColourParticles = 0;
  private colourParticleLight = 0;
  private targetProgram: WebGLProgram | null = null;
  private growthProgram: WebGLProgram | null = null;
  private continuousProgram: WebGLProgram | null = null;
  private arProgram: WebGLProgram | null = null;
  private arSimulation: ARSimulation | null = null;
  private arStates = new Map<number, ARState[]>();
  private arImpacts = new Map<ARState,{time:number;x:number;y:number;sites:LocalImpactSite[]}>();
  get arBouncedCount(){return [...this.arStates.values()].flat().reduce((n,s)=>n+s.stats.bounced,0);}
  resetARContacts(){
    for(const states of this.arStates.values())for(const state of states)this.arSimulation?.reset(state);
    this.arImpacts.clear();
  }
  private targetMotionProgram: WebGLProgram | null = null;
  private targetBodyProgram: WebGLProgram | null = null;
  private targetFrame = false;

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
    for (const name of ['uImage', 'uViewport', 'uPixelRatio', 'uDispersion', 'uAlpha', 'uAge', 'uDt']) this.pointUniforms[name] = this.gl.getUniformLocation(this.pointProgram, name);
    for (const name of ['uPrevious', 'uDecay', 'uCutoff']) this.feedbackUniforms[name] = this.gl.getUniformLocation(this.feedbackProgram, name);
    for (const name of ['uScene']) this.emissionUniforms[name] = this.gl.getUniformLocation(this.emissionProgram, name);
    for (const name of ['uSource', 'uTexel', 'uDirection', 'uRadius']) this.blurUniforms[name] = this.gl.getUniformLocation(this.blurProgram, name);
    for (const name of ['uScene', 'uBloomNear', 'uBloomMid', 'uBloomWide', 'uGlow', 'uSaturation', 'uHighlightDetail', 'uCoreTint', 'uInnerColourParticles', 'uColourParticleLight', 'uCamera', 'uBackground', 'uCameraScale', 'uCompositeMode']) this.displayUniforms[name] = this.gl.getUniformLocation(this.displayProgram, name);
    this.fallbackTexture = this.createTexture(1, 1, new Uint8Array([0, 0, 0, 0]));
    this.cameraTexture = this.createTexture(1, 1, new Uint8Array([0, 0, 0, 255]));
    this.loadTextures();
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
    this.targetFrame = false;
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
      // The lighting preview has no tracked head, so avoid unnecessary GPU
      // readback (especially during deterministic timeline scrubbing).
      if(head) this.simulation.updateStats(slot.state, time);
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
    const decay = hasActiveBurst ? Math.pow(0.87, safeDt * 60) : Math.pow(0.82, safeDt * 60);
    gl.uniform1f(this.feedbackUniforms.uDecay, decay);
    gl.uniform1f(this.feedbackUniforms.uCutoff, hasActiveBurst ? 0.0008 : 0.002);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Preserve the source palette in the feedback buffer. The display pass
    // supplies the additive-looking glow without repeatedly bleaching RGB.
    gl.useProgram(this.pointProgram); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(this.pointUniforms.uViewport, this.width, this.height);
    gl.uniform1f(this.pointUniforms.uPixelRatio, this.dpr);
    gl.uniform1i(this.pointUniforms.uImage, 0);
    for (const slot of this.slots) {
      if (!slot.active || !slot.state || slot.state.reset) continue;
      const age = time - slot.start;
      const dispersion = this.dispersionAt(age);
      const fade = 1.0 - smoothstep(2.55, BURST_LIFETIME, age);
      gl.uniform1f(this.pointUniforms.uAge, age); gl.uniform1f(this.pointUniforms.uDt, safeDt);
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

    this.previousTarget = nextTarget;
    this.refreshBackground();
    return contactCount;
  }

  setBackground(mode: 'black' | 'light' | 'camera' | 'transparent', video: HTMLVideoElement | null = null) {
    this.backgroundMode = mode;
    this.cameraVideo = mode === 'camera' ? video : null;
    this.refreshBackground();
  }

  setCompositeMode(mode: 'current' | 'colour-glow') {
    this.compositeMode = mode;
    this.refreshBackground();
  }

  setSaturationBoost(percent: number) {
    this.saturation = 1 + Math.max(0, percent) / 100;
    this.refreshBackground();
  }

  setHighlightDetail(percent: number) {
    this.highlightDetail = Math.max(0, Math.min(100, percent)) / 100;
    this.refreshBackground();
  }

  setCoreTint(percent: number) {
    this.coreTint = Math.max(0, Math.min(100, percent)) / 100;
    this.refreshBackground();
  }

  setInnerColourParticles(percent: number) {
    this.innerColourParticles = Math.max(0, Math.min(100, percent)) / 100;
    this.refreshBackground();
  }

  setColourParticleLight(percent: number) {
    this.colourParticleLight = Math.max(0, Math.min(100, percent)) / 100;
    this.refreshBackground();
  }

  renderTargetFrame(time = -1, growthStudy = false, continuous = false, placements?: Array<{id:number;age:number;x:number;y:number;extent:number;palette:number;angle?:number;particleStep?:number}>, head:HeadCollider|null=null, headVx=0, headVy=0, dt=1/60) {
    const gl=this.gl;
    if(!gl||!this.ready||this.targets.length!==2) return;
    this.targetProgram??=createProgram(gl,targetVertex,pointFragmentShader);
    const pointProgram=placements?(this.arProgram??=createProgram(gl,arRenderVertex,pointFragmentShader)):
      continuous?(this.continuousProgram??=createProgram(gl,continuousVertex,pointFragmentShader)):
      growthStudy?(this.growthProgram??=createProgram(gl,growthVertex,pointFragmentShader)):
      (time<=0.85?this.targetProgram:(this.targetMotionProgram??=createProgram(gl,motionVertex,pointFragmentShader)));
    this.targetFrame=true;
    if(placements){
      this.arSimulation??=new ARSimulation(gl,arCollisionVertex);
      const alive=new Set(placements.map(p=>p.id));
      for(const [id,states] of this.arStates)if(!alive.has(id)){
        states.forEach(s=>{this.arImpacts.delete(s);this.arSimulation!.disposeState(s);});this.arStates.delete(id);
      }
      for(const p of placements){
        let states=this.arStates.get(p.id);
        if(!states){states=Array.from({length:3},()=>this.arSimulation!.createState());this.arStates.set(p.id,states);}
        // One representative layer is enough for collision statistics and the
        // local impact plan. Reading all three 90k-state buffers caused large
        // periodic GPU-to-CPU stalls when two or three flowers overlapped.
        const primary=states[0];
        if(head) this.arSimulation.updateStats(primary,p.age);
        const contact=primary.stats.firstContact;
        let sharedImpact=this.arImpacts.get(primary);
        if(head&&contact&&!sharedImpact){
          sharedImpact={time:p.age,x:head.cx,y:head.cy,sites:createLocalImpactSites(head,contact.x+contact.nx*3,contact.y+contact.ny*3,p.id)};
          this.arImpacts.set(primary,sharedImpact);
        }
        if(head&&sharedImpact&&p.age-sharedImpact.time<0.45){
          for(const site of sharedImpact.sites){site.x+=head.cx-sharedImpact.x;site.y+=head.cy-sharedImpact.y;}
          sharedImpact.x=head.cx;sharedImpact.y=head.cy;
        }
        const sharedSites=sharedImpact&&p.age-sharedImpact.time<0.45?sharedImpact.sites:[];
        for(let layer=0;layer<3;layer++){
          const state=states[layer];
          this.arSimulation.step(state,{image:(this.imageTextures[p.palette]??this.fallbackTexture)!,x:p.x,y:p.y,
            time:p.age,dt:Math.max(0.001,Math.min(dt,0.05)),scale:p.extent,dispersion:p.angle??0,seed:p.id,layer,
            head,headVx,headVy,sites:sharedSites,particleStep:p.particleStep});
        }
      }
    }
    this.clearAccumulation();this.previousTarget=0;
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.targets[0].framebuffer);
    gl.viewport(0,0,this.width,this.height);gl.bindVertexArray(this.vao);
    if(targetBodyFragment&&time>0.85&&!growthStudy&&!continuous){
      this.targetBodyProgram??=createProgram(gl,quadVertexShader,targetBodyFragment);
      gl.useProgram(this.targetBodyProgram);gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.imageTextures[0]);
      gl.uniform1i(gl.getUniformLocation(this.targetBodyProgram,'uImage'),0);
      gl.uniform1f(gl.getUniformLocation(this.targetBodyProgram,'uTime'),time);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    gl.useProgram(pointProgram);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.imageTextures[0]);
    gl.uniform1i(gl.getUniformLocation(pointProgram,'uImage'),0);
    gl.uniform2f(gl.getUniformLocation(pointProgram,'uViewport'),this.width,this.height);
    gl.uniform1f(gl.getUniformLocation(pointProgram,'uPixelRatio'),this.dpr);
    gl.uniform1f(gl.getUniformLocation(pointProgram,'uTime'),time);
    for(const instance of placements??[{id:0,age:time,x:0,y:0,extent:0,palette:0}]){
      const particleStep=Math.max(1,Math.floor(instance.particleStep??1));
      gl.uniform1f(gl.getUniformLocation(pointProgram,'uTime'),instance.age);
      gl.uniform1i(gl.getUniformLocation(pointProgram,'uParticleStep'),particleStep);
      gl.bindTexture(gl.TEXTURE_2D,this.imageTextures[instance.palette]??this.fallbackTexture);
      for(let layer=0;layer<3;layer++){
        if(placements){const s=this.arStates.get(instance.id)![layer];gl.bindVertexArray(s.vaos[s.current]);}
        gl.uniform1i(gl.getUniformLocation(pointProgram,'uLayer'),layer);
        gl.drawArrays(gl.POINTS,0,Math.ceil(90000/particleStep));
      }
    }
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    for(const i of [0,2,4]) this.extractBloom(this.targets[0].texture,i);
    this.blurBloom(0,1,1,0,0.8);this.blurBloom(1,0,0,1,0.8);
    this.blurBloom(2,3,1,0,1.2);this.blurBloom(3,2,0,1,1.2);
    this.blurBloom(4,5,1,0,1.8);this.blurBloom(5,4,0,1,1.8);
    this.refreshBackground();
  }

  // Re-composite live video when the animation is paused, without advancing
  // simulation, particle lifetime, feedback or bloom.
  refreshBackground() {
    const gl = this.gl;
    if (!gl || !this.displayProgram || this.disposed || this.targets.length !== 2 || this.bloomTargets.length !== 6) return;
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.displayProgram); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.targets[this.previousTarget].texture);
    gl.uniform1i(this.displayUniforms.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[0].texture);
    gl.uniform1i(this.displayUniforms.uBloomNear, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[2].texture);
    gl.uniform1i(this.displayUniforms.uBloomMid, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bloomTargets[4].texture);
    gl.uniform1i(this.displayUniforms.uBloomWide, 3);
    gl.uniform1f(this.displayUniforms.uGlow, 1.7);
    gl.uniform1f(this.displayUniforms.uSaturation, this.saturation);
    gl.uniform1f(this.displayUniforms.uHighlightDetail, this.highlightDetail);
    gl.uniform1f(this.displayUniforms.uCoreTint, this.coreTint);
    gl.uniform1f(this.displayUniforms.uInnerColourParticles, this.innerColourParticles);
    gl.uniform1f(this.displayUniforms.uColourParticleLight, this.colourParticleLight);
    const video = this.cameraVideo;
    const cameraReady = this.backgroundMode === 'camera' && video && video.readyState >= 2 && video.videoWidth > 0;
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
    if (cameraReady) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    const aspect = cameraReady ? video.videoWidth / video.videoHeight / (this.width / this.height) : 1;
    gl.uniform2f(this.displayUniforms.uCameraScale, Math.min(1, 1 / aspect), Math.min(1, aspect));
    gl.uniform1i(this.displayUniforms.uCamera, 4);
    gl.uniform1i(this.displayUniforms.uBackground, this.backgroundMode==='transparent'?3:cameraReady ? 2 : this.backgroundMode === 'light' ? 1 : 0);
    gl.uniform1i(this.displayUniforms.uCompositeMode, this.targetFrame ? 2 : this.compositeMode === 'colour-glow' ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    for(const states of this.arStates.values())states.forEach(s=>this.arSimulation?.disposeState(s));
    this.arStates.clear();this.arSimulation?.dispose();
    this.arImpacts.clear();
    this.disposed = true; const gl = this.gl;
    for (const texture of this.imageTextures) if (texture) gl?.deleteTexture(texture);
    if (this.fallbackTexture) gl?.deleteTexture(this.fallbackTexture);
    if (this.cameraTexture) gl?.deleteTexture(this.cameraTexture);
    if (this.targetProgram) gl?.deleteProgram(this.targetProgram);
    if (this.growthProgram) gl?.deleteProgram(this.growthProgram);
    if (this.continuousProgram) gl?.deleteProgram(this.continuousProgram);
    if (this.arProgram) gl?.deleteProgram(this.arProgram);
    if (this.targetMotionProgram) gl?.deleteProgram(this.targetMotionProgram);
    if (this.targetBodyProgram) gl?.deleteProgram(this.targetBodyProgram);
    for (const slot of this.slots) if (slot.state) this.simulation?.disposeState(slot.state);
    this.simulation?.dispose();
    for (const target of this.targets) { gl?.deleteTexture(target.texture); gl?.deleteFramebuffer(target.framebuffer); }
    for (const target of this.bloomTargets) { gl?.deleteTexture(target.texture); gl?.deleteFramebuffer(target.framebuffer); }
    if (this.pointProgram) gl?.deleteProgram(this.pointProgram); if (this.feedbackProgram) gl?.deleteProgram(this.feedbackProgram); if (this.emissionProgram) gl?.deleteProgram(this.emissionProgram); if (this.blurProgram) gl?.deleteProgram(this.blurProgram); if (this.displayProgram) gl?.deleteProgram(this.displayProgram); if (this.vao) gl?.deleteVertexArray(this.vao);
    this.canvas.remove();
  }

  private dispersionAt(age: number) {
    return age;
  }

  get ready() { return this.available && this.imageTextures.every(Boolean); }
  get element() { return this.canvas; }
  get hdrEnabled() { return this.supportsFloatBloom; }
  restart(palette=0) {
    for(const slot of this.slots) slot.active=false;
    this.clearAccumulation();
    this.time=0; this.idleSince=-1;
    this.burst(this.width/this.dpr/2,this.height/this.dpr/2,palette);
    this.slots[(this.cursor+BURST_SLOTS-1)%BURST_SLOTS].seed=42;
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
      const target = this.createTarget(this.width, this.height, true);
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
