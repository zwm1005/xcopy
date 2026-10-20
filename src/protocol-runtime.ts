import { t } from './i18n/index.js';
import type { ConnectionEvents, RpcName, RpcOutput } from './types/protocol.js';
export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const boolean = (v: unknown): boolean => typeof v === 'boolean';
const params = (v: unknown): boolean => record(v) && Object.values(v).every(value => text(value) || (typeof value === 'number' && Number.isFinite(value)));
const reason = (v: Record<string, unknown>): boolean => optional(v.reason, text) && optional(v.reasonKey, text) && optional(v.reasonParams, params);
const reception = (v: unknown): boolean => record(v) && boolean(v.here) && number(v.pages);
const arrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const device = (v: unknown): boolean => record(v) && text(v.id) && text(v.name);
const peer = (v: unknown): boolean => device(v) && record(v) && typeof v.online === 'boolean' && number(v.busy);
const task = (v: unknown): boolean => record(v) && text(v.id) && ['waiting', 'queued', 'transferring', 'completed', 'failed', 'cancelled'].includes(String(v.status));
const metadata = (v: unknown): boolean => record(v) && text(v.name) && number(v.size) && v.size >= 0 && text(v.mime);
const claim = (v: unknown): boolean => record(v) && text(v.id) && text(v.recipientName) && number(v.position) && number(v.attempt) && number(v.acceptedAt) && number(v.deadline) && reason(v)
    && ['queued', 'transferring', 'retryable', 'completed', 'cancelled', 'expired', 'unavailable'].includes(String(v.state))
    && arrayOf(v.files, (f) => record(f) && number(f.index) && typeof f.completed === 'boolean');
const share = (v: unknown): boolean => record(v) && text(v.id) && ['single', 'multiple'].includes(String(v.mode))
    && ['ready', 'claimed', 'draining', 'completed', 'cancelled', 'expired', 'unavailable', 'stopped'].includes(String(v.status))
    && number(v.expires) && number(v.totalBytes) && text(v.senderName) && typeof v.accepting === 'boolean'
    && typeof v.senderOnline === 'boolean' && typeof v.mine === 'boolean'
    && arrayOf(v.files, (f) => metadata(f) && record(f) && number(f.index) && typeof f.completed === 'boolean')
    && optional(v.counts, c => record(c) && ['completed', 'failed', 'active', 'queued', 'retryable'].every(key => number(c[key])))
    && optional(v.token, text) && (v.requestId === null || optional(v.requestId, text)) && optional(v.recipientName, text) && optional(v.historyLimit, number)
    && (v.myClaim === undefined || claim(v.myClaim)) && (v.claims === undefined || arrayOf(v.claims, claim));
const ice = (v: unknown): boolean => record(v) && text(v.id) && boolean(v.forceRelay) && optional(v.directOnly, boolean) && optional(v.maxRelayFileBytes, number) && Array.isArray(v.iceServers) && v.iceServers.every((s: unknown) => record(s)
    && (text(s.urls) || arrayOf(s.urls, text)) && (s.username === undefined || text(s.username)) && (s.credential === undefined || text(s.credential)));
const ready = (v: unknown): boolean => record(v) && device(v.device) && text(v.sessionId) && typeof v.resumed === 'boolean'
    && arrayOf(v.peers, peer) && arrayOf(v.tasks, task) && record(v.config) && number(v.config.maxFileBytes) && number(v.config.maxTextBytes) && optional(v.config.maxRelayFileBytes, number) && optional(v.config.forceRelay, boolean) && optional(v.config.hasTurn, boolean) && optional(v.reception, reception);
const signal = (v: unknown): boolean => record(v) && ((record(v.description) && ['offer', 'answer'].includes(String(v.description.type)) && text(v.description.sdp))
    || (record(v.candidate) && text(v.candidate.candidate)));
const replyChecks: Record<RpcName, (value: unknown) => boolean> = {
    'auth.begin': (v) => record(v) && text(v.challenge) && text(v.fingerprint),
    'auth.finish': ready, 'guest.open': ready,
    'device.rename': record,
    'pair.code': (v) => record(v) && text(v.code) && number(v.expires),
    'pair.join': (v) => record(v) && text(v.id),
    'pair.cancel': record, 'pair.respond': record, 'pair.forget': record,
    'transfer.start': ice, 'transfer.accept': record, 'transfer.progress': record, 'transfer.end': record, signal: record,
    'share.create': share, 'share.inspect': share, 'share.claim': share, 'share.retry': share,
    'share.claim.cancel': share, 'share.cancel': share, 'share.stop': share, 'share.file.start': ice,
    'share.list': (v) => record(v) && Array.isArray(v.shares) && arrayOf(v.shares, share) && v.shares.length <= 50 && number(v.maxShareFiles) && (v.maxShareBytes === null || number(v.maxShareBytes)) && number(v.shareProtocol)
        && optional(v.hasMore, boolean) && (v.nextCursor === null || optional(v.nextCursor, text)),
};
export function parseReply<K extends RpcName>(method: K, value: unknown): RpcOutput<K> {
    if (!replyChecks[method](value)) {
        throw new Error(t("connection.invalid.server.response.please.try.again"));
    }
    // The method-specific runtime guard is the only network-to-domain assertion.
    return value as RpcOutput<K>;
}
const eventChecks: Partial<Record<keyof ConnectionEvents, (value: unknown) => boolean>> = {
    peers: (v) => record(v) && arrayOf(v.peers, peer) && text(v.name) && optional(v.reception, reception),
    'pair.request': (v) => record(v) && text(v.id) && text(v.name) && text(v.fingerprint),
    'pair.result': (v) => record(v) && text(v.id) && ['paired', 'denied', 'expired', 'cancelled'].includes(String(v.status)),
    'pair.codeExpired': (v) => record(v) && text(v.code),
    'transfer.offer': (v) => ice(v) && record(v) && text(v.peerId) && text(v.peerName) && metadata(v.metadata) && record(v.metadata) && ['text', 'file', 'image'].includes(String(v.metadata.kind)),
    'transfer.accepted': (v) => record(v) && text(v.id),
    'transfer.state': (v) => record(v) && task(v) && ['completed', 'failed', 'cancelled'].includes(String(v.status)) && reason(v),
    signal: (v) => record(v) && text(v.id) && signal(v.signal),
    'share.state': share,
    'share.claimed': (v) => record(v) && text(v.id) && text(v.claimId),
    'share.retry': (v) => record(v) && text(v.id) && text(v.claimId),
};
export function isServerEvent(type: string, value: unknown): boolean {
    const check = Object.hasOwn(eventChecks, type) ? eventChecks[type as keyof ConnectionEvents] : undefined;
    return check ? check(value) : false;
}
