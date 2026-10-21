import { describeMessage } from './i18n/errors.js';
import { t } from './i18n/index.js';
import { record } from './protocol-runtime.js';
import type { Connection } from './connection.js';
import type { Device, Peer } from './types/device.js';
import type { Claim, ShareSnapshot } from './types/share.js';
import type { TransferItem, TransferGroup, TransferOffer, Source, Signal, TransferStatus, TerminalStatus, Metadata } from './types/transfer.js';
import { errorValue } from './dom.js';
import { sha256 } from './vendor/noble-hashes/sha2.js';
import { SpeedSampler } from './transfer-progress.js';
const ended = { has: (status: TransferStatus): status is TerminalStatus => ['completed', 'failed', 'cancelled'].includes(status) };
const chunkSize = 16384;
const blockSize = 1024 * 1024;
const safeImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export class Transfers extends EventTarget {
    connection: Connection;
    items: TransferItem[] = [];
    groups: TransferGroup[] = [];
    peers: Peer[] = [];
    queue: TransferItem[] = [];
    running = new Set<TransferItem>();
    byId = new Map<string, TransferItem>();
    pendingEnds = new Map<string, {
        status: TerminalStatus;
        reasonCode?: string;
    }>();
    maintenance: ReturnType<typeof setInterval>;
    changeTimer: ReturnType<typeof setTimeout> | null = null;
    pumpScheduled = false;
    lastQueuePeer = '';
    private speedSampler = new SpeedSampler();
    constructor(connection: Connection) {
        super();
        this.connection = connection;
        this.items = [];
        this.groups = [];
        this.peers = [];
        this.queue = [];
        this.running = new Set();
        this.byId = new Map();
        this.pendingEnds = new Map();
        connection.addEventListener('transfer.offer', (e) => this.receive(e.detail));
        connection.addEventListener('transfer.accepted', (e) => {
            const item = this.byId.get(e.detail.id);
            if (item) {
                this.beginOffer(item).catch((error) => this.fail(item, error.message, error.code));
            }
        });
        connection.addEventListener('signal', (e) => {
            const item = this.byId.get(e.detail.id);
            if (item && !ended.has(item.status)) {
                item.signalQueue = (item.signalQueue || Promise.resolve()).then(() => this.signal(item, e.detail.signal)).catch((error) => this.fail(item, error.message, error.code));
            }
        });
        connection.addEventListener('transfer.state', (e) => {
            const item = this.byId.get(e.detail.id);
            if (item && !ended.has(item.status)) {
                if (e.detail.status === 'completed' && item.incoming && !item.verified) {
                    this.fail(item, t("transfer.content.verification.is.incomplete"));
                    return;
                }
                this.finishLocal(item, e.detail.status, e.detail.reason);
            }
        });
        connection.addEventListener('ready', (e) => {
            const { resumed, tasks } = e.detail;
            this.updatePeers(e.detail.peers);
            for (const item of this.items) {
                if (ended.has(item.status) || item.status === 'queued') {
                    continue;
                }
                const remote = tasks.find((t) => t.id === item.id);
                if (!resumed || !remote) {
                    this.fail(item, t("transfer.connection.reset.please.send.again"));
                }
                else if (ended.has(remote.status)) {
                    this.finishLocal(item, remote.status);
                }
            }
            for (const [id, result] of this.pendingEnds) {
                if (resumed && tasks.some((t) => t.id === id && !ended.has(t.status))) {
                    this.endRemote(id, result.status, result.reasonCode);
                }
                else {
                    this.pendingEnds.delete(id);
                }
            }
            this.schedulePump();
        });
        connection.addEventListener('peers', (e) => this.updatePeers(e.detail.peers));
        let lastMaintenance = Date.now();
        this.maintenance = setInterval(() => {
            let active = false;
            for (const item of this.items) {
                this.speedSampler.sample(item);
                active ||= !ended.has(item.status) && item.kind !== 'text';
            }
            if (active) {
                this.changed();
            }
            if (Date.now() - lastMaintenance < 5000) {
                return;
            }
            lastMaintenance = Date.now();
            for (const item of this.items) {
                if (!ended.has(item.status) && item.status !== 'queued') {
                    if (Date.now() - item.activity > 45000) {
                        const blocked = item.directOnly && !item.route;
                        this.fail(item, blocked ? this.relayError(item).message : t("transfer.connection.or.transfer.timed.out.please.send.again"), blocked ? 'RELAY_SIZE_LIMIT' : undefined);
                    }
                    else if (item.id && item.bytes !== item.lastPulseBytes && connection.ready) {
                        item.lastPulseBytes = item.bytes;
                        connection.rpc('transfer.progress', { id: item.id }).catch(() => { });
                    }
                }
            }
        }, 1000);
    }
    changed(force = false) {
        this.schedulePump();
        if (force || !this.changeTimer) {
            clearTimeout(this.changeTimer ?? undefined);
            this.changeTimer = setTimeout(() => {
                this.changeTimer = null;
                this.dispatchEvent(new Event('change'));
            }, force ? 0 : 100);
        }
    }
    newItem(data: Partial<TransferItem> & Metadata): TransferItem {
        const item: TransferItem = { peerId: '', peerName: '', incoming: false, sourceIndex: 0, shareIndex: 0, parts: [], chunkBytes: 0, reason: '', localId: crypto.randomUUID(), status: 'waiting', bytes: 0, activity: Date.now(), route: '', chunks: [], candidates: [], ...data };
        this.items.unshift(item);
        this.changed(true);
        return item;
    }
    async send(peer: Device, source: Source) {
        return this.sendBatch([peer], [source])[0];
    }
    queuedItem(peer: Device, source: Source, extra: Partial<TransferItem> = {}): TransferItem {
        const blob = source.kind === 'text' ? new Blob([source.text], { type: 'text/plain' }) : source.file;
        return { sourceIndex: 0, shareIndex: 0, parts: [], chunkBytes: 0, reason: '', localId: crypto.randomUUID(), status: 'queued', bytes: 0, activity: Date.now(), route: '', chunks: [], candidates: [], incoming: false, peerId: peer.id, peerName: peer.name, kind: source.kind, name: source.kind === 'text' ? t("home.text") : source.file.name, size: blob.size, mime: blob.type, source, blob, ...extra };
    }
    sendBatch(peers: (Device & {
        online?: boolean;
    })[], sources: Source[], { group = false } = {}) {
        const recipients = [...new Map(peers.filter((peer) => peer.online !== false && peer.id !== this.connection.device?.id).map((peer) => [peer.id, { id: peer.id, name: peer.name }])).values()];
        if (!recipients.length || !sources.length) {
            return [];
        }
        const batch = group ? { id: crypto.randomUUID(), peers: recipients, sourceCount: sources.length } : null;
        const batchId = crypto.randomUUID();
        const items = sources.flatMap((source, sourceIndex) => recipients.map((peer) => this.queuedItem(peer, source, { groupId: batch?.id, batchId, sourceIndex })));
        if (batch) {
            this.groups.unshift(batch);
        }
        this.items.unshift(...items);
        this.queue.push(...items);
        this.changed(true);
        return items;
    }
    sendShare(share: ShareSnapshot, files: File[], claim?: Claim) {
        const items = files.flatMap((file, shareIndex) => claim?.files[shareIndex].completed ? [] : [this.queuedItem({ id: share.id, name: claim?.recipientName || t("transfer.share.by.link") }, { kind: 'file', file }, { shareId: share.id, claimId: claim?.id, shareIndex, shareOpen: true })]);
        this.items.unshift(...items);
        this.queue.push(...items);
        this.changed(true);
        return items;
    }
    updatePeers(peers: Peer[]) {
        this.peers = peers;
        for (const item of this.queue) {
            if (item.status === 'queued' && !item.shareId) {
                const peer = peers.find((p) => p.id === item.peerId);
                if (!peer?.online) {
                    this.fail(item, peer ? t("transfer.receiving.device.is.offline.retry.when.it.reconnects") : t("transfer.pairing.removed.connect.the.devices.again.before.retrying"));
                }
            }
        }
        this.schedulePump();
    }
    schedulePump() {
        if (this.pumpScheduled) {
            return;
        }
        this.pumpScheduled = true;
        queueMicrotask(() => {
            this.pumpScheduled = false;
            this.pump();
        });
    }
    pump() {
        for (const item of this.running) {
            if (ended.has(item.status) && !item.starting) {
                this.running.delete(item);
            }
        }
        if (!this.connection.ready) {
            return;
        }
        while (this.running.size < 3 && this.queue.length) {
            // 按接收会话轮转，普通设备传输也参与同一预算，避免大文件包独占队列。
            const key = (item: TransferItem) => item.claimId || item.peerId;
            const peers = [...new Set(this.queue.map(key))];
            const next = peers[(peers.indexOf(this.lastQueuePeer) + 1) % peers.length];
            const index = this.queue.findIndex((item) => key(item) === next);
            const [item] = this.queue.splice(index, 1);
            this.lastQueuePeer = key(item);
            if (item.status !== 'queued') {
                continue;
            }
            const peer = this.peers.find((p) => p.id === item.peerId);
            if (!item.shareId && !peer?.online) {
                this.fail(item, peer ? t("transfer.receiving.device.is.offline.retry.when.it.reconnects") : t("transfer.pairing.removed.connect.the.devices.again.before.retrying"));
                continue;
            }
            item.status = 'waiting';
            item.activity = Date.now();
            item.starting = true;
            this.running.add(item);
            this.start(item);
        }
    }
    async start(item: TransferItem) {
        try {
            const result = await (item.shareId ? this.connection.rpc('share.file.start', { id: item.shareId, claimId: item.claimId, index: item.shareIndex }) : this.connection.rpc('transfer.start', { peerId: item.peerId, metadata: { kind: item.kind, name: item.name, size: item.size, mime: item.mime } }));
            Object.assign(item, result);
            if (ended.has(item.status)) {
                this.endRemote(item.id, item.status);
                return;
            }
            this.byId.set(remoteId(item), item);
            this.createPeer(item);
        }
        catch (caught) {
            const error = errorValue(caught);
            this.fail(item, error.message, error.code);
        }
        finally {
            item.starting = false;
            this.changed(true);
        }
    }
    groupItems(group: TransferGroup) {
        return this.items.filter((item) => item.groupId === group.id);
    }
    cancelGroup(group: TransferGroup) {
        for (const item of this.groupItems(group)) {
            this.cancel(item);
        }
    }
    retry(item: TransferItem | undefined) {
        if (!item || item.incoming || !['failed', 'cancelled'].includes(item.status) || !this.connection.ready || !item.source) {
            return;
        }
        const peer = item.shareId ? { id: item.shareId, name: item.peerName || t("transfer.share.by.link") } : this.peers.find((p) => p.id === item.peerId && p.online);
        const index = this.items.indexOf(item);
        if (!peer || index < 0) {
            return;
        }
        const replacement = this.queuedItem(peer, item.source, { localId: item.localId, groupId: item.groupId, batchId: item.batchId, sourceIndex: item.sourceIndex, shareId: item.shareId, claimId: item.claimId, shareIndex: item.shareIndex, shareOpen: item.shareOpen });
        this.byId.delete(item.id || '');
        this.items[index] = replacement;
        this.queue.push(replacement);
        this.changed(true);
    }
    retryGroup(group: TransferGroup) {
        for (const item of this.groupItems(group)) {
            if (item.status === 'failed') {
                this.retry(item);
            }
        }
    }
    async receive(offer: TransferOffer) {
        const item = this.newItem({ ...offer.metadata, id: offer.id, peerId: offer.peerId, peerName: offer.peerName, incoming: true, iceServers: offer.iceServers, forceRelay: offer.forceRelay, directOnly: offer.directOnly, maxRelayFileBytes: offer.maxRelayFileBytes, parts: [], chunkBytes: 0, hash: sha256.create() });
        this.byId.set(remoteId(item), item);
        try {
            this.createPeer(item);
            await this.connection.rpc('transfer.accept', { id: remoteId(item) });
        }
        catch (caught) {
            const error = errorValue(caught);
            this.fail(item, error.message, error.code);
        }
    }
    relayError(item: TransferItem) {
        const max = item.maxRelayFileBytes || this.connection.config?.maxRelayFileBytes || this.connection.config?.maxFileBytes || 50 * 1048576;
        return Object.assign(new Error(t("transfer.p2p.connection.failed.relay.files.cannot.exceed.mb", { p0: max / 1048576 })), { code: 'RELAY_SIZE_LIMIT' });
    }
    createPeer(item: TransferItem) {
        const max = item.maxRelayFileBytes || this.connection.config?.maxRelayFileBytes || this.connection.config?.maxFileBytes || 50 * 1048576;
        item.directOnly = item.directOnly || item.size > max;
        if (item.directOnly && item.forceRelay) {
            throw this.relayError(item);
        }
        const iceServers = (item.iceServers || []).map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !item.directOnly || !/^turns?:/i.test(url)) })).filter((server) => server.urls.length);
        const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: item.forceRelay ? 'relay' : 'all' });
        item.pc = pc;
        pc.onicecandidate = (event) => {
            if (event.candidate && !ended.has(item.status)) {
                if (item.directOnly && /\btyp relay\b/.test(event.candidate.candidate)) {
                    return;
                }
                this.connection.rpc('signal', { id: remoteId(item), signal: { candidate: event.candidate.toJSON() } }).catch((error) => this.fail(item, error.message));
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                this.fail(item, item.directOnly ? this.relayError(item).message : t("transfer.unable.to.reach.the.other.device.check.the"), item.directOnly ? 'RELAY_SIZE_LIMIT' : undefined);
            }
        };
        if (item.incoming) {
            pc.ondatachannel = (event) => this.bindChannel(item, event.channel);
        }
        else {
            this.bindChannel(item, pc.createDataChannel('suichuan', { ordered: true }));
        }
    }
    async beginOffer(item: TransferItem) {
        if (!(item.pc)) {
            throw new Error(t("transfer.transfer.resources.are.not.ready"));
        }
        if (ended.has(item.status)) {
            return;
        }
        const description = await item.pc.createOffer();
        await item.pc.setLocalDescription(description);
        await this.connection.rpc('signal', { id: remoteId(item), signal: { description } });
    }
    async signal(item: TransferItem, signal: Signal) {
        if (!(item.pc)) {
            throw new Error(t("transfer.transfer.resources.are.not.ready"));
        }
        if (ended.has(item.status)) {
            return;
        }
        if (signal.description) {
            const description = item.directOnly ? { ...signal.description, sdp: (signal.description.sdp || '').split(/\r?\n/).filter((line) => !/^a=candidate:.*\btyp relay\b/.test(line)).join('\r\n') } : signal.description;
            await item.pc.setRemoteDescription(description);
            for (const candidate of item.candidates.splice(0)) {
                await item.pc.addIceCandidate(candidate);
            }
            if (signal.description.type === 'offer') {
                const description = await item.pc.createAnswer();
                await item.pc.setLocalDescription(description);
                await this.connection.rpc('signal', { id: remoteId(item), signal: { description } });
            }
        }
        else if (signal.candidate) {
            if (item.directOnly && /\btyp relay\b/.test(signal.candidate.candidate || '')) {
                return;
            }
            if (item.pc.remoteDescription) {
                await item.pc.addIceCandidate(signal.candidate);
            }
            else {
                item.candidates.push(signal.candidate);
            }
        }
    }
    bindChannel(item: TransferItem, channel: RTCDataChannel) {
        if (item.channel) {
            channel.close();
            return;
        }
        item.channel = channel;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = 256 * 1024;
        channel.onopen = () => {
            if (ended.has(item.status)) {
                channel.close();
                return;
            }
            item.opening = this.openChannel(item);
            item.opening.then(async () => {
                if (!item.incoming && !ended.has(item.status)) {
                    await this.sendBytes(item);
                }
            }).catch((error) => this.fail(item, error.message, error.code));
        };
        channel.onmessage = (event) => {
            item.receiveQueue = (item.receiveQueue || Promise.resolve()).then(async () => {
                await item.opening;
                await this.message(item, event.data);
            }).catch((error) => this.fail(item, error.message, error.code));
        };
        channel.onerror = () => this.fail(item, t("transfer.data.connection.error.please.try.again"));
        channel.onclose = () => {
            if (!ended.has(item.status)) {
                // Allow a previously queued final receipt / digest check to settle.
                (item.receiveQueue || Promise.resolve()).finally(() => {
                    if (!ended.has(item.status)) {
                        this.fail(item, t("transfer.data.connection.closed.please.try.again"));
                    }
                });
            }
        };
    }
    async openChannel(item: TransferItem) {
        if (!(item.pc)) {
            throw new Error(t("transfer.transfer.resources.are.not.ready"));
        }
        item.activity = Date.now();
        // 大文件仅允许直连，确认实际候选对后才发送文件内容。
        for (let attempt = 0; attempt < (item.directOnly ? 20 : 1); attempt += 1) {
            if (ended.has(item.status)) {
                return;
            }
            const selected = item.pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
            if (selected?.local?.type && selected?.remote?.type) {
                item.route = [selected.local, selected.remote].some((c) => c.type === 'relay') ? 'relay' : 'direct';
            }
            else {
                const stats = await item.pc.getStats();
                for (const report of stats.values()) {
                    const pair = report.type === 'transport' ? stats.get(report.selectedCandidatePairId) : report.type === 'candidate-pair' && (report.selected || report.nominated && report.state === 'succeeded') ? report : null;
                    if (pair) {
                        const candidates = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)];
                        if (candidates.every((candidate) => candidate?.candidateType)) {
                            item.route = candidates.some((candidate) => candidate.candidateType === 'relay') ? 'relay' : 'direct';
                            break;
                        }
                    }
                }
            }
            if (item.route || !item.directOnly) {
                break;
            }
            await pause(100);
        }
        if (ended.has(item.status)) {
            return;
        }
        if (item.directOnly && item.route !== 'direct') {
            throw this.relayError(item);
        }
        item.status = 'transferring';
        this.speedSampler.sample(item);
        this.changed(true);
    }
    async sendBytes(item: TransferItem) {
        if (!(item.blob && item.channel)) {
            throw new Error(t("transfer.transfer.resources.are.not.ready"));
        }
        const hash = sha256.create();
        try {
            for (let start = 0; start < item.size; start += blockSize) {
                if (ended.has(item.status)) {
                    return;
                }
                const buffer = new Uint8Array(await item.blob.slice(start, start + blockSize).arrayBuffer());
                hash.update(buffer);
                for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
                    while (item.channel.bufferedAmount > 512 * 1024 && !ended.has(item.status)) {
                        await pause(15);
                    }
                    if (ended.has(item.status)) {
                        return;
                    }
                    const chunk = buffer.subarray(offset, offset + chunkSize);
                    item.channel.send(chunk);
                    item.bytes = start + offset + chunk.byteLength;
                    item.activity = Date.now();
                    this.changed();
                }
            }
            if (!ended.has(item.status)) {
                item.channel.send(JSON.stringify({ type: 'end', hash: hex(hash.digest()) }));
                item.sentEnd = true;
            }
        }
        finally {
            hash.destroy();
        }
    }
    async message(item: TransferItem, data: unknown) {
        if (ended.has(item.status)) {
            return;
        }
        item.activity = Date.now();
        if (typeof data !== 'string') {
            if (!item.incoming || !(data instanceof ArrayBuffer) || data.byteLength > chunkSize || item.bytes + data.byteLength > item.size || item.receivingEnd) {
                throw new Error(t("transfer.received.data.does.not.match.the.declared.transfer"));
            }
            if (item.directOnly && item.route !== 'direct') {
                throw this.relayError(item);
            }
            if (!item.hash) {
                throw new Error(t("transfer.transfer.resources.are.not.ready"));
            }
            item.hash.update(new Uint8Array(data));
            item.chunks.push(data);
            item.chunkBytes += data.byteLength;
            if (item.chunkBytes >= blockSize) {
                item.parts.push(new Blob(item.chunks));
                item.chunks = [];
                item.chunkBytes = 0;
            }
            item.bytes += data.byteLength;
            this.changed();
            return;
        }
        if (data.length > 256) {
            throw new Error(t("transfer.invalid.transfer.acknowledgement"));
        }
        const message: unknown = JSON.parse(data);
        if (!record(message) || typeof message.type !== 'string') {
            throw new Error(t("transfer.invalid.transfer.message"));
        }
        if (message.type === 'cancel') {
            this.finishLocal(item, 'cancelled');
            this.endRemote(item.id, 'cancelled');
        }
        else if (message.type === 'ack' && !item.incoming) {
            this.finishLocal(item, 'completed');
        }
        else if (message.type === 'end' && item.incoming && !item.receivingEnd) {
            item.receivingEnd = true;
            if (item.bytes !== item.size) {
                throw new Error(t("transfer.received.content.is.incomplete.please.send.again"));
            }
            if (!item.hash || !item.channel) {
                throw new Error(t("transfer.transfer.resources.are.not.ready"));
            }
            const blob = new Blob([...item.parts, ...item.chunks], { type: item.mime });
            if (hex(item.hash.digest()) !== message.hash) {
                throw new Error(t("transfer.content.verification.failed.please.send.again"));
            }
            const text = item.kind === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()) : undefined;
            if (ended.has(item.status)) {
                return;
            }
            item.blob = blob;
            item.verified = true;
            if (item.kind === 'text') {
                item.text = text;
            }
            if (safeImages.has(item.mime)) {
                item.url = URL.createObjectURL(blob);
            }
            item.status = 'completed';
            item.chunks = [];
            item.parts = [];
            try {
                item.channel.send(JSON.stringify({ type: 'ack' }));
            }
            catch {
                // Verified local receipt still needs server notification and cleanup
                // when the channel closes before the acknowledgement can leave.
            }
            this.endRemote(item.id, 'completed');
            this.changed(true);
            setTimeout(() => this.closePeer(item), 1500);
        }
        else {
            throw new Error(t("transfer.invalid.transfer.message"));
        }
    }
    endRemote(id: string | undefined, status: TerminalStatus, reasonCode?: string) {
        if (!id) {
            return;
        }
        const result = { status, ...(reasonCode ? { reasonCode } : {}) };
        this.pendingEnds.set(id, result);
        this.connection.rpc('transfer.end', { id, ...result }).then(() => this.pendingEnds.delete(id)).catch((error) => {
            if (['TRANSFER_ENDED', 'NOT_FOUND', 'NOT_PAIRED'].includes(error.code)) {
                this.pendingEnds.delete(id);
            }
        });
    }
    closePeer(item: TransferItem) {
        item.pc?.close();
        item.chunks = [];
        item.parts = [];
        item.hash?.destroy();
    }
    finishLocal(item: TransferItem, status: TransferStatus, reason = '') {
        if (ended.has(item.status)) {
            return;
        }
        // ACK, signaling state and reconnect snapshots share the same completion
        // gate. Even an empty file must publish its digest before it can be sent.
        if (status === 'completed' && (item.incoming ? !item.verified : !item.sentEnd || item.bytes !== item.size)) {
            this.fail(item, t("transfer.invalid.transfer.acknowledgement"));
            return;
        }
        item.status = status;
        item.reason = reason;
        const descriptor = describeMessage(reason);
        item.reasonKey = descriptor.messageKey;
        item.reasonParams = descriptor.messageParams;
        this.closePeer(item);
        this.changed(true);
    }
    fail(item: TransferItem, reason: string, reasonCode?: string) {
        if (!ended.has(item.status)) {
            this.finishLocal(item, 'failed', reason || t("transfer.transfer.failed.please.try.again"));
            this.endRemote(item.id, 'failed', reasonCode);
        }
    }
    cancel(item: TransferItem | undefined) {
        if (!item) {
            return;
        }
        if (!ended.has(item.status)) {
            if (item.channel?.readyState === 'open') {
                item.channel.send(JSON.stringify({ type: 'cancel' }));
            }
            this.finishLocal(item, 'cancelled');
            this.endRemote(item.id, 'cancelled');
        }
    }
    clear(matches: (item: TransferItem) => boolean = () => true) {
        const activeGroups = new Set(this.items.filter((item) => item.groupId && !ended.has(item.status)).map((item) => item.groupId));
        const activeBatches = new Set(this.items.filter(item => item.batchId && !ended.has(item.status)).map(item => item.batchId));
        this.items = this.items.filter((item) => {
            if (activeBatches.has(item.batchId) || !matches(item) || item.shareOpen || !ended.has(item.status) || activeGroups.has(item.groupId)) {
                return true;
            }
            if (item.url) {
                URL.revokeObjectURL(item.url);
            }
            this.byId.delete(item.id || '');
            return false;
        });
        this.groups = this.groups.filter((group) => this.items.some((item) => item.groupId === group.id));
        this.queue = this.queue.filter((item) => item.status === 'queued');
        this.changed(true);
    }
}

function remoteId(item: TransferItem): string {
    if (!item.id) {
        throw new Error(t("transfer.transfer.resources.are.not.ready"));
    }
    return item.id;
}
