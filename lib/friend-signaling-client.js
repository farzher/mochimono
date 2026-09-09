import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, settings } from './agent-context.js';
import { getPeerIdentity } from './peer-identity.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SIGNAL_PATH = join(CONFIG_DIR, 'friend-signaling.json');

function normalizeSignalUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Friend signaling URL is invalid');
  return url.toString().replace(/\/$/, '');
}

const explicitBase = process.env.MOCHIMONO_SIGNAL_URL ? normalizeSignalUrl(process.env.MOCHIMONO_SIGNAL_URL) : '';

function defaultSignalUrl() {
  if (explicitBase) return explicitBase;
  const source = new URL(settings.server);
  source.pathname = '/friend-signal';
  source.search = '';
  source.hash = '';
  return normalizeSignalUrl(source);
}

let savedBase = '';
if (!explicitBase) {
  try {
    const saved = JSON.parse(await readFile(SIGNAL_PATH, 'utf8'));
    savedBase = normalizeSignalUrl(saved.base);
  } catch {}
}

async function persistBase(base) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SIGNAL_PATH, `${JSON.stringify({ version: 1, base }, null, 2)}\n`, { mode: 0o600 });
  savedBase = base;
}

export class FriendSignalingClient {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.pinnedBase = explicitBase || savedBase;
    this.sessionBase = '';
    this.base = this.pinnedBase || defaultSignalUrl();
    this.identity = null;
    this.token = '';
    this.running = false;
  }

  selectBase(value) {
    const base = normalizeSignalUrl(value);
    if (this.pinnedBase && base !== this.pinnedBase) {
      throw new Error('This Agent is already paired through a different Friend Drive rendezvous');
    }
    this.sessionBase = base;
    if (base !== this.base) {
      this.base = base;
      this.token = '';
    }
    return base;
  }

  resetSelectedBase() {
    if (this.pinnedBase) return;
    this.sessionBase = '';
    const base = defaultSignalUrl();
    if (base !== this.base) {
      this.base = base;
      this.token = '';
    }
  }

  async pinBase(value) {
    const base = this.selectBase(value);
    if (!this.pinnedBase) {
      await persistBase(base);
      this.pinnedBase = base;
    }
    this.sessionBase = '';
    return base;
  }

  currentBase() {
    const base = this.sessionBase || this.pinnedBase || defaultSignalUrl();
    if (base !== this.base) {
      this.base = base;
      this.token = '';
    }
    return this.base;
  }

  async inviteBase() {
    return this.pinBase(this.currentBase());
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
    const base = this.currentBase();
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        ...options,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          'content-type': 'application/json',
          ...(options.headers || {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      const configured = Boolean(explicitBase || this.pinnedBase || this.sessionBase);
      const hint = configured
        ? `Friend signaling is unreachable at ${base}`
        : `Friend signaling is unreachable at ${base}. Check that this Mochimono Cloud is reachable.`;
      throw Object.assign(new Error(hint), { cause: error });
    }
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
    this.currentBase();
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
        // /poll is a server-side long poll. When nothing is happening this is
        // one quiet open request instead of repeated sub-second HTTP traffic.
        const result = await this.request('/poll');
        for (const event of result.messages || []) await this.onEvent(event);
      } catch {
        this.token = '';
        await sleep(5_000);
      }
    }
  }

  createPair(body) { return this.request('/pair/create', { method: 'POST', body }); }
  joinPair(body) { return this.request('/pair/join', { method: 'POST', body }); }
  send(to, data) { return this.request('/send', { method: 'POST', body: { to, data } }); }
  presence(peers) { return this.request('/presence', { method: 'POST', body: { peers } }); }
}
