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
const { DashboardClient, DashboardError } = require('./dashboard');
const caseImport = require('./test-case-import');
const paymentMethodCases = require('./payment-method-cases');
const regexCases = require('./regex-cases');
const { reportWorkbook } = require('./report-xlsx');
const ai = require('./ai-generate');
const cardImport = require('./card-import');
const maskingRules = require('../../config/masking-rules');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.LAUNCHER_DATA_DIR ? path.resolve(process.env.LAUNCHER_DATA_DIR) : ROOT;
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.local.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const REPORT_DIR = path.join(ROOT, 'reports', 'html');
const RESULTS_CSV = path.join(ROOT, 'reports', 'field-tests', 'field-test-results.csv');
const PSP_CSV = path.join(ROOT, 'reports', 'psp-validation', 'psp-validation-results.csv');
const UI_REPORT_DIR = path.join(ROOT, 'reports', 'ui');
/** Screenshots / videos / docs per 3DS flow: psp-flows/<flow id>/<file> (videos stay local – git-ignored). */
const FLOW_FILES_DIR = path.join(DATA_DIR, 'psp-flows');
const FLOW_FILE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
const MAX_FLOW_FILE_BYTES = 200 * 1024 * 1024;
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli', { paths: [ROOT] });

const HOST = '127.0.0.1';
const PORT = Number(process.env.LAUNCHER_PORT || 4173);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 64 * 1024;
/** Excel/CSV uploads arrive base64-encoded in JSON (≈4.5 MB file). */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_LOG_LINES = 5000;

const ENVIRONMENT_IDS = ['uat', 'local'];
/** Cashier devices – keep in sync with src/pages/devices.ts. */
const DEVICES = {
  desktop: 'Desktop – Chrome, 1280×900',
  'tablet-ipad': 'Tablet – iPad',
  'tablet-android': 'Tablet – Galaxy Tab S4',
  'phone-iphone': 'Phone – iPhone 14',
  'phone-android': 'Phone – Pixel 7',
};

// ── settings (config/defaults.json + settings.local.json) ─────────────────────

/** Sections the UI may change. */
const SETTINGS_PATHS = [
  'run',
  'auth',
  'environments.uat',
  'environments.local',
  'purchase.uat',
  'purchase.local',
  's2s.uat',
  's2s.local',
  'session.uat',
  'session.local',
  's2sLibrary.uat',
  's2sLibrary.local',
  'sessionLibrary.uat',
  'sessionLibrary.local',
  'cards.uat',
  'cards.local',
  'masking',
  'threeDsFlows',
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
    maskingFields: maskingRules.FIELDS.map(({ id, label, group, hint }) => ({
      id,
      label,
      group,
      hint,
    })),
  };
}

// ── dashboard (banks, MIDs, merchants) ─────────────────────────────────────

/** @type {Map<string, InstanceType<typeof DashboardClient>>} */
const dashboards = new Map();

/** Dashboard client for a tester profile (their own dashboard login). */
function dashboardFor(env, profileId) {
  if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
  const profile = readProfiles().profiles.find((p) => p.id === profileId);
  const creds = profile?.environments?.[env];
  if (!creds) throw new HttpError(400, `Select a tester with ${env.toUpperCase()} credentials`);
  if (!creds.dashboard?.username || !creds.dashboard?.password) {
    throw new HttpError(400, 'This tester has no dashboard login – add it in the Testers tab');
  }
  const baseUrl = effectiveSettings().environments[env].baseUrl;
  if (!baseUrl)
    throw new HttpError(400, `No dashboard URL for ${env.toUpperCase()} – set it in Environments`);
  const key = `${env}|${baseUrl}|${creds.dashboard.username}`;
  let client = dashboards.get(key);
  if (!client || client.password !== creds.dashboard.password) {
    client = new DashboardClient({
      baseUrl,
      username: creds.dashboard.username,
      password: creds.dashboard.password,
    });
    dashboards.set(key, client);
  }
  return { client, creds };
}

/** Wraps dashboard calls so login/network problems become readable 502s. */
async function fromDashboard(load) {
  try {
    return await load();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      error instanceof DashboardError ? message : `Dashboard unreachable: ${message}`,
    );
  }
}

/** Limits/Charges routing of the tester's merchant: currency + payment method → MID / bank. */
async function routingFor(env, profileId) {
  const { client, creds } = dashboardFor(env, profileId);
  if (!creds.merchant) {
    throw new HttpError(400, 'Set the merchant of this tester in the Testers tab first');
  }
  return fromDashboard(async () => ({
    merchant: creds.merchant,
    routes: (await client.routing(creds.merchant.id)).map((r) => ({
      currency: r.currency,
      paymentMethod: r.paymentMethod,
      routeTo: r.routeTo,
      targets: r.targets.map((t) => ({ id: t.id, name: t.name })),
    })),
  }));
}

/**
 * Dashboard health check of a tester (Testers tab → Check dashboard): login, merchant, Limits/Charges
 * routing, KYC Bank MID and the saved KYC switch – each step ok / warn / fail / skip with a reason.
 * Fresh data: the client cache is cleared first. Nothing is changed on the dashboard.
 */
async function dashboardHealth(env, profileId) {
  /** @type {{id:string, title:string, status:'ok'|'warn'|'fail'|'skip', detail:string, action?:string}[]} */
  const steps = [];
  const add = (id, title, status, detail, action) =>
    steps.push({ id, title, status, detail, ...(action ? { action } : {}) });
  const skipRest = (from) => {
    const all = [
      ['login', 'Dashboard connection'],
      ['merchant', 'Merchant'],
      ['routing', 'Limits / Charges routing'],
      ['kyc', 'KYC Bank MID'],
      ['switch', 'KYC cases on the Run tab'],
    ];
    for (const [id, title] of all.slice(all.findIndex(([i]) => i === from)))
      if (!steps.some((st) => st.id === id))
        add(id, title, 'skip', 'Not checked – fix the step above first');
  };
  const message = (error) => (error instanceof Error ? error.message : String(error));
  const baseUrl = isEnv(env) ? effectiveSettings().environments[env].baseUrl || '' : '';
  const result = (extra = {}) => ({
    env: env.toUpperCase(),
    dashboardUrl: baseUrl,
    steps,
    ...extra,
  });

  const profile = readProfiles().profiles.find((p) => p.id === profileId);
  if (profile && !profile.environments?.[env]) {
    add(
      'login',
      'Dashboard connection',
      'fail',
      `${profile.name} has no ${env.toUpperCase()} credentials`,
      `Switch the environment at the top, or add ${env.toUpperCase()} credentials for ${profile.name} and save.`,
    );
    skipRest('merchant');
    return result();
  }
  let client;
  let creds;
  try {
    ({ client, creds } = dashboardFor(env, profileId));
  } catch (error) {
    add(
      'login',
      'Dashboard connection',
      'fail',
      message(error),
      'Add the dashboard username and password of this tester, then save.',
    );
    skipRest('merchant');
    return result();
  }
  client.clearCache();
  try {
    await client.login();
    add(
      'login',
      'Dashboard connection',
      'ok',
      `Signed in to ${new URL(baseUrl).host} as ${creds.dashboard.username}`,
    );
  } catch (error) {
    add(
      'login',
      'Dashboard connection',
      'fail',
      message(error),
      'Check the dashboard username / password (and the dashboard URL in Environments).',
    );
    skipRest('merchant');
    return result();
  }

  if (!creds.merchant) {
    add(
      'merchant',
      'Merchant',
      'fail',
      'No merchant chosen for this tester',
      'Click "Load merchants", pick the merchant of this brand and save the tester.',
    );
    skipRest('routing');
    return result();
  }
  const merchant = creds.merchant;
  try {
    const found = (await client.merchants()).find((m) => m.id === merchant.id);
    if (!found) {
      add(
        'merchant',
        'Merchant',
        'fail',
        `${merchant.name} (ID ${merchant.id}) is not visible to ${creds.dashboard.username}`,
        'Pick another merchant, or use a dashboard login that can see this one.',
      );
      skipRest('routing');
      return result({ merchant: merchant.name });
    }
    add('merchant', 'Merchant', 'ok', `${found.name} (ID ${found.id}) found in the dashboard`);
  } catch (error) {
    add('merchant', 'Merchant', 'fail', message(error));
    skipRest('routing');
    return result({ merchant: merchant.name });
  }

  try {
    const routes = await client.routing(merchant.id);
    const currencies = [...new Set(routes.map((r) => r.currency))];
    const methods = [...new Set(routes.map((r) => r.paymentMethod))];
    if (routes.length === 0)
      add(
        'routing',
        'Limits / Charges routing',
        'warn',
        'No currency / payment-method routes configured',
        'Add routing in Merchant → Limits/Charges – otherwise the Run tab cannot pick a currency, payment method or MID.',
      );
    else
      add(
        'routing',
        'Limits / Charges routing',
        'ok',
        `${routes.length} route${routes.length === 1 ? '' : 's'} · ${currencies.slice(0, 6).join(', ')}${currencies.length > 6 ? ' …' : ''} · ${methods.slice(0, 5).join(', ')}${methods.length > 5 ? ' …' : ''}`,
      );
  } catch (error) {
    add(
      'routing',
      'Limits / Charges routing',
      'warn',
      `Could not read the routing: ${message(error)}`,
    );
  }

  let kyc = { enabled: false, provider: '', mid: '' };
  try {
    const setup = await client.kycSetup(merchant.id);
    kyc = { enabled: setup.enabled, provider: setup.provider || '', mid: setup.mid || '' };
    if (setup.enabled)
      add(
        'kyc',
        'KYC Bank MID',
        'ok',
        `${[kyc.provider, kyc.mid].filter(Boolean).join(' – ') || `Bank MID ${setup.bankMidId}`} configured`,
      );
    else
      add(
        'kyc',
        'KYC Bank MID',
        'warn',
        'No KYC Bank MID configured – KYC cases would fail with kyc_not_enabled',
        'Select a KYC Bank MID in Merchant Details → Kyc Configuration, then check again.',
      );
  } catch (error) {
    add('kyc', 'KYC Bank MID', 'warn', `Could not read the Kyc Configuration: ${message(error)}`);
  }

  const saved = creds.kyc?.enabled === true;
  if (saved === kyc.enabled)
    add(
      'switch',
      'KYC cases on the Run tab',
      'ok',
      saved ? 'On – matches the dashboard' : 'Off – matches the dashboard',
    );
  else
    add(
      'switch',
      'KYC cases on the Run tab',
      'warn',
      `Saved as ${saved ? 'on' : 'off'}, the dashboard says ${kyc.enabled ? 'on' : 'off'} – switched below`,
      'Click "Save tester" to keep the corrected KYC switch.',
    );
  return result({ merchant: merchant.name, kyc });
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
    environments: Object.fromEntries(
      Object.entries(p.environments || {}).map(([env, c]) => [
        env,
        {
          brandId: c.brandId,
          apiKeyHint: keyHint(c.apiKey),
          dashboardUsername: c.dashboard?.username || '',
          hasDashboardPassword: Boolean(c.dashboard?.password),
          merchant: c.merchant || null,
          kyc: c.kyc || { enabled: false },
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
  // Payment method is chosen per run (from the MID), not stored on the tester.
  delete profile.paymentMethod;
  profile.environments = profile.environments || {};
  const merchantId = Number(input.merchantId || 0);
  const merchant =
    merchantId > 0
      ? {
          id: merchantId,
          name: String(input.merchantName || '')
            .trim()
            .slice(0, 120),
        }
      : existing?.merchant;
  // KYC is merchant configuration (Merchant Details → Kyc Configuration): only a merchant with a
  // KYC MID can run the KYC cases. The tester switch decides whether they are offered on the Run tab.
  const kyc =
    input.kycEnabled === undefined
      ? existing?.kyc
      : {
          enabled: input.kycEnabled === true,
          ...(input.kycEnabled === true && input.kycMid
            ? { mid: String(input.kycMid).slice(0, 120) }
            : {}),
        };
  profile.environments[env] = {
    brandId,
    apiKey: apiKey || existingKey,
    ...(merchant ? { merchant } : {}),
    ...(kyc ? { kyc } : {}),
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

/** Card IDs of the Test cards tab for an environment (template dropdown / preview warnings). */
function cardIdsFor(url, envOverride) {
  const env = String(envOverride || url.searchParams.get('env') || '');
  if (!isEnv(env)) return [];
  return (effectiveSettings().cards[env] || []).map((c) => c.id);
}

function childEnvFor(env) {
  const childEnv = { ...process.env, TEST_ENV: env, FORCE_COLOR: '0', TEST_PROFILE: '' };
  delete childEnv.ANTHROPIC_API_KEY; // tests never need AI credentials
  delete childEnv.AI_GATEWAY_TOKEN;
  return childEnv;
}

/** Everything the AI needs to know for one category (no secrets, no card numbers). */
async function aiContext(category, env, profileId, bank, mid = '') {
  const settings = effectiveSettings();
  const cards = settings.cards[env] || [];
  const ctx = {
    cards: cards.map((c) => ({
      id: c.id,
      label: c.label,
      expectedOutcome: c.expectedOutcome,
      expectedStatuses: c.expectedStatuses,
      challenge: c.challenge,
    })),
    cardIds: cards.map((c) => c.id),
    purchaseTemplate: settings.purchase[env],
    existing: [],
  };
  if (category === 'field') {
    for (const c of caseImport.builtinFieldCases()) {
      const v = c.mutation?.type === 'set' ? JSON.stringify(c.mutation.value) : c.mutation?.type;
      ctx.existing.push(`${c.path} = ${String(v).slice(0, 40)} → ${c.expectation}`);
    }
    for (const c of caseImport.loadCases('field')) ctx.existing.push(`${c.path} – ${c.title}`);
    try {
      const { client } = dashboardFor(env, profileId);
      ctx.paymentMethods = paymentMethodCases.describeMethods(await client.paymentMethods());
    } catch {
      /* no dashboard login – the AI still gets the generic extraParam rules */
    }
  } else if (category === 'regex') {
    if (!/^[\w .-]{1,80}$/.test(bank)) throw new HttpError(400, 'Choose a bank first');
    const { client } = dashboardFor(env, profileId);
    ctx.bank = bank;
    ctx.country = settings.purchase[env]?.client?.country || 'AT';
    ctx.rules = await fromDashboard(() => client.fieldRules(bank));
    if (Object.keys(ctx.rules).length === 0)
      throw new HttpError(400, `${bank} has no field regexes configured`);
    for (const c of caseImport.loadCases('regex')) {
      if (!c.bank || c.bank === bank) ctx.existing.push(`${c.field} = ${c.value}`);
    }
  } else if (category === 'bank-config') {
    const { client, creds } = dashboardFor(env, profileId);
    if (!creds.merchant)
      throw new HttpError(400, 'Set the merchant of this tester in the Testers tab first');
    let midName = String(mid || '')
      .split(',')[0]
      .trim();
    if (!midName) {
      const routing = await routingFor(env, profileId);
      midName = routing.routes.find((r) => r.routeTo === 'route_to_mid')?.targets[0]?.name || '';
    }
    if (!/^[\w .:/-]{1,120}$/.test(midName))
      throw new HttpError(
        400,
        'No routed MID – choose currency / payment method on the Run tab (Routes to)',
      );
    ctx.bankConfig = await fromDashboard(() =>
      client.bankConfigContext(midName, creds.merchant.id),
    );
    if (!ctx.bankConfig) throw new HttpError(400, `MID ${midName} was not found in the dashboard`);
    ctx.currency = settings.purchase[env]?.purchase?.currency || 'EUR';
    ctx.existing.push(
      'BM-003/004 2D only 0/1 · BM-005/006 partial refund 0/1 · BM-007 convert to {other} + merchant conversion 1 · BM-008 convert to {other} + merchant conversion 0 · BM-009 allowed currencies {other} · BM-010 allowed cards {other} (built-in)',
    );
    for (const c of caseImport.loadCases(category))
      ctx.existing.push(`${c.title} – ${caseImport.summarize(category, c).join(' | ')}`);
  } else if (category === 's2s') {
    ctx.s2sTemplate = settings.s2s?.[env];
    ctx.existing.push(
      'S2S-010…029 built-in: no auth, key without Bearer, text/plain, unknown purchase, Luhn, card_number / cvc / cardholder_name / expires / remember_card missing, MMYY expiry, expired 01/20, month 13, letters in the number, remote_ip / user_agent / accept_header missing, malformed JSON, second call, APM purchase',
    );
    for (const c of caseImport.loadCases(category))
      ctx.existing.push(`${c.title} – ${caseImport.summarize(category, c).join(' | ')}`);
  } else if (category === 'refund') {
    ctx.currency = settings.purchase[env]?.purchase?.currency || 'EUR';
    ctx.total = settings.purchase[env]?.purchase?.total;
    ctx.existing.push(
      'RF-002 partial 30% · RF-003 more than refundable → invalid_amount · RF-004 amount 0 · RF-005 rest → refunded · RF-006 refund after full refund · RF-007 unpaid purchase · RF-008 no reason · RF-009 no amount (built-in)',
    );
    for (const c of caseImport.loadCases(category))
      ctx.existing.push(`${c.title} – ${caseImport.summarize(category, c).join(' | ')}`);
  } else {
    for (const c of caseImport.loadCases(category)) ctx.existing.push(c.title);
  }
  return ctx;
}

/** Lists the tests of the flow projects (cached per environment for a short time). */
const catalogCache = new Map();
function listTests(env) {
  const cached = catalogCache.get(env);
  if (cached && Date.now() - cached.at < 15_000) return Promise.resolve(cached.data);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        PLAYWRIGHT_CLI,
        'test',
        '--list',
        '--reporter=json',
        '--project=cashier-purchase',
        '--project=s2s-purchase',
        '--project=session',
        '--project=kyc',
      ],
      {
        cwd: ROOT,
        env: { ...childEnvFor(env), PSP_PURCHASE_IDS: '', KYC_INCLUDE_SLOW: '1' },
        shell: false,
      },
    );
    child.on('error', (error) =>
      reject(new HttpError(500, `Could not list tests: ${error.message}`)),
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
            const key = tags.find((t) =>
              /^@(FT-|FV-|RX-|PR-|EC-|RF-|RC-|BM-|BC-|S2S-|S2-|s2s-card-|SES-|session-card-|KYC-|KV-|card-|backoffice-smoke)/.test(
                t,
              ),
            );
            if (!key) continue;
            // KYC and refund cases each form one group on the Run tab; the spec's section becomes a label.
            const isKyc = /^@(KYC|KV)-/.test(key);
            const isRefund = /^@(RF|RC)-/.test(key);
            const isBank = /^@(BM|BC)-/.test(key);
            const section = isKyc
              ? String(group).replace(/^KYC verification › /, '')
              : isRefund
                ? key.startsWith('@RC-')
                  ? 'Uploaded cases'
                  : /request validation/i.test(group)
                    ? 'Request validation'
                    : 'Refund flow'
                : isBank
                  ? key.startsWith('@BC-')
                    ? 'Uploaded cases'
                    : 'Built-in checks'
                  : undefined;
            tests.push({
              key,
              title: spec.title,
              group: isKyc
                ? 'KYC verification'
                : isRefund
                  ? 'Cashier purchase › 5. Refunds'
                  : isBank
                    ? 'Cashier purchase › 6. Bank & MID configuration'
                    : group,
              ...(section ? { section } : {}),
              transaction: tags.includes('@transaction'),
              // KYC: @slow waits minutes on the expiry poller, @sumsub drives the provider's UI.
              slow: tags.includes('@slow'),
              provider: tags.includes('@sumsub'),
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
          group: 'PSP check – existing purchase IDs (read-only)',
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
  const mid = String(input.mid || '').trim();
  if (mid && !/^[\w .:/,-]{1,400}$/.test(mid)) throw new HttpError(400, 'Invalid MID');
  const device = String(input.device || 'desktop');
  if (!Object.hasOwn(DEVICES, device)) throw new HttpError(400, 'Unknown device');
  const payCard = String(input.payCard || '').trim();
  if (payCard && !settings.cards[env].some((c) => c.id === payCard)) {
    throw new HttpError(400, 'Unknown payment card');
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

  // Bank & MID cases flip shared bank / MID / merchant settings (and restore them):
  // they run on their own, one at a time, so no other test sees a flipped setting.
  const bankConfigKeys = keys.filter((k) => /^@(BM|BC)-/.test(k));
  if (bankConfigKeys.length > 0 && bankConfigKeys.length !== keys.length) {
    throw new HttpError(
      400,
      'Bank & MID configuration cases change shared bank / MID settings while they run – run them on their own (unselect the other cases).',
    );
  }

  const prefix = env.toUpperCase();
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...childEnvFor(env),
    PAYMENT_METHOD: paymentMethod,
    RUN_CURRENCY: currency,
    RUN_BANK: bank,
    RUN_MID: mid,
    RUN_PAY_CARD: payCard,
    RUN_DEVICE: device,
    RUN_PAY_FIELD_CASES: payCard && input.payFieldCases === true ? '1' : '',
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
    if (bankConfigKeys.length > 0 && !(creds.dashboard?.username && creds.dashboard?.password)) {
      throw new HttpError(
        400,
        `Bank & MID cases change settings through the dashboard – add a dashboard login (SUPERADMIN) for ${profile.name} (${prefix}) on the Testers tab.`,
      );
    }
    brandId = creds.brandId;
    apiKeyHint = maskedKey(creds.apiKey);
    const kycKeys = keys.filter((k) => /^@(KYC|KV)-/.test(k));
    if (kycKeys.length > 0 && creds.kyc?.enabled !== true) {
      throw new HttpError(
        400,
        `KYC is off for ${profile.name} (${prefix}) – ${kycKeys.length} KYC case(s) selected. ` +
          'Enable KYC for this tester on the Testers tab (the merchant needs a KYC Bank MID in Merchant Details → Kyc Configuration), or unselect them.',
      );
    }
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
  // KYC @slow / @sumsub cases run when selected (the project skips them otherwise).
  childEnv.KYC_INCLUDE_SLOW = '1';
  const refundPurchaseId = String(input.refundPurchaseId || '').trim();
  if (refundPurchaseId && !/^[A-Za-z0-9_-]{6,64}$/.test(refundPurchaseId)) {
    throw new HttpError(
      400,
      'The purchase ID to refund may only contain letters, digits, "-" and "_"',
    );
  }
  childEnv.REFUND_PURCHASE_ID = refundPurchaseId;

  const payWith = settings.cards[env].find((c) => c.id === payCard);
  childEnv.RUN_META = JSON.stringify({
    environment: prefix,
    tester: who,
    brandId,
    apiKey: apiKeyHint,
    currency: currency || `${settings.purchase[env].purchase.currency} (template)`,
    bank: bank || 'not checked',
    mid: mid || 'not checked',
    paymentMethod,
    device: DEVICES[device],
    payWithCard: payWith
      ? `${payWith.label}${input.payFieldCases === true ? ' (also for accepted field cases)' : ''}`
      : 'none',
    selection: `${keys.length} test case(s)`,
  });

  const args = [
    PLAYWRIGHT_CLI,
    'test',
    ...(frameworkOnly
      ? ['--project=framework']
      : [
          '--project=cashier-purchase',
          '--project=s2s-purchase',
          '--project=session',
          '--project=kyc',
        ]),
  ];
  if (!frameworkOnly) {
    const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
    args.push('--grep', `(?:${escaped.join('|')})(?=\\s|$)`);
  }
  const workers = Number(input.workers || 0);
  if (!Number.isInteger(workers) || workers < 0 || workers > 16) {
    throw new HttpError(400, 'Workers must be 1–16 (or empty for default)');
  }
  if (input.headed === true || bankConfigKeys.length > 0) args.push('--workers=1');
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
  child.on('error', (error) => {
    pushLine(`■ could not start the test run: ${error.message}`);
    if (run) run.status = 'failed';
    broadcast('status', runState());
  });
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
    pruneRunHistory();
    broadcast('status', runState());
  });
  return run.id;
}

/** History file name of a run (same as the UI reporter): finish time in UTC, e.g. 2026-10-06T12-18-14. */
const runStamp = (finishedAt) =>
  String(finishedAt || '')
    .replace(/[:.]/g, '-')
    .slice(0, 19);

/**
 * Keeps only the newest `run.keepRuns` reports (Advanced → Logging & reports, default 5)
 * in reports/ui/history – the Report tab's run list. latest.json is never touched.
 */
function pruneRunHistory() {
  const dir = path.join(UI_REPORT_DIR, 'history');
  const keep = effectiveSettings().run.keepRuns ?? 5;
  let removed = 0;
  try {
    const old = fs
      .readdirSync(dir)
      .filter((f) => /^[\w-]+\.json$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed++;
    }
  } catch {
    /* no history yet */
  }
  return removed;
}

/** Report files from the last run – they survive a launcher restart. */
function reportFiles() {
  return {
    hasReport: fs.existsSync(path.join(REPORT_DIR, 'index.html')),
    hasCsv: fs.existsSync(RESULTS_CSV),
    hasPspCsv: fs.existsSync(PSP_CSV),
    hasUiReport: fs.existsSync(path.join(UI_REPORT_DIR, 'latest.json')),
  };
}

function runState() {
  if (!run) return { status: 'idle', ...reportFiles() };
  return {
    id: run.id,
    status: run.status,
    exitCode: run.exitCode,
    summary: run.summary,
    startedAt: run.startedAt,
    meta: run.meta,
    ...reportFiles(),
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

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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
  fs.createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
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

    // Branding images (logo, favicon) – only files that exist in tools/launcher/assets.
    const asset = /^\/assets\/([a-z0-9-]+\.(?:png|svg))$/.exec(url.pathname);
    if (method === 'GET' && asset) {
      const file = path.join(__dirname, 'assets', asset[1]);
      if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)],
        'cache-control': 'max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      return fs.createReadStream(file).pipe(res);
    }
    // 3DS flows: files (screenshots, a recording, PSP docs) of one bank's flow.
    const flowFile = /^\/api\/three-ds\/([a-z0-9][a-z0-9-]{0,47})\/files(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (flowFile) {
      const dir = path.join(FLOW_FILES_DIR, flowFile[1]);
      const name = flowFile[2] === undefined ? '' : decodeURIComponent(flowFile[2]);
      const safe = (n) => /^[\w.() -]{1,120}$/.test(n) && !n.startsWith('.');
      if (method === 'GET' && name === '') {
        const files = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => safe(f) && FLOW_FILE_TYPES[path.extname(f).toLowerCase()])
              .map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size }))
          : [];
        return send(res, 200, { files });
      }
      if (!safe(name) || !FLOW_FILE_TYPES[path.extname(name).toLowerCase()]) {
        throw new HttpError(
          400,
          'File type not supported – use PNG / JPG / GIF / WEBP, PDF, MP4 / MOV / WEBM or TXT / MD',
        );
      }
      const file = path.join(dir, name);
      if (method === 'GET') {
        if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
        res.writeHead(200, {
          'content-type': FLOW_FILE_TYPES[path.extname(name).toLowerCase()],
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (method === 'PUT') {
        // Raw body (no JSON / base64) so a screen recording of a few minutes fits.
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.part`;
        await new Promise((resolve, reject) => {
          let size = 0;
          const out = fs.createWriteStream(tmp);
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_FLOW_FILE_BYTES) {
              req.destroy();
              out.destroy();
              fs.rmSync(tmp, { force: true });
              reject(new HttpError(413, 'File too large (max 200 MB)'));
            }
          });
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          req.on('error', reject);
        });
        fs.renameSync(tmp, file);
        return send(res, 200, { file: name, bytes: fs.statSync(file).size });
      }
      if (method === 'DELETE') {
        fs.rmSync(file, { force: true });
        return send(res, 200, { deleted: name });
      }
    }
    if (method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(HTML_FILE, 'utf8').replace('__LAUNCHER_TOKEN__', TOKEN);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/api/options') {
      return send(res, 200, {
        environments: environments(),
        profiles: publicProfiles(),
        run: runState(),
      });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/dashboard/')) {
      const env = String(url.searchParams.get('env') || '');
      const profileId = String(url.searchParams.get('profileId') || '');
      const what = url.pathname.slice('/api/dashboard/'.length);
      if (what === 'merchants') {
        const { client } = dashboardFor(env, profileId);
        const merchants = await fromDashboard(() => client.merchants());
        return send(res, 200, { merchants: merchants.map((m) => ({ id: m.id, name: m.name })) });
      }
      if (what === 'kyc') {
        const { client, creds } = dashboardFor(env, profileId);
        if (!creds.merchant) {
          throw new HttpError(400, 'Choose the merchant of this tester first (Load merchants)');
        }
        const setup = await fromDashboard(() => client.kycSetup(creds.merchant.id));
        return send(res, 200, { merchant: creds.merchant.name, ...setup });
      }
      if (what === 'banks') {
        const { client } = dashboardFor(env, profileId);
        const banks = await fromDashboard(() => client.banks());
        const names = banks.map((b) => b.name);
        const mids = String(url.searchParams.get('mids') || '')
          .split(',')
          .filter(Boolean);
        const suggested = mids.map((m) => regexCases.bankForMid(m, names)).find(Boolean) || '';
        return send(res, 200, { banks: names, suggested });
      }
      if (what === 'payment-methods') {
        const { client } = dashboardFor(env, profileId);
        const methods = await fromDashboard(() => client.paymentMethods());
        return send(res, 200, { methods });
      }
      if (what === 'payment-method-cases') {
        const name = String(url.searchParams.get('method') || '').trim();
        if (!/^[\w .-]{1,80}$/.test(name)) throw new HttpError(400, 'Choose a payment method');
        const { client } = dashboardFor(env, profileId);
        const method = (await fromDashboard(() => client.paymentMethods())).find(
          (m) => m.name === name,
        );
        if (!method) throw new HttpError(404, `${name} is not a payment method in the dashboard`);
        const preview = caseImport.previewObjects(
          'field',
          paymentMethodCases.rowsForMethod(method),
        );
        return send(res, 200, { method, ...preview });
      }
      if (what === 'regex-rules') {
        const bank = String(url.searchParams.get('bank') || '').trim();
        if (!/^[\w .-]{1,80}$/.test(bank)) throw new HttpError(400, 'Choose a bank');
        const { client } = dashboardFor(env, profileId);
        const rules = await fromDashboard(() => client.fieldRules(bank));
        const generated = regexCases.casesForBank(bank, rules, {
          country: effectiveSettings().purchase[env]?.client?.country,
        });
        return send(res, 200, {
          bank,
          rules: generated.rules,
          ...caseImport.markDuplicates('regex', generated.cases),
        });
      }
      if (what === 'health') {
        return send(res, 200, await dashboardHealth(env, profileId));
      }
      if (what === 'routing') {
        return send(res, 200, await routingFor(env, profileId));
      }
      throw new HttpError(404, 'Not found');
    }
    if (method === 'POST' && url.pathname === '/api/dashboard/refresh') {
      for (const client of dashboards.values()) client.clearCache();
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === '/api/tests') {
      const env = String(url.searchParams.get('env') || '');
      if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
      return send(res, 200, { tests: await listTests(env) });
    }
    if (
      method === 'GET' &&
      (url.pathname === '/api/report' || url.pathname === '/api/report.xlsx')
    ) {
      const name = String(url.searchParams.get('run') || 'latest');
      const latestFile = path.join(UI_REPORT_DIR, 'latest.json');
      let file =
        name === 'latest'
          ? latestFile
          : /^[0-9T-]{19}$/.test(name)
            ? path.join(UI_REPORT_DIR, 'history', `${name}.json`)
            : undefined;
      // A run already pruned from history may still be the latest one.
      if (file && !fs.existsSync(file) && name !== 'latest' && fs.existsSync(latestFile)) {
        const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
        if (runStamp(latest.finishedAt) === name) file = latestFile;
      }
      if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No report yet');
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (url.pathname === '/api/report') return send(res, 200, report);
      // One presentable workbook (Summary + Results) for sharing – named after the run's
      // local finish time (the time shown on the report page), not UTC.
      const finished = report.finishedAt ? new Date(report.finishedAt) : undefined;
      const two = (n) => String(n).padStart(2, '0');
      const stamp =
        finished && !Number.isNaN(finished.getTime())
          ? `${finished.getFullYear()}-${two(finished.getMonth() + 1)}-${two(finished.getDate())}_${two(finished.getHours())}-${two(finished.getMinutes())}-${two(finished.getSeconds())}`
          : '';
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="test-report-${stamp || name}.xlsx"`,
        'cache-control': 'no-store',
      });
      return res.end(await reportWorkbook(report));
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
            .slice(0, effectiveSettings().run.keepRuns ?? 5)
        : [];
      return send(res, 200, { runs });
    }
    // ── uploaded test cases (Excel/CSV, by category → tests/test-data/uploaded-cases) ──
    if (method === 'GET' && url.pathname === '/api/test-cases') {
      return send(res, 200, { categories: caseImport.listCategories() });
    }
    if (method === 'GET' && url.pathname === '/api/test-cases/template.xlsx') {
      const category = String(url.searchParams.get('category') || '');
      if (!caseImport.CATEGORIES[category]) throw new HttpError(400, 'Unknown category');
      const buffer = Buffer.from(await caseImport.templateBuffer(category, cardIdsFor(url)));
      const name = caseImport.CATEGORIES[category].label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${name}-template.xlsx"`,
        'cache-control': 'no-store',
      });
      return res.end(buffer);
    }
    if (method === 'POST' && url.pathname === '/api/test-cases/preview') {
      const body = await readJson(req, MAX_UPLOAD_BYTES);
      const category = String(body.category || '');
      if (!caseImport.CATEGORIES[category]) throw new HttpError(400, 'Choose a category');
      const filename = String(body.filename || '');
      if (!/\.(xlsx|csv)$/i.test(filename))
        throw new HttpError(400, 'Upload an .xlsx or .csv file');
      const buffer = Buffer.from(String(body.data || ''), 'base64');
      if (buffer.length === 0) throw new HttpError(400, 'The file is empty');
      try {
        return send(
          res,
          200,
          await caseImport.previewImport(category, buffer, filename, cardIdsFor(url, body.env)),
        );
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }
    if (method === 'GET' && url.pathname === '/api/ai/status') {
      return send(res, 200, ai.aiStatus());
    }
    // "Set up AI" window: gateway link + token go to this computer's .env only (git-ignored).
    if (method === 'POST' && url.pathname === '/api/ai/setup') {
      const body = await readJson(req);
      try {
        return send(res, 200, await ai.setupGateway(body));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    }
    if (method === 'POST' && url.pathname === '/api/test-cases/generate') {
      const body = await readJson(req);
      const category = String(body.category || '');
      if (!caseImport.CATEGORIES[category]) throw new HttpError(400, 'Choose a category');
      const env = String(body.env || '');
      if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
      const ctx = await aiContext(
        category,
        env,
        String(body.profileId || ''),
        String(body.bank || '').trim(),
        String(body.mid || '').trim(),
      );
      try {
        return send(res, 200, await ai.generateCases(category, body, ctx));
      } catch (error) {
        throw new HttpError(502, error.message);
      }
    }
    if (method === 'POST' && url.pathname === '/api/test-cases/refine') {
      const body = await readJson(req, MAX_UPLOAD_BYTES);
      try {
        return send(
          res,
          200,
          await ai.refineCases(String(body.session || ''), {
            instruction: body.instruction,
            rejected: body.rejected,
          }),
        );
      } catch (error) {
        throw new HttpError(error instanceof ai.ConversationGoneError ? 410 : 502, error.message);
      }
    }
    if (method === 'POST' && url.pathname === '/api/test-cases/ai-close') {
      const body = await readJson(req);
      return send(res, 200, { closed: ai.closeAiSession(String(body.session || '')) });
    }
    if (method === 'POST' && url.pathname === '/api/test-cases/append') {
      if (run && run.status === 'running')
        throw new HttpError(409, 'Wait for the current run to finish');
      const body = await readJson(req, MAX_UPLOAD_BYTES);
      const category = String(body.category || '');
      if (!caseImport.CATEGORIES[category]) throw new HttpError(400, 'Choose a category');
      let result;
      try {
        result = caseImport.appendCases(category, body.cases, String(body.filename || 'upload'));
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      catalogCache.clear();
      return send(res, 200, { ...result, categories: caseImport.listCategories() });
    }
    const caseMatch = /^\/api\/test-cases\/([A-Z][A-Z0-9]-\d{3,})$/.exec(url.pathname);
    if (method === 'DELETE' && caseMatch) {
      if (run && run.status === 'running')
        throw new HttpError(409, 'Wait for the current run to finish');
      try {
        caseImport.deleteCase(caseMatch[1]);
      } catch (error) {
        throw new HttpError(404, error.message);
      }
      catalogCache.clear();
      return send(res, 200, { categories: caseImport.listCategories() });
    }
    // Test cards tab: read a PSP's test-card page (or pasted text) and list the cards on it.
    if (method === 'POST' && url.pathname === '/api/cards/import-preview') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const env = String(body.env || '');
      if (!isEnv(env)) throw new HttpError(400, 'Unknown environment');
      let source = String(body.text || '');
      let link = '';
      if (!source.trim()) {
        link = String(body.url || '').trim();
        if (!link)
          throw new HttpError(400, 'Enter the link of the PSP test-card page, or paste its text');
        try {
          source = await cardImport.fetchPage(link);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new HttpError(
            502,
            /timeout|aborted/i.test(message) ? 'The page did not answer within 20 s' : message,
          );
        }
      }
      const result = cardImport.extractCards(source);
      const existing = new Set((effectiveSettings().cards[env] || []).map((c) => c.number));
      return send(res, 200, {
        source: link,
        title: result.title,
        defaults: result.defaults,
        cards: result.cards.map((c) => ({ ...c, exists: existing.has(String(c.number)) })),
      });
    }
    if (method === 'GET' && url.pathname === '/api/settings') {
      return send(res, 200, settingsView());
    }
    if (method === 'PUT' && url.pathname === '/api/settings') {
      const body = await readJson(req, 1024 * 1024); // a card list imported from a PSP page can be long
      if (body.value === undefined || body.value === null)
        throw new HttpError(400, 'Missing value');
      updateSettings(String(body.path || ''), body.value);
      if (String(body.path || '') === 'run') pruneRunHistory();
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

pruneRunHistory();
server.on('error', (error) => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
    process.stderr.write(
      `\n  Port ${PORT} is already in use – the launcher is probably still running in another terminal.\n` +
        `  Open http://${HOST}:${PORT} in the browser, or stop the old one first:\n` +
        `    lsof -ti tcp:${PORT} | xargs kill\n` +
        `  Or start this one on another port:  LAUNCHER_PORT=4174 npm run launcher\n\n`,
    );
    process.exit(1);
  }
  throw error;
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

// One unexpected error (a dropped connection, a dashboard timeout, a child
// process that fails to start) must not take the whole launcher down – log it
// and keep serving.
process.on('uncaughtException', (error) => {
  process.stderr.write(
    `\n[launcher] unexpected error (still running): ${error.stack || error.message}\n`,
  );
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `\n[launcher] unhandled promise rejection (still running): ${reason instanceof Error ? reason.stack : String(reason)}\n`,
  );
});

function shutdown() {
  if (run && run.status === 'running') run.child.kill();
  ai.closeAllAiSessions(); // frees the AI gateway seat
  setTimeout(() => process.exit(0), 400).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
