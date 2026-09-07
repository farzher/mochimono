import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifyBytes
} from 'node:crypto';

const PREFIX = '/friend-signal';
const MAX_BODY = 256 * 1024;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const ONLINE_MS = 20 * 1000;
const PAIR_MS = 10 * 60 * 1000;
const CHALLENGE_MS = 60 * 1000;

const challenges = new Map();
const sessionsByToken = new Map();
const sessionsByDevice = new Map();
const pairs = new Map();

const now = () => Date.now();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function validDeviceId(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function validPairId(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function publicKeyId(publicKey) {
  try {
    const bytes = Buffer.from(String(publicKey || ''), 'base64url');
    if (!bytes.length || bytes.length > 256) return '';
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return '';
  }
}

function registrationPayload(challengeId, challenge, deviceId) {
  return `mochimono-signal-v1:${challengeId}:${challenge}:${deviceId}`;
}

function publicKeyObject(publicKey) {
  return createPublicKey({ key: Buffer.from(String(publicKey || ''), 'base64url'), format: 'der', type: 'spki' });
}

function bearer(req) {
  return /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
}

function sessionFor(req) {
  const session = sessionsByToken.get(bearer(req));
  if (!session) return null;
  if (now() - session.lastSeen > SESSION_IDLE_MS) {
    sessionsByToken.delete(session.token);
    if (sessionsByDevice.get(session.deviceId) === session) sessionsByDevice.delete(session.deviceId);
    return null;
  }
  session.lastSeen = now();
  return session;
}

function requireSession(req, res) {
  const session = sessionFor(req);
  if (!session) json(res, 401, { error: 'Signaling session expired' });
  return session;
}

function sameSecretValue(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'base64url');
    const right = Buffer.from(String(b || ''), 'base64url');
    return left.length >= 16 && left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function online(deviceId) {
  const session = sessionsByDevice.get(deviceId);
  return Boolean(session && now() - session.lastSeen <= ONLINE_MS);
}

function queue(deviceId, event) {
  const session = sessionsByDevice.get(deviceId);
  if (!session) return false;
  session.queue.push(event);
  if (session.queue.length > 1000) session.queue.splice(0, session.queue.length - 1000);
  return true;
}

export async function handleFriendSignaling(req, res, url) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const path = url.pathname.slice(PREFIX.length) || '/';

  try {
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && path === '/challenge') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '');
      const publicKey = String(body.publicKey || '');
      if (!validDeviceId(deviceId) || publicKeyId(publicKey) !== deviceId) {
        json(res, 400, { error: 'Invalid device identity' });
        return true;
      }
      const challengeId = randomBytes(16).toString('hex');
      const challenge = randomBytes(32).toString('base64url');
      challenges.set(challengeId, { deviceId, publicKey, challenge, expires: now() + CHALLENGE_MS });
      json(res, 200, { challengeId, challenge });
      return true;
    }

    if (req.method === 'POST' && path === '/register') {
      const body = await readJson(req);
      const challengeId = String(body.challengeId || '');
      const challenge = challenges.get(challengeId);
      challenges.delete(challengeId);
      if (!challenge || challenge.expires < now()) {
        json(res, 400, { error: 'Signaling challenge expired' });
        return true;
      }
      const deviceId = String(body.deviceId || '');
      const publicKey = String(body.publicKey || '');
      if (deviceId !== challenge.deviceId || publicKey !== challenge.publicKey) {
        json(res, 400, { error: 'Device identity changed during registration' });
        return true;
      }
      let valid = false;
      try {
        valid = verifyBytes(
          null,
          Buffer.from(registrationPayload(challengeId, challenge.challenge, deviceId)),
          publicKeyObject(publicKey),
          Buffer.from(String(body.signature || ''), 'base64url')
        );
      } catch {}
      if (!valid) {
        json(res, 401, { error: 'Device identity proof failed' });
        return true;
      }

      const previous = sessionsByDevice.get(deviceId);
      if (previous) sessionsByToken.delete(previous.token);
      const token = randomBytes(32).toString('base64url');
      const session = { token, deviceId, publicKey, lastSeen: now(), queue: previous?.queue || [] };
      sessionsByToken.set(token, session);
      sessionsByDevice.set(deviceId, session);
      json(res, 200, { token });
      return true;
    }

    const session = requireSession(req, res);
    if (!session) return true;

    if (req.method === 'POST' && path === '/pair/create') {
      const body = await readJson(req);
      const pairId = String(body.pairId || '');
      const verifier = String(body.verifier || '');
      const bundle = body.bundle;
      const mac = String(body.mac || '');
      if (!validPairId(pairId) || Buffer.from(verifier, 'base64url').length !== 32 || !bundle || typeof bundle !== 'object' || !mac) {
        json(res, 400, { error: 'Invalid friend invite' });
        return true;
      }
      if (bundle.deviceId !== session.deviceId || bundle.publicKey !== session.publicKey) {
        json(res, 400, { error: 'Invite identity does not match this Agent' });
        return true;
      }
      pairs.set(pairId, {
        pairId,
        verifier,
        hostDeviceId: session.deviceId,
        hostBundle: bundle,
        hostMac: mac,
        expires: now() + PAIR_MS
      });
      json(res, 200, { ok: true, expiresAt: new Date(now() + PAIR_MS).toISOString() });
      return true;
    }

    if (req.method === 'POST' && path === '/pair/join') {
      const body = await readJson(req);
      const pairId = String(body.pairId || '');
      const pair = pairs.get(pairId);
      if (!pair || pair.expires < now()) {
        pairs.delete(pairId);
        json(res, 404, { error: 'Friend invite expired or was not found' });
        return true;
      }
      if (!sameSecretValue(pair.verifier, body.verifier)) {
        json(res, 401, { error: 'Friend invite is invalid' });
        return true;
      }
      if (!online(pair.hostDeviceId)) {
        json(res, 409, { error: 'Friend Agent is offline' });
        return true;
      }
      const bundle = body.bundle;
      const mac = String(body.mac || '');
      if (!bundle || typeof bundle !== 'object' || !mac || bundle.deviceId !== session.deviceId || bundle.publicKey !== session.publicKey) {
        json(res, 400, { error: 'Pairing identity is invalid' });
        return true;
      }
      if (session.deviceId === pair.hostDeviceId) {
        json(res, 400, { error: 'Cannot pair an Agent with itself' });
        return true;
      }
      queue(pair.hostDeviceId, { kind: 'pair-joined', pairId, bundle, mac });
      pairs.delete(pairId);
      json(res, 200, { bundle: pair.hostBundle, mac: pair.hostMac });
      return true;
    }

    if (req.method === 'POST' && path === '/send') {
      const body = await readJson(req);
      const to = String(body.to || '');
      if (!validDeviceId(to) || !body.data || typeof body.data !== 'object') {
        json(res, 400, { error: 'Invalid signaling message' });
        return true;
      }
      if (JSON.stringify(body.data).length > 128 * 1024) {
        json(res, 413, { error: 'Signaling message is too large' });
        return true;
      }
      if (!online(to)) {
        json(res, 409, { error: 'Peer is offline' });
        return true;
      }
      queue(to, { kind: 'signal', from: session.deviceId, data: body.data });
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && path === '/poll') {
      const messages = session.queue.splice(0, 100);
      json(res, 200, { messages });
      return true;
    }

    if (req.method === 'POST' && path === '/presence') {
      const body = await readJson(req);
      const peers = Array.isArray(body.peers) ? [...new Set(body.peers.map(String).filter(validDeviceId))].slice(0, 256) : [];
      json(res, 200, { peers: Object.fromEntries(peers.map(id => [id, online(id)])) });
      return true;
    }

    json(res, 404, { error: 'Not found' });
    return true;
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Signaling error' });
    else res.destroy();
    return true;
  }
}

const cleanup = setInterval(() => {
  const timestamp = now();
  for (const [id, challenge] of challenges) if (challenge.expires < timestamp) challenges.delete(id);
  for (const [id, pair] of pairs) if (pair.expires < timestamp) pairs.delete(id);
  for (const [token, session] of sessionsByToken) {
    if (timestamp - session.lastSeen <= SESSION_IDLE_MS) continue;
    sessionsByToken.delete(token);
    if (sessionsByDevice.get(session.deviceId) === session) sessionsByDevice.delete(session.deviceId);
  }
}, 60_000);
cleanup.unref?.();
