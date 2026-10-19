export interface Device { id: string; name: string }
export interface Peer extends Device { online: boolean; busy: number; lastUsed?: number }
export interface Identity { privateKey: CryptoKey; publicKey: string; fingerprint: string }
export interface Reception { here: boolean; pages: number }
export interface Attachment { id: string; file: File; url: string | null; kind: 'image' | 'file' }
export interface PairRequest { id: string; name: string; fingerprint: string }
export type PairResult = { id: string; status: 'paired' | 'denied' | 'expired' | 'cancelled' };
export interface ClientLimits {
  maxFileBytes: number;
  maxRelayFileBytes?: number;
  maxTextBytes: number;
  forceRelay?: boolean;
  hasTurn?: boolean;
  maxShareFiles?: number;
  maxShareBytes?: number | null;
  shareProtocol?: number;
}
