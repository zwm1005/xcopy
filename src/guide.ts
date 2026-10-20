import { onLocaleChange, t } from './i18n/index.js';
import type { MessageKey } from './i18n/messages.js';
import { query } from './dom.js';

const seenKey = 'suichuan-guide-seen';
const steps = [
  { title: 'guide.connect.title', copy: 'guide.connect.copy', note: 'guide.connect.note', mode: 'device', selector: '[data-action="connect"]' },
  { title: 'guide.send.title', copy: 'guide.send.copy', note: 'guide.send.note', mode: 'device', selector: '#device-composer' },
  { title: 'guide.share.title', copy: 'guide.share.copy', note: 'guide.share.note', mode: 'share', selector: '#share-composer .share-upload' }
] as const satisfies readonly { title: MessageKey; copy: MessageKey; note: MessageKey; mode: string; selector: string }[];
interface GuideOptions {
  canStart: () => boolean;
  canAutoStart: () => boolean;
  prepare: () => () => void;
  setMode: (mode: string) => void;
}

/** A local, once-only tour. It never pairs, sends, or creates a share. */
export class FirstUseGuide {
  private layer: HTMLElement;
  private card: HTMLElement;
  private spotlight: HTMLElement;
  private help: HTMLButtonElement;
  private app: HTMLElement;
  private next: HTMLButtonElement;
  private back: HTMLButtonElement;
  private seen = false;
  private step = 0;
  private frame = 0;
  private restore?: () => void;
  private originalFocus: HTMLElement | null = null;
  private originalScroll = 0;
  private contentPosition?: { left: number; top: number };
  private layoutRunning = false;

  constructor(private root: HTMLElement, private options: GuideOptions) {
    this.app = query(root, '.qt-app');
    this.help = query(root, '[data-use-guide]');
    this.layer = document.createElement('div');
    this.layer.className = 'qt-guide-layer';
    this.layer.hidden = true;
    this.layer.dataset.guide = '';
    this.layer.innerHTML = `
      <div class="qt-guide-spotlight" aria-hidden="true"></div>
      <section class="qt-guide-card" role="dialog" aria-modal="true" aria-labelledby="qt-guide-title" aria-describedby="qt-guide-copy qt-guide-note">
        <div class="qt-guide-heading">
          <div class="qt-guide-counter"><span class="qt-guide-dots" aria-hidden="true"><i></i><i></i><i></i></span><span data-guide-step></span></div>
          <button type="button" class="qt-button qt-quiet qt-guide-close" data-guide-close>×</button>
        </div>
        <h2 id="qt-guide-title"></h2>
        <p class="qt-guide-copy" id="qt-guide-copy"></p>
        <p class="qt-guide-note" id="qt-guide-note"></p>
        <div class="qt-guide-footer">
          <button type="button" class="qt-text-button qt-guide-skip" data-guide-skip></button>
          <div class="qt-guide-nav">
            <button type="button" class="qt-text-button" data-guide-back></button>
            <button type="button" class="qt-button qt-primary" data-guide-next></button>
          </div>
        </div>
      </section>`;
    root.append(this.layer);
    this.card = query(this.layer, '.qt-guide-card');
    this.spotlight = query(this.layer, '.qt-guide-spotlight');
    this.next = query(this.layer, '[data-guide-next]');
    this.back = query(this.layer, '[data-guide-back]');
    this.help.addEventListener('click', () => this.start());
    query(this.layer, '[data-guide-close]').addEventListener('click', () => this.finish());
    query(this.layer, '[data-guide-skip]').addEventListener('click', () => this.finish());
    this.next.addEventListener('click', () => {
      if (this.step === steps.length - 1) {
        this.finish();
      } else {
        this.step += 1;
        this.showStep();
      }
    });
    this.back.addEventListener('click', () => {
      this.step -= 1;
      this.showStep();
    });
    this.layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.finish();
      }
      if (event.key === 'Tab') {
        const buttons = [...this.card.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.hidden);
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
    window.addEventListener('resize', () => this.scheduleLayout());
    window.visualViewport?.addEventListener('resize', () => this.scheduleLayout());
    window.addEventListener('scroll', () => this.position(), { passive: true });
    document.addEventListener('visibilitychange', () => this.update());
    onLocaleChange(() => this.scheduleLayout());
  }
  get active() {
    return !this.layer.hidden;
  }
  private hasSeen() {
    if (this.seen) {
      return true;
    }
    for (const kind of ['localStorage', 'sessionStorage'] as const) {
      try {
        if (window[kind].getItem(seenKey) === '1') {
          return true;
        }
      } catch { /* Fall back when browser storage is restricted. */ }
    }
    return false;
  }
  private remember() {
    this.seen = true;
    for (const kind of ['localStorage', 'sessionStorage'] as const) {
      try {
        window[kind].setItem(seenKey, '1');
      } catch { /* The current page still remembers when all storage is blocked. */ }
    }
  }
  update() {
    this.help.disabled = !this.options.canStart();
    if (this.active) {
      if (!this.options.canStart()) {
        this.finish(false);
      }
    } else if (!document.hidden && !this.hasSeen() && this.options.canStart() && this.options.canAutoStart()) {
      this.start();
    }
  }
  private start() {
    if (this.active || !this.options.canStart()) {
      return;
    }
    this.step = 0;
    this.contentPosition = undefined;
    this.originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.originalScroll = window.scrollY;
    this.layer.hidden = false;
    this.app.inert = true;
    this.app.classList.add('qt-guide-running');
    this.restore = this.options.prepare();
    window.scrollTo({ top: 0, behavior: 'instant' });
    this.layout();
    this.remember();
    this.next.focus({ preventScroll: true });
  }
  finish(restoreFocus = true) {
    if (!this.active) {
      return;
    }
    this.layer.hidden = true;
    cancelAnimationFrame(this.frame);
    this.app.inert = false;
    this.app.classList.remove('qt-guide-running');
    const restore = this.restore;
    this.restore = undefined;
    restore?.();
    window.scrollTo({ top: this.originalScroll, behavior: 'instant' });
    if (restoreFocus) {
      const focus = this.originalFocus?.isConnected && this.originalFocus !== document.body ? this.originalFocus : this.help;
      focus.focus({ preventScroll: true });
    }
  }
  private renderCopy(index: number) {
    const step = steps[index];
    query(this.card, '#qt-guide-title').textContent = t(step.title);
    query(this.card, '#qt-guide-copy').textContent = t(step.copy);
    query(this.card, '#qt-guide-note').textContent = t(step.note);
    query(this.card, '[data-guide-step]').textContent = t('guide.step', { current: index + 1, total: steps.length });
    query(this.card, '[data-guide-close]').setAttribute('aria-label', t('guide.close'));
    query(this.card, '[data-guide-skip]').textContent = t('guide.skip');
    this.back.textContent = t('guide.back');
    this.back.hidden = index === 0;
    this.next.textContent = t(index === steps.length - 1 ? 'guide.done' : 'guide.next');
    this.card.querySelectorAll('.qt-guide-dots i').forEach((dot, i) => dot.toggleAttribute('data-current', i === index));
  }
  private scheduleLayout() {
    if (!this.active) {
      return;
    }
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.layout());
  }
  private layout() {
    if (!this.active || this.layoutRunning) {
      return;
    }
    this.layoutRunning = true;
    this.card.style.height = '';
    let height = 0;
    for (let index = 0; index < steps.length; index += 1) {
      this.renderCopy(index);
      height = Math.max(height, Math.ceil(this.card.getBoundingClientRect().height));
    }
    this.card.style.height = `${height}px`;
    this.contentPosition = undefined;
    // Measure both file regions so resizing on either step keeps a shared anchor.
    let bottom = 0;
    let left = 0;
    for (const index of [1, 2]) {
      this.options.setMode(steps[index].mode);
      const rect = query(this.root, steps[index].selector).getBoundingClientRect();
      bottom = Math.max(bottom, rect.bottom);
      left = rect.left;
    }
    const top = Math.max(12, Math.min(bottom + 20, window.innerHeight - this.card.offsetHeight - 16));
    this.contentPosition = {
      left: window.innerWidth <= 600 ? 12 : Math.max(12, Math.min(window.innerWidth - this.card.offsetWidth - 20, left)),
      top: window.innerWidth <= 600 ? Math.max(12, window.innerHeight - this.card.offsetHeight - 16) : top
    };
    this.options.setMode(steps[this.step].mode);
    this.renderCopy(this.step);
    if (this.step > 0 && bottom > this.contentPosition.top - 20) {
      window.scrollBy({ top: bottom - this.contentPosition.top + 20, behavior: 'instant' });
    }
    this.position();
    this.layoutRunning = false;
  }
  private showStep() {
    this.options.setMode(steps[this.step].mode);
    this.renderCopy(this.step);
    if (this.step === 0) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    if (this.step === 1) {
      this.layout();
    } else {
      this.position();
    }
    this.next.focus({ preventScroll: true });
  }
  private position() {
    if (!this.active) {
      return;
    }
    const target = this.root.querySelector<HTMLElement>(steps[this.step].selector);
    if (!target || !target.getClientRects().length) {
      return;
    }
    const rect = target.getBoundingClientRect();
    Object.assign(this.spotlight.style, {
      left: `${Math.max(4, rect.left - 6)}px`, top: `${rect.top - 6}px`,
      width: `${Math.min(window.innerWidth - 8, rect.width + 12)}px`, height: `${rect.height + 12}px`
    });
    if (this.step > 0 && this.contentPosition) {
      this.card.style.left = `${this.contentPosition.left}px`;
      this.card.style.top = `${this.contentPosition.top}px`;
      return;
    }
    const mobile = window.innerWidth <= 600;
    this.card.style.left = `${mobile ? 12 : Math.max(12, Math.min(window.innerWidth - this.card.offsetWidth - 20, rect.right - this.card.offsetWidth))}px`;
    this.card.style.top = `${Math.max(12, Math.min(mobile ? Infinity : rect.bottom + 20, window.innerHeight - this.card.offsetHeight - 16))}px`;
  }
}
