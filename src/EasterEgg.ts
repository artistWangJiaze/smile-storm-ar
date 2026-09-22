const KEY = 'smile-storm:easter-egg:v1';
export const eggCopy = ['彩蛋来了！','举起手握拳放入镜头','你现在可以控制烟花了！','手张开烟花绽放','手握拳烟花回溯','手旋转烟花旋转'];

export class EasterEgg {
  phase = -1;
  pending = false;
  holding = false;
  private seen = false;
  private laughs = 0;
  private laughing = false;
  private elapsed = 0;
  private success = 0;
  private rotationStart: number | null = null;
  constructor() {
    try { this.seen = localStorage.getItem(KEY) === 'seen'; } catch { /* Storage optional. */ }
  }
  get active() { return this.phase >= 0; }
  expression(state: string) {
    if(state === 'LAUGH' && !this.laughing && !this.seen && !this.pending) {
      if(++this.laughs === 3) this.pending = true;
    }
    this.laughing = state === 'LAUGH';
  }
  bloomReady() {
    if(!this.pending) return;
    this.pending = false; this.seen = true; this.holding = true;
    try { localStorage.setItem(KEY,'seen'); } catch { /* Session still only once. */ }
    this.advance(0);
  }
  private advance(phase: number) {
    this.phase = phase; this.elapsed = 0; this.success = 0; this.rotationStart = null;
  }
  tick(dt: number, hand: {active:boolean;openness:number;angle:number}) {
    if(!this.active) return;
    dt = Math.min(Math.max(dt,0),.1); this.elapsed += dt;
    if(hand.active) this.holding = false;
    if(this.phase === 0) { if(this.elapsed >= 2.5) this.advance(1); return; }
    if(this.phase === 2) {
      if(hand.active && this.elapsed >= 2.5) this.advance(3);
      return;
    }
    let correct = false;
    if(hand.active) {
      if(this.phase === 1 || this.phase === 4) correct = hand.openness < .25;
      if(this.phase === 3) correct = hand.openness > .8;
      if(this.phase === 5) {
        this.rotationStart ??= hand.angle;
        const delta = Math.atan2(Math.sin(hand.angle-this.rotationStart),Math.cos(hand.angle-this.rotationStart));
        correct = Math.abs(delta) > Math.PI/6;
      }
    } else this.rotationStart = null;
    this.success = correct ? this.success+dt : 0;
    if(this.success >= .45) this.advance(this.phase === 5 ? -1 : this.phase+1);
  }
}
export const easterEgg = new EasterEgg();

export class EasterEggView {
  private element = document.createElement('div');
  private text = document.createElement('p');
  constructor(stage: HTMLElement) {
    this.element.className = 'easter-egg'; this.element.hidden = true;
    this.element.setAttribute('role','status'); this.element.setAttribute('aria-live','polite');
    this.element.append(this.text); stage.append(this.element);
  }
  render() {
    this.element.hidden = !easterEgg.active;
    const copy = eggCopy[easterEgg.phase] ?? '';
    if(this.text.textContent !== copy) this.text.textContent = copy;
  }
}
