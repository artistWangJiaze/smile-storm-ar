import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import type { ExpressionSample, HeadCollider, HeadPoint } from './types';

const WASM_ROOT = '/wasm';
const MODEL_PATH = '/models/face_landmarker.task';
const INFERENCE_INTERVAL_MS = 58;
const EMA_ALPHA = 0.34;
const COLLIDER_POINT_ALPHA = 0.25;
const FACE_LOST_GRACE_MS = 200;
const HEAD_CONTOUR_INDICES = [
  10, 297, 284, 389, 454, 361, 397, 379, 400, 152,
  176, 150, 172, 58, 93, 234, 162, 54,
] as const;

type SampleHandler = (sample: ExpressionSample) => void;

const EMPTY_SAMPLE: ExpressionSample = {
  faceDetected: false,
  smile: 0,
  jawOpen: 0,
  cheekSquint: 0,
  laugh: 0,
  head: null,
  inferenceMs: 0,
};

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private running = false;
  private timer = 0;
  private sample: ExpressionSample = { ...EMPTY_SAMPLE };
  private head: HeadCollider | null = null;
  private lostHeadSince = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly stage: HTMLElement,
    private readonly onSample: SampleHandler,
  ) {}

  async init() {
    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
    const options = {
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.52,
      minFacePresenceConfidence: 0.52,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    } as const;

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      });
    } catch (gpuError) {
      console.warn('GPU delegate unavailable, falling back to CPU.', gpuError);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
  }

  destroy() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
  }

  private schedule(delay: number) {
    this.timer = window.setTimeout(() => this.tick(), delay);
  }

  private tick() {
    if (!this.running || !this.landmarker) return;
    if (document.hidden || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.schedule(INFERENCE_INTERVAL_MS);
      return;
    }

    const startedAt = performance.now();
    let result: FaceLandmarkerResult;
    try {
      result = this.landmarker.detectForVideo(this.video, startedAt);
    } catch (error) {
      console.warn('Face inference skipped', error);
      this.schedule(INFERENCE_INTERVAL_MS);
      return;
    }

    const inferenceMs = performance.now() - startedAt;
    const next = this.readResult(result, inferenceMs);
    this.sample = this.smooth(this.sample, next);
    this.onSample(this.sample);

    const remaining = Math.max(4, INFERENCE_INTERVAL_MS - inferenceMs);
    this.schedule(remaining);
  }

  private readResult(result: FaceLandmarkerResult, inferenceMs: number): ExpressionSample {
    const categories = result.faceBlendshapes[0]?.categories;
    const landmarks = result.faceLandmarks[0];
    if (!categories || !landmarks) {
      if (this.head && !this.lostHeadSince) this.lostHeadSince = performance.now();
      if (this.head && performance.now() - this.lostHeadSince < FACE_LOST_GRACE_MS) {
        return { ...EMPTY_SAMPLE, head: this.head, inferenceMs };
      }
      this.head = null;
      return { ...EMPTY_SAMPLE, inferenceMs };
    }

    const scores = new Map(categories.map((item) => [item.categoryName, item.score]));
    const smile = average(
      scores.get('mouthSmileLeft') ?? 0,
      scores.get('mouthSmileRight') ?? 0,
    );
    const jawOpen = scores.get('jawOpen') ?? 0;
    const cheekSquint = average(
      scores.get('cheekSquintLeft') ?? 0,
      scores.get('cheekSquintRight') ?? 0,
    );

    const laugh = clamp(smile * 0.54 + jawOpen * 0.3 + cheekSquint * 0.16);
    this.lostHeadSince = 0;
    this.head = this.getHeadCollider(landmarks);

    return {
      faceDetected: true,
      smile,
      jawOpen,
      cheekSquint,
      laugh,
      head: this.head,
      inferenceMs,
    };
  }

  private smooth(previous: ExpressionSample, next: ExpressionSample): ExpressionSample {
    if (!next.faceDetected) return next;
    if (!previous.faceDetected) return next;

    return {
      faceDetected: true,
      smile: lerp(previous.smile, next.smile, EMA_ALPHA),
      jawOpen: lerp(previous.jawOpen, next.jawOpen, EMA_ALPHA),
      cheekSquint: lerp(previous.cheekSquint, next.cheekSquint, EMA_ALPHA),
      laugh: lerp(previous.laugh, next.laugh, EMA_ALPHA),
      head: smoothHead(previous.head, next.head, 0.32),
      inferenceMs: next.inferenceMs,
    };
  }

  private getHeadCollider(landmarks: NormalizedLandmark[]): HeadCollider {
    const stageWidth = this.stage.clientWidth;
    const stageHeight = this.stage.clientHeight;
    const videoWidth = this.video.videoWidth || 1280;
    const videoHeight = this.video.videoHeight || 720;
    const scale = Math.max(stageWidth / videoWidth, stageHeight / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const cropX = (renderedWidth - stageWidth) / 2;
    const cropY = (renderedHeight - stageHeight) / 2;

    const mapPoint = (point: NormalizedLandmark): HeadPoint => ({
      // Match the mirrored camera transform used by the existing collider.
      x: stageWidth + cropX - point.x * renderedWidth,
      y: point.y * renderedHeight - cropY,
    });
    const rawPoints = HEAD_CONTOUR_INDICES.map((index) => mapPoint(landmarks[index] ?? landmarks[0]));
    const previousPoints = this.head?.points;
    const points = rawPoints.map((point, index) => {
      const previous = previousPoints?.[index];
      return previous
        ? { x: lerp(previous.x, point.x, COLLIDER_POINT_ALPHA), y: lerp(previous.y, point.y, COLLIDER_POINT_ALPHA) }
        : point;
    });
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    const left = minX;
    const right = maxX;
    const top = minY;
    const bottom = maxY;
    const eyeLeft = mapPoint(landmarks[33] ?? landmarks[0]);
    const eyeRight = mapPoint(landmarks[263] ?? landmarks[0]);

    return {
      cx: (left + right) / 2,
      cy: (top + bottom) / 2 - (bottom - top) * 0.025,
      rx: Math.max(42, (right - left) * 0.5),
      ry: Math.max(56, (bottom - top) * 0.5),
      points,
      rotation: Math.atan2(eyeRight.y - eyeLeft.y, eyeRight.x - eyeLeft.x),
      type: 'POLYGON',
    };
  }
}

function average(a: number, b: number) {
  return (a + b) / 2;
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function smoothHead(
  previous: HeadCollider | null,
  next: HeadCollider | null,
  amount: number,
): HeadCollider | null {
  if (!previous || !next) return next;
  return {
    cx: lerp(previous.cx, next.cx, amount),
    cy: lerp(previous.cy, next.cy, amount),
    rx: lerp(previous.rx, next.rx, amount),
    ry: lerp(previous.ry, next.ry, amount),
    points: previous.points && next.points
      ? next.points.map((point, index) => ({
        x: lerp(previous.points?.[index]?.x ?? point.x, point.x, amount),
        y: lerp(previous.points?.[index]?.y ?? point.y, point.y, amount),
      }))
      : next.points,
    rotation: lerp(previous.rotation ?? 0, next.rotation ?? 0, amount),
    type: next.type ?? previous.type,
  };
}
