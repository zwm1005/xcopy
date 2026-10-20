import type { ClientLimits, Device, Peer, Reception, PairRequest, PairResult } from './device.js';
import type { ShareSnapshot, ShareMode } from './share.js';
import type { IceOptions, Metadata, Signal, TerminalStatus, TransferOffer, TransferStatus } from './transfer.js';

export interface Ready {
  device: Device; sessionId: string; resumed: boolean; peers: Peer[]; config: ClientLimits;
  tasks: { id: string; status: TransferStatus }[]; reception?: Reception;
}
type Empty = Record<string, never>;
type Method<Input, Output> = { input: Input; output: Output };
export interface RpcMap {
  'auth.begin': Method<{ publicKey: string; name: string }, { challenge: string; fingerprint: string }>;
  'auth.finish': Method<{ signature: string; resumeSession: string | null }, Ready>;
  'guest.open': Method<{ resumeSession: string | null; name: string; shareProtocol: number }, Ready>;
  'device.rename': Method<{ name: string }, Empty>;
  'pair.code': Method<undefined, { code: string; expires: number }>;
  'pair.join': Method<{ code: string }, { id: string }>;
  'pair.cancel': Method<{ id: string }, Empty>;
  'pair.respond': Method<{ id: string; allow: boolean }, Empty>;
  'pair.forget': Method<{ peerId: string }, Empty>;
  'transfer.start': Method<{ peerId: string; metadata: Metadata }, { id: string } & IceOptions>;
  'transfer.accept': Method<{ id: string }, Empty>;
  'transfer.progress': Method<{ id: string }, Empty>;
  'transfer.end': Method<{ id: string; status: TerminalStatus; reasonCode?: string }, Empty>;
  'signal': Method<{ id: string; signal: Signal }, Empty>;
  'share.create': Method<{ requestId: string; minutes: number; mode: ShareMode; shareProtocol: number; files: { name: string; size: number; mime: string }[] }, ShareSnapshot>;
  'share.list': Method<{ limit?: number; cursor?: string; requestId?: string } | undefined, { shares: ShareSnapshot[]; maxShareFiles: number; maxShareBytes: number | null; shareProtocol: number; nextCursor?: string | null; hasMore?: boolean }>;
  'share.inspect': Method<{ token: string }, ShareSnapshot>;
  'share.claim': Method<{ token: string; name: string }, ShareSnapshot>;
  'share.retry': Method<{ id: string; claimId?: string }, ShareSnapshot>;
  'share.claim.cancel': Method<{ id: string; claimId?: string }, ShareSnapshot>;
  'share.cancel': Method<{ id: string }, ShareSnapshot>;
  'share.stop': Method<{ id: string }, ShareSnapshot>;
  'share.file.start': Method<{ id: string; claimId?: string; index: number }, { id: string } & IceOptions>;
}
export type RpcName = keyof RpcMap;
export type RpcInput<K extends RpcName> = RpcMap[K]['input'];
export type RpcOutput<K extends RpcName> = RpcMap[K]['output'];
export type RpcArgs<K extends RpcName> = undefined extends RpcInput<K> ? [] | [RpcInput<K>] : [RpcInput<K>];
export interface ConnectionEvents {
  ready: Ready;
  peers: { peers: Peer[]; name: string; reception?: Reception };
  connecting: Empty; disconnected: Empty;
  notice: { message: string }; fatal: { message: string };
  'pair.request': PairRequest; 'pair.result': PairResult; 'pair.codeExpired': { code: string };
  'transfer.offer': TransferOffer;
  'transfer.accepted': { id: string };
  'transfer.state': { id: string; status: TerminalStatus; reason?: string; reasonKey?: string; reasonParams?: Record<string, string | number> };
  signal: { id: string; signal: Signal };
  'share.state': ShareSnapshot;
  'share.claimed': { id: string; claimId: string };
  'share.retry': { id: string; claimId: string };
}
