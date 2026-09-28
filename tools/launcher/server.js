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
const settingsCore = require('../../config/settings-core');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILES_FILE = path.join(ROOT, 'profiles.local.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const REPORT_DIR = path.join(ROOT, 'reports', 'html');
const RESULTS_CSV = path.join(ROOT, 'reports', 'field-tests', 'field-test-results.csv');
const PSP_CSV = path.join(ROOT, 'reports', 'psp-validation', 'psp-validation-results.csv');
const UI_REPORT_DIR = path.join(ROOT, 'reports', 'ui');
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli', { paths: [ROOT] });

const HOST = '127.0.0.1';
const PORT = Number(process.env.LAUNCHER_PORT || 4173);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 5000;

const ENVIRONMENT_IDS = ['uat', 'local'];

// ── settings (config/defaults.json + settings.local.json) ─────────────────────

/** Sections the UI may change. */
const SETTINGS_PATHS = [
  'run',
  'auth',
  'paymentMethods',
  'currencies',
  'banks.uat',
  'banks.local',
  'environments.uat',
  'environments.local',
  'purchase.uat',
  'purchase.local',
  'cards.uat',
  'cards.local',
];

function effectiveSettings() {
  const result = settingsCore.resolveSettings();
  if (!result.success) {
    throw new HttpError(500, `Settings are invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function getAt(obj, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setAt(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let node = obj;
  for (const key of keys) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  // Drop empty parents so "reset" really falls back to the defaults.
  if (keys.length && Object.keys(node).length === 0) setAt(obj, keys.join('.'), undefined);
}

function writeLocalSettings(data) {
  const tmp = `${settingsCore.SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, settingsCore.SETTINGS_FILE);
}

/** Validates the whole merged result before anything is written. */
function updateSettings(dotted, value) {
  if (!SETTINGS_PATHS.includes(dotted)) throw new HttpError(400, 'Unknown settings section');
  const local = settingsCore.readJson(settingsCore.SETTINGS_FILE);
  setAt(local, dotted, value);
  const merged = settingsCore.mergeSettings(settingsCore.readDefaults(), local);
  const parsed = settingsCore.settingsSchema.safeParse(merged);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  writeLocalSettings(local);
}

function settingsView() {
  const local = settingsCore.readJson(settingsCore.SETTINGS_FILE);
  return {
    effective: effectiveSettings(),
    defaults: settingsCore.readDefaults(),
    overridden: SETTINGS_PATHS.filter((p) => getAt(local, p) !== undefined),
  };
}

function environments() {
  const settings = effectiveSettings();
  return ENVIRONMENT_IDS.map((id) => {
    const url = settings.environments[id].baseUrl || settings.environments[id].apiBaseUrl;
    let hint = 'not configured';
    try {
      if (url) hint = new URL(url).host;
    } catch {
      /* keep hint */
    }
    return { id, label: id.toUpperCase(), hint };
  });
}

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
        {
          brandId: c.brandId,
          apiKeyHint: keyHint(c.apiKey),
          dashboardUsername: c.dashboard?.username || '',
          hasDashboardPassword: Boolean(c.dashboard?.password),
        },
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
  return ENVIRONMENT_IDS.includes(value);
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
  const existing = profile.environments?.[env];
  const existingKey = existing?.apiKey;
  if (!apiKey && !existingKey) throw new HttpError(400, 'API key is required');

  const dashboardUsername = String(input.dashboardUsername || '').trim();
  const dashboardPassword = String(input.dashboardPassword || '');
  const keptPassword = dashboardPassword || existing?.dashboard?.password || '';
  if (dashboardUsername && !keptPassword) {
    throw new HttpError(400, 'Dashboard password is required');
  }

  profile.name = name;
  if (paymentMethod) profile.paymentMethod = paymentMethod;
  profile.environments = profile.environments || {};
  profile.environments[env] = {
    brandId,
    apiKey: apiKey || existingKey,
    ...(dashboardUsername
      ? { dashboard: { username: dashboardUsername, password: keptPassword } }
      : {}),
  };
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

const KEY_PATTERN = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FRAMEWORK_KEY = '@framework';

function childEnvFor(env) {
  return { ...process.env, TEST_ENV: env, FORCE_COLOR: '0', TEST_PROFILE: '' };
}

/** Lists the tests of the flow projects (cached per environment for a short time). */
const catalogCache = new Map();
function listTests(env) {
  const cached = catalogCache.get(env);
  if (cached && Date.now() - cached.at < 15_000) return Promise.resolve(cached.data);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', '--list', '--reporter=json', '--project=cashier-purchase'],
      { cwd: ROOT, env: { ...childEnvFor(env), PSP_PURCHASE_IDS: '' }, shell: false },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      try {
        const json = JSON.parse(out.slice(out.indexOf('{')));
        const tests = [];
        const walk = (suite, group) => {
          for (const spec of suite.specs || []) {
            // JSON reporter lists tags without the leading '@'.
            const tags = (spec.tags || []).map((t) => (t.startsWith('@') ? t : `@${t}`));
            const key = tags.find((t) => /^@(FT-|card-|backoffice-smoke)/.test(t));
            if (!key) continue;
            tests.push({
              key,
              title: spec.title,
              group,
              transaction: tags.includes('@transaction'),
              expectation:
                tags
                  .find((t) => ['@accepted', '@rejected', '@observe', '@sanitized'].includes(t))
                  ?.slice(1) || '',
            });
          }
          for (const child of suite.suites || []) walk(child, child.title || group);
        };
        for (const suite of json.suites || []) walk(suite, suite.title);
        tests.push({
          key: '@psp-by-id',
          title: 'PSP check for existing purchase IDs (enter IDs below)',
          group: 'PSP check (read-only)',
          transaction: false,
          needsPurchaseIds: true,
          expectation: '',
        });
        tests.push({
          key: FRAMEWORK_KEY,
          title: 'Framework self-tests (offline)',
          group: 'Framework',
          transaction: false,
          expectation: '',
        });
        catalogCache.set(env, { at: Date.now(), data: tests });
        resolve(tests);
      } catch {
        reject(
          new HttpError(500, `Could not list tests: ${err.split('\n').slice(0, 5).join(' ')}`),
        );
      }
    });
  });
}

function maskedKey(key) {
  return typeof key === 'string' && key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

function startRun(input) {
  if (run && run.status === 'running') throw new HttpError(409, 'A run is already in progress');

  const env = String(input.env || '');
  if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
  const settings = effectiveSettings();
  const paymentMethod = String(input.paymentMethod || 'VISA')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9_]{2,30}$/.test(paymentMethod)) throw new HttpError(400, 'Invalid payment method');
  const currency = String(input.currency || '')
    .trim()
    .toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency))
    throw new HttpError(400, 'Currency must be a 3-letter ISO code');
  const bank = String(input.bank || '').trim();
  if (bank && !/^[\w .:/-]{1,80}$/.test(bank)) throw new HttpError(400, 'Invalid bank name');
  const payCard = String(input.payCard || '').trim();
  if (payCard && !settings.cards[env].some((c) => c.id === payCard)) {
    throw new HttpError(400, 'Unknown "pay with" card');
  }

  const keys = Array.isArray(input.testKeys) ? input.testKeys.map(String) : [];
  if (keys.length === 0) throw new HttpError(400, 'Select at least one test case');
  if (keys.length > 500 || keys.some((k) => !KEY_PATTERN.test(k))) {
    throw new HttpError(400, 'Invalid test selection');
  }
  const frameworkOnly = keys.length === 1 && keys[0] === FRAMEWORK_KEY;
  if (keys.includes(FRAMEWORK_KEY) && !frameworkOnly) {
    throw new HttpError(400, 'Run the framework self-tests on their own');
  }

  const prefix = env.toUpperCase();
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...childEnvFor(env),
    PAYMENT_METHOD: paymentMethod,
    RUN_CURRENCY: currency,
    RUN_BANK: bank,
    RUN_PAY_CARD: payCard,
    RUN_HEADED: input.headed === true ? '1' : '',
    ATTACH_HTTP_ALWAYS: '1',
  };
  const secrets = [];
  let who = 'one-off credentials';
  let brandId = '';
  let apiKeyHint = '';

  if (frameworkOnly) {
    who = '–';
  } else if (input.profileId) {
    const profile = readProfiles().profiles.find((p) => p.id === input.profileId);
    const creds = profile?.environments?.[env];
    if (!profile || !creds) throw new HttpError(400, `Profile has no ${prefix} credentials`);
    childEnv.TEST_PROFILE = profile.id;
    secrets.push(creds.apiKey);
    if (creds.dashboard?.password) secrets.push(creds.dashboard.password);
    who = profile.name;
    brandId = creds.brandId;
    apiKeyHint = maskedKey(creds.apiKey);
  } else {
    brandId = String(input.brandId || '').trim();
    const apiKey = String(input.apiKey || '').trim();
    if (!brandId || !apiKey) throw new HttpError(400, 'Brand ID and API key are required');
    childEnv[`${prefix}_BRAND_ID`] = brandId;
    childEnv[`${prefix}_API_KEY`] = apiKey;
    secrets.push(apiKey);
    apiKeyHint = maskedKey(apiKey);
    const dashboardUsername = String(input.dashboardUsername || '').trim();
    const dashboardPassword = String(input.dashboardPassword || '');
    if (dashboardUsername && dashboardPassword) {
      childEnv[`${prefix}_DASHBOARD_USERNAME`] = dashboardUsername;
      childEnv[`${prefix}_DASHBOARD_PASSWORD`] = dashboardPassword;
      secrets.push(dashboardPassword);
    }
  }

  const purchaseIds = String(input.purchaseIds || '')
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (purchaseIds.some((id) => !/^[A-Za-z0-9_-]{6,64}$/.test(id))) {
    throw new HttpError(400, 'Purchase IDs may only contain letters, digits, "-" and "_"');
  }
  if (keys.includes('@psp-by-id') && purchaseIds.length === 0) {
    throw new HttpError(400, 'Enter at least one purchase ID for the PSP check');
  }
  if (purchaseIds.length > 50) throw new HttpError(400, 'At most 50 purchase IDs per run');
  childEnv.PSP_PURCHASE_IDS = purchaseIds.join(',');

  const payWith = settings.cards[env].find((c) => c.id === payCard);
  childEnv.RUN_META = JSON.stringify({
    environment: prefix,
    tester: who,
    brandId,
    apiKey: apiKeyHint,
    currency: currency || `${settings.purchase[env].purchase.currency} (template)`,
    bank: bank || 'not checked',
    paymentMethod,
    payWithCard: payWith ? payWith.label : 'no transaction for field cases',
    selection: `${keys.length} test case(s)`,
  });

  const args = [
    PLAYWRIGHT_CLI,
    'test',
    `--project=${frameworkOnly ? 'framework' : 'cashier-purchase'}`,
  ];
  if (!frameworkOnly) {
    const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
    args.push('--grep', `(?:${escaped.join('|')})(?=\\s|$)`);
  }
  const workers = Number(input.workers || 0);
  if (!Number.isInteger(workers) || workers < 0 || workers > 16) {
    throw new HttpError(400, 'Workers must be 1–16 (or empty for default)');
  }
  if (input.headed === true) args.push('--workers=1');
  else if (workers > 0) args.push(`--workers=${workers}`);
  const retries = Number(input.retries || 0);
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
    throw new HttpError(400, 'Retries must be 0–3');
  }
  if (retries > 0) args.push(`--retries=${retries}`);
  const suite = {
    label: frameworkOnly ? 'Framework self-tests' : `${keys.length} selected test case(s)`,
  };
  const filter = '';

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
    hasPspCsv: fs.existsSync(PSP_CSV),
    hasUiReport: fs.existsSync(path.join(UI_REPORT_DIR, 'latest.json')),
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
        environments: environments(),
        paymentMethods: effectiveSettings().paymentMethods,
        profiles: publicProfiles(),
        run: runState(),
      });
    }
    if (method === 'GET' && url.pathname === '/api/tests') {
      const env = String(url.searchParams.get('env') || '');
      if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
      return send(res, 200, { tests: await listTests(env) });
    }
    if (method === 'GET' && url.pathname === '/api/report') {
      const name = String(url.searchParams.get('run') || 'latest');
      const file =
        name === 'latest'
          ? path.join(UI_REPORT_DIR, 'latest.json')
          : /^[0-9T-]{19}$/.test(name)
            ? path.join(UI_REPORT_DIR, 'history', `${name}.json`)
            : undefined;
      if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No report yet');
      return send(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (method === 'GET' && url.pathname === '/api/reports') {
      const dir = path.join(UI_REPORT_DIR, 'history');
      const runs = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort()
            .reverse()
            .slice(0, 30)
        : [];
      return send(res, 200, { runs });
    }
    if (method === 'GET' && url.pathname === '/api/settings') {
      return send(res, 200, settingsView());
    }
    if (method === 'PUT' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      if (body.value === undefined || body.value === null)
        throw new HttpError(400, 'Missing value');
      updateSettings(String(body.path || ''), body.value);
      return send(res, 200, settingsView());
    }
    if (method === 'DELETE' && url.pathname === '/api/settings') {
      const dotted = String(url.searchParams.get('path') || '');
      if (!SETTINGS_PATHS.includes(dotted)) throw new HttpError(400, 'Unknown settings section');
      const local = settingsCore.readJson(settingsCore.SETTINGS_FILE);
      setAt(local, dotted, undefined);
      writeLocalSettings(local);
      return send(res, 200, settingsView());
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
    if (method === 'GET' && url.pathname === '/psp-results.csv') {
      if (!fs.existsSync(PSP_CSV)) throw new HttpError(404, 'No PSP results yet');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="psp-validation-results.csv"',
        'cache-control': 'no-store',
      });
      return fs.createReadStream(PSP_CSV).pipe(res);
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
