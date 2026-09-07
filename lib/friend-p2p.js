import { FriendPeerNetwork as CoreFriendPeerNetwork } from './friend-p2p-core.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transferHeader = id => Buffer.from(id, 'hex');
const RETRY_OFFER_MS = 2500;
const NUDGE_MS = 500;
const SEND_BUFFER_LIMIT = 4 * 1024 * 1024;

function encodeInvite(signalUrl, secretCode) {
  const endpoint = Buffer.from(String(signalUrl), 'utf8').toString('base64url');
  const secret = String(secretCode || '').toUpperCase().replace(/^M1-/, '').replace(/[^A-Z2-7]/g, '');
  if (!endpoint || secret.length !== 26) throw new Error('Friend invite could not be created');
  return `M2-${endpoint}.${secret}`;
}

function decodeInvite(code) {
  const match = /^M2-([A-Za-z0-9_-]+)\.([A-Z2-7]{26})$/i.exec(String(code || '').trim());
  if (!match) throw new Error('Friend invite code is invalid');
  let signalUrl;
  try { signalUrl = Buffer.from(match[1], 'base64url').toString('utf8'); }
  catch { throw new Error('Friend invite code is invalid'); }
  if (!signalUrl) throw new Error('Friend invite code is invalid');
  return { signalUrl, secretCode: `M1-${match[2].toUpperCase()}` };
}

export class FriendPeerNetwork extends CoreFriendPeerNetwork {
  constructor(options) {
    const pairedKeys = new Map();
    const peerPublicKey = options.peerPublicKey;
    const onPairJoined = options.onPairJoined || (async () => {});
    super({
      ...options,
      peerPublicKey: peerId => pairedKeys.get(peerId) || peerPublicKey(peerId),
      onPairJoined: async event => {
        const peer = event?.peer;
        if (peer?.deviceId && peer?.publicKey) pairedKeys.set(peer.deviceId, peer.publicKey);
        await onPairJoined(event);
      }
    });
    this.pairedKeys = pairedKeys;
  }

  async createInvite(share) {
    const invite = await super.createInvite(share);
    return { ...invite, code: encodeInvite(this.signal.inviteBase(), invite.code) };
  }

  async joinInvite(code) {
    const invite = decodeInvite(code);
    this.signal.setBase(invite.signalUrl);
    const peer = await super.joinInvite(invite.secretCode);
    if (peer?.deviceId && peer?.publicKey) this.pairedKeys.set(peer.deviceId, peer.publicKey);
    return peer;
  }

  usable(conn) {
    if (!conn?.authenticated || !conn.dc?.isOpen?.()) return false;
    const state = String(conn.pc?.state?.() || '').toLowerCase();
    return !['closed', 'failed', 'disconnected'].includes(state);
  }

  sendControl(conn, data) {
    if (!conn?.dc?.isOpen?.() || !conn.dc.sendMessage(JSON.stringify(data))) {
      this.destroy(conn?.peerId);
      throw new Error('Friend connection closed');
    }
  }

  async waitConnected(peerId, timeout = 20_000) {
    let conn = this.connections.get(peerId);
    if (this.usable(conn)) return conn;
    if (conn) this.destroy(peerId);

    const presence = await this.signal.presence([peerId]);
    if (!presence.peers?.[peerId]) throw new Error('Friend Agent is offline');

    const initiator = this.identity.deviceId < peerId;
    const deadline = Date.now() + timeout;
    let lastOffer = 0;
    let lastNudge = 0;

    while (Date.now() < deadline) {
      conn = this.connections.get(peerId);
      if (this.usable(conn)) return conn;
      if (conn?.authenticated) {
        this.destroy(peerId);
        conn = null;
      }
      const timestamp = Date.now();

      if (initiator && (!conn || timestamp - lastOffer >= RETRY_OFFER_MS)) {
        // The first offer after pairing can arrive before the host has consumed
        // the pair-joined event and pinned this identity. Rebuild an unauthenticated
        // attempt so a dropped offer cannot strand the connection until timeout.
        if (conn && !conn.authenticated) this.destroy(peerId);
        await this.ensurePeer(peerId, true);
        lastOffer = timestamp;
      } else if (!initiator && timestamp - lastNudge >= NUDGE_MS) {
        // Wake the deterministic initiator once this side is ready. Repeating the
        // nudge also recovers cleanly after either Agent reconnects to signaling.
        await this.signal.send(peerId, { type: 'connect' }).catch(() => {});
        lastNudge = timestamp;
      }

      await sleep(100);
    }

    this.destroy(peerId);
    const hasTurn = Boolean(String(process.env.MOCHIMONO_TURN_URLS || '').trim());
    throw new Error(hasTurn
      ? 'Friend connection timed out. The peer is online, but a P2P route could not be established.'
      : 'Friend connection timed out. Direct P2P appears blocked by the network; configure TURN and retry.');
  }

  async sendBinary(conn, id, payload) {
    const max = Number(conn.dc.maxMessageSize?.()) || 64 * 1024;
    const chunkSize = Math.max(1024, Math.min(64 * 1024, max - 16));
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      while (conn.dc.bufferedAmount() > SEND_BUFFER_LIMIT) {
        if (!this.usable(conn)) {
          this.destroy(conn.peerId);
          throw new Error('Friend connection closed during transfer');
        }
        await sleep(4);
      }
      if (!this.usable(conn) || !conn.dc.sendMessageBinary(Buffer.concat([transferHeader(id), payload.subarray(offset, offset + chunkSize)]))) {
        this.destroy(conn.peerId);
        throw new Error('Friend connection closed during transfer');
      }
    }
  }
}
