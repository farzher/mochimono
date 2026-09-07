import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import nodeDataChannel from 'node-datachannel';
import { settings } from './agent-context.js';
import { FriendSignalingClient } from './friend-signaling-client.js';
import { deviceIdForPublicKey, getPeerIdentity, verifyPeerSignature } from './peer-identity.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transferHeader = id => Buffer.from(id, 'hex');
const validObjectId = id => /^[a-f0-9]{64}$/.test(String(id || ''));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function b32encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(text) {
  const clean = String(text || '').toUpperCase().replace(/^M1-/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error('Friend invite code is invalid');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function displayCode(secret) {
  const raw = b32encode(secret);
  return `M1-${raw.match(/.{1,4}/g).join('-')}`;
}

function pairId(secret) {
  return createHash('sha256').update(Buffer.concat([Buffer.from('mochimono-pair-v1:'), secret])).digest('hex');
}

function pairVerifier(secret) {
  return createHmac('sha256', secret).update('mochimono-pair-join-v1').digest('base64url');
}

function pairMac(secret, bundle) {
  return createHmac('sha256', secret).update(`mochimono-pair-bundle-v1:${stable(bundle)}`).digest('base64url');
}

function verifyPairMac(secret, bundle, mac) {
  const expected = Buffer.from(pairMac(secret, bundle), 'base64url');
  const actual = Buffer.from(String(mac || ''), 'base64url');
  return expected.length === actual.length && expected.equals(actual);
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('Friend invite identity is missing');
  if (!/^[a-f0-9]{64}$/.test(String(bundle.deviceId || '')) || deviceIdForPublicKey(bundle.publicKey) !== bundle.deviceId) {
    throw new Error('Friend invite identity is invalid');
  }
  return bundle;
}

function turnWithCredentials(url, username, password) {
  const value = String(url || '').trim();
  if (!username && !password || !/^turns?:\/\//i.test(value) && !/^turns?:/i.test(value) || value.includes('@')) return value;
  if (!username || !password) throw new Error('TURN requires both MOCHIMONO_TURN_USERNAME and MOCHIMONO_TURN_PASSWORD');
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return value.replace(/^(turns?:)(?:\/\/)?/i, (_, scheme) => `${scheme}${user}:${pass}@`);
}

function iceServers() {
  const stun = String(process.env.MOCHIMONO_STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean);
  const username = String(process.env.MOCHIMONO_TURN_USERNAME || '');
  const password = String(process.env.MOCHIMONO_TURN_PASSWORD || '');
  const turn = String(process.env.MOCHIMONO_TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean).map(url => turnWithCredentials(url, username, password));
  return [...stun, ...turn];
}

export class FriendPeerNetwork {
  constructor({ peerPublicKey, backend, onPairJoined = async () => {} }) {
    this.peerPublicKey = peerPublicKey;
    this.backend = backend;
    this.onPairJoined = onPairJoined;
    this.identity = null;
    this.signal = new FriendSignalingClient(event => this.onSignalEvent(event));
    this.connections = new Map();
    this.candidates = new Map();
    this.pendingInvites = new Map();
  }

  async start() {
    this.identity = await getPeerIdentity();
    await this.signal.start();
    return this;
  }

  async createInvite(share) {
    const secret = randomBytes(16);
    const id = pairId(secret);
    const bundle = {
      version: 1,
      deviceId: this.identity.deviceId,
      publicKey: this.identity.publicKey,
      deviceName: settings.device,
      shareId: share.id,
      name: share.name,
      quotaBytes: Number(share.quotaBytes) || 0
    };
    this.pendingInvites.set(id, { secret, shareId: share.id, expires: Date.now() + 10 * 60 * 1000 });
    await this.signal.createPair({ pairId: id, verifier: pairVerifier(secret), bundle, mac: pairMac(secret, bundle) });
    return { code: displayCode(secret) };
  }

  async joinInvite(code) {
    const secret = b32decode(code);
    if (secret.length !== 16) throw new Error('Friend invite code is invalid');
    const bundle = { version: 1, deviceId: this.identity.deviceId, publicKey: this.identity.publicKey, deviceName: settings.device };
    const result = await this.signal.joinPair({
      pairId: pairId(secret),
      verifier: pairVerifier(secret),
      bundle,
      mac: pairMac(secret, bundle)
    });
    validateBundle(result.bundle);
    if (!verifyPairMac(secret, result.bundle, result.mac)) throw new Error('Friend invite authentication failed');
    return result.bundle;
  }

  async onSignalEvent(event) {
    if (event.kind === 'pair-joined') {
      const pending = this.pendingInvites.get(event.pairId);
      if (!pending || pending.expires < Date.now()) return;
      validateBundle(event.bundle);
      if (!verifyPairMac(pending.secret, event.bundle, event.mac)) return;
      this.pendingInvites.delete(event.pairId);
      await this.onPairJoined({ shareId: pending.shareId, peer: event.bundle });
      return;
    }
    if (event.kind !== 'signal') return;
    const from = String(event.from || '');
    if (!this.peerPublicKey(from)) return;
    const data = event.data || {};
    if (data.type === 'connect') {
      if (this.identity.deviceId < from) await this.ensurePeer(from, true);
      return;
    }
    if (data.type === 'description') {
      let conn = this.connections.get(from);
      if (!conn && String(data.descriptionType).toLowerCase() === 'offer') conn = await this.ensurePeer(from, false);
      if (!conn) return;
      conn.pc.setRemoteDescription(String(data.sdp || ''), data.descriptionType);
      conn.remoteDescription = true;
      for (const candidate of this.candidates.get(from) || []) conn.pc.addRemoteCandidate(candidate.candidate, candidate.mid);
      this.candidates.delete(from);
      return;
    }
    if (data.type === 'candidate') {
      const conn = this.connections.get(from);
      if (conn?.remoteDescription) conn.pc.addRemoteCandidate(String(data.candidate || ''), String(data.mid || '0'));
      else {
        const list = this.candidates.get(from) || [];
        list.push({ candidate: String(data.candidate || ''), mid: String(data.mid || '0') });
        this.candidates.set(from, list.slice(-64));
      }
    }
  }

  async ensurePeer(peerId, initiator) {
    let conn = this.connections.get(peerId);
    if (conn && !['closed', 'failed'].includes(String(conn.pc.state()).toLowerCase())) return conn;
    if (conn) this.destroy(peerId);

    const pc = new nodeDataChannel.PeerConnection(`friend-${peerId.slice(0, 8)}`, { iceServers: iceServers() });
    conn = {
      peerId,
      pc,
      dc: null,
      authenticated: false,
      challenge: '',
      waiters: [],
      requests: new Map(),
      incoming: new Map(),
      connection: 'connecting',
      remoteDescription: false
    };
    this.connections.set(peerId, conn);

    pc.onLocalDescription((sdp, descriptionType) => {
      this.signal.send(peerId, { type: 'description', sdp, descriptionType }).catch(() => {});
    });
    pc.onLocalCandidate((candidate, mid) => {
      this.signal.send(peerId, { type: 'candidate', candidate, mid }).catch(() => {});
    });
    pc.onDataChannel(dc => this.attachChannel(conn, dc));
    pc.onStateChange(state => {
      if (['closed', 'failed'].includes(String(state).toLowerCase())) this.destroy(peerId);
    });
    if (initiator) this.attachChannel(conn, pc.createDataChannel('friend-storage'));
    return conn;
  }

  attachChannel(conn, dc) {
    conn.dc = dc;
    dc.onOpen(() => {
      conn.challenge = randomBytes(32).toString('base64url');
      this.sendControl(conn, { t: 'challenge', nonce: conn.challenge });
    });
    dc.onClosed(() => this.destroy(conn.peerId));
    dc.onError(() => this.destroy(conn.peerId));
    dc.onMessage(message => {
      if (Buffer.isBuffer(message)) this.onBinary(conn, message);
      else this.onControl(conn, String(message)).catch(() => this.destroy(conn.peerId));
    });
  }

  destroy(peerId) {
    const conn = this.connections.get(peerId);
    if (!conn) return;
    this.connections.delete(peerId);
    try { conn.dc?.close(); } catch {}
    try { conn.pc?.close(); } catch {}
    const error = new Error('Friend connection closed');
    for (const waiter of conn.waiters) waiter.reject(error);
    for (const state of conn.requests.values()) state.reject?.(error);
    for (const state of conn.requests.values()) state.stream?.destroy(error);
    for (const transfer of conn.incoming.values()) transfer.sink?.destroy(error);
  }

  sendControl(conn, data) {
    if (!conn.dc?.isOpen() || !conn.dc.sendMessage(JSON.stringify(data))) throw new Error('Friend connection is unavailable');
  }

  proofPayload(nonce, signer, verifier) {
    return `mochimono-peer-v1:${nonce}:${signer}:${verifier}`;
  }

  async onControl(conn, text) {
    const msg = JSON.parse(text);
    if (msg.t === 'challenge') {
      this.sendControl(conn, {
        t: 'proof',
        deviceId: this.identity.deviceId,
        publicKey: this.identity.publicKey,
        nonce: msg.nonce,
        signature: this.identity.sign(this.proofPayload(msg.nonce, this.identity.deviceId, conn.peerId))
      });
      return;
    }
    if (msg.t === 'proof') {
      const expectedKey = this.peerPublicKey(conn.peerId);
      if (!expectedKey || msg.deviceId !== conn.peerId || msg.publicKey !== expectedKey || msg.nonce !== conn.challenge ||
          !verifyPeerSignature(expectedKey, this.proofPayload(conn.challenge, conn.peerId, this.identity.deviceId), msg.signature)) {
        throw new Error('Friend identity authentication failed');
      }
      conn.authenticated = true;
      try {
        const pair = conn.pc.getSelectedCandidatePair();
        const type = `${pair?.local?.type || ''} ${pair?.remote?.type || ''}`.toLowerCase();
        conn.connection = type.includes('relay') ? 'relayed' : 'direct';
      } catch { conn.connection = 'direct'; }
      for (const waiter of conn.waiters.splice(0)) waiter.resolve(conn);
      return;
    }
    if (!conn.authenticated) throw new Error('Unauthenticated friend message');

    if (msg.t === 'req') return this.handleIncomingRequest(conn, msg);
    if (msg.t === 'ready') {
      const state = conn.requests.get(msg.id);
      state?.readyResolve?.();
      return;
    }
    if (msg.t === 'stream') {
      const state = conn.requests.get(msg.id);
      if (!state || state.kind !== 'get') return;
      state.stream = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
      state.streamResolve({ stream: state.stream, ...(msg.data || {}) });
      return;
    }
    if (msg.t === 'end') {
      const incoming = conn.incoming.get(msg.id);
      if (incoming?.kind === 'put') {
        conn.incoming.delete(msg.id);
        incoming.sink.end();
        try { this.sendControl(conn, { t: 'res', id: msg.id, ok: true, data: await incoming.done }); }
        catch (error) { this.sendControl(conn, { t: 'res', id: msg.id, ok: false, error: error.message }); }
        return;
      }
      const state = conn.requests.get(msg.id);
      if (state?.kind === 'get') {
        conn.requests.delete(msg.id);
        state.stream?.end();
      }
      return;
    }
    if (msg.t === 'res') {
      const state = conn.requests.get(msg.id);
      if (!state) return;
      conn.requests.delete(msg.id);
      if (msg.ok) state.resolve?.(msg.data);
      else {
        const error = new Error(msg.error || 'Friend request failed');
        state.reject?.(error);
        state.stream?.destroy(error);
      }
    }
  }

  onBinary(conn, message) {
    if (!conn.authenticated || message.length < 17) return;
    const id = message.subarray(0, 16).toString('hex');
    const payload = message.subarray(16);
    const incoming = conn.incoming.get(id);
    if (incoming?.kind === 'put') {
      if (!incoming.sink.destroyed) incoming.sink.write(payload);
      return;
    }
    const state = conn.requests.get(id);
    if (state?.kind === 'get' && state.stream && !state.stream.destroyed) state.stream.write(payload);
  }

  async handleIncomingRequest(conn, msg) {
    try {
      if (!msg.shareId || (msg.objectId && !validObjectId(msg.objectId))) throw new Error('Invalid friend storage request');
      if (msg.op === 'info') return this.sendControl(conn, { t: 'res', id: msg.id, ok: true, data: await this.backend.info(conn.peerId, msg.shareId) });
      if (msg.op === 'head') return this.sendControl(conn, { t: 'res', id: msg.id, ok: true, data: await this.backend.head(conn.peerId, msg.shareId, msg.objectId) });
      if (msg.op === 'delete') return this.sendControl(conn, { t: 'res', id: msg.id, ok: true, data: await this.backend.remove(conn.peerId, msg.shareId, msg.objectId) });
      if (msg.op === 'put') {
        const opened = await this.backend.beginPut(conn.peerId, msg.shareId, msg.objectId);
        conn.incoming.set(msg.id, { kind: 'put', ...opened });
        this.sendControl(conn, { t: 'ready', id: msg.id });
        return;
      }
      if (msg.op === 'get') {
        const opened = await this.backend.openGet(conn.peerId, msg.shareId, msg.objectId);
        this.sendControl(conn, { t: 'stream', id: msg.id, data: { size: opened.size, sha256: opened.sha256 || '' } });
        for await (const chunk of opened.stream) await this.sendBinary(conn, msg.id, Buffer.from(chunk));
        this.sendControl(conn, { t: 'end', id: msg.id });
        return;
      }
      throw new Error('Unknown friend storage operation');
    } catch (error) {
      this.sendControl(conn, { t: 'res', id: msg.id, ok: false, error: error.message });
    }
  }

  async waitConnected(peerId, timeout = 20_000) {
    let conn = this.connections.get(peerId);
    if (conn?.authenticated) return conn;
    const presence = await this.signal.presence([peerId]);
    if (!presence.peers?.[peerId]) throw new Error('Friend Agent is offline');
    if (!conn) {
      if (this.identity.deviceId < peerId) conn = await this.ensurePeer(peerId, true);
      else {
        await this.signal.send(peerId, { type: 'connect' });
        conn = this.connections.get(peerId);
      }
    }
    if (conn?.authenticated) return conn;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Friend connection timed out')), timeout);
      const waiter = {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      };
      const current = this.connections.get(peerId);
      if (current) current.waiters.push(waiter);
      else {
        const poll = async () => {
          for (let i = 0; i < 40; i++) {
            const found = this.connections.get(peerId);
            if (found?.authenticated) return waiter.resolve(found);
            if (found) { found.waiters.push(waiter); return; }
            await sleep(50);
          }
          waiter.reject(new Error('Friend connection timed out'));
        };
        poll();
      }
    });
  }

  requestState(conn, id, kind = 'call') {
    return new Promise((resolve, reject) => conn.requests.set(id, { kind, resolve, reject }));
  }

  async call(peerId, request) {
    const conn = await this.waitConnected(peerId);
    const id = randomBytes(16).toString('hex');
    const result = this.requestState(conn, id);
    this.sendControl(conn, { t: 'req', id, ...request });
    return result;
  }

  async put(peerId, request, source) {
    const conn = await this.waitConnected(peerId);
    const id = randomBytes(16).toString('hex');
    let readyResolveRaw, readyReject, readyDone = false;
    const ready = new Promise((resolve, reject) => { readyResolveRaw = resolve; readyReject = reject; });
    const readyResolve = () => { readyDone = true; readyResolveRaw(); };
    let resolveResponse, rejectResponse;
    const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const reject = error => { if (readyDone) rejectResponse(error); else readyReject(error); };
    conn.requests.set(id, { kind: 'put', readyResolve, resolve: resolveResponse, reject });
    this.sendControl(conn, { t: 'req', id, ...request });
    await ready;
    for await (const chunk of source) await this.sendBinary(conn, id, Buffer.from(chunk));
    this.sendControl(conn, { t: 'end', id });
    return response;
  }

  async get(peerId, request) {
    const conn = await this.waitConnected(peerId);
    const id = randomBytes(16).toString('hex');
    let streamResolve, streamReject;
    const started = new Promise((resolve, reject) => { streamResolve = resolve; streamReject = reject; });
    conn.requests.set(id, { kind: 'get', streamResolve, reject: streamReject });
    this.sendControl(conn, { t: 'req', id, ...request });
    return started;
  }

  async sendBinary(conn, id, payload) {
    const max = Number(conn.dc.maxMessageSize?.()) || 64 * 1024;
    const chunkSize = Math.max(1024, Math.min(64 * 1024, max - 16));
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      while (conn.dc.bufferedAmount() > 4 * 1024 * 1024) await sleep(4);
      if (!conn.dc.isOpen() || !conn.dc.sendMessageBinary(Buffer.concat([transferHeader(id), payload.subarray(offset, offset + chunkSize)]))) {
        throw new Error('Friend connection closed during transfer');
      }
    }
  }

  connectionInfo(peerId) {
    const conn = this.connections.get(peerId);
    return conn?.authenticated ? conn.connection : 'offline';
  }
}
