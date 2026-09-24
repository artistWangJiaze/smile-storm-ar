import './ResetPreview';
import './styles.css';
import './design-ui.css';
import { Onboarding } from './Onboarding';
import { HandControlTracker, handControl } from './HandControl';
import { easterEgg, EasterEggView } from './EasterEgg';
import { ExpressionMachine } from './ExpressionMachine';
import { FaceTracker } from './FaceTracker';
import { LoadingParticleScene } from './LoadingParticleScene';
import type { ParticleEngine as ParticleEngineType } from './ParticleEngine';
import type { ExpressionSample, ExpressionState, HeadCollider } from './types';

type CameraStatus = 'idle' | 'requesting' | 'ready' | 'error';

const stage = document.querySelector<HTMLElement>('#phone-screen')!;
const video = document.querySelector<HTMLVideoElement>('#camera')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-button')!;
const permissionScreen = document.querySelector<HTMLElement>('#permission-screen')!;
const signalChip = document.querySelector<HTMLElement>('#signal-chip')!;
const signalLabel = document.querySelector<HTMLElement>('#signal-label')!;
const rainEffectVideo = document.querySelector<HTMLVideoElement>('#rain-effect-video')!;
const faceBadge = document.querySelector<HTMLElement>('#face-badge')!;
const stateLabel = document.querySelector<HTMLElement>('#state-label')!;
const promptTitle = document.querySelector<HTMLElement>('#prompt-title')!;
const promptHint = document.querySelector<HTMLElement>('#prompt-hint')!;
const loadingGestureHint = document.querySelector<HTMLElement>('#loading-gesture-hint')!;
const renderFps = document.querySelector<HTMLElement>('#render-fps')!;
const inferenceFps = document.querySelector<HTMLElement>('#inference-fps')!;
const headColliderElement = document.querySelector<HTMLElement>('#head-collider')!;
const collisionCount = document.querySelector<HTMLElement>('#collision-count')!;
const collisionRate = document.querySelector<HTMLElement>('#collision-rate')!;
const effectsLayer = document.querySelector<HTMLElement>('#effects-layer')!;
const loadingParticleCanvas = document.querySelector<HTMLCanvasElement>('#loading-particle-scene')!;
const impactFlash = document.querySelector<HTMLElement>('#impact-flash')!;
const fireworkCount = document.querySelector<HTMLElement>('#firework-count')!;
const colliderStatus = document.querySelector<HTMLElement>('#collider-status')!;
const colliderType = document.querySelector<HTMLElement>('#collider-type')!;
const headSpeed = document.querySelector<HTMLElement>('#head-speed')!;
const hardCollisionRate = document.querySelector<HTMLElement>('#hard-collision-rate')!;
const midFlowCount = document.querySelector<HTMLElement>('#mid-flow-count')!;
const outerFlowCount = document.querySelector<HTMLElement>('#outer-flow-count')!;
const averageFlowForce = document.querySelector<HTMLElement>('#average-flow-force')!;
const debugPanel = document.querySelector<HTMLElement>('.debug-panel')!;
const colliderPolygon = document.querySelector<SVGPolygonElement>('#head-collider-polygon')!;
const headVelocityVector = document.querySelector<SVGLineElement>('#head-velocity-vector')!;
const colliderToggle = document.querySelector<HTMLInputElement>('#collider-toggle')!;
const collisionPointsToggle = document.querySelector<HTMLInputElement>('#collision-points-toggle')!;
const flowVectorsToggle = document.querySelector<HTMLInputElement>('#flow-vectors-toggle')!;

const metricElements = {
  smile: {
    value: document.querySelector<HTMLOutputElement>('#smile-value')!,
    meter: document.querySelector<HTMLProgressElement>('#smile-meter')!,
  },
  jawOpen: {
    value: document.querySelector<HTMLOutputElement>('#jaw-value')!,
    meter: document.querySelector<HTMLProgressElement>('#jaw-meter')!,
  },
  cheekSquint: {
    value: document.querySelector<HTMLOutputElement>('#cheek-value')!,
    meter: document.querySelector<HTMLProgressElement>('#cheek-meter')!,
  },
};

const stateCopy: Record<ExpressionState, { label: string; title: string; hint: string }> = {
  NEUTRAL: { label: '自然状态', title: '微笑一下进入体验', hint: '嘴角轻轻上扬，雨会落下' },
  SMILE: { label: '微笑状态', title: '彩色雨幕已开启', hint: '继续大笑，点亮整片烟花' },
  LAUGH: { label: '大笑状态', title: '烟花正在绽放', hint: '移动头部，把粒子弹开' },
};

let stream: MediaStream | null = null;
let cameraStatus: CameraStatus = 'idle';
let tracker: FaceTracker | null = null;
let trackerInitPromise: Promise<void> | null = null;
let modelWarmStartedAt = 0;
let modelCountdownTimer = 0;
let handTracker: HandControlTracker | null = null;
let currentSample: ExpressionSample | null = null;
let frames = 0;
let inferenceFrames = 0;
let fpsStartedAt = performance.now();
let previousFrameAt = performance.now();
let modelReady = false;
let effectsInitialized = false;
let particles: ParticleEngineType | null = null;
let effectsReady: Promise<void> | null = null;
let rainVideoReady = false;
let rainReadyPromise: Promise<void> | null = null;
let experienceReady = false;
let onboardingStarted = false;
const FACE_MODEL_SLOW_MS = 8_000;

function syncPhoneScreen() {
  // The camera, tracking and effects share the actual responsive viewport.
  stage.style.setProperty('--viewport-height', `${window.innerHeight}px`);
}

syncPhoneScreen();
window.addEventListener('resize', syncPhoneScreen);

const machine = new ExpressionMachine();
const onboarding = new Onboarding(stage);
const eggView = new EasterEggView(stage);
const loadingParticles = new LoadingParticleScene(loadingParticleCanvas);
const pageParams = new URLSearchParams(location.search);
// Keep debug panels behind an explicit QA flag. Legacy preview parameters are
// ignored so an old test URL cannot skip the camera permission screen.
const debugUI = ['localhost', '127.0.0.1'].includes(location.hostname)
  && pageParams.get('qa') === '1';
document.body.classList.toggle('debug-ui', debugUI);
const localV3=true;
if(localV3 && debugUI){
  stateCopy.LAUGH.hint='移动头部，把粒子弹开';
  const controls=document.createElement('div');
  controls.style.cssText='position:fixed;right:12px;bottom:12px;z-index:1000;background:#172129;color:white;padding:12px;border-radius:10px;font:14px system-ui;max-width:240px';
  const label=document.createElement('div');label.textContent='本地 AR · v3 碰撞 / 三色';
  const test=document.createElement('button');test.type='button';test.textContent='测试烟花';
  test.style.cssText='display:block;margin-top:8px;padding:9px 16px;background:#e8c666;color:#172129;border:0;border-radius:6px;cursor:pointer';
  test.onclick=()=>{if(effectsInitialized)launchStrongFirework(currentSample?.head??null,1.25);};
  controls.append(label,test);document.body.append(controls);
}

function ensureEffectsReady() {
  if (effectsReady) return effectsReady;
  // Keep Three.js, Pixi and the shader compiler out of the critical path for
  // the first button. Their chunk is fetched only after the camera is visible.
  effectsReady = import('./ParticleEngine').then(async ({ ParticleEngine }) => {
    const instance = new ParticleEngine(effectsLayer);
    particles = instance;
    instance.setBurstHandler((x, y) => {
      impactFlash.style.setProperty('--burst-x', `${x}px`);
      impactFlash.style.setProperty('--burst-y', `${y}px`);
      impactFlash.classList.remove('is-active');
      requestAnimationFrame(() => impactFlash.classList.add('is-active'));
    });
    await instance.init();
    effectsInitialized = true;
  }).catch((error) => {
    // A slow or unavailable WebGL context must not block camera access or the
    // face model. The camera can still be used without the visual layer.
    console.warn('Effects layer unavailable; keeping camera and tracking active.', error);
  });
  return effectsReady;
}

function setCameraStatus(nextStatus: CameraStatus, label: string) {
  cameraStatus = nextStatus;
  signalChip.dataset.status = cameraStatus;
  signalLabel.textContent = label;
}

function ensureFaceTrackerReady() {
  if (!tracker) tracker = new FaceTracker(video, stage, handleSample);
  if (!trackerInitPromise) {
    modelWarmStartedAt = performance.now();
    trackerInitPromise = tracker.init()
      .catch(error => {
        tracker?.destroy();
        tracker = null;
        trackerInitPromise = null;
        modelWarmStartedAt = 0;
        throw error;
      });
  }
  return trackerInitPromise;
}

function estimatedModelSeconds() {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  switch (connection?.effectiveType) {
    case 'slow-2g': return 32;
    case '2g': return 24;
    case '3g': return 16;
    case '4g': return 8;
    default: return 10;
  }
}

function startModelCountdown() {
  stopModelCountdown();
  const expectedSeconds = estimatedModelSeconds();
  const update = () => {
    if (modelReady) return;
    const warmElapsed = modelWarmStartedAt ? (performance.now() - modelWarmStartedAt) / 1000 : 0;
    const remaining = Math.ceil(expectedSeconds - warmElapsed);
    promptTitle.textContent = '正在准备互动效果';
    promptHint.textContent = remaining > 0
      ? `表情模型加载中，预计剩余约 ${remaining} 秒`
      : '表情模型仍在加载，请继续拨动烟花';
  };
  update();
  modelCountdownTimer = window.setInterval(update, 500);
}

function stopModelCountdown() {
  window.clearInterval(modelCountdownTimer);
  modelCountdownTimer = 0;
}

async function startCamera() {
  if (cameraStatus === 'requesting' || cameraStatus === 'ready') return;

  setCameraStatus('requesting', '正在请求权限');
  startButton.disabled = true;
  startButton.querySelector('span')!.textContent = '正在开启…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support camera capture.');
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        // Tracking and the AR compositor do not benefit from a 60 fps camera
        // stream. Cap capture at 30 fps to leave GPU time for overlapping
        // fireworks while the renderer can still animate independently.
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    permissionScreen.classList.add('is-hidden');
    // Do not make the first camera frame wait for MediaPipe or WebGL. Both
    // models are several megabytes and can take a long time on mobile Safari,
    // especially on a cold CDN cache. The camera is usable immediately while
    // tracking warms up in the background.
    setCameraStatus('requesting', '正在准备互动');
    faceBadge.textContent = '模型加载中';
    startButton.querySelector('span')!.textContent = '摄像头已开启';
    loadingParticles.start();
    loadingGestureHint.classList.add('is-visible');
    startModelCountdown();

    const trackerInit = ensureFaceTrackerReady();
    // A cold mobile load fetches roughly 15 MB of MediaPipe runtime + model.
    // Treat a slow load as progress, not failure: the old hard timeout left a
    // successfully loaded model orphaned after 15 seconds on iOS.
    const slowModelTimer = window.setTimeout(() => {
      if (modelReady) return;
      setCameraStatus('requesting', '正在加载表情模型');
      faceBadge.textContent = '首次加载较慢';
    }, FACE_MODEL_SLOW_MS);

    void trackerInit.then(() => {
      window.clearTimeout(slowModelTimer);
      stopModelCountdown();
      modelReady = true;
      tracker?.start();
      faceBadge.textContent = '寻找面部';
      loadingParticles.setReady();
      maybeStartExperience();

      // Face tracking is the critical interaction. Load the visual layer and
      // rain only after it is ready; the lightweight CSS rain responds while
      // the full video buffers in the background.
      window.setTimeout(() => void ensureEffectsReady(), 0);
      // Hand control is only needed after the first expression interactions,
      // so keep its 7.5 MB model off the face-model critical path, but give it
      // priority over the optional 21 MB high-detail rain video.
      window.setTimeout(() => void startHandTracking(), 800);
      window.setTimeout(() => void prepareRainVideo(), 8_000);
    }).catch((error) => {
      window.clearTimeout(slowModelTimer);
      stopModelCountdown();
      loadingParticles.stop();
      loadingGestureHint.classList.remove('is-visible');
      console.warn('Face model unavailable; camera remains active.', error);
      setCameraStatus('ready', '摄像头已开启');
      faceBadge.textContent = '模型不可用';
      promptHint.textContent = '表情模型加载失败，请刷新重试';
    });
  } catch (error) {
    stopModelCountdown();
    loadingParticles.stop();
    loadingGestureHint.classList.remove('is-visible');
    console.error(error);
    setCameraStatus('error', stream ? '模型加载失败' : '摄像头不可用');
    faceBadge.textContent = '不可用';
    startButton.disabled = false;
    startButton.querySelector('span')!.textContent = '重试摄像头';
    permissionScreen.classList.remove('is-hidden');
  }
}

function startHandTracking() {
  if (!localV3 || !stream || handTracker) return;
  handTracker = new HandControlTracker(video);
  void handTracker.init().catch(error => {
    console.warn('Hand model unavailable; face interaction remains active.', error);
    handTracker?.destroy();
    handTracker = null;
  });
}

function handleSample(sample: ExpressionSample) {
  currentSample = sample;
  inferenceFrames += 1;
  faceBadge.textContent = sample.faceDetected ? '面部已锁定' : '寻找面部';
  faceBadge.dataset.detected = sample.faceDetected ? 'true' : 'false';
  updateMetric('smile', sample.smile);
  updateMetric('jawOpen', sample.jawOpen);
  updateMetric('cheekSquint', sample.cheekSquint);
  updateHeadCollider(sample.head);

  // Calibration may run while the rain asset is still buffering. Do not ask
  // the user to perform gestures until every first-interaction dependency is
  // actually ready.
  if (!experienceReady) return;

  const change = machine.update(sample, performance.now());
  if (change.changed) {
    setExpressionState(change.current);
  }

  // Keep feeding a laugh signal into the firework pool. ThreeFireworks owns
  // the short cooldown, so sustained laughter can create several staggered
  // rockets while still avoiding per-frame bursts.
  if (change.current === 'LAUGH' && sample.laugh > 0.42) {
    launchStrongFirework(sample.head, 1.28);
  }
}

function updateMetric(name: keyof typeof metricElements, score: number) {
  const metric = metricElements[name];
  metric.value.value = score.toFixed(2);
  metric.value.textContent = score.toFixed(2);
  metric.meter.value = score;
}

function setExpressionState(state: ExpressionState) {
  if(localV3) easterEgg.expression(state);
  const copy = stateCopy[state];
  document.body.dataset.expression = state.toLowerCase();
  stateLabel.textContent = copy.label;
  promptTitle.textContent = copy.title;
  promptHint.textContent = copy.hint;
  if (state !== 'NEUTRAL') {
    loadingParticles.stop();
    loadingGestureHint.classList.remove('is-visible');
  }
  particles?.setState(state);
  setRainVideoActive(state === 'SMILE');
}

function setRainVideoActive(active: boolean) {
  rainEffectVideo.classList.toggle('is-active', active);
  if (active) {
    void prepareRainVideo();
    if (rainVideoReady && rainEffectVideo.paused) {
      void rainEffectVideo.play().catch(() => undefined);
    }
  }
}

function prepareRainVideo() {
  if (rainReadyPromise) return rainReadyPromise;
  rainReadyPromise = new Promise<void>((resolve) => {
    if (!rainEffectVideo.hasAttribute('src')) {
      const source = rainEffectVideo.dataset.src;
      if (source) rainEffectVideo.src = source;
    }
    rainEffectVideo.preload = 'auto';
    rainEffectVideo.muted = true;
    rainEffectVideo.loop = true;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(slowTimer);
      rainVideoReady = true;
      document.body.classList.add('rain-video-ready');
      // Once unlocked, keep the muted loop running. Expressions only fade the
      // layer in and out, so threshold jitter can never freeze a visible frame.
      void rainEffectVideo.play().catch(() => undefined);
      maybeStartExperience();
      resolve();
    };
    const fail = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(slowTimer);
      // Keep the lightweight generated rain active. A failed decorative video
      // must not make the expression interaction appear broken.
      console.warn('Rain video unavailable; using the lightweight rain layer.');
      resolve();
    };
    const slowTimer = window.setTimeout(() => {
      if (rainVideoReady) return;
      // The generated rain is already interactive; avoid replacing useful
      // gesture guidance with a loading message.
    }, 4_000);

    rainEffectVideo.addEventListener('canplay', finish, { once: true });
    rainEffectVideo.addEventListener('error', fail, { once: true });
    rainEffectVideo.load();
    // Preserve the user-gesture playback permission before the async camera
    // request returns. The promise can remain pending until data is buffered.
    void rainEffectVideo.play().catch(() => undefined);
    if (rainEffectVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) finish();
  });
  return rainReadyPromise;
}

function maybeStartExperience() {
  if (experienceReady || !modelReady) return;
  experienceReady = true;
  setCameraStatus('ready', '实时识别中');
  faceBadge.textContent = '寻找面部';
  machine.reset();
  setExpressionState('NEUTRAL');
  if (!onboardingStarted) {
    onboardingStarted = true;
    onboarding.start();
  }
}

function updateHeadCollider(head: HeadCollider | null) {
  if (!head) {
    headColliderElement.classList.remove('has-head');
    headColliderElement.classList.remove('debug-visible');
    headColliderElement.classList.remove('has-polygon', 'has-velocity');
    colliderType.textContent = '—';
    colliderStatus.textContent = 'INACTIVE';
    return;
  }
  headColliderElement.classList.add('has-head');
  headColliderElement.classList.toggle('debug-visible', colliderToggle.checked);
  const hasPolygon = Boolean(head.points && head.points.length >= 3);
  headColliderElement.classList.toggle('has-polygon', hasPolygon);
  colliderType.textContent = hasPolygon ? 'POLYGON' : 'ELLIPSE';
  colliderStatus.textContent = 'ACTIVE';
  headColliderElement.style.setProperty('--head-x', `${head.cx - head.rx}px`);
  headColliderElement.style.setProperty('--head-y', `${head.cy - head.ry}px`);
  headColliderElement.style.setProperty('--head-w', `${head.rx * 2}px`);
  headColliderElement.style.setProperty('--head-h', `${head.ry * 2}px`);
  if (hasPolygon) {
    const originX = head.cx - head.rx;
    const originY = head.cy - head.ry;
    const width = Math.max(1, head.rx * 2);
    const height = Math.max(1, head.ry * 2);
    colliderPolygon.setAttribute('points', head.points!.map((point) => `${((point.x - originX) / width) * 100},${((point.y - originY) / height) * 100}`).join(' '));
  }
}

function launchStrongFirework(head: HeadCollider | null, intensity = 1) {
  particles?.launchFirework(head, intensity);
}

function renderLoop(now: number) {
  const dtSeconds = (now - previousFrameAt) / 1000;
  previousFrameAt = now;
  if(localV3) { easterEgg.tick(dtSeconds,handControl); eggView.render(); }
  frames += 1;

  const activeParticles = particles;
  if (effectsInitialized && activeParticles) {
    activeParticles.update(dtSeconds, currentSample?.head ?? null);
    const nextCollisionCount = activeParticles.collisionCount.toString();
    if (collisionCount.textContent !== nextCollisionCount) {
      collisionCount.textContent = nextCollisionCount;
    }
    collisionRate.textContent = activeParticles.collisionCountPerSecond.toFixed(1);
    hardCollisionRate.textContent = activeParticles.collisionCountPerSecond.toFixed(1);
    midFlowCount.textContent = activeParticles.particlesInMidFlow.toString();
    outerFlowCount.textContent = activeParticles.particlesInOuterFlow.toString();
    averageFlowForce.textContent = Math.round(activeParticles.averageInteractionForce).toString();
    fireworkCount.textContent = activeParticles.activeFireworkParticleCount.toString();
    colliderStatus.textContent = currentSample?.head ? 'ACTIVE' : 'INACTIVE';
    headSpeed.textContent = Math.round(activeParticles.headSpeed).toString();
    const velocityMagnitude = activeParticles.headSpeed;
    headColliderElement.classList.toggle('has-velocity', velocityMagnitude > 8 && Boolean(currentSample?.head));
    if (currentSample?.head && velocityMagnitude > 8) {
      const scale = Math.min(0.65, velocityMagnitude > 0 ? 34 / velocityMagnitude : 0);
      // Direction is represented by the current smoothed velocity; keep the
      // vector short and inside the debug collider bounds.
      const vx = activeParticles.headVelocityXValue;
      const vy = activeParticles.headVelocityYValue;
      headVelocityVector.setAttribute('x1', '50');
      headVelocityVector.setAttribute('y1', '50');
      headVelocityVector.setAttribute('x2', `${50 + vx * scale}`);
      headVelocityVector.setAttribute('y2', `${50 + vy * scale}`);
    }
  }

  const elapsed = now - fpsStartedAt;
  if (elapsed >= 750) {
    renderFps.textContent = Math.round((frames * 1000) / elapsed).toString();
    inferenceFps.textContent = Math.round((inferenceFrames * 1000) / elapsed).toString();
    frames = 0;
    inferenceFrames = 0;
    fpsStartedAt = now;
  }
  requestAnimationFrame(renderLoop);
}

function destroy() {
  stopModelCountdown();
  loadingParticles.destroy();
  handTracker?.destroy();
  tracker?.destroy();
  particles?.destroy();
  window.removeEventListener('resize', syncPhoneScreen);
  rainEffectVideo.pause();
  stream?.getTracks().forEach((track) => track.stop());
}

startButton.addEventListener('click', startCamera);
colliderToggle.addEventListener('change', () => {
  headColliderElement.classList.toggle('debug-visible', colliderToggle.checked && Boolean(currentSample?.head));
  debugPanel.classList.toggle('show-interaction-debug', colliderToggle.checked);
  particles?.setColliderDebug(colliderToggle.checked);
  if (!colliderToggle.checked) {
    flowVectorsToggle.checked = false;
    particles?.setFlowVectorDebug(false);
  }
});
collisionPointsToggle.addEventListener('change', () => {
  particles?.setCollisionDebug(collisionPointsToggle.checked);
});
flowVectorsToggle.addEventListener('change', () => {
  particles?.setFlowVectorDebug(flowVectorsToggle.checked);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) tracker?.stop();
  else if (modelReady) tracker?.start();
});
window.addEventListener('pagehide', destroy, { once: true });

// Alt+S / Alt+L / Alt+N keeps visual QA possible on machines without a camera.
window.addEventListener('keydown', (event) => {
  if (!event.altKey) return;
  const key = event.key.toLowerCase();
  const state: ExpressionState | null =
    key === 'l' ? 'LAUGH' : key === 's' ? 'SMILE' : key === 'n' ? 'NEUTRAL' : null;
  if (!state) return;
  setExpressionState(state);
  if (state === 'LAUGH') launchStrongFirework(currentSample?.head ?? null, 1.25);
});

setExpressionState('NEUTRAL');
// Warm the face model after the permission screen has painted. This does not
// access the camera; it only downloads and compiles the on-device recognizer.
window.setTimeout(() => {
  void ensureFaceTrackerReady().catch(error => {
    console.warn('Face model preload deferred until camera start.', error);
  });
}, 600);
requestAnimationFrame(renderLoop);
