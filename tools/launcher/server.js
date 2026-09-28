// @ts-check
/**
 * Test Launcher – a small local web UI for running the suites.
 *
 *   npm run launcher            → http://127.0.0.1:4173
 *
 * Testers pick environment, tester profile (brand ID + API key), payment method
 * and suite, then run Playwright and open the results.
 *
 * Security
 * - Binds to 127.0.0.1 only; rejects foreign Host headers (DNS rebinding).
 * - Every mutating call needs a per-process token embedded in the page (CSRF).
 * - API keys are stored only in profiles.local.json (git-ignored, mode 600),
 *   never sent back to the browser, and masked in streamed output.
 * - Playwright is spawned without a shell; user input is never interpolated
 *   into a command line.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILES_FILE = path.join(ROOT, 'profiles.local.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const REPORT_DIR = path.join(ROOT, 'reports', 'html');
const RESULTS_CSV = path.join(ROOT, 'reports', 'field-tests', 'field-test-results.csv');
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli', { paths: [ROOT] });

const HOST = '127.0.0.1';
const PORT = Number(process.env.LAUNCHER_PORT || 4173);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 5000;

const ENVIRONMENTS = [
  { id: 'uat', label: 'UAT', hint: 'test4.paymentsclub.net' },
  { id: 'local', label: 'LOCAL', hint: 'your machine' },
];

/** Card schemes offered in the UI. "Other" lets testers type any value. */
const PAYMENT_METHODS = ['VISA', 'MASTERCARD'];

const SUITES = [
  {
    id: 'cashier-fields',
    label: 'Cashier purchase › 1. API field validation',
    project: 'cashier-purchase',
    grep: '@field-validation',
  },
  { id: 'cashier-all', label: 'Cashier purchase › all stages', project: 'cashier-purchase' },
  { id: 'framework', label: 'Framework self-tests (offline)', project: 'framework' },
];

// ── profiles ────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** @returns {{ profiles: any[] }} */
function readProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) return { profiles: [] };
  const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  if (!data || !Array.isArray(data.profiles)) throw new Error('profiles.local.json is malformed');
  return data;
}

/** @param {{ profiles: any[] }} data */
function writeProfiles(data) {
  const tmp = `${PROFILES_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, PROFILES_FILE);
}

/** Last 4 characters only – enough for a tester to recognise their key. */
function keyHint(key) {
  return typeof key === 'string' && key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

/** Public view of profiles – API keys are never returned. */
function publicProfiles() {
  return readProfiles().profiles.map((p) => ({
    id: p.id,
    name: p.name,
    paymentMethod: p.paymentMethod || '',
    environments: Object.fromEntries(
      Object.entries(p.environments || {}).map(([env, c]) => [
        env,
        { brandId: c.brandId, apiKeyHint: keyHint(c.apiKey) },
      ]),
    ),
  }));
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tester'
  );
}

function isEnv(value) {
  return ENVIRONMENTS.some((e) => e.id === value);
}

/** Upserts one environment's credentials on a profile. */
function saveProfile(input) {
  const name = String(input.name || '').trim();
  const env = String(input.env || '');
  const brandId = String(input.brandId || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const paymentMethod = String(input.paymentMethod || '')
    .trim()
    .toUpperCase();
  if (!name) throw new HttpError(400, 'Profile name is required');
  if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
  if (!brandId) throw new HttpError(400, 'Brand ID is required');

  const data = readProfiles();
  const id = input.id ? String(input.id) : slugify(name);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'Invalid profile id');
  let profile = data.profiles.find((p) => p.id === id);
  if (!profile) {
    if (data.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `A profile named "${name}" already exists`);
    }
    profile = { id, name, environments: {} };
    data.profiles.push(profile);
  }
  const existingKey = profile.environments?.[env]?.apiKey;
  if (!apiKey && !existingKey) throw new HttpError(400, 'API key is required');

  profile.name = name;
  if (paymentMethod) profile.paymentMethod = paymentMethod;
  profile.environments = profile.environments || {};
  profile.environments[env] = { brandId, apiKey: apiKey || existingKey };
  writeProfiles(data);
  return id;
}

function deleteProfile(id) {
  const data = readProfiles();
  const next = data.profiles.filter((p) => p.id !== id);
  if (next.length === data.profiles.length) throw new HttpError(404, 'Profile not found');
  writeProfiles({ profiles: next });
}

// ── runs ────────────────────────────────────────────────────────────────────

/** @type {null | { id: string, child: import('node:child_process').ChildProcess, lines: string[], status: string, exitCode: number | null, summary: string, startedAt: number, secrets: string[], meta: object }} */
let run = null;
/** @type {Set<http.ServerResponse>} */
const listeners = new Set();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mask(text, secrets) {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out;
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) res.write(frame);
}

function pushLine(line) {
  if (!run) return;
  // eslint-disable-next-line no-control-regex -- strip terminal colour codes
  const clean = mask(line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''), run.secrets);
  run.lines.push(clean);
  if (run.lines.length > MAX_LOG_LINES) run.lines.shift();
  const summary = /Field tests: .*/.exec(clean);
  if (summary) run.summary = summary[0];
  broadcast('line', clean);
}

function startRun(input) {
  if (run && run.status === 'running') throw new HttpError(409, 'A run is already in progress');

  const env = String(input.env || '');
  if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
  const suite = SUITES.find((s) => s.id === input.suiteId);
  if (!suite) throw new HttpError(400, 'Unknown suite');
  const paymentMethod = String(input.paymentMethod || 'VISA')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9_]{2,30}$/.test(paymentMethod)) throw new HttpError(400, 'Invalid payment method');
  const filter = String(input.filter || '')
    .trim()
    .slice(0, 100);

  const prefix = env.toUpperCase();
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...process.env,
    TEST_ENV: env,
    PAYMENT_METHOD: paymentMethod,
    FORCE_COLOR: '0',
    TEST_PROFILE: '',
  };
  const secrets = [];
  let who = 'custom credentials';

  if (suite.project === 'framework') {
    // Offline self-tests need no credentials.
  } else if (input.profileId) {
    const profile = readProfiles().profiles.find((p) => p.id === input.profileId);
    const creds = profile?.environments?.[env];
    if (!profile || !creds) throw new HttpError(400, `Profile has no ${prefix} credentials`);
    childEnv.TEST_PROFILE = profile.id;
    secrets.push(creds.apiKey);
    who = profile.name;
  } else {
    const brandId = String(input.brandId || '').trim();
    const apiKey = String(input.apiKey || '').trim();
    if (!brandId || !apiKey) throw new HttpError(400, 'Brand ID and API key are required');
    childEnv[`${prefix}_BRAND_ID`] = brandId;
    childEnv[`${prefix}_API_KEY`] = apiKey;
    secrets.push(apiKey);
  }

  const args = [PLAYWRIGHT_CLI, 'test', `--project=${suite.project}`];
  const patterns = [suite.grep, filter ? escapeRegExp(filter) : undefined].filter(Boolean);
  if (patterns.length === 1) args.push('--grep', /** @type {string} */ (patterns[0]));
  if (patterns.length > 1) args.push('--grep', patterns.map((p) => `(?=.*${p})`).join(''));

  const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, shell: false });
  run = {
    id: crypto.randomUUID(),
    child,
    lines: [],
    status: 'running',
    exitCode: null,
    summary: '',
    startedAt: Date.now(),
    secrets,
    meta: { env, suite: suite.label, paymentMethod, who, filter },
  };
  broadcast('status', runState());
  pushLine(
    `▶ ${suite.label} | ${prefix} | ${who} | ${paymentMethod}${filter ? ` | filter: ${filter}` : ''}`,
  );

  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    parts.forEach(pushLine);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    if (buffer) pushLine(buffer);
    if (!run) return;
    run.exitCode = code;
    run.status = run.status === 'stopping' ? 'stopped' : code === 0 ? 'passed' : 'failed';
    pushLine(`■ finished: ${run.status}${code === null ? '' : ` (exit ${code})`}`);
    broadcast('status', runState());
  });
  return run.id;
}

function runState() {
  if (!run) return { status: 'idle' };
  return {
    id: run.id,
    status: run.status,
    exitCode: run.exitCode,
    summary: run.summary,
    startedAt: run.startedAt,
    meta: run.meta,
    hasReport: fs.existsSync(path.join(REPORT_DIR, 'index.html')),
    hasCsv: fs.existsSync(RESULTS_CSV),
  };
}

// ── http ────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
  });
}

function serveFile(res, baseDir, relative) {
  const target = path.resolve(baseDir, `.${path.sep}${relative}`);
  if (!target.startsWith(baseDir + path.sep) && target !== baseDir)
    throw new HttpError(403, 'Forbidden');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile())
    throw new HttpError(404, 'Not found');
  const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(target).pipe(res);
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(String(req.headers.host))) throw new HttpError(403, 'Forbidden host');
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method || 'GET';
    const isApi = url.pathname.startsWith('/api/');
    if (isApi && method !== 'GET' && req.headers['x-launcher-token'] !== TOKEN) {
      throw new HttpError(403, 'Invalid launcher token');
    }

    if (method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(HTML_FILE, 'utf8').replace('__LAUNCHER_TOKEN__', TOKEN);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/api/options') {
      return send(res, 200, {
        environments: ENVIRONMENTS,
        paymentMethods: PAYMENT_METHODS,
        suites: SUITES.map(({ id, label }) => ({ id, label })),
        profiles: publicProfiles(),
        run: runState(),
      });
    }
    if (method === 'POST' && url.pathname === '/api/profiles') {
      const id = saveProfile(await readJson(req));
      return send(res, 200, { id, profiles: publicProfiles() });
    }
    const profileMatch = /^\/api\/profiles\/([a-z0-9-]+)$/.exec(url.pathname);
    if (method === 'DELETE' && profileMatch) {
      deleteProfile(profileMatch[1]);
      return send(res, 200, { profiles: publicProfiles() });
    }
    if (method === 'POST' && url.pathname === '/api/runs') {
      const id = startRun(await readJson(req));
      return send(res, 200, { id });
    }
    if (method === 'POST' && url.pathname === '/api/runs/stop') {
      if (run && run.status === 'running') {
        run.status = 'stopping';
        run.child.kill();
      }
      return send(res, 200, runState());
    }
    if (method === 'GET' && url.pathname === '/api/runs/events') {
      if (url.searchParams.get('token') !== TOKEN)
        throw new HttpError(403, 'Invalid launcher token');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: status\ndata: ${JSON.stringify(runState())}\n\n`);
      for (const line of run?.lines ?? [])
        res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return undefined;
    }
    if (method === 'GET' && url.pathname === '/results.csv') {
      if (!fs.existsSync(RESULTS_CSV)) throw new HttpError(404, 'No results yet');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="field-test-results.csv"',
        'cache-control': 'no-store',
      });
      return fs.createReadStream(RESULTS_CSV).pipe(res);
    }
    if (method === 'GET' && (url.pathname === '/report' || url.pathname.startsWith('/report/'))) {
      if (url.pathname === '/report') {
        res.writeHead(302, { location: '/report/' });
        return res.end();
      }
      const relative = decodeURIComponent(url.pathname.slice('/report/'.length)) || 'index.html';
      return serveFile(res, REPORT_DIR, relative);
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  process.stdout.write(`\n  Test Launcher running at ${address}\n  Press Ctrl+C to stop.\n\n`);
  if (!process.argv.includes('--no-open') && !process.env.CI) {
    const opener =
      process.platform === 'darwin'
        ? ['open', [address]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', address]]
          : ['xdg-open', [address]];
    try {
      spawn(opener[0], /** @type {string[]} */ (opener[1]), { stdio: 'ignore', detached: true })
        .on('error', () => undefined)
        .unref();
    } catch {
      /* opening the browser is best-effort */
    }
  }
});

process.on('SIGINT', () => {
  if (run && run.status === 'running') run.child.kill();
  process.exit(0);
});
