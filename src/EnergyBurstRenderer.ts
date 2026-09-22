import * as THREE from 'three';

const VISUAL_SLOT_COUNT = 4;
const VISUAL_LIFETIME = 3.7;
const PLUME_SLOT_CAP_COMPACT = 180;
const PLUME_SLOT_CAP_WIDE = 260;

interface StreakBatch {
  geometry: THREE.InstancedBufferGeometry;
  emission: THREE.InstancedBufferAttribute;
  motion: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute;
  alpha: THREE.InstancedBufferAttribute;
  emissions: Float32Array;
  motions: Float32Array;
  styles: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
}

interface PlumeBatch {
  geometry: THREE.InstancedBufferGeometry;
  emission: THREE.InstancedBufferAttribute;
  motion: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute;
  alpha: THREE.InstancedBufferAttribute;
  emissions: Float32Array;
  motions: Float32Array;
  styles: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
}

const plumeVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHalo;
  attribute vec4 aEmission;
  attribute vec4 aMotion;
  attribute vec4 aStyle;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    float age = max(0.0, uTime - aEmission.z);
    float life = max(0.2, aEmission.w);
    float progress = clamp(age / life, 0.0, 1.0);
    float radialAngle = aMotion.x;
    float speed = aMotion.y;
    float seed = aMotion.z;
    vec2 radial = vec2(cos(radialAngle), sin(radialAngle));
    vec2 tangent = vec2(-radial.y, radial.x);
    float eased = 1.0 - exp(-1.18 * age);
    float distance = speed * eased;
    float curl = smoothstep(0.18, 0.86, age);
    float sway = curl * (
      sin(age * 3.1 + aMotion.w + seed * 8.0) * 28.0 +
      sin(age * 1.7 + seed * 13.0) * 19.0
    );
    float fall = max(0.0, age - 1.12);
    vec2 center = aEmission.xy + radial * (distance - aStyle.x * 0.18)
      + tangent * sway + vec2(0.0, fall * fall * 34.0);
    float grow = smoothstep(0.0, 0.34, progress);
    float plumeLength = aStyle.x * (0.22 + grow * 0.78) * (uHalo > 0.5 ? 1.12 : 1.0);
    float plumeWidth = aStyle.y * (0.35 + grow * 0.65) * (uHalo > 0.5 ? 1.5 : 1.0);
    float rotation = radialAngle + sin(seed * 17.0) * 0.18;
    vec2 forward = vec2(cos(rotation), sin(rotation));
    vec2 side = vec2(-forward.y, forward.x);
    vec2 world = center + side * position.x * plumeWidth + forward * position.y * plumeLength * 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, aStyle.z, 1.0);
    vUv = uv;
    vColor = aColor;
    vSeed = seed;
    float alive = step(aEmission.z, uTime) * (1.0 - step(life, age));
    vAlpha = alive * aAlpha * smoothstep(0.0, 0.10, progress) * (1.0 - smoothstep(0.74, 1.0, progress));
  }
`;

const plumeFragmentShader = /* glsl */ `
  uniform float uHalo;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    if (vAlpha < 0.001) discard;
    vec2 p = vUv * 2.0 - 1.0;
    float y = p.y;
    float x = p.x;
    float taper = pow(max(0.0, 1.0 - abs(y)), 0.56);
    float edge = 1.0 - smoothstep(taper * 0.42, taper, abs(x));
    float pointed = smoothstep(-1.0, -0.72, y) * (1.0 - smoothstep(0.68, 1.0, y));
    float wisps = 0.82 + 0.18 * sin(y * 18.0 + vSeed * 31.0 + x * 4.0);
    float soft = exp(-abs(x) * (uHalo > 0.5 ? 2.4 : 4.3));
    float plume = edge * pointed * wisps * soft;
    float hotHead = exp(-pow((y - 0.52) * 2.5, 2.0)) * exp(-abs(x) * 3.2);
    float alpha = vAlpha * plume * (uHalo > 0.5 ? 0.34 : 0.78);
    vec3 color = mix(vColor, vec3(1.0), hotHead * (uHalo > 0.5 ? 0.08 : 0.22));
    color *= (uHalo > 0.5 ? 1.18 : 1.06);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const streakVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uInteractive;
  uniform float uHalo;
  attribute vec4 aEmission;
  attribute vec4 aMotion;
  attribute vec4 aStyle;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vEnergy;

  void main() {
    vec2 center;
    vec2 velocity;
    float alpha;
    float seed = aMotion.z;
    float energy = 1.0;

    if (uInteractive > 0.5) {
      center = aEmission.xy;
      velocity = aMotion.xy;
      alpha = aAlpha;
      energy = clamp(length(velocity) / 950.0, 0.35, 1.25);
    } else {
      float age = max(0.0, uTime - aEmission.z);
      float angle = aMotion.x;
      float speed = aMotion.y;
      vec2 radial = vec2(cos(angle), sin(angle));
      vec2 tangent = vec2(-radial.y, radial.x);

      // Build outward momentum over a few tenths of a second so the cloud
      // blooms visibly instead of filling the frame at the first flash.
      float fast = exp(-1.35 * age);
      float launch = exp(-5.0 * age);
      float distance = speed * 0.66 * ((1.0 - fast) / 1.35 - (1.0 - launch) / 5.0);
      float curlPhase = seed * 13.7 + aMotion.w;
      float curl = smoothstep(0.34, 0.95, age);
      float sideways = curl * (
        (sin(age * 3.7 + curlPhase) - sin(curlPhase)) * 47.0 +
        (sin(age * 1.9 + curlPhase * 0.47) - sin(curlPhase * 0.47)) * 35.0
      );
      float fall = max(0.0, age - 1.55);
      center = aEmission.xy + radial * distance + tangent * sideways + vec2(0.0, fall * fall * 102.0);
      float sideVelocity = curl * (cos(age * 3.7 + curlPhase) * 173.9 + cos(age * 1.9 + curlPhase * 0.47) * 66.5);
      velocity = radial * (speed * 0.66 * (fast - launch)) + tangent * sideVelocity + vec2(0.0, fall * 204.0);

      float alive = step(aEmission.z, uTime) * (1.0 - step(aEmission.w, age));
      alpha = alive * aAlpha * smoothstep(0.0, 0.105, age)
        * (1.0 - smoothstep(1.25, aEmission.w, age));
      energy = clamp(speed / 1500.0, 0.5, 1.4);
    }

    float speedNow = length(velocity);
    vec2 forward = velocity / max(speedNow, 0.001);
    vec2 side = vec2(-forward.y, forward.x);
    float lengthScale = uInteractive > 0.5
      ? clamp(0.55 + speedNow / 650.0, 0.55, 1.7)
      : clamp(0.48 + speedNow / 690.0, 0.42, 1.75);
    float lengthPx = aStyle.x * lengthScale * mix(1.0, 1.20, uHalo);
    float widthPx = aStyle.y * mix(1.0, 3.1, uHalo);
    // Multiple vertices down the ribbon let each filament bow like a feather
    // rather than remain a rigid straight line from head to tail.
    float bow = sin(position.y * 2.15 + seed * 19.0) * (1.0 - position.y * position.y) * lengthPx * 0.10;
    vec2 world = center + side * (position.x * widthPx + bow) + forward * position.y * lengthPx * 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, aStyle.z, 1.0);
    vUv = position.xy;
    vColor = aColor;
    vAlpha = alpha;
    vSeed = seed;
    vEnergy = energy;
  }
`;

const streakFragmentShader = /* glsl */ `
  uniform float uHalo;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vEnergy;

  void main() {
    if (vAlpha < 0.002) discard;
    float path = vUv.x + sin(vUv.y * 4.7 + vSeed * 23.0) * 0.09;
    float taper = mix(0.22, 0.92, smoothstep(-1.0, 0.76, vUv.y));
    float ragged = 0.92 + 0.08 * sin(vUv.y * 21.0 + vSeed * 41.0);
    float crossSection = exp(-pow(abs(path) / max(0.1, taper * ragged), 1.6) * (uHalo > 0.5 ? 2.2 : 4.8));
    float longitudinal = smoothstep(-1.0, -0.68, vUv.y) * (1.0 - smoothstep(0.80, 1.0, vUv.y));
    float tail = pow(clamp((vUv.y + 1.0) * 0.5, 0.0, 1.0), uHalo > 0.5 ? 0.55 : 1.45);
    float head = exp(-pow((vUv.y - 0.69) * 3.4, 2.0));
    float alpha = vAlpha * crossSection * longitudinal * tail * (uHalo > 0.5 ? 0.28 : 0.95);
    vec3 color = mix(vColor, vec3(1.0), head * (uHalo > 0.5 ? 0.08 : 0.28));
    color *= (uHalo > 0.5 ? 1.0 : 1.43) * (0.75 + 0.25 * vEnergy);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

/** Instanced luminous ribbons: only the interactive batch receives CPU updates. */
export class EnergyBurstRenderer {
  private readonly interactive: StreakBatch;
  private readonly visual: StreakBatch;
  private readonly plume: PlumeBatch;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly slotBirth = new Float32Array(VISUAL_SLOT_COUNT);
  private readonly slotCount = new Uint16Array(VISUAL_SLOT_COUNT);
  private readonly lobeWeights = new Float32Array(9);
  private readonly visualSlotCap: number;
  private readonly plumeSlotCap: number;
  private nextSlot = 0;
  private time = 0;

  constructor(scene: THREE.Scene, interactiveCap: number, compactViewport: boolean) {
    this.visualSlotCap = compactViewport ? 3200 : 5000;
    this.plumeSlotCap = compactViewport ? PLUME_SLOT_CAP_COMPACT : PLUME_SLOT_CAP_WIDE;
    this.interactive = createStreakBatch(interactiveCap, true);
    this.visual = createStreakBatch(VISUAL_SLOT_COUNT * this.visualSlotCap, false);
    this.plume = createPlumeBatch(VISUAL_SLOT_COUNT * this.plumeSlotCap);
    for (const [batch, interactive] of [[this.visual, false], [this.interactive, true]] as const) {
      // The broad pass knits adjacent filaments into feathery energy masses.
      // The narrow pass gives each ribbon a sharp white-hot leading edge.
      for (const halo of [true, false]) {
        const material = new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: 0 },
            uInteractive: { value: interactive ? 1 : 0 },
            uHalo: { value: halo ? 1 : 0 },
          },
          vertexShader: streakVertexShader,
          fragmentShader: streakFragmentShader,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(batch.geometry, material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        this.materials.push(material);
        this.meshes.push(mesh);
      }
    }
    for (const halo of [true, false]) {
      const material = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uHalo: { value: halo ? 1 : 0 } },
        vertexShader: plumeVertexShader,
        fragmentShader: plumeFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.plume.geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.materials.push(material);
      this.meshes.push(mesh);
    }
    this.slotBirth.fill(-1000);
  }

  setTime(time: number) {
    this.time = time;
    for (const material of this.materials) material.uniforms.uTime.value = time;
    this.interactive.emission.needsUpdate = true;
    this.interactive.motion.needsUpdate = true;
    this.interactive.style.needsUpdate = true;
    this.interactive.color.needsUpdate = true;
    this.interactive.alpha.needsUpdate = true;
    this.plume.emission.needsUpdate = true;
    this.plume.motion.needsUpdate = true;
    this.plume.style.needsUpdate = true;
    this.plume.color.needsUpdate = true;
    this.plume.alpha.needsUpdate = true;
  }

  setInteractive(index: number, x: number, y: number, vx: number, vy: number, size: number, color: number, alpha: number, seed: number) {
    const v4 = index * 4;
    const v3 = index * 3;
    this.interactive.emissions[v4] = x;
    this.interactive.emissions[v4 + 1] = y;
    this.interactive.motions[v4] = vx;
    this.interactive.motions[v4 + 1] = vy;
    this.interactive.motions[v4 + 2] = seed;
    this.interactive.styles[v4] = size * 3.7;
    this.interactive.styles[v4 + 1] = Math.max(1.2, size * 0.20);
    this.interactive.styles[v4 + 2] = (seed - 5.0) * 4.0;
    setColor(this.interactive.colors, v3, color);
    this.interactive.alphas[index] = alpha;
  }

  hideInteractive(index: number) {
    this.interactive.alphas[index] = 0;
  }

  burst(x: number, y: number, palette: readonly number[]) {
    const slot = this.nextSlot;
    this.nextSlot = (slot + 1) % VISUAL_SLOT_COUNT;
    const start = slot * this.visualSlotCap;
    const count = this.visualSlotCap;
    const phase = Math.random() * Math.PI * 2;
    let weightTotal = 0;
    for (let lobe = 0; lobe < this.lobeWeights.length; lobe += 1) {
      this.lobeWeights[lobe] = 0.10 + Math.random() * Math.random() * 1.9;
      weightTotal += this.lobeWeights[lobe];
    }

    for (let i = 0; i < this.visualSlotCap; i += 1) {
      const index = start + i;
      const v4 = index * 4;
      const v3 = index * 3;
      let choice = Math.random() * weightTotal;
      let lobe = 0;
      for (; lobe < this.lobeWeights.length - 1 && choice > this.lobeWeights[lobe]; lobe += 1) {
        choice -= this.lobeWeights[lobe];
      }
      const baseAngle = phase + lobe * Math.PI * 2 / this.lobeWeights.length;
      const angle = baseAngle + random(-0.32, 0.32) + Math.sin(i * 0.47) * 0.05;
      const band = Math.random();
      const speed = band < 0.24 ? random(200, 620) : band < 0.58 ? random(620, 1150) : random(1150, 1850);
      const seed = Math.random();
      const life = random(2.45, 3.55);
      const sizeVariation = random(0.6, 1.4);
      this.visual.emissions[v4] = x + random(-6, 6);
      this.visual.emissions[v4 + 1] = y + random(-6, 6);
      this.visual.emissions[v4 + 2] = this.time + random(-0.08, 0.04);
      this.visual.emissions[v4 + 3] = life;
      this.visual.motions[v4] = angle;
      this.visual.motions[v4 + 1] = speed;
      this.visual.motions[v4 + 2] = seed;
      this.visual.motions[v4 + 3] = phase + lobe * 0.5;
      this.visual.styles[v4] = random(28, 86) * sizeVariation;
      this.visual.styles[v4 + 1] = random(1.4, 5.6) * sizeVariation;
      this.visual.styles[v4 + 2] = random(-27, 27);
      this.visual.styles[v4 + 3] = 0;
      setColor(this.visual.colors, v3, pickPaletteColor(palette));
      this.visual.alphas[index] = random(0.36, 0.78);
    }
    this.slotBirth[slot] = this.time;
    this.slotCount[slot] = count;
    this.visual.geometry.instanceCount = Math.max(this.visual.geometry.instanceCount, start + this.visualSlotCap);
    this.visual.emission.needsUpdate = true;
    this.visual.motion.needsUpdate = true;
    this.visual.style.needsUpdate = true;
    this.visual.color.needsUpdate = true;
    this.visual.alpha.needsUpdate = true;
    this.burstPlumes(x, y, palette, slot, phase);
  }

  private burstPlumes(x: number, y: number, palette: readonly number[], slot: number, phase: number) {
    const start = slot * this.plumeSlotCap;
    for (let i = 0; i < this.plumeSlotCap; i += 1) {
      const index = start + i;
      const v4 = index * 4;
      const v3 = index * 3;
      const lobe = i % 11;
      const angle = phase + lobe * Math.PI * 2 / 11 + random(-0.22, 0.22);
      const speed = random(210, 560) * (0.72 + Math.random() * 0.55);
      const seed = Math.random();
      const life = random(1.7, 2.8);
      this.plume.emissions[v4] = x + random(-12, 12);
      this.plume.emissions[v4 + 1] = y + random(-12, 12);
      this.plume.emissions[v4 + 2] = this.time + random(-0.05, 0.08);
      this.plume.emissions[v4 + 3] = life;
      this.plume.motions[v4] = angle;
      this.plume.motions[v4 + 1] = speed;
      this.plume.motions[v4 + 2] = seed;
      this.plume.motions[v4 + 3] = phase + lobe * 0.41;
      this.plume.styles[v4] = random(105, 235) * (0.74 + Math.random() * 0.48);
      this.plume.styles[v4 + 1] = random(19, 54) * (0.78 + Math.random() * 0.42);
      this.plume.styles[v4 + 2] = random(-22, 22);
      this.plume.styles[v4 + 3] = 0;
      setColor(this.plume.colors, v3, pickPaletteColor(palette));
      this.plume.alphas[index] = random(0.045, 0.15);
    }
    this.plume.geometry.instanceCount = Math.max(this.plume.geometry.instanceCount, start + this.plumeSlotCap);
    this.plume.emission.needsUpdate = true;
    this.plume.motion.needsUpdate = true;
    this.plume.style.needsUpdate = true;
    this.plume.color.needsUpdate = true;
    this.plume.alpha.needsUpdate = true;
  }

  get activeVisualCount() {
    let count = 0;
    for (let slot = 0; slot < VISUAL_SLOT_COUNT; slot += 1) {
      if (this.time - this.slotBirth[slot] < VISUAL_LIFETIME) count += this.slotCount[slot] + this.plumeSlotCap;
    }
    return count;
  }

  dispose(scene: THREE.Scene) {
    for (const mesh of this.meshes) scene.remove(mesh);
    for (const material of this.materials) material.dispose();
    this.interactive.geometry.dispose();
    this.visual.geometry.dispose();
    this.plume.geometry.dispose();
  }
}

function createStreakBatch(capacity: number, dynamic: boolean): StreakBatch {
  const geometry = new THREE.InstancedBufferGeometry();
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let row = 0; row <= 4; row += 1) {
    const along = -1 + row * 0.5;
    vertices.push(-1, along, 0, 1, along, 0);
    if (row < 4) {
      const base = row * 2;
      triangles.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(triangles);
  const emissions = new Float32Array(capacity * 4);
  const motions = new Float32Array(capacity * 4);
  const styles = new Float32Array(capacity * 4);
  const colors = new Float32Array(capacity * 3);
  const alphas = new Float32Array(capacity);
  const emission = new THREE.InstancedBufferAttribute(emissions, 4);
  const motion = new THREE.InstancedBufferAttribute(motions, 4);
  const style = new THREE.InstancedBufferAttribute(styles, 4);
  const color = new THREE.InstancedBufferAttribute(colors, 3);
  const alpha = new THREE.InstancedBufferAttribute(alphas, 1);
  if (dynamic) {
    for (const attribute of [emission, motion, style, color, alpha]) attribute.setUsage(THREE.DynamicDrawUsage);
  }
  geometry.setAttribute('aEmission', emission);
  geometry.setAttribute('aMotion', motion);
  geometry.setAttribute('aStyle', style);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aAlpha', alpha);
  geometry.instanceCount = dynamic ? capacity : 0;
  return { geometry, emission, motion, style, color, alpha, emissions, motions, styles, colors, alphas };
}

function createPlumeBatch(capacity: number): PlumeBatch {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const emissions = new Float32Array(capacity * 4);
  const motions = new Float32Array(capacity * 4);
  const styles = new Float32Array(capacity * 4);
  const colors = new Float32Array(capacity * 3);
  const alphas = new Float32Array(capacity);
  const emission = new THREE.InstancedBufferAttribute(emissions, 4);
  const motion = new THREE.InstancedBufferAttribute(motions, 4);
  const style = new THREE.InstancedBufferAttribute(styles, 4);
  const color = new THREE.InstancedBufferAttribute(colors, 3);
  const alpha = new THREE.InstancedBufferAttribute(alphas, 1);
  geometry.setAttribute('aEmission', emission);
  geometry.setAttribute('aMotion', motion);
  geometry.setAttribute('aStyle', style);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aAlpha', alpha);
  geometry.instanceCount = 0;
  return { geometry, emission, motion, style, color, alpha, emissions, motions, styles, colors, alphas };
}

function setColor(colors: Float32Array, offset: number, color: number) {
  colors[offset] = ((color >> 16) & 255) / 255;
  colors[offset + 1] = ((color >> 8) & 255) / 255;
  colors[offset + 2] = (color & 255) / 255;
}

function pickPaletteColor(palette: readonly number[]) {
  const roll = Math.random();
  if (roll < 0.60) return palette[0];
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

function random(min: number, max: number) {
  return min + Math.random() * (max - min);
}
