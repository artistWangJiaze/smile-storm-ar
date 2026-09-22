export type ExpressionState = 'NEUTRAL' | 'SMILE' | 'LAUGH';

export interface ExpressionSample {
  faceDetected: boolean;
  smile: number;
  jawOpen: number;
  cheekSquint: number;
  laugh: number;
  head: HeadCollider | null;
  inferenceMs: number;
}

export interface HeadCollider {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  points?: HeadPoint[];
  rotation?: number;
  type?: 'POLYGON' | 'ELLIPSE';
}

export interface HeadPoint {
  x: number;
  y: number;
}

export interface StateChange {
  previous: ExpressionState;
  current: ExpressionState;
  changed: boolean;
}
