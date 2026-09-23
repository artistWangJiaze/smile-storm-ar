import type { ExpressionSample, ExpressionState, StateChange } from './types';

interface CandidateState {
  value: ExpressionState;
  since: number;
}

const ENTER_DELAY: Record<ExpressionState, number> = {
  NEUTRAL: 220,
  SMILE: 200,
  LAUGH: 160,
};

// Keep a detected laugh alive long enough for the rocket to rise and the
// burst to read, even if the user's mouth relaxes immediately afterwards.
const LAUGH_HOLD_MS = 1200;

export class ExpressionMachine {
  private state: ExpressionState = 'NEUTRAL';
  private candidate: CandidateState = { value: 'NEUTRAL', since: 0 };
  private lastLaughAt = -Infinity;

  get current() {
    return this.state;
  }

  update(sample: ExpressionSample, now: number): StateChange {
    const previous = this.state;
    const laughIsHeld = this.state === 'LAUGH' && now - this.lastLaughAt < LAUGH_HOLD_MS;
    const desired = laughIsHeld ? 'LAUGH' : this.classify(sample);

    if (desired !== this.candidate.value) {
      this.candidate = { value: desired, since: now };
    }

    if (desired !== this.state && now - this.candidate.since >= ENTER_DELAY[desired]) {
      this.state = desired;
      if (desired === 'LAUGH') this.lastLaughAt = now;
    }

    return { previous, current: this.state, changed: previous !== this.state };
  }

  canLaunchFirework(now: number, cooldown = 820) {
    if (this.state !== 'LAUGH' || now - this.lastLaughAt < cooldown) return false;
    this.lastLaughAt = now;
    return true;
  }

  reset() {
    this.state = 'NEUTRAL';
    this.candidate = { value: 'NEUTRAL', since: 0 };
  }

  private classify(sample: ExpressionSample): ExpressionState {
    if (!sample.faceDetected) return 'NEUTRAL';

    const laughEnter =
      sample.laugh > 0.42 && sample.smile > 0.36 && sample.jawOpen > 0.12;
    const laughHold =
      this.state === 'LAUGH' && sample.laugh > 0.31 && sample.smile > 0.27;
    if (laughEnter || laughHold) return 'LAUGH';

    // A smile needs a stronger signal and a longer dwell than a laugh so
    // small mouth movements do not start the rain layer repeatedly.
    const smileEnter = sample.smile > 0.38;
    const smileHold = this.state === 'SMILE' && sample.smile > 0.31;
    if (smileEnter || smileHold) return 'SMILE';

    return 'NEUTRAL';
  }
}
