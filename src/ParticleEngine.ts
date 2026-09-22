import {
  Application,
  Particle,
  ParticleContainer,
  Rectangle,
  Texture,
} from 'pixi.js';
import type { ExpressionState, HeadCollider } from './types';
import { ThreeFireworks } from './ThreeFireworks';

interface RainParticle {
  view: Particle;
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  age: number;
  life: number;
}

const MAX_RAIN = 520;
// Rain is now supplied by the screen-blended effect video. Keep the Pixi
// pool code intact for compatibility, but do not allocate or render the old
// illustrated teardrops on top of the video layer.
const LEGACY_RAIN_ENABLED = false;

/**
 * Hybrid compositor: Pixi keeps the already-working illustrated rain pool,
 * while ThreeFireworks owns the WebGL rocket, burst, glow and collision layers.
 * The public API stays unchanged so camera, tracking and expression code do
 * not need to know which renderer owns a visual effect.
 */
export class ParticleEngine {
  private readonly app = new Application();
  private readonly rainLayer = new ParticleContainer<Particle>({
    dynamicProperties: { position: true, rotation: false, vertex: false, color: true },
  });
  private readonly rain: RainParticle[] = [];
  private readonly fireworks: ThreeFireworks;
  private rainTexture: Texture | null = null;
  private rainCursor = 0;
  private rainAccumulator = 0;
  private ready = false;
  private state: ExpressionState = 'NEUTRAL';
  private previousHead: HeadCollider | null = null;
  private headVelocityX = 0;
  private headVelocityY = 0;
  private headSampleElapsed = 0;

  constructor(private readonly mount: HTMLElement) {
    this.fireworks = new ThreeFireworks(mount);
  }

  async init() {
    await this.app.init({
      resizeTo: this.mount,
      autoStart: false,
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      preference: 'webgl',
      powerPreference: 'high-performance',
    });

    if (LEGACY_RAIN_ENABLED) {
      this.app.canvas.className = 'pixi-canvas';
      this.app.canvas.setAttribute('aria-hidden', 'true');
      this.mount.appendChild(this.app.canvas);
      this.rainLayer.blendMode = 'screen';
      this.app.stage.addChild(this.rainLayer);
      this.rainTexture = Texture.from(createIllustratedRainTexture());
      this.preallocateRain(MAX_RAIN);
    }
    this.updateBounds();
    window.addEventListener('resize', this.updateBounds);
    this.fireworks.init();
    this.ready = true;
  }

  setState(state: ExpressionState) {
    this.state = state;
  }

  setBurstHandler(handler: ((x: number, y: number) => void) | null) {
    this.fireworks.setBurstHandler(handler);
  }

  setCollisionDebug(enabled: boolean) {
    this.fireworks.setCollisionDebug(enabled);
  }

  setColliderDebug(enabled: boolean) { this.fireworks.setColliderDebug(enabled); }
  setFlowVectorDebug(enabled: boolean) { this.fireworks.setFlowVectorDebug(enabled); }

  update(dtSeconds: number, head: HeadCollider | null) {
    if (!this.ready) return;
    const dt = Math.min(dtSeconds, 0.034);
    if (LEGACY_RAIN_ENABLED && this.state === 'SMILE') {
      const emissionRate = this.width < 700 ? 180 : 240;
      this.rainAccumulator += emissionRate * dt;
      while (this.rainAccumulator >= 1) {
        this.spawnRain();
        this.rainAccumulator -= 1;
      }
    } else {
      this.rainAccumulator = 0;
    }

    this.updateHeadMotion(dt, head);
    if (LEGACY_RAIN_ENABLED) this.updateRain(dt);
    this.fireworks.update(dt, head, this.headVelocityX, this.headVelocityY);
    if (LEGACY_RAIN_ENABLED) this.app.renderer.render(this.app.stage);
  }

  launchFirework(head: HeadCollider | null, intensity = 1) {
    this.fireworks.launch(head, intensity);
  }

  get collisionCount() {
    return this.fireworks.collisionCount;
  }

  get collisionCountPerSecond() {
    return this.fireworks.collisionCountPerSecond;
  }

  get particlesInMidFlow() { return this.fireworks.particlesInMidFlow; }
  get particlesInOuterFlow() { return this.fireworks.particlesInOuterFlow; }
  get averageInteractionForce() { return this.fireworks.averageInteractionForce; }

  get activeFireworkParticleCount() {
    return this.fireworks.activeParticleCount;
  }

  get headSpeed() {
    return Math.hypot(this.headVelocityX, this.headVelocityY);
  }

  get headVelocityXValue() {
    return this.headVelocityX;
  }

  get headVelocityYValue() {
    return this.headVelocityY;
  }

  destroy() {
    window.removeEventListener('resize', this.updateBounds);
    this.rainTexture?.destroy(true);
    this.fireworks.destroy();
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }

  private get width() {
    return Math.max(1, this.mount.clientWidth);
  }

  private get height() {
    return Math.max(1, this.mount.clientHeight);
  }

  private readonly updateBounds = () => {
    const bounds = new Rectangle(0, 0, this.width, this.height);
    this.rainLayer.boundsArea = bounds;
  };

  private preallocateRain(count: number) {
    if (!this.rainTexture) return;
    for (let index = 0; index < count; index += 1) {
      const view = new Particle({
        texture: this.rainTexture,
        anchorX: 0.5,
        anchorY: 0.5,
        x: -100,
        y: -100,
        scaleX: 0.78,
        scaleY: 0.9,
        alpha: 0,
      });
      this.rain.push({ view, active: false, x: -100, y: -100, vx: 0, vy: 0, gravity: 0, age: 0, life: 0 });
      this.rainLayer.particleChildren.push(view);
    }
    this.rainLayer.update();
  }

  private spawnRain() {
    const particle = this.rain[this.rainCursor];
    this.rainCursor = (this.rainCursor + 1) % this.rain.length;
    const depth = random(0.72, 1.42);
    particle.active = true;
    particle.x = random(-80, this.width + 30);
    particle.y = random(-160, -20);
    particle.vx = random(105, 175) * depth;
    particle.vy = random(820, 1180) * depth;
    particle.gravity = 70;
    particle.age = 0;
    particle.life = random(0.85, 1.5);
    particle.view.x = particle.x;
    particle.view.y = particle.y;
    particle.view.scaleX = random(0.72, 1.05) * depth;
    particle.view.scaleY = random(0.86, 1.28) * depth;
    particle.view.rotation = random(-0.12, 0.02);
    particle.view.tint = Math.random() > 0.18 ? 0x65d9ff : 0xffffff;
    particle.view.alpha = random(0.8, 1);
  }

  private updateRain(dt: number) {
    for (const particle of this.rain) {
      if (!particle.active) continue;
      particle.age += dt;
      particle.vy += particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.view.x = particle.x;
      particle.view.y = particle.y;
      if (particle.age > particle.life || particle.y > this.height + 80) {
        particle.active = false;
        particle.view.alpha = 0;
        particle.view.x = -100;
        particle.view.y = -100;
      }
    }
  }

  private updateHeadMotion(dt: number, head: HeadCollider | null) {
    this.headSampleElapsed += dt;
    if (!head) {
      this.headVelocityX = 0;
      this.headVelocityY = 0;
      this.previousHead = null;
      this.headSampleElapsed = 0;
      return;
    }
    if (head === this.previousHead) {
      if (this.headSampleElapsed > 0.16) {
        this.headVelocityX *= Math.exp(-5 * dt);
        this.headVelocityY *= Math.exp(-5 * dt);
      }
      return;
    }
    if (this.previousHead) {
      // Face tracking runs slower than rendering; divide by the interval
      // between distinct samples rather than a single render frame.
      const sampleDt = Math.max(this.headSampleElapsed, 1 / 60);
      const targetVx = clamp((head.cx - this.previousHead.cx) / sampleDt, -480, 480);
      const targetVy = clamp((head.cy - this.previousHead.cy) / sampleDt, -480, 480);
      this.headVelocityX = lerp(this.headVelocityX, targetVx, 0.24);
      this.headVelocityY = lerp(this.headVelocityY, targetVy, 0.24);
    }
    this.previousHead = head;
    this.headSampleElapsed = 0;
  }
}

function random(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function createIllustratedRainTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const glow = ctx.createRadialGradient(20, 28, 3, 20, 30, 28);
  glow.addColorStop(0, 'rgba(255,255,255,.9)');
  glow.addColorStop(0.5, 'rgba(83,227,255,.9)');
  glow.addColorStop(1, 'rgba(31,125,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(20, 30, 17, 28, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(20, 30);
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.bezierCurveTo(15, -7, 16, 6, 0, 25);
  ctx.bezierCurveTo(-16, 6, -15, -7, 0, -26);
  ctx.closePath();
  const fill = ctx.createLinearGradient(-10, -20, 10, 25);
  fill.addColorStop(0, '#e8ffff');
  fill.addColorStop(0.2, '#79f5ff');
  fill.addColorStop(1, '#3e7dff');
  ctx.fillStyle = fill;
  ctx.shadowColor = 'rgba(111,255,229,.95)';
  ctx.shadowBlur = 9;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath();
  ctx.ellipse(-5, -8, 3, 8, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return canvas;
}
