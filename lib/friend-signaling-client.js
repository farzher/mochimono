import { settings } from './agent-context.js';
import { getPeerIdentity } from './peer-identity.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function defaultSignalUrl() {
  if (process.env.MOCHIMONO_SIGNAL_URL) return String(process.env.MOCHIMONO_SIGNAL_URL).replace(/\/$/, '');
  const source = new URL(settings.server);
  if (['127.0.0.1', 'localhost', '::1'].includes(source.hostname)) source.protocol = 'http:';
  source.port = String(process.env.MOCHIMONO_SIGNAL_PORT || 8645);
  source.pathname = '/friend-signal';
  source.search = '';
  source.hash = '';
  return source.toString().replace(/\/$/, '');
}

export class FriendSignalingClient {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.base = defaultSignalUrl();
    this.identity = null;
    this.token = '';
    this.running = false;
  }

  async start() {
    this.identity = await getPeerIdentity();
    try { await this.register(); } catch {}
    if (!this.running) {
      this.running = true;
      this.pollLoop();
    }
    return this;
  }

  async raw(path, options = {}) {
    const response = await fetch(`${this.base}${path}`, {
      ...options,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        'content-type': 'application/json',
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `${response.status} ${response.statusText}`), { status: response.status });
    return data;
  }

  async register() {
    this.identity ||= await getPeerIdentity();
    const challenge = await this.raw('/challenge', { method: 'POST', body: { deviceId: this.identity.deviceId, publicKey: this.identity.publicKey } });
    const payload = `mochimono-signal-v1:${challenge.challengeId}:${challenge.challenge}:${this.identity.deviceId}`;
    const registered = await this.raw('/register', {
      method: 'POST',
      body: {
        challengeId: challenge.challengeId,
        deviceId: this.identity.deviceId,
        publicKey: this.identity.publicKey,
        signature: this.identity.sign(payload)
      }
    });
    this.token = registered.token;
  }

  async request(path, options = {}) {
    if (!this.token) await this.register();
    try { return await this.raw(path, options); }
    catch (error) {
      if (error.status !== 401) throw error;
      this.token = '';
      await this.register();
      return this.raw(path, options);
    }
  }

  async pollLoop() {
    while (this.running) {
      try {
        const result = await this.request('/poll');
        for (const event of result.messages || []) await this.onEvent(event);
        await sleep(700);
      } catch {
        this.token = '';
        await sleep(1500);
      }
    }
  }

  createPair(body) { return this.request('/pair/create', { method: 'POST', body }); }
  joinPair(body) { return this.request('/pair/join', { method: 'POST', body }); }
  send(to, data) { return this.request('/send', { method: 'POST', body: { to, data } }); }
  presence(peers) { return this.request('/presence', { method: 'POST', body: { peers } }); }
}
