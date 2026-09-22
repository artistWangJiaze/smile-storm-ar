import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { EnergyBurstRenderer } from './EnergyBurstRenderer';
import { TDParticleBurstRenderer } from './TDParticleBurstRenderer';
import { ARBurstAdapter } from '../preview/glow/ARBurstAdapter';
import {
  createSurfaceSample, findColliderCrossing, flowWeights, nearHeadBounds,
  pointInsideCollider, reflectAgainstHead, sampleHeadSurface,
} from './HeadInteraction';
import type { HeadCollider } from './types';

const INTERACTIVE_CAP = 480;
const TRAIL_CAP = 240;
const COLLISION_POINT_CAP = 64;
const MAX_ROCKETS = 4;
const BURST_CORE_INDEX = MAX_ROCKETS;
const FIREWORK_COOLDOWN_MS = 520;

type FireworkPalette = readonly [number, number, number, number];

const FIREWORK_PALETTES: readonly FireworkPalette[] = [
  [0xff4d00, 0xff9a00, 0xffdd33, 0xff2d55],
  [0x00cfff, 0x247bff, 0x6633ff, 0xd946ef],
  [0xff2d8a, 0xff4d4d, 0x9b4dff, 0x4cc9f0],
  [0x7cffcb, 0x00e5ff, 0x3a86ff, 0xb8f2e6],
  [0xffb4a2, 0xff758f, 0xffd166, 0xa78bfa],
];

const particleVertexShader = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uTime;
  uniform float uTrailPass;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec2 aVelocity;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vVelocity;
  varying float vSeed;
  varying float vDepth;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float speed = length(aVelocity);
    float shimmer = 0.96 + 0.04 * sin(uTime * 7.0 + aSeed * 19.0);
    float depthFactor = 0.84 + clamp((position.z + 30.0) / 60.0, 0.0, 1.0) * 0.28;
    float stretch = 1.0 + min(speed * 0.0025, 3.8) * (0.5 + uTrailPass * 0.86);
    gl_PointSize = max(1.0, aSize * uPixelRatio * uSizeScale * depthFactor * stretch * (1.0 + min(speed * 0.00042, 0.34)) * shimmer);
    gl_Position = projectionMatrix * mvPosition;
    vColor = aColor;
    vAlpha = aAlpha;
    vVelocity = aVelocity;
    vSeed = aSeed;
    vDepth = depthFactor;
  }
`;

const particleFragmentShader = /* glsl */ `
  uniform float uGlowPass;
  uniform float uTrailPass;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vVelocity;
  varying float vSeed;
  varying float vDepth;

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float distanceSq = dot(p, p);
    if (distanceSq > 1.12) discard;

    float radial = exp(-distanceSq * 3.7);
    float core = exp(-distanceSq * 13.0);
    vec2 direction = normalize(vVelocity + vec2(0.0001, 0.0001));
    vec2 normal = vec2(-direction.y, direction.x);
    vec2 oriented = vec2(dot(p, normal), dot(p, direction));
    float directional = smoothstep(-0.95, 0.72, oriented.y);
    float streak = exp(-(oriented.x * oriented.x * 32.0 + oriented.y * oriented.y * 0.25));
    streak *= mix(0.28, 1.0, directional);
    float softEdge = smoothstep(1.12, 0.08, distanceSq);
    float shape = mix(radial * 0.2, streak, clamp(0.42 + uTrailPass * 0.62, 0.0, 1.0));
    shape *= softEdge;
    float flicker = 0.9 + 0.1 * sin(vSeed * 23.0 + length(vVelocity) * 0.008);
    float alpha = vAlpha * shape * flicker * mix(0.78, 1.08, vDepth);
    float heat = clamp(0.09 + length(vVelocity) * 0.00022 + vAlpha * 0.14, 0.0, 0.34);
    vec3 color = mix(vColor, vec3(1.0), heat) * (0.82 + core * (uGlowPass > 0.5 ? 0.48 : 0.74));
    if (uGlowPass > 0.5) {
      float bloomGate = smoothstep(0.42, 0.92, vAlpha);
      alpha *= 0.46 * bloomGate;
      color *= 1.56;
    }
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

interface Batch {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute;
  color: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  alpha: THREE.BufferAttribute;
  velocity: THREE.BufferAttribute;
  seed: THREE.BufferAttribute;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  velocities: Float32Array;
  seeds: Float32Array;
}

interface RocketState {
  active: boolean;
  batchIndex: number;
  paletteIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  targetY: number;
  age: number;
  intensity: number;
}

export class ThreeFireworks {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -120, 120);
  private renderer: THREE.WebGLRenderer | null = null;
  private fireworksCanvas: HTMLCanvasElement | null = null;
  private fireworksContext: CanvasRenderingContext2D | null = null;
  private canvasPixelRatio = 1;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private ready = false;
  private lastFireworkAt = -Infinity;
  private lastPaletteIndex = -1;
  private lastCollisionCount = 0;
  private collisionRateTimer = 0;
  private collisionRateCount = 0;
  private collisionsPerSecond = 0;
  private collisionDebugEnabled = false;
  private colliderDebugEnabled = false;
  private flowVectorDebugEnabled = false;
  private midFlowCount = 0;
  private outerFlowCount = 0;
  private averageForce = 0;
  private forceTotal = 0;
  private forceSamples = 0;
  private readonly surfaceSample = createSurfaceSample();
  private head: HeadCollider | null = null;
  private headVelocityX = 0;
  private headVelocityY = 0;
  private time = 0;
  private burstCoreAge = -1;
  private burstFlashX = 0;
  private burstFlashY = 0;
  private readonly colorCache = new Map<number, string>();
  private mainCursor = 0;
  private trailCursor = 0;
  private mainActiveCount = 0;
  private trailActiveCount = 0;
  private readonly mainActive = new Uint8Array(INTERACTIVE_CAP);
  private readonly mainX = new Float32Array(INTERACTIVE_CAP);
  private readonly mainY = new Float32Array(INTERACTIVE_CAP);
  private readonly mainPrevX = new Float32Array(INTERACTIVE_CAP);
  private readonly mainPrevY = new Float32Array(INTERACTIVE_CAP);
  private readonly mainVx = new Float32Array(INTERACTIVE_CAP);
  private readonly mainVy = new Float32Array(INTERACTIVE_CAP);
  private readonly mainAge = new Float32Array(INTERACTIVE_CAP);
  private readonly mainLife = new Float32Array(INTERACTIVE_CAP);
  private readonly mainGravity = new Float32Array(INTERACTIVE_CAP);
  private readonly mainDrag = new Float32Array(INTERACTIVE_CAP);
  private readonly mainSize = new Float32Array(INTERACTIVE_CAP);
  private readonly mainColor = new Uint32Array(INTERACTIVE_CAP);
  private readonly mainLastCollisionAt = new Float32Array(INTERACTIVE_CAP);
  private readonly mainHasCollided = new Uint8Array(INTERACTIVE_CAP);
  private readonly mainSeed = new Float32Array(INTERACTIVE_CAP);
  private readonly trailActive = new Uint8Array(TRAIL_CAP);
  private readonly trailX = new Float32Array(TRAIL_CAP);
  private readonly trailY = new Float32Array(TRAIL_CAP);
  private readonly trailVx = new Float32Array(TRAIL_CAP);
  private readonly trailVy = new Float32Array(TRAIL_CAP);
  private readonly trailAge = new Float32Array(TRAIL_CAP);
  private readonly trailLife = new Float32Array(TRAIL_CAP);
  private readonly trailSize = new Float32Array(TRAIL_CAP);
  private readonly trailSeed = new Float32Array(TRAIL_CAP);
  private readonly trailPalette = new Uint8Array(TRAIL_CAP);
  private readonly collisionPointActive = new Uint8Array(COLLISION_POINT_CAP);
  private readonly collisionPointX = new Float32Array(COLLISION_POINT_CAP);
  private readonly collisionPointY = new Float32Array(COLLISION_POINT_CAP);
  private readonly collisionPointNormalX = new Float32Array(COLLISION_POINT_CAP);
  private readonly collisionPointNormalY = new Float32Array(COLLISION_POINT_CAP);
  private readonly collisionPointAge = new Float32Array(COLLISION_POINT_CAP);
  private readonly collisionPointCursor = { value: 0 };
  private readonly burstRenderer: EnergyBurstRenderer;
  private readonly tdBurstRenderer: TDParticleBurstRenderer | ARBurstAdapter;
  private readonly trailBatch: Batch;
  private readonly rocketBatch: Batch;
  private readonly collisionPointBatch: Batch;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly trailGlowMaterial: THREE.ShaderMaterial;
  private readonly rocketMaterial: THREE.ShaderMaterial;
  private readonly rocketGlowMaterial: THREE.ShaderMaterial;
  private readonly collisionPointMaterial: THREE.ShaderMaterial;
  private readonly batches: Batch[];
  private readonly materials: THREE.ShaderMaterial[];
  private readonly trailPoints: THREE.Points;
  private readonly trailGlowPoints: THREE.Points;
  private readonly rocketPoints: THREE.Points;
  private readonly rocketGlowPoints: THREE.Points;
  private readonly collisionPointPoints: THREE.Points;
  private readonly rockets: RocketState[] = Array.from({ length: MAX_ROCKETS }, (_, batchIndex) => ({
    active: false,
    batchIndex,
    paletteIndex: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    gravity: 0,
    targetY: 0,
    age: 0,
    intensity: 1,
  }));
  private burstHandler: ((x: number, y: number) => void) | null = null;

  constructor(private readonly mount: HTMLElement) {
    this.burstRenderer = new EnergyBurstRenderer(this.scene, INTERACTIVE_CAP, mount.clientWidth < 700);
    const localV3=true;
    this.tdBurstRenderer = localV3 ? new ARBurstAdapter(mount) : new TDParticleBurstRenderer(mount);
    this.trailBatch = createBatch(TRAIL_CAP);
    this.rocketBatch = createBatch(MAX_ROCKETS + 1);
    this.collisionPointBatch = createBatch(COLLISION_POINT_CAP);
    this.trailMaterial = this.createMaterial(1, 0, 1);
    this.trailGlowMaterial = this.createMaterial(2.4, 1, 1);
    this.rocketMaterial = this.createMaterial(1.2, 0, 0);
    this.rocketGlowMaterial = this.createMaterial(3.4, 1, 0);
    this.collisionPointMaterial = this.createMaterial(1.7, 1, 0);
    this.batches = [this.trailBatch, this.rocketBatch, this.collisionPointBatch];
    this.materials = [
      this.trailMaterial,
      this.trailGlowMaterial,
      this.rocketMaterial,
      this.rocketGlowMaterial,
      this.collisionPointMaterial,
    ];
    this.trailPoints = this.createPoints(this.trailBatch, this.trailMaterial);
    this.trailGlowPoints = this.createPoints(this.trailBatch, this.trailGlowMaterial);
    this.rocketPoints = this.createPoints(this.rocketBatch, this.rocketMaterial);
    this.rocketGlowPoints = this.createPoints(this.rocketBatch, this.rocketGlowMaterial);
    this.collisionPointPoints = this.createPoints(this.collisionPointBatch, this.collisionPointMaterial);
    this.scene.add(
      this.trailGlowPoints,
      this.rocketGlowPoints,
      this.trailPoints,
      this.rocketPoints,
      this.collisionPointPoints,
    );
    for (let index = 0; index <= MAX_ROCKETS; index += 1) {
      this.setBatchPosition(this.rocketBatch, index, -100, -100);
    }
  }

  init() {
    if (this.ready) return;
    try {
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: true,
      });
      this.renderer = renderer;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      renderer.setClearAlpha(0);
      const composer = new EffectComposer(renderer);
      composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      const renderPass = new RenderPass(this.scene, this.camera);
      renderPass.clearAlpha = 0;
      composer.addPass(renderPass);
      const bloomPass = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 1.1, 0.82, 0.64);
      bloomPass.threshold = 0.64;
      bloomPass.strength = 1.1;
      bloomPass.radius = 0.82;
      composer.addPass(bloomPass);
      this.composer = composer;
      this.bloomPass = bloomPass;
      renderer.domElement.className = 'three-fireworks-canvas';
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.style.display = 'none';
      this.mount.appendChild(renderer.domElement);
      const canvas = document.createElement('canvas');
      canvas.className = 'fireworks-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.zIndex = '3';
      this.mount.appendChild(canvas);
      this.fireworksCanvas = canvas;
      this.fireworksContext = canvas.getContext('2d');
      this.updateBounds();
      window.addEventListener('resize', this.updateBounds);
      this.ready = true;
    } catch (error) {
      console.warn('Three.js fireworks unavailable; keeping the camera and rain layer active.', error);
      if (!this.fireworksCanvas) {
        const canvas = document.createElement('canvas');
        canvas.className = 'fireworks-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.zIndex = '3';
        this.mount.appendChild(canvas);
        this.fireworksCanvas = canvas;
        this.fireworksContext = canvas.getContext('2d');
      }
      this.updateBounds();
      window.addEventListener('resize', this.updateBounds);
      this.ready = true;
    }
  }

  setBurstHandler(handler: ((x: number, y: number) => void) | null) {
    this.burstHandler = handler;
  }

  launch(head: HeadCollider | null, intensity = 1) {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this.lastFireworkAt < FIREWORK_COOLDOWN_MS) return;
    const rocket = this.rockets.find((candidate) => !candidate.active);
    if (!rocket) return;
    this.lastFireworkAt = now;
    rocket.active = true;
    rocket.paletteIndex = this.choosePaletteIndex();
    // Snapshot the head position at launch time. The rocket keeps this target
    // while it rises, so a moving face cannot make the ascent jitter.
    const targetX = head
      ? clamp(head.cx + random(-this.width * 0.1, this.width * 0.1), this.width * 0.18, this.width * 0.82)
      : this.width * random(0.18, 0.82);
    const targetY = head
      ? clamp(head.cy - head.ry * random(1.3, 1.6), this.height * 0.18, this.height * 0.38)
      : this.height * random(0.22, 0.38);
    rocket.x = targetX;
    rocket.y = this.height + 20;
    rocket.vx = random(-55, 55);
    // A slower, longer ascent gives the laugh-triggered rocket a readable
    // launch phase before it blooms in the upper-middle of the stage.
    rocket.vy = -random(680, 820);
    rocket.gravity = random(320, 400);
    rocket.targetY = targetY;
    rocket.age = 0;
    rocket.intensity = clamp(intensity, 0.85, 1.2);
    this.syncRocket(rocket);
  }

  update(dtSeconds: number, head: HeadCollider | null, headVelocityX = 0, headVelocityY = 0) {
    if (!this.ready) return;
    const dt = Math.min(dtSeconds, 0.034);
    this.time += dt;
    this.head = head;
    this.headVelocityX = headVelocityX;
    this.headVelocityY = headVelocityY;
    this.lastCollisionCount = 0;
    this.midFlowCount = 0;
    this.outerFlowCount = 0;
    this.forceTotal = 0;
    this.forceSamples = 0;
    this.collisionRateTimer += dt;
    this.updateRockets(dt);
    this.updateBurstCore(dt);
    this.updateTrail(dt);
    this.updateMain(dt);
    this.averageForce = this.forceSamples ? this.forceTotal / this.forceSamples : 0;
    this.updateCollisionPoints(dt);
    const visualContactCount = this.tdBurstRenderer.update(this.time, this.head, this.headVelocityX, this.headVelocityY, dt);
    if (visualContactCount > 0) {
      this.lastCollisionCount += visualContactCount;
      this.collisionRateCount += visualContactCount;
    }
    if (this.collisionRateTimer >= 1) {
      this.collisionsPerSecond = this.collisionRateCount / this.collisionRateTimer;
      this.collisionRateTimer = 0;
      this.collisionRateCount = 0;
    }
    this.drawCanvas();
  }

  get collisionCount() {
    return this.tdBurstRenderer.available ? this.tdBurstRenderer.bouncedCount : this.lastCollisionCount;
  }

  get collisionCountPerSecond() {
    return this.collisionsPerSecond;
  }

  get particlesInMidFlow() { return this.midFlowCount; }
  get particlesInOuterFlow() { return this.outerFlowCount; }
  get averageInteractionForce() { return this.averageForce; }

  setColliderDebug(enabled: boolean) { this.colliderDebugEnabled = enabled; }
  setFlowVectorDebug(enabled: boolean) { this.flowVectorDebugEnabled = enabled; }

  setCollisionDebug(enabled: boolean) {
    this.collisionDebugEnabled = enabled;
    if (!enabled) for (let index = 0; index < COLLISION_POINT_CAP; index += 1) this.setBatchAlpha(this.collisionPointBatch, index, 0);
  }

  private choosePaletteIndex() {
    const paletteCount = this.tdBurstRenderer instanceof ARBurstAdapter ? 3 : FIREWORK_PALETTES.length;
    let nextIndex = Math.floor(Math.random() * paletteCount);
    if (paletteCount > 1 && nextIndex === this.lastPaletteIndex) {
      nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (paletteCount - 1))) % paletteCount;
    }
    this.lastPaletteIndex = nextIndex;
    return nextIndex;
  }

  get activeParticleCount() {
    let activeRockets = 0;
    for (const rocket of this.rockets) if (rocket.active) activeRockets += 1;
    return this.tdBurstRenderer.activeCount + this.mainActiveCount + this.trailActiveCount + activeRockets + (this.burstCoreAge >= 0 ? 1 : 0);
  }

  destroy() {
    window.removeEventListener('resize', this.updateBounds);
    this.burstRenderer.dispose(this.scene);
    this.tdBurstRenderer.dispose();
    for (const batch of this.batches) batch.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.bloomPass?.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.fireworksCanvas?.remove();
    this.fireworksCanvas = null;
    this.fireworksContext = null;
    this.renderer = null;
    this.ready = false;
  }

  private createMaterial(sizeScale: number, glowPass: number, trailPass: number) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) },
        uSizeScale: { value: sizeScale },
        uGlowPass: { value: glowPass },
        uTrailPass: { value: trailPass },
        uTime: { value: 0 },
      },
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
  }

  private createPoints(batch: Batch, material: THREE.ShaderMaterial) {
    const points = new THREE.Points(batch.geometry, material);
    points.frustumCulled = false;
    return points;
  }

  private readonly updateBounds = () => {
    const width = this.width;
    const height = this.height;
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = 0;
    this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(width, height, false);
    this.composer?.setSize(width, height);
      this.bloomPass?.setSize(width, height);
    if (this.fireworksCanvas && this.fireworksContext) {
      this.canvasPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      this.fireworksCanvas.width = Math.max(1, Math.round(width * this.canvasPixelRatio));
      this.fireworksCanvas.height = Math.max(1, Math.round(height * this.canvasPixelRatio));
      this.fireworksCanvas.style.width = `${width}px`;
      this.fireworksCanvas.style.height = `${height}px`;
      this.fireworksContext.setTransform(this.canvasPixelRatio, 0, 0, this.canvasPixelRatio, 0, 0);
    }
    this.tdBurstRenderer.resize(width, height);
  };

  private get width() {
    return Math.max(1, this.mount.clientWidth);
  }

  private get height() {
    return Math.max(1, this.mount.clientHeight);
  }

  private drawCanvas() {
    const ctx = this.fireworksContext;
    if (!ctx) return;
    const width = this.width;
    const height = this.height;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.burstCoreAge >= 0 && this.burstCoreAge < 0.16) {
      const progress = this.burstCoreAge / 0.16;
      const radius = 24 + progress * 92;
      const glow = ctx.createRadialGradient(this.burstFlashX, this.burstFlashY, 0, this.burstFlashX, this.burstFlashY, radius);
      glow.addColorStop(0, `rgba(255,255,238,${0.42 * (1 - progress)})`);
      glow.addColorStop(0.22, `rgba(130,225,255,${0.18 * (1 - progress)})`);
      glow.addColorStop(1, 'rgba(70,180,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(this.burstFlashX - radius, this.burstFlashY - radius, radius * 2, radius * 2);
    }

    for (const rocket of this.rockets) {
      if (!rocket.active) continue;
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = this.colorCss(FIREWORK_PALETTES[rocket.paletteIndex][2]);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(rocket.x - rocket.vx * 0.035, rocket.y - rocket.vy * 0.035);
      ctx.lineTo(rocket.x, rocket.y);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = '#fffce8';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(rocket.x - rocket.vx * 0.008, rocket.y - rocket.vy * 0.008);
      ctx.lineTo(rocket.x, rocket.y);
      ctx.stroke();
    }

    // CPU particles are a fallback only. The main TD cloud integrates its
    // own persistent position/velocity records on the GPU.
    for (let index = 0; index < INTERACTIVE_CAP; index += 1) {
      if (!this.mainActive[index]) continue;
      const life = 1 - this.mainAge[index] / this.mainLife[index];
      const speed = Math.hypot(this.mainVx[index], this.mainVy[index]);
      ctx.globalAlpha = Math.max(0, life) * 0.72;
      ctx.strokeStyle = this.colorCss(this.mainColor[index]);
      ctx.lineWidth = clamp(this.mainSize[index] * 0.16 + speed * 0.0013, 1.1, 3.2);
      ctx.beginPath();
      ctx.moveTo(this.mainPrevX[index], this.mainPrevY[index]);
      ctx.lineTo(this.mainX[index], this.mainY[index]);
      ctx.stroke();
    }

    if (this.collisionDebugEnabled) {
      for (let index = 0; index < COLLISION_POINT_CAP; index += 1) {
        if (!this.collisionPointActive[index]) continue;
        const fade = Math.max(0, 1 - this.collisionPointAge[index] / 0.22);
        ctx.globalAlpha = fade;
        ctx.strokeStyle = '#7dffe3';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.collisionPointX[index], this.collisionPointY[index]);
        ctx.lineTo(this.collisionPointX[index] + this.collisionPointNormalX[index] * 12,
          this.collisionPointY[index] + this.collisionPointNormalY[index] * 12);
        ctx.stroke();
      }
    }

    ctx.restore();
    if (this.colliderDebugEnabled && this.head) this.drawHeadInteractionDebug(ctx, this.head);
  }

  private drawHeadInteractionDebug(ctx: CanvasRenderingContext2D, head: HeadCollider) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const points = head.points;
    if (points && points.length >= 3) {
      for (const [scale, color] of [[0, 'rgba(111,255,229,.9)'], [0.22, 'rgba(118,196,255,.6)'], [0.40, 'rgba(231,149,255,.4)']] as const) {
        ctx.beginPath();
        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          const previous = points[(index - 1 + points.length) % points.length];
          const next = points[(index + 1) % points.length];
          let normalX = next.y - previous.y;
          let normalY = previous.x - next.x;
          if (normalX * (point.x - head.cx) + normalY * (point.y - head.cy) < 0) {
            normalX = -normalX; normalY = -normalY;
          }
          const length = Math.hypot(normalX, normalY) || 1;
          const radius = Math.max(36, Math.hypot(point.x - head.cx, point.y - head.cy));
          const x = point.x + normalX / length * radius * scale;
          const y = point.y + normalY / length * radius * scale;
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = scale === 0 ? 1.4 : 1;
        ctx.setLineDash(scale === 0 ? [] : [4, 5]);
        ctx.stroke();
      }
      if (this.flowVectorDebugEnabled) {
        ctx.setLineDash([]);
        for (let index = 0; index < points.length; index += 3) {
          const point = points[index];
          const sample = sampleHeadSurface(point.x, point.y, head, this.surfaceSample);
          const tangentX = -sample.normalY;
          const tangentY = sample.normalX;
          const x = point.x + sample.normalX * sample.localRadius * 0.15;
          const y = point.y + sample.normalY * sample.localRadius * 0.15;
          drawDebugVector(ctx, x, y, sample.normalX, sample.normalY, 13, '#7dffe3');
          drawDebugVector(ctx, x, y, tangentX, tangentY, 18, '#ee9eff');
          const flowX = tangentX * 0.8 + sample.normalX * 0.2 + this.headVelocityX / 700;
          const flowY = tangentY * 0.8 + sample.normalY * 0.2 + this.headVelocityY / 700;
          drawDebugVector(ctx, x, y, flowX, flowY, 23, '#ffe5a0');
        }
      }
    } else {
      for (const [scale, color] of [[1, '#7dffe3'], [1.22, '#76c4ff'], [1.4, '#e795ff']] as const) {
        ctx.beginPath();
        ctx.ellipse(head.cx, head.cy, head.rx * scale, head.ry * scale, head.rotation ?? 0, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private colorCss(color: number) {
    const cached = this.colorCache.get(color);
    if (cached) return cached;
    const value = `#${color.toString(16).padStart(6, '0')}`;
    this.colorCache.set(color, value);
    return value;
  }

  private updateRockets(dt: number) {
    for (const rocket of this.rockets) {
      if (!rocket.active) continue;
      rocket.age += dt;
      rocket.vx += Math.sin(rocket.age * 4.2) * 8 * dt;
      rocket.vy += rocket.gravity * dt;
      rocket.x += rocket.vx * dt;
      rocket.y += rocket.vy * dt;
      this.spawnTrail(rocket.x, rocket.y + 16, rocket.paletteIndex, rocket.vx, rocket.vy);
      this.syncRocket(rocket);

      if (rocket.y <= rocket.targetY || rocket.vy >= -80 || rocket.age > 2.0) {
        const burstX = rocket.x;
        const burstY = rocket.y;
        rocket.active = false;
        this.setBatchAlpha(this.rocketBatch, rocket.batchIndex, 0);
        this.setBatchPosition(this.rocketBatch, rocket.batchIndex, -100, -100);
        this.burstCoreAge = 0;
        this.burstFlashX = burstX;
        this.burstFlashY = burstY;
        this.setBatchPosition(this.rocketBatch, BURST_CORE_INDEX, burstX, burstY);
        this.setBatchVelocity(this.rocketBatch, BURST_CORE_INDEX, 0, 0);
        this.setBatchColor(this.rocketBatch, BURST_CORE_INDEX, 0xffffff);
        this.setBatchSize(this.rocketBatch, BURST_CORE_INDEX, 76);
        this.setBatchAlpha(this.rocketBatch, BURST_CORE_INDEX, 1.0);
        this.burstHandler?.(burstX, burstY);
        if (!this.tdBurstRenderer.available) {
          const mainCount = this.width < 700 ? 280 : 320;
          this.spawnBurst(burstX, burstY, Math.floor(mainCount * rocket.intensity), rocket.paletteIndex);
        }
        this.tdBurstRenderer.burst(burstX, burstY, rocket.paletteIndex);
      }
    }
  }

  private updateBurstCore(dt: number) {
    if (this.burstCoreAge < 0) return;
    this.burstCoreAge += dt;
    const progress = this.burstCoreAge / 0.12;
    this.setBatchSize(this.rocketBatch, BURST_CORE_INDEX, 76 + progress * 64);
    this.setBatchAlpha(this.rocketBatch, BURST_CORE_INDEX, Math.max(0, 1.0 - progress));
    if (progress >= 1) {
      this.burstCoreAge = -1;
      this.setBatchAlpha(this.rocketBatch, BURST_CORE_INDEX, 0);
      this.setBatchPosition(this.rocketBatch, BURST_CORE_INDEX, -100, -100);
    }
  }

  private syncRocket(rocket: RocketState) {
    const index = rocket.batchIndex;
    this.rocketBatch.seeds[index] = 0.42 + index * 0.07;
    this.setBatchPosition(this.rocketBatch, index, rocket.x, rocket.y);
    this.setBatchVelocity(this.rocketBatch, index, rocket.vx, rocket.vy);
    this.setBatchColor(this.rocketBatch, index, 0xffffe1);
    this.setBatchSize(this.rocketBatch, index, rocket.active ? 25 + Math.min(10, rocket.age * 12) : 0);
    this.setBatchAlpha(this.rocketBatch, index, rocket.active ? 1 : 0);
  }

  private spawnTrail(x: number, y: number, paletteIndex: number, rocketVx: number, rocketVy: number) {
    const index = this.acquireTrail();
    if (index < 0) return;
    this.trailActive[index] = 1;
    this.trailActiveCount += 1;
    this.trailX[index] = x + random(-5, 5);
    this.trailY[index] = y + random(-2, 7);
    // Inherit a little of the rocket motion so fragments read as one
    // continuous wake instead of unrelated dots.
    this.trailVx[index] = rocketVx * 0.18 + random(-42, 42);
    this.trailVy[index] = Math.max(30, -rocketVy * 0.16 + random(-18, 36));
    this.trailAge[index] = 0;
    this.trailLife[index] = random(0.42, 0.82);
    this.trailSize[index] = random(4.5, 9.5);
    this.trailSeed[index] = Math.random();
    this.trailPalette[index] = paletteIndex;
    this.trailBatch.seeds[index] = this.trailSeed[index];
    this.setBatchColor(this.trailBatch, index, pickPaletteColor(paletteIndex, index + 3));
    this.syncTrail(index);
  }

  private spawnBurst(x: number, y: number, count: number, paletteIndex: number) {
    for (let index = 0; index < count; index += 1) {
      const particleIndex = this.acquireMain();
      if (particleIndex < 0) break;
      this.mainActive[particleIndex] = 1;
      this.mainActiveCount += 1;
      const radialAngle = (index / count) * Math.PI * 2;
      const lobeBias = Math.sin(radialAngle * 4.0 + paletteIndex * 1.7) * 0.18;
      const sectorAngle = Math.floor(Math.random() * 8) * (Math.PI * 2 / 8);
      const clusteredAngle = sectorAngle + random(-0.34, 0.34);
      const angle = radialAngle * 0.62 + clusteredAngle * 0.38 + lobeBias + random(-0.16, 0.16);
      const clusterEnergy = 0.68 + Math.pow(Math.random(), 0.62) * 0.56;
      const speed = random(235, 610) * clusterEnergy;
      this.mainX[particleIndex] = x + random(-4, 4);
      this.mainY[particleIndex] = y + random(-4, 4);
      this.mainPrevX[particleIndex] = this.mainX[particleIndex];
      this.mainPrevY[particleIndex] = this.mainY[particleIndex];
      this.mainVx[particleIndex] = Math.cos(angle) * speed;
      // A small upward bias keeps the visual mass above the face before
      // gravity takes over, without changing the radial character of the
      // imported burst.
      this.mainVy[particleIndex] = Math.sin(angle) * speed - speed * random(0.06, 0.14);
      this.mainAge[particleIndex] = 0;
      this.mainLife[particleIndex] = random(1.125, 1.675);
      this.mainGravity[particleIndex] = random(145, 255);
      this.mainDrag[particleIndex] = random(0.958, 0.982);
      this.mainSize[particleIndex] = random(5.5, 12.5);
      this.mainLastCollisionAt[particleIndex] = -Infinity;
      this.mainHasCollided[particleIndex] = 0;
      this.mainSeed[particleIndex] = Math.random() * 10;
      this.mainColor[particleIndex] = pickPaletteColor(paletteIndex, index);
      this.syncMain(particleIndex, 1);
    }
  }

  private updateMain(dt: number) {
    for (let index = 0; index < INTERACTIVE_CAP; index += 1) {
      if (!this.mainActive[index]) continue;
      this.mainAge[index] += dt;
      this.mainPrevX[index] = this.mainX[index];
      this.mainPrevY[index] = this.mainY[index];
      const seed = this.mainSeed[index];
      this.mainVx[index] += (Math.sin(this.mainAge[index] * 3.1 + seed) * 24 + Math.cos(this.mainAge[index] * 1.7 + seed * 0.7) * 8) * dt;
      this.mainVy[index] += (Math.cos(this.mainAge[index] * 2.6 + seed * 1.7) * 18 + Math.sin(this.mainAge[index] * 1.45 + seed) * 6) * dt;
      if (this.head) this.applyHeadFlow(index, this.head, dt);
      const drag = Math.pow(this.mainDrag[index], dt * 60);
      this.mainVx[index] *= drag;
      this.mainVy[index] = this.mainVy[index] * drag + this.mainGravity[index] * dt;
      this.mainX[index] += this.mainVx[index] * dt;
      this.mainY[index] += this.mainVy[index] * dt;
      if (this.head) this.resolveHeadCollision(index, this.head, this.mainPrevX[index], this.mainPrevY[index], dt);
      const progress = this.mainAge[index] / this.mainLife[index];
      this.syncMain(index, Math.max(0, (1 - progress) * (progress < 0.16 ? 1.35 : 1.05)));
      if (this.mainAge[index] >= this.mainLife[index]) this.deactivateMain(index);
    }
  }

  private applyHeadFlow(index: number, head: HeadCollider, dt: number) {
    const x = this.mainX[index];
    const y = this.mainY[index];
    if (!nearHeadBounds(x, y, head)) return;
    const sample = sampleHeadSurface(x, y, head, this.surfaceSample);
    if (sample.inside) return; // Surface crossings belong to the hard collider.
    const outerRadius = sample.localRadius * 0.4;
    if (sample.distance >= outerRadius) return;
    const weights = flowWeights(sample.distance, sample.localRadius);
    if (sample.distance < sample.localRadius * 0.22) this.midFlowCount += 1;
    else this.outerFlowCount += 1;

    const headVx = clamp(this.headVelocityX, -480, 480);
    const headVy = clamp(this.headVelocityY, -480, 480);
    const headSpeed = Math.hypot(headVx, headVy);
    if (headSpeed < 7) return;
    // Do not steer stationary particles around the complete contour. Only
    // actual head motion contributes pre-contact flow; the swept collider
    // below owns the visible impact and reflection.
    const transfer = 1.5 * weights.mid + 0.4 * weights.outer;
    const outwardSpeed = Math.max(0, headVx * sample.normalX + headVy * sample.normalY);
    let forceX = headVx * transfer + sample.normalX * outwardSpeed * weights.mid * 0.7;
    let forceY = headVy * transfer + sample.normalY * outwardSpeed * weights.mid * 0.7;
    const speed = Math.hypot(this.mainVx[index], this.mainVy[index]);
    const maxAcceleration = Math.min(1800, Math.max(360, speed * 0.38 / Math.max(dt, 1 / 120)));
    const forceMagnitude = Math.hypot(forceX, forceY);
    if (forceMagnitude > maxAcceleration) {
      const scale = maxAcceleration / forceMagnitude;
      forceX *= scale;
      forceY *= scale;
    }
    this.mainVx[index] += forceX * dt;
    this.mainVy[index] += forceY * dt;
    this.forceTotal += Math.hypot(forceX, forceY);
    this.forceSamples += 1;
  }

  private updateTrail(dt: number) {
    for (let index = 0; index < TRAIL_CAP; index += 1) {
      if (!this.trailActive[index]) continue;
      this.trailAge[index] += dt;
      this.trailVx[index] += Math.sin(this.trailAge[index] * 11 + this.trailSeed[index] * 9) * 22 * dt;
      this.trailVy[index] += 60 * dt;
      this.trailX[index] += this.trailVx[index] * dt;
      this.trailY[index] += this.trailVy[index] * dt;
      const progress = this.trailAge[index] / this.trailLife[index];
      this.syncTrail(index, Math.max(0, (1 - progress) * 1.2));
      if (this.trailAge[index] >= this.trailLife[index]) this.deactivateTrail(index);
    }
  }

  private spawnCollisionPoint(x: number, y: number, normalX: number, normalY: number) {
    const index = this.collisionPointCursor.value;
    this.collisionPointCursor.value = (index + 1) % COLLISION_POINT_CAP;
    this.collisionPointActive[index] = 1;
    this.collisionPointX[index] = x;
    this.collisionPointY[index] = y;
    this.collisionPointNormalX[index] = normalX;
    this.collisionPointNormalY[index] = normalY;
    this.collisionPointAge[index] = 0;
    this.collisionPointBatch.seeds[index] = 0.9;
    this.setBatchPosition(this.collisionPointBatch, index, x, y);
    this.setBatchVelocity(this.collisionPointBatch, index, normalX * 160, normalY * 160);
    this.setBatchColor(this.collisionPointBatch, index, 0x7dffe3);
    this.setBatchSize(this.collisionPointBatch, index, 13);
    this.setBatchAlpha(this.collisionPointBatch, index, this.collisionDebugEnabled ? 1 : 0);
  }

  private updateCollisionPoints(dt: number) {
    for (let index = 0; index < COLLISION_POINT_CAP; index += 1) {
      if (!this.collisionPointActive[index]) continue;
      this.collisionPointAge[index] += dt;
      const progress = this.collisionPointAge[index] / 0.22;
      this.setBatchAlpha(this.collisionPointBatch, index, this.collisionDebugEnabled ? Math.max(0, 1 - progress) : 0);
      this.setBatchSize(this.collisionPointBatch, index, 13 + progress * 7);
      if (progress >= 1) {
        this.collisionPointActive[index] = 0;
        this.setBatchAlpha(this.collisionPointBatch, index, 0);
      }
    }
  }

  private resolveHeadCollision(index: number, head: HeadCollider, previousX: number, previousY: number, dt: number) {
    const currentX = this.mainX[index];
    const currentY = this.mainY[index];
    const previousInside = pointInsideCollider(previousX, previousY, head);
    const currentInside = pointInsideCollider(currentX, currentY, head);

    // Newly enveloped points are projected out but do not produce a false
    // impact. Only an outside-to-surface sweep may reflect velocity.
    if (previousInside) {
      if (currentInside) {
        const embedded = sampleHeadSurface(currentX, currentY, head, this.surfaceSample);
        this.mainX[index] = embedded.x + embedded.normalX * 2;
        this.mainY[index] = embedded.y + embedded.normalY * 2;
        this.mainPrevX[index] = this.mainX[index];
        this.mainPrevY[index] = this.mainY[index];
      }
      return;
    }
    const crossingT = findColliderCrossing(previousX, previousY, currentX, currentY, head, currentInside);
    if (crossingT === null) return;
    const contactX = previousX + (currentX - previousX) * crossingT;
    const contactY = previousY + (currentY - previousY) * crossingT;
    const surface = sampleHeadSurface(contactX, contactY, head, this.surfaceSample);
    this.mainX[index] = surface.x + surface.normalX * 2;
    this.mainY[index] = surface.y + surface.normalY * 2;
    this.mainPrevX[index] = surface.x;
    this.mainPrevY[index] = surface.y;
    if (this.mainHasCollided[index]) {
      // A particle may graze the moving polygon again, but it must never
      // perform a second elastic bounce back toward the forehead.
      const inwardSpeed = this.mainVx[index] * surface.normalX + this.mainVy[index] * surface.normalY;
      if (inwardSpeed < 0) {
        this.mainVx[index] -= inwardSpeed * surface.normalX;
        this.mainVy[index] -= inwardSpeed * surface.normalY;
      }
      return;
    }
    if (this.time - this.mainLastCollisionAt[index] < 0.08) return;
    const reflected = reflectAgainstHead(
      this.mainVx[index], this.mainVy[index], this.headVelocityX, this.headVelocityY,
      surface.normalX, surface.normalY, 0.78, 0.58,
    );
    if (!reflected) return;
    this.mainVx[index] = reflected.x;
    this.mainVy[index] = reflected.y;
    const remainingTime = dt * (1 - crossingT);
    this.mainX[index] += this.mainVx[index] * remainingTime;
    this.mainY[index] += this.mainVy[index] * remainingTime;
    if (pointInsideCollider(this.mainX[index], this.mainY[index], head)) {
      this.mainX[index] = surface.x + surface.normalX * 2;
      this.mainY[index] = surface.y + surface.normalY * 2;
    }
    this.mainLastCollisionAt[index] = this.time;
    this.mainHasCollided[index] = 1;
    this.lastCollisionCount += 1;
    this.collisionRateCount += 1;
    if (this.collisionDebugEnabled) this.spawnCollisionPoint(this.mainX[index], this.mainY[index], surface.normalX, surface.normalY);
  }

  private syncMain(index: number, alpha: number) {
    this.burstRenderer.setInteractive(
      index, this.mainX[index], this.mainY[index], this.mainVx[index], this.mainVy[index],
      this.mainSize[index] * (1 - this.mainAge[index] / this.mainLife[index] * 0.34),
      this.mainColor[index], alpha, this.mainSeed[index],
    );
  }

  private syncTrail(index: number, alpha = 1) {
    this.trailBatch.seeds[index] = this.trailSeed[index];
    this.setBatchPosition(this.trailBatch, index, this.trailX[index], this.trailY[index]);
    this.setBatchVelocity(this.trailBatch, index, this.trailVx[index], this.trailVy[index]);
    this.setBatchSize(this.trailBatch, index, this.trailSize[index] * (1 - this.trailAge[index] / this.trailLife[index] * 0.58));
    this.setBatchAlpha(this.trailBatch, index, alpha);
  }

  private acquireMain() {
    for (let attempt = 0; attempt < INTERACTIVE_CAP; attempt += 1) {
      const index = this.mainCursor;
      this.mainCursor = (this.mainCursor + 1) % INTERACTIVE_CAP;
      if (!this.mainActive[index]) return index;
    }
    return -1;
  }

  private acquireTrail() {
    for (let attempt = 0; attempt < TRAIL_CAP; attempt += 1) {
      const index = this.trailCursor;
      this.trailCursor = (this.trailCursor + 1) % TRAIL_CAP;
      if (!this.trailActive[index]) return index;
    }
    return -1;
  }

  private deactivateMain(index: number) {
    if (!this.mainActive[index]) return;
    this.mainActive[index] = 0;
    this.mainActiveCount -= 1;
    this.burstRenderer.hideInteractive(index);
  }

  private deactivateTrail(index: number) {
    if (!this.trailActive[index]) return;
    this.trailActive[index] = 0;
    this.trailActiveCount -= 1;
    this.setBatchAlpha(this.trailBatch, index, 0);
    this.setBatchPosition(this.trailBatch, index, -100, -100);
  }

  private setBatchPosition(batch: Batch, index: number, x: number, y: number) {
    const offset = index * 3;
    batch.positions[offset] = x;
    batch.positions[offset + 1] = y;
    batch.positions[offset + 2] = (batch.seeds[index] - 0.5) * 60;
  }

  private setBatchVelocity(batch: Batch, index: number, x: number, y: number) {
    const offset = index * 2;
    batch.velocities[offset] = x;
    batch.velocities[offset + 1] = y;
  }

  private setBatchColor(batch: Batch, index: number, color: number) {
    const offset = index * 3;
    batch.colors[offset] = ((color >> 16) & 255) / 255;
    batch.colors[offset + 1] = ((color >> 8) & 255) / 255;
    batch.colors[offset + 2] = (color & 255) / 255;
  }

  private setBatchSize(batch: Batch, index: number, size: number) {
    batch.sizes[index] = size;
  }

  private setBatchAlpha(batch: Batch, index: number, alpha: number) {
    batch.alphas[index] = alpha;
  }
}

function createBatch(capacity: number): Batch {
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const velocities = new Float32Array(capacity * 2);
  const seeds = new Float32Array(capacity);
  positions.fill(-100);
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  const color = new THREE.BufferAttribute(colors, 3);
  const size = new THREE.BufferAttribute(sizes, 1);
  const alpha = new THREE.BufferAttribute(alphas, 1);
  const velocity = new THREE.BufferAttribute(velocities, 2);
  const seed = new THREE.BufferAttribute(seeds, 1);
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aSize', size);
  geometry.setAttribute('aAlpha', alpha);
  geometry.setAttribute('aVelocity', velocity);
  geometry.setAttribute('aSeed', seed);
  return { geometry, position, color, size, alpha, velocity, seed, positions, colors, sizes, alphas, velocities, seeds };
}

function random(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pickPaletteColor(paletteIndex: number, _particleIndex: number) {
  const palette = FIREWORK_PALETTES[paletteIndex % FIREWORK_PALETTES.length];
  const roll = Math.random();
  if (roll < 0.6) return palette[0];
  if (roll < 0.85) return palette[1];
  if (roll < 0.95) return palette[2];
  return mixColor(palette[3], 0xffffff, 0.82);
}

function mixColor(from: number, to: number, amount: number) {
  const fromR = (from >> 16) & 255;
  const fromG = (from >> 8) & 255;
  const fromB = from & 255;
  const toR = (to >> 16) & 255;
  const toG = (to >> 8) & 255;
  const toB = to & 255;
  return (
    (Math.round(fromR + (toR - fromR) * amount) << 16)
    | (Math.round(fromG + (toG - fromG) * amount) << 8)
    | Math.round(fromB + (toB - fromB) * amount)
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function drawDebugVector(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  vx: number,
  vy: number,
  length: number,
  color: string,
) {
  const magnitude = Math.hypot(vx, vy) || 1;
  const endX = x + vx / magnitude * length;
  const endY = y + vy / magnitude * length;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
}
