// @ts-check
/**
 * Login for a shared (server) launcher – one team account from the environment:
 *   LAUNCHER_AUTH_USER       e.g. qa-team
 *   LAUNCHER_AUTH_PASSWORD   plain, or LAUNCHER_AUTH_PASSWORD_HASH = scrypt$<salt-hex>$<hash-hex>
 *                            (npm run launcher:hash-password -- '<password>')
 * Sessions live in memory (HttpOnly, SameSite=Strict cookie, LAUNCHER_SESSION_HOURS, default 12 h):
 * a restart logs everyone out. 10 wrong passwords from one address lock it for 15 minutes.
 * Locally (127.0.0.1) without these variables the launcher stays login-free as before.
 */
'use strict';

const crypto = require('node:crypto');

const COOKIE = 'launcher_session';
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

function config() {
  const user = String(process.env.LAUNCHER_AUTH_USER || '').trim();
  const password = String(process.env.LAUNCHER_AUTH_PASSWORD || '');
  const hash = String(process.env.LAUNCHER_AUTH_PASSWORD_HASH || '').trim();
  const hours = Number(process.env.LAUNCHER_SESSION_HOURS || 12);
  return {
    user,
    password,
    hash,
    ttlMs: (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000,
    enabled: user !== '' && (password !== '' || hash !== ''),
  };
}

/** scrypt$salt$hash for LAUNCHER_AUTH_PASSWORD_HASH. */
function hashPassword(/** @type {string} */ password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const digest = (/** @type {string} */ v) => crypto.createHash('sha256').update(v, 'utf8').digest();

function passwordMatches(/** @type {string} */ given, cfg = config()) {
  if (cfg.hash) {
    const [kind, saltHex, hashHex] = cfg.hash.split('$');
    if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(given, Buffer.from(saltHex, 'hex'), want.length);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  return crypto.timingSafeEqual(digest(given), digest(cfg.password));
}

/** @type {Map<string, number>} session id → expiry */
const sessions = new Map();
/** @type {Map<string, { count: number, until: number }>} address → failures */
const failures = new Map();

function cookieOf(/** @type {import('node:http').IncomingMessage} */ req) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

function isLoggedIn(/** @type {import('node:http').IncomingMessage} */ req) {
  const id = cookieOf(req);
  const expires = id ? sessions.get(id) : undefined;
  if (expires === undefined) return false;
  if (expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

const clientAddress = (/** @type {import('node:http').IncomingMessage} */ req) =>
  String(req.socket.remoteAddress || 'unknown');

/**
 * Checks user + password. Returns a Set-Cookie value on success, or an error message.
 * @returns {{ cookie: string } | { error: string, status: number }}
 */
function login(/** @type {import('node:http').IncomingMessage} */ req, /** @type {any} */ body) {
  const cfg = config();
  const who = clientAddress(req);
  const f = failures.get(who);
  if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
    return { status: 429, error: 'Too many wrong passwords – try again in 15 minutes' };
  }
  const user = String(body?.user || '');
  const password = String(body?.password || '');
  const userOk = crypto.timingSafeEqual(digest(user.trim()), digest(cfg.user));
  const passOk = passwordMatches(password, cfg);
  if (!userOk || !passOk) {
    const next = f && f.until > Date.now() ? f.count + 1 : 1;
    failures.set(who, { count: next, until: Date.now() + LOCK_MS });
    return { status: 401, error: 'Wrong user name or password' };
  }
  failures.delete(who);
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + cfg.ttlMs);
  // Plain http on the server for now – add "; Secure" once it is behind HTTPS (LAUNCHER_COOKIE_SECURE=1).
  const secure = process.env.LAUNCHER_COOKIE_SECURE === '1' ? '; Secure' : '';
  return {
    cookie: `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(Math.round(cfg.ttlMs / 1000))}${secure}`,
  };
}

function logout(/** @type {import('node:http').IncomingMessage} */ req) {
  sessions.delete(cookieOf(req));
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Login page – self-contained (no external files), matches the launcher colours. */
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Test Launcher</title><style>
:root{--brand:#6d5dfc;--text:#1f1d3a;--muted:#6b6890;--bg:#f4f2fb;--card:#fff;--border:#e2def5;--fail:#d6336c}
@media (prefers-color-scheme:dark){:root{--text:#ece9ff;--muted:#a7a3c7;--bg:#15131f;--card:#1e1b2b;--border:#2f2b45}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}
form{width:min(380px,calc(100vw - 32px));padding:28px;border-radius:20px;background:var(--card);border:1px solid var(--border);box-shadow:0 20px 50px rgb(40 30 120/.12)}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 18px;color:var(--muted);font-size:13.5px}
label{display:block;margin:12px 0 4px;font-weight:600;font-size:13.5px}input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--brand);outline-offset:1px}button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:10px;font:inherit;font-weight:700;color:#fff;background:linear-gradient(135deg,#6d5dfc,#8b5cf6);cursor:pointer}
.err{min-height:20px;margin-top:10px;color:var(--fail);font-size:13.5px}
</style></head><body><form id="f"><h1>Test Launcher</h1><p>Integration QA Automation · Paysecure – team sign in</p>
<label for="u">User name</label><input id="u" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
<button>Sign in</button><div class="err" id="e" role="alert"></div></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:document.getElementById('u').value,password:document.getElementById('p').value})}).catch(()=>null);
if(r&&r.ok){location.replace(new URLSearchParams(location.search).get('next')||'/');return}
e.textContent=r?((await r.json().catch(()=>({}))).error||'Sign in failed'):'Launcher not reachable';});</script></body></html>`;

module.exports = { config, hashPassword, isLoggedIn, login, logout, LOGIN_PAGE, COOKIE };

if (require.main === module) {
  const pw = process.argv[2];
  if (!pw) {
    process.stderr.write("Usage: npm run launcher:hash-password -- '<password>'\n");
    process.exit(1);
  }
  // Single quotes: docker compose would read the $ signs of the hash as variables otherwise.
  process.stdout.write(`LAUNCHER_AUTH_PASSWORD_HASH='${hashPassword(pw)}'\n`);
}
