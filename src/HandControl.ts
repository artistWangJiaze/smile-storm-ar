import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

export const handControl = { active: false, openness: 0, angle: 0 };
const clamp = (v: number) => Math.max(0, Math.min(1, v));

// Finger joint straightness is independent of palm position and camera distance.
export function measureHand(points: NormalizedLandmark[]) {
  let openness = 0;
  for (const [base, joint, tip] of [[5,6,8],[9,10,12],[13,14,16],[17,18,20]]) {
    const a = points[base], b = points[joint], c = points[tip];
    const u = [a.x-b.x,a.y-b.y,a.z-b.z], v = [c.x-b.x,c.y-b.y,c.z-b.z];
    const cosine = (u[0]*v[0]+u[1]*v[1]+u[2]*v[2]) / Math.max(1e-6,Math.hypot(...u)*Math.hypot(...v));
    // Use joint angle rather than cosine: cosine saturates too quickly as
    // fingers straighten, making a half-open hand behave like a full palm.
    const degrees = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    openness += clamp((degrees-60)/115)/4;
  }
  // Mirror x just as the live camera does. Upright palm has zero roll.
  const angle = Math.atan2(-(points[9].x-points[0].x), -(points[9].y-points[0].y));
  return { openness, angle };
}

export function handAnimationAge(openness: number) {
  const progress = clamp((openness-.06)/.94);
  // Hold at visible fragmented particles, never scrub into the invisible tail.
  // A gentler start gives slightly opened fingers useful adjustment room.
  return .18 + Math.pow(progress, 1.35) * 1.47;
}

export class HandControlTracker {
  private model: HandLandmarker | null = null;
  private timer = 0;
  private lastSeen = 0;
  private lastVideoTime = -1;
  private stopped = false;
  constructor(private video: HTMLVideoElement) {}
  async init() {
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    const options = { runningMode: 'VIDEO' as const, numHands: 1, minHandDetectionConfidence: .6, minHandPresenceConfidence: .6, minTrackingConfidence: .6 };
    this.model = await HandLandmarker.createFromOptions(vision, { ...options, baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'GPU' } });
    if (this.stopped) { this.model.close(); return; }
    this.tick();
  }
  private tick = () => {
    if(this.stopped) return;
    const now = performance.now();
    try {
      if(this.video.readyState >= 2 && this.lastVideoTime !== this.video.currentTime) {
        this.lastVideoTime = this.video.currentTime;
        const points = this.model?.detectForVideo(this.video,now).landmarks[0];
        if(points) {
          const next = measureHand(points);
          if(!handControl.active) { handControl.openness = next.openness; handControl.angle = next.angle; }
          else {
            handControl.openness += (next.openness-handControl.openness)*.28;
            const delta = Math.atan2(Math.sin(next.angle-handControl.angle),Math.cos(next.angle-handControl.angle));
            handControl.angle += delta*.28;
          }
          handControl.active = true; this.lastSeen = now;
        }
      }
      if(now-this.lastSeen > 350) handControl.active = false;
    } catch (error) { console.warn('Hand tracking stopped',error); this.destroy(); return; }
    this.timer = window.setTimeout(this.tick,80);
  };
  destroy() { this.stopped = true; clearTimeout(this.timer); this.model?.close(); this.model = null; handControl.active = false; }
}
