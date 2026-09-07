import { FriendPeerNetwork as CoreFriendPeerNetwork } from './friend-p2p-core.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_OFFER_MS = 2500;
const NUDGE_MS = 500;

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

  async joinInvite(code) {
    const peer = await super.joinInvite(code);
    if (peer?.deviceId && peer?.publicKey) this.pairedKeys.set(peer.deviceId, peer.publicKey);
    return peer;
  }

  async waitConnected(peerId, timeout = 20_000) {
    let conn = this.connections.get(peerId);
    if (conn?.authenticated) return conn;

    const presence = await this.signal.presence([peerId]);
    if (!presence.peers?.[peerId]) throw new Error('Friend Agent is offline');

    const initiator = this.identity.deviceId < peerId;
    const deadline = Date.now() + timeout;
    let lastOffer = 0;
    let lastNudge = 0;

    while (Date.now() < deadline) {
      conn = this.connections.get(peerId);
      if (conn?.authenticated) return conn;
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
}
