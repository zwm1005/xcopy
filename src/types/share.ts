import type { Attachment } from './device.js';
import type { Connection } from '../connection.js';
import type { Transfers } from '../transfer.js';

export type ShareMode = 'single' | 'multiple';
export type ShareStatus = 'ready' | 'claimed' | 'draining' | 'completed' | 'cancelled' | 'expired' | 'unavailable' | 'stopped';
export type ClaimState = 'queued' | 'transferring' | 'retryable' | 'completed' | 'cancelled' | 'expired' | 'unavailable';
export interface ShareFile { name: string; size: number; mime: string; index: number; completed: boolean; kind?: 'file' }
export interface Claim {
  id: string; state: ClaimState; recipientName: string; acceptedAt: number; deadline: number;
  position: number; attempt: number; files: { index: number; completed: boolean }[]; reason: string;
  reasonKey?: string; reasonParams?: Record<string, string | number>;
}
export interface ShareSnapshot {
  id: string; mode: ShareMode; status: ShareStatus; expires: number; accepting: boolean;
  senderOnline: boolean; senderName: string; mine: boolean; totalBytes: number;
  files: ShareFile[]; recipientName?: string; myClaim?: Claim; claims?: Claim[];
  token?: string; requestId?: string | null; historyLimit?: number;
  counts?: { completed: number; failed: number; active: number; queued: number; retryable: number };
}
export interface ShareEntry extends ShareSnapshot { sources: File[] }
export interface ShareComposerOptions {
  root: HTMLElement; connection: Connection; transfers: Transfers;
  files: () => Attachment[]; pick: () => void; remove: (id: string) => void;
  consumeFiles: (ids: string[]) => void; addFiles: (files: File[]) => void;
  tell: (message: string) => void; changed: () => void;
  received?: (entry: ShareEntry, claim?: Claim) => void;
}
