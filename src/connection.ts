import { RemoteError } from './i18n/errors.js';
import { t } from './i18n/index.js';
import type { Identity, Device, ClientLimits } from './types/device.js';
import type { ConnectionEvents, RpcName, RpcArgs, RpcOutput } from './types/protocol.js';
import { record, parseReply, isServerEvent } from './protocol-runtime.js';
import { errorValue } from './dom.js';
import { loadIdentity, signChallenge } from './identity.js';
import { deviceNames } from './device-name.js';
export class Connection extends EventTarget {
    pending = new Map<string, {
        timer: ReturnType<typeof setTimeout>;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    ready = false;
    attempt = 0;
    sessionId: string | null = null;
    guest: boolean;
    identity?: Identity;
    device?: Device;
    config: ClientLimits = { maxFileBytes: 50 * 1048576, maxTextBytes: 1048576 };
    ws?: WebSocket;
    stopped = false;
    suspended = false;
    waking?: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    override addEventListener<K extends keyof ConnectionEvents>(type: K, listener: (event: CustomEvent<ConnectionEvents[K]>) => void, options?: boolean | AddEventListenerOptions): void;
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
    override addEventListener(type: string, listener: ((event: never) => unknown) | EventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
    }
    constructor({ guest = false } = {}) {
        super();
        this.pending = new Map();
        this.ready = false;
        this.attempt = 0;
        this.sessionId = null;
        this.guest = guest;
    }
    emit<K extends keyof ConnectionEvents>(type: K, data: ConnectionEvents[K]) {
        this.dispatchEvent(new CustomEvent(type, { detail: data }));
    }
    async start() {
        try {
            if (!this.guest) {
                this.identity = await loadIdentity();
            }
            this.connect();
        }
        catch (caught) {
            const error = errorValue(caught);
            this.emit('fatal', { message: error.message });
        }
    }
    connect() {
        const url = new URL('/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(url);
        this.ws = ws;
        this.emit('connecting', {});
        ws.addEventListener('message', (event) => {
            let message: unknown;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                this.emit('notice', { message: t("connection.invalid.server.response.please.try.again") });
                return;
            }
            if (!record(message)) {
                return;
            }
            if (typeof message.replyTo === 'string') {
                const pending = this.pending.get(message.replyTo);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(message.replyTo);
                    if (message.ok) {
                        pending.resolve(message.data);
                    }
                    else {
                        const detail = record(message.error) ? message.error : {};
                        pending.reject(new RemoteError(typeof detail.code === 'string' ? detail.code : 'INVALID', { message: typeof detail.message === 'string' ? detail.message : t("connection.unable.to.process.the.request"), messageKey: typeof detail.messageKey === 'string' ? detail.messageKey : undefined, messageParams: record(detail.messageParams) ? Object.fromEntries(Object.entries(detail.messageParams).filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')) : undefined }, typeof detail.retryAfterMs === 'number' && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0 ? detail.retryAfterMs : undefined));
                    }
                }
            }
            else if (typeof message.type === 'string' && isServerEvent(message.type, message.data)) {
                this.dispatchEvent(new CustomEvent(message.type, { detail: message.data }));
            }
        });
        ws.addEventListener('open', async () => {
            try {
                if (this.guest) {
                    const result = await this.rpc('guest.open', { resumeSession: this.sessionId, name: deviceNames.guest(), shareProtocol: 2 });
                    this.sessionId = result.sessionId;
                    this.device = result.device;
                    this.config = result.config;
                    this.ready = true;
                    this.attempt = 0;
                    this.emit('ready', result);
                    return;
                }
                const identity = this.identity;
                if (!identity) {
                    throw new Error(t("connection.device.identity.mismatch"));
                }
                const name = deviceNames.device();
                const { challenge, fingerprint } = await this.rpc('auth.begin', { publicKey: identity.publicKey, name });
                if (fingerprint !== identity.fingerprint) {
                    throw new Error(t("connection.device.identity.mismatch"));
                }
                const signature = await signChallenge(identity, challenge);
                const result = await this.rpc('auth.finish', { signature, resumeSession: this.sessionId });
                deviceNames.rememberDevice(result.device.name);
                this.sessionId = result.sessionId;
                this.device = result.device;
                this.config = result.config;
                this.ready = true;
                this.attempt = 0;
                this.emit('ready', result);
            }
            catch (caught) {
                const error = errorValue(caught);
                this.emit('notice', { message: error.message });
                ws.close();
            }
        });
        ws.addEventListener('close', (event) => {
            this.ready = false;
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error(t("connection.server.connection.lost.reconnecting")));
            }
            this.pending.clear();
            this.suspended = this.guest && event.code === 1000 && event.reason === 'Guest session idle';
            this.emit('disconnected', {});
            if (!this.stopped && !this.suspended) {
                const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 6), 30000);
                this.timer = setTimeout(() => this.connect(), delay * (0.75 + Math.random() * 0.5));
            }
        });
        ws.addEventListener('error', () => { });
    }
    private wake(): Promise<void> {
        if (!this.waking) {
            this.waking = new Promise<void>((resolve, reject) => {
                const ready = () => { cleanup(); resolve(); };
                const timer = setTimeout(() => { cleanup(); reject(new Error(t("connection.request.timed.out.please.try.again"))); }, 12000);
                const cleanup = () => {
                    clearTimeout(timer);
                    this.removeEventListener('ready', ready);
                    this.waking = undefined;
                };
                this.addEventListener('ready', ready);
                this.suspended = false;
                this.connect();
            });
        }
        return this.waking;
    }
    async rpc<K extends RpcName>(type: K, ...args: RpcArgs<K>): Promise<RpcOutput<K>> {
        if (this.stopped) {
            throw new Error(t("connection.server.unavailable.waiting.to.reconnect"));
        }
        if (this.suspended || (this.waking && type !== 'guest.open')) {
            await this.wake();
        }
        const deadline = Date.now() + 30000;
        for (;;) {
            try {
                return await this.request(type, ...args);
            }
            catch (error) {
                if ((type !== 'transfer.start' && type !== 'share.file.start') || !(error instanceof RemoteError) || error.code !== 'RATE_LIMIT' || !error.retryAfterMs || Date.now() + error.retryAfterMs > deadline || this.stopped || !this.ready) {
                    throw error;
                }
                const socket = this.ws;
                await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs! + Math.random() * 100));
                if (this.stopped || !this.ready || this.ws !== socket) {
                    throw error;
                }
            }
        }
    }
    private request<K extends RpcName>(type: K, ...args: RpcArgs<K>): Promise<RpcOutput<K>> {
        const data = args[0] ?? {};
        return new Promise<RpcOutput<K>>((resolve, reject) => {
            if (this.ws?.readyState !== WebSocket.OPEN || (!this.ready && !type.startsWith('auth.') && type !== 'guest.open')) {
                reject(new Error(t("connection.server.unavailable.waiting.to.reconnect")));
                return;
            }
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(t("connection.request.timed.out.please.try.again")));
            }, 12000);
            this.pending.set(id, { resolve: (value) => {
                    try {
                        resolve(parseReply(type, value));
                    }
                    catch (error) {
                        reject(error);
                    }
                }, reject, timer });
            this.ws.send(JSON.stringify({ id, type, data }));
        });
    }
    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.ws?.close();
    }
}
