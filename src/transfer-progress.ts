import type { TransferItem } from './types/transfer.js';
import { t } from './i18n/index.js';
import { sizeLabel } from './i18n/format.js';
import { text } from './dom.js';

export const activeTransfer = (item: TransferItem) => !['completed', 'failed', 'cancelled'].includes(item.status);
export function transferredBytes(item: TransferItem): number {
  if (item.status === 'completed') {
    return item.size;
  }
  return Math.min(item.size, Math.max(0, item.bytes - (item.incoming ? 0 : item.channel?.bufferedAmount || 0)));
}

/** Three-second rolling window; each retry has its own TransferItem and samples. */
export class SpeedSampler {
  private samples = new WeakMap<TransferItem, { points: { time: number; bytes: number }[]; moved: number }>();
  sample(item: TransferItem, now = performance.now()) {
    if (item.status !== 'transferring' || item.kind === 'text') {
      item.speed = undefined;
      item.stalled = false;
      this.samples.delete(item);
      return;
    }
    const bytes = transferredBytes(item);
    let state = this.samples.get(item);
    if (!state) {
      state = { points: [{ time: now, bytes }], moved: now };
      this.samples.set(item, state);
      item.speed = undefined;
      item.stalled = false;
      return;
    }
    const last = state.points[state.points.length - 1];
    const monotonicBytes = Math.max(last.bytes, bytes);
    if (monotonicBytes > last.bytes) {
      state.moved = now;
    }
    if (now <= last.time) {
      return;
    }
    state.points.push({ time: now, bytes: monotonicBytes });
    while (state.points.length > 2 && state.points[1].time <= now - 3000) {
      state.points.shift();
    }
    const first = state.points[0];
    item.speed = now - first.time >= 1000 ? (monotonicBytes - first.bytes) * 1000 / (now - first.time) : undefined;
    item.stalled = now - state.moved >= 5000;
  }
}

export function speedLabel(items: TransferItem[]): string {
  const active = items.filter(item => item.kind !== 'text' && item.status === 'transferring');
  if (!active.length) {
    return '';
  }
  if (active.every(item => transferredBytes(item) >= item.size)) {
    return t(active[0].incoming ? 'progress.verifying' : 'progress.awaiting.confirmation');
  }
  if (active.every(item => item.stalled)) {
    return t('progress.stalled');
  }
  if (active.every(item => item.speed === undefined)) {
    return t('progress.calculating');
  }
  return `${sizeLabel(active.reduce((sum, item) => sum + (item.speed || 0), 0))}/s`;
}

export function progressMetrics(items: TransferItem[], total = items.reduce((sum, item) => sum + item.size, 0), bytes = items.reduce((sum, item) => sum + transferredBytes(item), 0), incoming = items[0]?.incoming || false) {
  const box = document.createElement('div');
  box.className = 'qt-transfer-metrics';
  const amount = document.createElement('span');
  box.append(amount);
  updateProgressMetrics(box, items, total, bytes, incoming);
  return box;
}

export function updateProgressMetrics(box: HTMLElement, items: TransferItem[], total = items.reduce((sum, item) => sum + item.size, 0), bytes = items.reduce((sum, item) => sum + transferredBytes(item), 0), incoming = items[0]?.incoming || false) {
  text(box.firstChild!, t(incoming ? 'progress.received.bytes' : 'progress.sent.bytes', { done: sizeLabel(Math.min(bytes, total)), total: sizeLabel(total) }));
  const label = speedLabel(items);
  let speed = box.querySelector<HTMLElement>('[data-transfer-speed]');
  if (label) {
    if (!speed) {
      speed = document.createElement('span');
      speed.className = 'qt-transfer-speed';
      speed.dataset.transferSpeed = '';
      box.append(speed);
    }
    text(speed, label);
  } else {
    speed?.remove();
  }
}

export function updateMeter(meter: HTMLProgressElement, value: number) {
  if (meter.value !== value) {
    meter.value = value;
  }
}
