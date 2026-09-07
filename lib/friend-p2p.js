import { FriendPeerNetwork as CoreFriendPeerNetwork } from './friend-p2p-core.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

    const deadline = Date.now() + timeout;
    let lastNudge = 0;
    while (Date.now() < deadline) {
      conn = this.connections.get(peerId);
      if (conn?.authenticated) return conn;

      if (!conn && this.identity.deviceId < peerId) {
        await this.ensurePeer(peerId, true);
      } else if (Date.now() - lastNudge >= 500) {
        await this.signal.send(peerId, { type: 'connect' }).catch(() => {});
        lastNudge = Date.now();
      }
      await sleep(100);
    }

    throw new Error('Friend connection timed out');
  }
}
