import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'herdr_boss_session';
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_MS = 15 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Lax, not Strict: a home-screen web app opens the dashboard as a top-level navigation. The server still refuses
// cross-site requests with its same-origin check.
function sessionCookie(id, sessionMs) {
  return `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.round(sessionMs / 1000)}`;
}

// Sessions survive a service restart. The file holds only SHA-256 hashes of the session IDs, and a fingerprint of the
// token: a new token signs out every device.
function loadSessions(file, tokenHash) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.token !== tokenHash || !data.sessions || typeof data.sessions !== 'object') return new Map();
    const now = Date.now();
    return new Map(Object.entries(data.sessions).filter(([, expiry]) => Number.isFinite(expiry) && expiry > now));
  } catch { return new Map(); }
}

function saveSessions(file, tokenHash, sessions) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token: tokenHash, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadToken(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error('The remote access token must contain at least 32 characters.');
  return Buffer.from(token);
}

function equal(left, right) {
  const value = Buffer.from(String(left || ''));
  return value.length === right.length && timingSafeEqual(value, right);
}

function loopback(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && ['127.0.0.1', 'localhost', '[::1]'].includes(host);
}

export function createAccessControl(tokenFile, { sessionFile = path.join(path.dirname(tokenFile), 'sessions.json'), sessionDays = 30 } = {}) {
  const token = loadToken(tokenFile);
  const tokenHash = hash(token);
  const sessionMs = Math.max(1, Number(sessionDays) || 30) * DAY_MS;
  const sessions = loadSessions(sessionFile, tokenHash);
  const attempts = new Map();
  const persist = () => { try { saveSessions(sessionFile, tokenHash, sessions); } catch {} };

  function authorized(req, res) {
    if (loopback(req)) return true;
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (bearer && equal(bearer[1], token)) return true;
    const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const session = cookie?.slice(COOKIE.length + 1);
    if (!session) return false;
    const key = hash(session);
    const expires = sessions.get(key);
    if (!expires) return false;
    const now = Date.now();
    if (expires < now) { sessions.delete(key); persist(); return false; }
    // Renew at most once a day while the device uses the dashboard.
    if (sessionMs - (expires - now) > DAY_MS) {
      sessions.set(key, now + sessionMs);
      persist();
      res.setHeader('set-cookie', sessionCookie(session, sessionMs));
    }
    return true;
  }

  function login(req, supplied) {
    const remote = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (attempts.get(remote) || []).filter((at) => now - at < ATTEMPT_MS);
    if (recent.length >= 8) return { ok: false, limited: true };
    if (!equal(supplied, token)) {
      recent.push(now);
      attempts.set(remote, recent);
      return { ok: false, limited: false };
    }
    attempts.delete(remote);
    for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
    const id = randomBytes(32).toString('hex');
    sessions.set(hash(id), now + sessionMs);
    persist();
    return { ok: true, cookie: sessionCookie(id, sessionMs) };
  }

  return { authorized, login };
}

export function loginPage(error = '') {
  const message = error ? '<p role="alert">Invalid token or too many attempts. Try again later.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Herdr Boss access</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121110;color:#ece8e1;font:16px system-ui}main{width:min(90vw,380px);padding:28px;border:1px solid #3b3833;border-radius:10px;background:#1b1a18}h1{font-size:22px}label,input,button{display:block;width:100%;box-sizing:border-box}input{margin:12px 0;padding:12px;background:#24221f;border:1px solid #696259;border-radius:6px;color:inherit;font:inherit}button{padding:11px;border:0;border-radius:6px;background:#ef8a4a;color:#1d1b18;font:600 15px system-ui;cursor:pointer}p{color:#c8bcb0;font-size:14px}</style></head><body><main><h1>Herdr Boss</h1><p>Enter the access token stored on the host computer.</p>${message}<form action="/login" method="post"><input type="text" name="username" value="herdr-boss" autocomplete="username" hidden><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">Unlock dashboard</button></form></main></body></html>`;
}
