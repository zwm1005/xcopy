import { t, onLocaleChange } from './i18n/index.js';
import { messageText } from './i18n/errors.js';

export interface Notice {
  key: string;
  content: () => { title: string; description?: string; actionLabel?: string };
  action?: () => void;
  valid?: () => boolean;
  tone?: 'success' | 'warning' | 'info';
  plain?: boolean;
}

export function locateRecord(record: HTMLElement | null) {
  if (!record) {
    return;
  }
  record.tabIndex = -1;
  record.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  record.focus({ preventScroll: true });
  highlightRecord(record, Date.now() + 2200);
}

function highlightRecord(record: HTMLElement, until: number) {
  record.dataset.locatedUntil = String(until);
  record.classList.add('qt-record-highlight');
  setTimeout(() => record.classList.remove('qt-record-highlight'), Math.max(0, until - Date.now()));
}

/** Progress updates replace records; retain the destination without scrolling again. */
export function preserveRecordLocation(container: HTMLElement) {
  const record = container.querySelector<HTMLElement>('.qt-record-highlight, [data-transfer]:focus, [data-group]:focus, [data-share-record]:focus');
  const attribute = ['data-transfer', 'data-group', 'data-share-record'].find(key => record?.hasAttribute(key));
  const selector = attribute ? `[${attribute}="${CSS.escape(record!.getAttribute(attribute)!)}"]` : '.share-panel';
  const until = Number(record?.dataset.locatedUntil || 0);
  const focused = record === document.activeElement;
  return () => {
    if (!record || (!focused && until <= Date.now())) {
      return;
    }
    const replacement = container.querySelector<HTMLElement>(selector);
    if (replacement) {
      replacement.tabIndex = -1;
      if (until > Date.now()) {
        highlightRecord(replacement, until);
      }
      if (focused) {
        replacement.focus({ preventScroll: true });
      }
    }
  };
}

/** A single, non-modal notification surface. Transfer outcomes are queued, not overwritten. */
export class Notices {
  private queue: Notice[] = [];
  private current?: Notice;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private host: HTMLElement) {
    host.addEventListener('mouseenter', () => clearTimeout(this.timer));
    host.addEventListener('focusin', () => clearTimeout(this.timer));
    host.addEventListener('mouseleave', () => this.resume());
    host.addEventListener('focusout', () => this.resume());
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.timer);
      if (!document.hidden) {
        this.resume();
      }
    });
    onLocaleChange(() => this.render());
  }
  message(message: string) {
    if (this.current && !this.current.plain) {
      this.queue.unshift(this.current);
    }
    this.current = { key: 'message', content: () => ({ title: messageText(message) }), plain: true };
    this.render();
  }
  push(notice: Notice) {
    if (notice.valid && !notice.valid()) {
      return;
    }
    if (this.current?.key === notice.key) {
      this.current = notice;
      this.render();
      return;
    }
    const existing = this.queue.findIndex(entry => entry.key === notice.key);
    if (existing >= 0) {
      this.queue[existing] = notice;
    }
    else {
      this.queue.push(notice);
    }
    if (!this.current) {
      this.next();
    }
  }
  remove(key: string) {
    this.queue = this.queue.filter(notice => notice.key !== key);
    if (this.current?.key === key) {
      this.next();
    }
  }
  prune() {
    this.queue = this.queue.filter(notice => !notice.valid || notice.valid());
    if (this.current?.valid && !this.current.valid()) {
      this.next();
    }
  }
  next() {
    clearTimeout(this.timer);
    this.current = this.queue.shift();
    while (this.current?.valid && !this.current.valid()) {
      this.current = this.queue.shift();
    }
    this.render();
  }
  private resume() {
    clearTimeout(this.timer);
    if (this.current && !document.hidden && !this.host.matches(':hover') && !this.host.contains(document.activeElement)) {
      this.timer = setTimeout(() => this.next(), this.current.plain ? 5000 : 6000);
    }
  }
  private render() {
    clearTimeout(this.timer);
    const notice = this.current;
    this.host.hidden = !notice;
    if (!notice) {
      this.host.replaceChildren();
      return;
    }
    const focus = (document.activeElement as HTMLElement | null)?.dataset.noticeControl;
    const content = notice.content();
    this.host.classList.toggle('qt-notice', !notice.plain);
    this.host.dataset.noticeKind = notice.tone || 'info';
    this.host.dataset.noticeKey = notice.key;
    if (notice.plain) {
      this.host.textContent = content.title;
      this.resume();
      return;
    }
    const icon = document.createElement('span');
    icon.className = 'qt-notice-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = notice.tone === 'success' ? '✓' : notice.tone === 'warning' ? '!' : '…';
    const copy = document.createElement('div');
    copy.className = 'qt-notice-copy';
    const title = document.createElement('div');
    title.className = 'qt-notice-title';
    title.textContent = content.title;
    copy.append(title);
    if (content.description) {
      const description = document.createElement('div');
      description.className = 'qt-notice-description';
      description.textContent = content.description;
      copy.append(description);
    }
    this.host.replaceChildren(icon, copy);
    if (notice.action && content.actionLabel) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'qt-text-button qt-notice-view';
      view.dataset.noticeControl = 'view';
      view.textContent = content.actionLabel;
      view.addEventListener('click', () => {
        this.next();
        notice.action?.();
      });
      this.host.append(view);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'qt-notice-close';
    close.dataset.noticeControl = 'close';
    close.setAttribute('aria-label', t('feedback.dismiss'));
    close.textContent = '×';
    close.addEventListener('click', () => this.next());
    this.host.append(close);
    if (focus) {
      this.host.querySelector<HTMLElement>(`[data-notice-control="${focus}"]`)?.focus({ preventScroll: true });
    }
    this.resume();
  }
}
