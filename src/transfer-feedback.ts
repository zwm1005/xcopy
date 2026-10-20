import type { TransferItem } from './types/transfer.js';
import { activeTransfer } from './transfer-progress.js';

export interface TransferFeedbackEvent {
  kind: 'received' | 'receiving' | 'sent' | 'partial' | 'cancelled';
  key: string;
  items: TransferItem[];
}

/** Observe actual lifecycle states, not render counts or 100% byte progress. */
export class TransferFeedback {
  private received = new WeakSet<TransferItem>();
  private started = new WeakSet<TransferItem>();
  private firstSeen = new WeakMap<TransferItem, number>();
  private results = new Map<string, string>();
  collect(items: TransferItem[], now = Date.now()): TransferFeedbackEvent[] {
    const events: TransferFeedbackEvent[] = [];
    const batches = new Map<string, TransferItem[]>();
    for (const item of items) {
      if (item.shareId) {
        continue;
      }
      if (item.incoming) {
        if (item.kind === 'text') {
          continue;
        }
        if (item.status === 'completed' && item.verified && !this.received.has(item)) {
          this.received.add(item);
          events.push({ kind: 'received', key: item.localId, items: [item] });
        }
        if (!this.firstSeen.has(item)) {
          this.firstSeen.set(item, now);
        }
        if (activeTransfer(item) && now - this.firstSeen.get(item)! >= 1000 && !this.started.has(item)) {
          this.started.add(item);
          events.push({ kind: 'receiving', key: item.localId, items: [item] });
        }
        continue;
      }
      const key = item.batchId || item.groupId || item.localId;
      const batch = batches.get(key) || [];
      batch.push(item);
      batches.set(key, batch);
    }
    for (const [key, batch] of batches) {
      if (batch.some(activeTransfer)) {
        continue;
      }
      const signature = batch.map(item => `${item.localId}:${item.id}:${item.status}`).join('|');
      if (this.results.get(key) === signature) {
        continue;
      }
      this.results.set(key, signature);
      const success = batch.every(item => item.status === 'completed');
      const cancelled = batch.every(item => item.status === 'cancelled');
      events.push({ kind: success ? 'sent' : cancelled ? 'cancelled' : 'partial', key, items: batch });
    }
    for (const key of this.results.keys()) {
      if (!batches.has(key)) {
        this.results.delete(key);
      }
    }
    return events;
  }
}
