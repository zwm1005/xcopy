import type { Device } from './device.js';

export type TransferStatus = 'queued' | 'waiting' | 'transferring' | 'completed' | 'failed' | 'cancelled';
export type TerminalStatus = Extract<TransferStatus, 'completed' | 'failed' | 'cancelled'>;
export type Source = { kind: 'text'; text: string } | { kind: 'file' | 'image'; file: File };
export interface Metadata { kind: 'text' | 'image' | 'file'; name: string; size: number; mime: string; shareId?: string; claimId?: string; shareIndex?: number }
export interface IceOptions { iceServers: RTCIceServer[]; forceRelay: boolean; directOnly?: boolean; maxRelayFileBytes?: number }
export interface TransferOffer extends IceOptions { id: string; peerId: string; peerName: string; metadata: Metadata }
export interface TransferGroup { id: string; peers: Device[]; sourceCount: number }
export interface IncrementalHash { update(data: Uint8Array): IncrementalHash; digest(): Uint8Array; destroy(): void }
export interface TransferItem extends Metadata {
  shareIndex: number; shareAttempt?: number; localId: string; id?: string; status: TransferStatus; bytes: number; activity: number;
  route: '' | 'direct' | 'relay'; chunks: ArrayBuffer[]; parts: Blob[]; candidates: RTCIceCandidateInit[];
  incoming: boolean; peerId: string; peerName: string; groupId?: string; sourceIndex: number;
  shareOpen?: boolean; starting?: boolean; lastPulseBytes?: number;
  source?: Source | null; blob?: Blob | null; text?: string; reason: string; reasonKey?: string; reasonParams?: Record<string, string | number>;
  iceServers?: RTCIceServer[]; forceRelay?: boolean; directOnly?: boolean; maxRelayFileBytes?: number;
  pc?: RTCPeerConnection; channel?: RTCDataChannel; hash?: IncrementalHash; chunkBytes: number;
  opening?: Promise<void>; receiveQueue?: Promise<void>; signalQueue?: Promise<void>;
  receivingEnd?: boolean; verified?: boolean; url?: string; downloadStarted?: boolean; imageCopied?: boolean; copying?: boolean;
}
export type Signal = { description: RTCSessionDescriptionInit; candidate?: never } | { candidate: RTCIceCandidateInit; description?: never };
