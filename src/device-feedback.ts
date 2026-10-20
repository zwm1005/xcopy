import type { TransferItem } from './types/transfer.js';
import { t } from './i18n/index.js';
import { sizeLabel } from './i18n/format.js';
import { Notices, locateRecord } from './notices.js';
import { TransferFeedback } from './transfer-feedback.js';
import { activeTransfer } from './transfer-progress.js';

interface Options {
  root: HTMLElement;
  notices: Notices;
  items: () => TransferItem[];
  visible: () => boolean;
  open: () => void;
  changed: () => void;
}

export class DeviceFeedback {
  readonly unread = new Set<string>();
  private observer = new TransferFeedback();
  private seenSince = new Map<string, number>();
  private receipts: TransferItem[] = [];
  private receiptTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: Options) {
    setInterval(() => this.readVisible(), 1000);
    document.addEventListener('visibilitychange', () => {
      this.seenSince.clear();
      this.badge();
    });
  }
  update() {
    const { items, notices } = this.options;
    const current = items();
    notices.prune();
    for (const item of current) {
      if (!activeTransfer(item)) {
        notices.remove(`receiving:${item.localId}`);
      }
    }
    for (const id of this.unread) {
      if (!current.some(item => item.localId === id)) {
        this.unread.delete(id);
        this.seenSince.delete(id);
      }
    }
    for (const event of this.observer.collect(current)) {
      const item = event.items[0];
      if (event.kind === 'received') {
        this.unread.add(item.localId);
        notices.remove(`receiving:${item.localId}`);
        this.receipts.push(item);
        if (!this.receiptTimer) {
          // Batch files that arrive together without postponing feedback indefinitely.
          this.receiptTimer = setTimeout(() => this.flushReceipts(), 1800);
        }
      }
      else if (event.kind === 'receiving') {
        notices.push({
          key: `receiving:${item.localId}`, tone: 'info',
          content: () => ({ title: t(item.kind === 'text' ? 'feedback.receiving.content' : 'feedback.receiving'), description: `${item.peerName} · ${item.name}`, actionLabel: t('feedback.view') }),
          valid: () => items().includes(item) && activeTransfer(item),
          action: () => this.view([item])
        });
      }
      else {
        const success = event.kind === 'sent';
        const devices = new Set(event.items.map(entry => entry.peerId));
        const delivered = [...devices].filter(id => event.items.filter(entry => entry.peerId === id).every(entry => entry.status === 'completed')).length;
        const count = new Set(event.items.map(entry => entry.sourceIndex)).size;
        const onlyFiles = event.items.every(entry => entry.kind !== 'text');
        notices.push({
          key: `sent:${event.key}`, tone: success ? 'success' : 'warning',
          content: () => ({
            title: t(success ? devices.size > 1 ? 'feedback.all.sent' : 'feedback.sent' : event.kind === 'cancelled' ? 'feedback.cancelled' : 'feedback.partial'),
            description: success
              ? devices.size > 1
                ? t(onlyFiles ? 'feedback.files.broadcast' : 'feedback.content.broadcast', { count, devices: devices.size })
                : t(onlyFiles ? 'feedback.files.sent' : 'feedback.content.sent', { count, name: item.peerName })
              : devices.size > 1
              ? t('feedback.devices.delivered', { done: delivered, total: devices.size })
              : `${item.peerName} · ${t('feedback.items.delivered', { done: event.items.filter(entry => entry.status === 'completed').length, total: event.items.length })}`,
            actionLabel: t('feedback.view.record')
          }),
          valid: () => event.items.some(entry => items().includes(entry)),
          action: () => this.view(event.items)
        });
      }
    }
    this.badge();
  }
  markRead(item?: TransferItem) {
    if (item && this.unread.delete(item.localId)) {
      this.seenSince.delete(item.localId);
      this.badge();
    }
  }
  private flushReceipts() {
    this.receiptTimer = undefined;
    const items = this.receipts.filter(item => this.options.items().includes(item));
    this.receipts = [];
    if (!items.length) {
      return;
    }
    const hasFiles = items.some(item => item.kind !== 'text');
    const hasText = items.some(item => item.kind === 'text');
    this.options.notices.push({
      key: `received:${items[0].localId}`, tone: 'success',
      content: () => ({
        title: t(hasText ? hasFiles ? 'feedback.received.content' : 'feedback.received.text' : 'feedback.received', { count: items.length }),
        description: [
          t('feedback.received.from', { name: [...new Set(items.map(item => item.peerName))].join('、'), size: sizeLabel(items.reduce((sum, item) => sum + item.size, 0)) }),
          ...(hasFiles ? [t('feedback.save.reminder')] : [])
        ].join(' · '),
        actionLabel: t(hasText ? 'feedback.view.content' : 'feedback.view.files')
      }),
      valid: () => items.some(item => this.options.items().includes(item)),
      action: () => this.view(items)
    });
  }
  private view(items: TransferItem[]) {
    const current = items.filter(item => this.options.items().includes(item));
    const item = current.find(item => this.unread.has(item.localId)) || current[0];
    if (!item) {
      return;
    }
    this.markRead(item);
    this.options.open();
    this.options.changed();
    const selector = item.groupId ? `[data-group="${CSS.escape(item.groupId)}"]` : `[data-transfer="${CSS.escape(item.localId)}"]`;
    locateRecord(this.options.root.querySelector<HTMLElement>(selector));
  }
  private badge() {
    const count = this.unread.size;
    const badge = this.options.root.querySelector<HTMLElement>('[data-new-file-count]');
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.setAttribute('aria-label', t('feedback.unread', { count }));
      badge.setAttribute('aria-hidden', 'true');
      badge.parentElement?.setAttribute('aria-description', count ? t('feedback.unread', { count }) : '');
    }
    const title = t('page.xcopy.cross.device.transfers');
    document.title = document.hidden && count ? `(${count}) ${title}` : title;
  }
  private readVisible() {
    if (document.hidden || !this.options.visible()) {
      this.seenSince.clear();
      return;
    }
    let changed = false;
    for (const id of this.unread) {
      const row = this.options.root.querySelector<HTMLElement>(`[data-transfer="${CSS.escape(id)}"]`);
      const rect = row?.getBoundingClientRect();
      if (!rect || rect.height === 0 || rect.top < 0 || rect.bottom > innerHeight) {
        this.seenSince.delete(id);
        continue;
      }
      const since = this.seenSince.get(id);
      if (since === undefined) {
        this.seenSince.set(id, Date.now());
      }
      else if (Date.now() - since >= 2000) {
        this.unread.delete(id);
        this.seenSince.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.options.changed();
    }
  }
}
