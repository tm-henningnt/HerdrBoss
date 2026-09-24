import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'herdr_boss_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RENEW_MS = SESSION_MS / 2;
const ATTEMPT_MS = 15 * 60 * 1000;

function sessionCookie(id) {
  return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
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

export function createAccessControl(tokenFile) {
  const token = loadToken(tokenFile);
  const sessions = new Map();
  const attempts = new Map();

  function authorized(req, res) {
    if (loopback(req)) return true;
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (bearer && equal(bearer[1], token)) return true;
    const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const session = cookie?.slice(COOKIE.length + 1);
    const expires = sessions.get(session);
    if (!expires) return false;
    const now = Date.now();
    if (expires < now) { sessions.delete(session); return false; }
    if (expires - now < RENEW_MS) {
      sessions.set(session, now + SESSION_MS);
      res.setHeader('set-cookie', sessionCookie(session));
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
    for (const [id, expiry] of sessions) if (expiry < now) sessions.delete(id);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, now + SESSION_MS);
    return { ok: true, cookie: sessionCookie(id) };
  }

  return { authorized, login };
}

export function loginPage(error = '') {
  const message = error ? '<p role="alert">Invalid token or too many attempts. Try again later.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Herdr Boss access</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121110;color:#ece8e1;font:16px system-ui}main{width:min(90vw,380px);padding:28px;border:1px solid #3b3833;border-radius:10px;background:#1b1a18}h1{font-size:22px}label,input,button{display:block;width:100%;box-sizing:border-box}input{margin:12px 0;padding:12px;background:#24221f;border:1px solid #696259;border-radius:6px;color:inherit;font:inherit}button{padding:11px;border:0;border-radius:6px;background:#ef8a4a;color:#1d1b18;font:600 15px system-ui;cursor:pointer}p{color:#c8bcb0;font-size:14px}</style></head><body><main><h1>Herdr Boss</h1><p>Enter the access token stored on the host computer.</p>${message}<form action="/login" method="post"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="off" required autofocus><button type="submit">Unlock dashboard</button></form></main></body></html>`;
}
