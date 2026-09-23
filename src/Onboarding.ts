const STORAGE_KEY = 'smile-storm:onboarding:figma-v1';
const steps = [
  { title: '动作说明', description: '这里会告诉你当前要进行的动作' },
  { title: '实时状态', description: '这里展示了系统状态、以及你的表情状态、还有微笑和大笑张嘴的幅度变化' },
  { title: '彩蛋', description: '最后，当你试过微笑和大笑，第三次大笑时，有一个小惊喜在等着你！' },
];

export class Onboarding {
  private element = document.createElement('section');
  private step = 0;
  private started = false;
  private previousFocus: HTMLElement | null = null;

  constructor(stage: HTMLElement) {
    this.element.className = 'onboarding';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', '新手引导');
    this.element.setAttribute('aria-labelledby', 'onboarding-title');
    stage.append(this.element);
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.finish();
      if (event.key !== 'Tab') return;
      const buttons = [...this.element.querySelectorAll<HTMLButtonElement>('button')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    let completed = false;
    try { completed = localStorage.getItem(STORAGE_KEY) === 'done'; } catch { /* Private mode may block storage. */ }
    if (completed && new URLSearchParams(location.search).get('onboarding') !== '1') return;
    this.previousFocus = document.activeElement as HTMLElement | null;
    this.element.hidden = false;
    this.render();
  }

  private finish() {
    try { localStorage.setItem(STORAGE_KEY, 'done'); } catch { /* Still dismiss for this session. */ }
    this.element.hidden = true;
    if (this.previousFocus && this.previousFocus.getClientRects().length && !this.previousFocus.closest('.is-hidden')) {
      this.previousFocus.focus();
    }
  }

  private render() {
    const copy = steps[this.step];
    this.element.dataset.step = String(this.step + 1);
    this.element.innerHTML = `
      <img class="onboarding-arrow" src="/ui/figma/arrow-${this.step === 0 ? 'bottom' : 'top'}.svg" alt="" />
      <div class="onboarding-card">
        <div class="onboarding-heading"><span class="onboarding-new"><img src="/ui/figma/new.svg" alt="" />NEW</span>
          <button class="onboarding-close" type="button" aria-label="关闭新手引导"><img src="/ui/figma/close.svg" alt="" /></button></div>
        <h2 id="onboarding-title">${copy.title}</h2>
        <p>${copy.description}</p>
        <div class="onboarding-footer"><span>${this.step + 1}/3</span><div class="onboarding-actions">
          ${this.step === 1 ? '<button class="onboarding-back" type="button">上一步</button>' : ''}
          <button class="onboarding-next" type="button">${this.step === 2 ? '去试试' : '下一步'}</button>
        </div></div>
      </div>`;
    this.element.querySelector('.onboarding-close')!.addEventListener('click', () => this.finish());
    this.element.querySelector('.onboarding-back')?.addEventListener('click', () => { this.step--; this.render(); });
    const next = this.element.querySelector<HTMLButtonElement>('.onboarding-next')!;
    next.addEventListener('click', () => {
      if (this.step === 2) this.finish();
      else { this.step++; this.render(); }
    });
    next.focus({ preventScroll: true });
  }
}
