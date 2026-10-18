import { loadIdentity, signChallenge } from './identity.js';

export class Connection extends EventTarget {
  constructor() {
    super();
    this.pending = new Map();
    this.ready = false;
    this.attempt = 0;
    this.sessionId = null;
  }

  emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  async start() {
    try {
      this.identity = await loadIdentity();
      this.connect();
    } catch (error) {
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
      const message = JSON.parse(event.data);
      if (message.replyTo) {
        const pending = this.pending.get(message.replyTo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.replyTo);
          if (message.ok) {
            pending.resolve(message.data);
          } else {
            pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          }
        }
      } else if (message.type) {
        this.emit(message.type, message.data);
      }
    });
    ws.addEventListener('open', async () => {
      try {
        const name = localStorage.getItem('suichuan-name') || '我的电脑';
        const { challenge, fingerprint } = await this.rpc('auth.begin', { publicKey: this.identity.publicKey, name });
        if (fingerprint !== this.identity.fingerprint) {
          throw new Error('设备身份不匹配');
        }
        const signature = await signChallenge(this.identity, challenge);
        const result = await this.rpc('auth.finish', { signature, resumeSession: this.sessionId });
        this.sessionId = result.sessionId;
        this.device = result.device;
        this.config = result.config;
        this.ready = true;
        this.attempt = 0;
        this.emit('ready', result);
      } catch (error) {
        this.emit('notice', { message: error.message });
        ws.close();
      }
    });
    ws.addEventListener('close', () => {
      this.ready = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('服务连接中断，正在重连'));
      }
      this.pending.clear();
      this.emit('disconnected', {});
      if (!this.stopped) {
        this.timer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempt++, 10000));
      }
    });
    ws.addEventListener('error', () => {});
  }

  rpc(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN || (!this.ready && !type.startsWith('auth.'))) {
        reject(new Error('服务暂不可用，请等待重连'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('请求超时，请重试'));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, data }));
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
