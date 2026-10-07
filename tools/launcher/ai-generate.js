// @ts-check
/**
 * AI-generated test cases for the launcher's Test cases tab, through the Paysecure AI gateway.
 *
 * Generate opens a gateway WebSocket session (one Claude conversation) that uses the
 * `paysecure-qa__generate-test-cases` skill (ai-skills/paysecure-qa, deployed to the gateway).
 * The launcher sends the category's columns and live context; the model answers JSON rows. The rows
 * go through the SAME parser / validation / duplicate check as an Excel upload and are only saved
 * after the tester ticks and adds them.
 *
 * Refine keeps the conversation: the tester asks for changes ("add 3 partial-refund cases, drop C4")
 * and the model answers only the changes (add / update / remove by ref). The launcher holds the
 * current rows, so when the gateway session has ended (idle, restart) a new session is seeded with
 * them and the conversation continues.
 *
 * Settings (shell env or .env, launcher only – test runs never get them):
 *   AI_GATEWAY_URL     ws://host:8081/v1/agent (an http:// URL of the same host also works)
 *   AI_GATEWAY_TOKEN   gateway API key (never logged, never sent in a prompt)
 *   AI_GATEWAY_SKILLS  pack (default: agent session with the skill pack) | inline (chat session,
 *                      SKILL.md as system prompt – cheaper, no gateway deployment needed)
 *   AI_GATEWAY_SKILL_PACK  default paysecure-qa · AI_GATEWAY_MODEL optional (gateway default)
 *   AI_SESSION_IDLE_S  close an unused conversation after this many seconds (default 300) – frees
 *                      the gateway seat; a later Refine re-seeds a new session.
 * Nothing secret is sent: no API keys, card numbers, passwords or dashboard data other than field
 * regexes and MID settings.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const caseImport = require('./test-case-import');
const { expectationLabel, FIELD_PATHS } = require('./regex-cases');
const pgsRules = require('../../config/pgs/pgs-rules');
const { GatewaySession, websocketUrl } = require('./ai-gateway');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_NAME = 'generate-test-cases';
const SKILL_FILE = path.join(ROOT, 'ai-skills', 'paysecure-qa', SKILL_NAME, 'SKILL.md');
const MAX_CASES = 50;
const MAX_ROWS = 300;
/** Agent sessions only need the Skill tool – everything that touches files, shells or the web is off. */
const DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
];

/** Reads only the AI settings from .env – the token is never passed on to test runs. */
/** Committed team default link (config/ai-gateway.json) – the token is never committed. */
function teamGatewayUrl() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ai-gateway.json'), 'utf8'));
    return String(data.url || '').trim();
  } catch {
    return '';
  }
}

function aiSettings() {
  let file = {};
  try {
    file = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
  } catch {
    /* no .env */
  }
  // A variable set in the environment (even empty) wins over .env.
  const read = (name) => String(process.env[name] ?? file[name] ?? '').trim();
  const rawUrl = read('AI_GATEWAY_URL') || teamGatewayUrl();
  let url = '';
  let urlError = '';
  if (rawUrl) {
    try {
      url = websocketUrl(rawUrl);
    } catch (error) {
      urlError = error.message;
    }
  }
  const skills = read('AI_GATEWAY_SKILLS').toLowerCase() === 'inline' ? 'inline' : 'pack';
  return {
    url,
    rawUrl,
    urlError,
    token: read('AI_GATEWAY_TOKEN'),
    model: read('AI_GATEWAY_MODEL'),
    skills,
    pack: read('AI_GATEWAY_SKILL_PACK') || 'paysecure-qa',
    idleMs: Math.max(30, Number(read('AI_SESSION_IDLE_S')) || 300) * 1000,
    turnMs: Math.max(30, Number(read('AI_GATEWAY_TURN_TIMEOUT_S')) || 240) * 1000,
  };
}

function aiStatus() {
  const s = aiSettings();
  let host;
  try {
    host = s.url ? new URL(s.url).host : '';
  } catch {
    host = '';
  }
  return {
    configured: s.url !== '' && s.token !== '',
    // For the "Set up AI" window: the link (never the token) and where the values come from.
    gatewayUrl: s.rawUrl,
    tokenSet: s.token !== '',
    lockedByEnvironment: ['AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN'].some(
      (n) => process.env[n] !== undefined,
    ),
    provider: 'gateway',
    model: s.urlError ? s.urlError : `Paysecure AI gateway (${host || 'not set'})`,
    skills: s.skills === 'pack' ? `skill pack ${s.pack}` : 'inline skill',
  };
}

/** Field names seen in PSP requests / responses of earlier runs (keys only, values never). */
function knownPspKeys() {
  const dir = path.join(ROOT, 'reports', 'ui');
  const keys = { request: new Set(), response: new Set() };
  const files = [path.join(dir, 'latest.json')];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'history')).sort().slice(-10))
      files.push(path.join(dir, 'history', f));
  } catch {
    /* no history */
  }
  const walk = (node, prefix, set, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = /^\d+$/.test(k) ? prefix : prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') walk(v, p, set, depth + 1);
      else if (p) set.add(p);
    }
  };
  for (const file of files) {
    try {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const t of report.tests || []) {
        walk(t.pspRequest, '', keys.request, 0);
        walk(t.pspResponse, '', keys.response, 0);
      }
    } catch {
      /* skip unreadable report */
    }
  }
  // Credential / card fields are never useful checks – keep them out of the prompt.
  const safe = (list) =>
    [...list]
      .filter((k) => !/secret|token|password|cvv|cvc|cardnum|pan\b|expiry|holdername/i.test(k))
      .slice(0, 120);
  return { request: safe(keys.request), response: safe(keys.response) };
}

function templateFields(template) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v))
        v.forEach((item, i) =>
          item && typeof item === 'object' ? walk(item, `${p}.${i}`) : out.push(`${p}.${i}`),
        );
      else if (v && typeof v === 'object') walk(v, p);
      else out.push(`${p} (e.g. ${JSON.stringify(v)})`);
    }
  };
  walk(template, '');
  return out;
}

/** Sections of docs/pgs-behaviour.md (read from the PGS backend) relevant to each category. */
const PGS_SECTIONS = {
  field: ['1.'],
  edge: ['1.', '4.'],
  regex: ['2.'],
  psp: ['3.', '4.'],
  kyc: ['6.'],
  refund: ['5.'],
  s2s: ['8.'],
  'bank-config': ['7.'],
};
function pgsBehaviour(categoryId) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, 'docs', 'pgs-behaviour.md'), 'utf8');
  } catch {
    return '';
  }
  const sections = text
    .split(/\n(?=## )/)
    .filter((s) => (PGS_SECTIONS[categoryId] || []).some((n) => s.startsWith(`## ${n}`)));
  return sections.length
    ? [
        'How PGS really behaves (from the backend code; "bug" = confirmed defect worth a test):',
        ...sections,
      ].join('\n')
    : '';
}

/** Context sent to the model for one category. */
function buildContext(categoryId, ctx) {
  const lines = [];
  const cards = (ctx.cards || []).map(
    (c) =>
      `- ${c.id}: ${c.label} → expected ${c.expectedOutcome}, status ${c.expectedStatuses.join('/')}` +
      `${c.challenge && c.challenge.action !== 'none' ? `, 3DS challenge (${c.challenge.action})` : ''}`,
  );
  if (categoryId === 'field' || categoryId === 'edge') {
    const { methodFields, extraParam, ...template } = ctx.purchaseTemplate || {};
    lines.push(
      'Purchase request fields (standard request, dummy data):',
      ...templateFields(template).map((f) => `- ${f}`),
    );
    if (extraParam || methodFields) {
      lines.push(
        'Payment-method fields set in Purchase data (keys only):',
        ...Object.keys(extraParam || {}).map((k) => `- extraParam.${k} (all methods)`),
        ...Object.entries(methodFields || {}).flatMap(([m, f]) =>
          Object.entries(f || {}).flatMap(([k, v]) =>
            k === 'extraParam' && v && typeof v === 'object'
              ? Object.keys(v).map((ek) => `- extraParam.${ek} (${m === '*' ? 'all methods' : m})`)
              : [`- ${k} (${m === '*' ? 'all methods' : m})`],
          ),
        ),
      );
    }
  }
  if (categoryId === 'field') {
    lines.push(
      'Payment-method parameters are dynamic – keys differ per payment method, never assume a fixed list:',
      '- Parameter extraParam.<key> (any key) or extraParam (the whole object, Test Data as JSON {"k":"v",…}); other method fields at the top level by name (upiId, invoiceNo …).',
      '- Context sets the payment method and the other keys first: paymentMethod=UPI; extraParam.accountNumber="123" (separate with ;).',
      '- Test Data: "Field not sent", "" (empty), null, 123 (no quotes), true (boolean), {"json":"object"}, ["list"], "256 characters".',
      '- PGS stores extraParam / upiId / invoiceNo as sent (echoed in the answer); it does not reject missing or empty keys at create (the cashier asks); extraParam that is not an object → 400 invalid_json; keys from both extraParam groups for a method without user input → 400.',
      '- The merchant must allow the payment method, otherwise the case is skipped.',
    );
    if (ctx.paymentMethods && ctx.paymentMethods.length) {
      lines.push(
        'Payment methods with their own parameters (live dashboard configuration):',
        ...ctx.paymentMethods,
      );
    }
  }
  if (categoryId === 'regex') {
    lines.push(
      `Bank: ${ctx.bank}`,
      'Field regexes configured for this bank (Java regex, whole value must match):',
    );
    for (const [field, pattern] of Object.entries(ctx.rules || {})) {
      lines.push(
        `- ${field}: ${pattern}${FIELD_PATHS[field] ? '' : ' (not on the purchase request – skip)'}`,
      );
    }
    lines.push(
      `Customer country of the standard request: ${ctx.country || 'AT'} (set the Country column to test another country).`,
      'A list like ["IN","US","default"] means: customers from a listed country get that country\'s regex from the PGS catalog, others the catalog "default".',
    );
    for (const [field, pattern] of Object.entries(ctx.rules || {})) {
      const t = String(pattern).trim();
      if (!t.startsWith('[') && !t.startsWith('{')) continue;
      let list = [];
      try {
        list = t.startsWith('[') ? JSON.parse(t) : JSON.parse(t).enable || [];
      } catch {
        /* ignore */
      }
      for (const c of [...list.filter((x) => x !== 'default'), ctx.country || 'AT']) {
        lines.push(`  ${field} for ${c}: ${pgsRules.describe(pattern, c, field)}`);
      }
    }
    lines.push(
      'PGS behaviour: a value that does not fully match is REPLACED before the PSP call (not rejected); "NA" counts as invalid;',
      'per-country phone numbers are first repaired to +<code><digits> (e.g. 9876543210 for IN becomes +919876543210).',
    );
  }
  if (categoryId === 'psp' || categoryId === 'edge') {
    lines.push(
      'Test cards (use these IDs in the Card column, or leave it empty for the run card):',
      ...cards,
    );
  }
  if (categoryId === 'psp') {
    const keys = knownPspKeys();
    lines.push(
      'PSP request fields seen in earlier runs:',
      keys.request.length
        ? keys.request.join(', ')
        : '(none recorded yet – use common names: amount, currencyCode, merchantRefNum, billingDetails.zip …)',
      'PSP response fields seen in earlier runs:',
      keys.response.length ? keys.response.join(', ') : '(none recorded yet – e.g. status, id)',
      'Placeholders for Expected Value: {purchaseId} {amount} {amountMinor} {currency} {email} {country} {city} {zip} {phone} {fullName}',
    );
  }
  if (categoryId === 's2s') {
    const t = ctx.s2sTemplate || {};
    lines.push(
      'S2S API: POST /api/v1/p/{purchaseId}/?s2s=true (merchant key) – card payment methods only. The test creates the purchase first.',
      'Baseline body (S2S data tab; the card comes from the Card column or the Run tab card):',
      `- cardholder_name, card_number, expires (MM/YY), cvc from the card · remember_card=${t.remember_card || 'off'} · remote_ip=${t.remote_ip || '157.38.242.7'}`,
      `- user_agent, screen_width, screen_height (${t.browserData === 'custom' ? 'custom values' : 'from the Run tab device'}) · accept_header=${t.accept_header || 'text/html'} · language=${t.language || 'en-US'} · java_enabled=${t.java_enabled || 'false'} · javascript_enabled=${String(t.javascript_enabled ?? true)} · color_depth=${String(t.color_depth ?? 24)} · utc_offset=${String(t.utc_offset ?? 0)}`,
      'Request Changes: field="text"; field=12; field=true; field=null; field not sent; field=256 characters. Unknown fields are sent as extra fields.',
      'Purchase column: New purchase | Unknown purchaseId | Second call (payment already started). Authentication: Valid | No Authorization header | Key without Bearer | Content-Type text/plain.',
      'An accepted call answers HTTP 202 and the test continues (callback → 3DS → redirect): give Expected Purchase Status (final: PAID / ERROR) and Expected Browser Outcome.',
      'A rejected call: Expected HTTP + Code + Message; Expected Purchase Status is the status after the call (CREATED = still payable; ERROR = PGS ended the purchase – happens for card-detail / expiry errors).',
      'Test cards (Card column, empty = Run tab card):',
      ...cards,
    );
  }
  if (categoryId === 'refund') {
    lines.push(
      `Standard purchase: total ${ctx.total ?? 10} ${ctx.currency || 'EUR'} (Paysafe sandbox approves 10.00, declines 2.00).`,
      'Refund API: POST /api/v1/purchases/{id}/refund {amount, reason}; both mandatory. 202 = accepted (partial_refunded / refunded once the PSP confirms).',
      'Known answers: 400 invalid_amount "exceeds refundable amount"; 400 "Refund amount must be greater than zero."; 400 "reason for refund is required"; 400 "amount is required"; 400 "already fully refunded"; 400 "…can be refunded" for an unpaid purchase; 400 "Previous Refund Request already in Process" while a refund is pending.',
      'Sandbox: the PSP often refuses refunds of a payment that is not settled yet (PGS: "Refund can not be initiated") – such a case is reported as OBSERVED, so still write the business expectation (202).',
      'Purchase column: New payment | Unpaid purchase | Settled purchase (Run tab). Refunds column: amounts in order separated by ";" – 30% · 2.50 · rest · rest+0.01 · total · 0 · -1 · "abc" · not sent; expectations apply to the LAST step.',
      'Expected Status = final purchase status: PAID, PARTIAL_REFUNDED, REFUNDED (unpaid purchases stay CREATED / VIEWED).',
    );
  }
  if (categoryId === 'bank-config') {
    const b = ctx.bankConfig || {};
    const mid = b.mid || {};
    const bank = b.bank || {};
    const merchant = b.merchant || {};
    lines.push(
      `MID under test (live dashboard settings): ${mid.name} on bank ${bank.name}`,
      `- 2D only: ${mid.onlyTwoD} · 3DS: ${mid.is3ds} · partial refund allowed: ${mid.partialRefundAllowed} · convert to: ${mid.currConvertTo || 'none'}`,
      `- allowed currencies: ${String(mid.allowedCurr || 'all').split(',').length > 12 ? `${String(mid.allowedCurr).split(',').length} currencies (incl. ${ctx.currency})` : mid.allowedCurr || 'all'} · allowed cards: ${mid.allowedCard || 'all'} · allowed countries: ${mid.allowedCountry || 'all'}`,
      `Bank: max_refund_days ${bank.maxRefundDays} · allowed methods ${
        String(bank.allowedCard || '').split(',').length > 12
          ? `${String(bank.allowedCard).split(',').length} methods (bank-level, not changed by the tests)`
          : bank.allowedCard || 'all'
      }`,
      `Merchant: conversion allowed ${merchant.conversionAllowed} · transaction type ${merchant.trxType}`,
      `Purchase currency of the standard request: ${ctx.currency} · card scheme: the Run tab payment method (VISA by default).`,
      'Settings column: name=value; … with 2D only=1/0 · Partial refund=1/0 · Convert to=<currency>/{other}/none · Allowed currencies=<list> · Allowed cards=<list> · Merchant conversion=1/0.',
      'Tokens: {purchase} = the purchase currency, {card} = the card scheme, {other} = a different currency / scheme. Prefer tokens over literal codes so cases work for any run.',
      'Action: Pay (settings changed, then pay) | Partial refund / Full refund (pay with the current settings, then change them and refund – only Partial refund matters for refunds).',
      'A MID that cannot take the payment is SKIPPED: the payment goes to another eligible MID or fails with ERROR "This customer can not be processed !". Use Expected Routing (Uses the MID / Skips the MID).',
      'Refund with partial refund = 0 and an amount below the rest → HTTP 400 code payment_can_not_be_refunded (Expected Code). A full refund is not affected.',
      'Conversion: Convert to={other} with Merchant conversion=1 → the PSP gets the other currency (Expected PSP Currency={other}); with Merchant conversion=0 the MID is skipped.',
      'Only write cases for settings that exist here; one idea per case; mix "uses" and "skips".',
    );
  }
  if (categoryId === 'kyc') {
    lines.push(
      'KYC create request (POST /kyc/create, snake_case; test=true is always sent and cannot be changed):',
      '- country (required), customer_id or merchant_cust_id (one required – set by the Customer column)',
      '- success_redirect, pending_redirect, failure_redirect, success_callback, pending_callback, failure_callback, redirect_base_url',
      '- link_ttl_minutes (number), kyc_expiry_in_minutes (number), metadata.<key>; unknown fields are ignored',
      'Customer record fields (camelCase, change with customer.<field>=value or "customer.<field> not sent"):',
      '- merchantCustomerId, fullName, emailId, phoneNo, dateOfBirth (yyyy-mm-dd), address, city, stateCode, zipCode, country',
      'The standard customer is complete dummy data (Ada Lovelace, US, +14155550123, 1990-01-15).',
      'Customer column: New customer | New customer (merchant_cust_id) | Unknown customer_id | Unknown merchant_cust_id | No customer id',
      'Authentication column: Valid | No Authorization header | Key without Bearer | Unknown key | No Brand-Id | Brand not owned',
      'Expected HTTP is required; Expected Code for failures (e.g. country_required, customer_required, customer_not_found, authentication_failed, access_denied); Expected KYC Status on success (AWAITING_USER for a new verification).',
    );
  }
  const behaviour = pgsBehaviour(categoryId);
  if (behaviour) lines.push(behaviour);
  if (ctx.existing && ctx.existing.length) {
    lines.push(
      'Existing cases – do NOT repeat them:',
      ...ctx.existing.slice(0, 200).map((e) => `- ${e}`),
    );
  }
  return lines.join('\n');
}

// ── prompt pieces ───────────────────────────────────────────────────────────

/** The template columns as the COLUMNS block of a task message. */
function columnLines(category) {
  return [
    ...category.columns.map((col) => {
      const options = Array.isArray(col.options) ? col.options : undefined;
      return `- ${col.key} (${col.header}, ${col.required ? 'required' : 'optional'}): ${col.guide}${options ? `. One of: ${options.join(', ')}` : ''}`;
    }),
    '- why (required): one sentence – what this case proves',
    '- ref (required): C1, C2 … unique in the conversation',
  ];
}

/** SKILL.md without its front matter – the system prompt of an inline-skill session. */
function skillText() {
  try {
    return fs
      .readFileSync(SKILL_FILE, 'utf8')
      .replace(/^---[\s\S]*?\n---\s*/, '')
      .trim();
  } catch {
    throw new Error(`Skill file missing: ${path.relative(ROOT, SKILL_FILE)}`);
  }
}

function taskHeader(conv, task, usePack, settings) {
  const category = caseImport.CATEGORIES[conv.categoryId];
  return [
    usePack ? `Use the skill ${settings.pack}__${SKILL_NAME} for this task.` : '',
    `TASK: ${task}`,
    `CATEGORY: ${conv.categoryId} – ${category.label}: ${category.description}`,
    task === 'generate-test-cases' ? `COUNT: ${conv.min}–${conv.max}` : '',
    `FOCUS: ${conv.focus || 'default'}`,
    conv.categoryId === 'regex'
      ? 'Set bank to the bank in CONTEXT and field to a field from its regex list.'
      : '',
    conv.categoryId === 'psp'
      ? 'Rows with the same title (and ref) are checked on one transaction – COUNT counts test cases, not rows.'
      : '',
    'COLUMNS:',
    ...columnLines(category),
    'CONTEXT:',
    buildContext(conv.categoryId, conv.ctx),
  ].filter((l) => l !== '');
}

function refineLines(conv, instruction) {
  return [
    `REJECTED: ${conv.rejected.size ? [...conv.rejected].join(', ') : 'none'}`,
    `INSTRUCTION: ${instruction}`,
  ];
}

// ── answers ─────────────────────────────────────────────────────────────────

/** First JSON object in an answer (tolerates code fences and prose around it). */
function parseJsonObject(text) {
  const t = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('the answer is not a JSON object');
  return parsed;
}

/** Answer → the generated rows. */
function parseCasesJson(text) {
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.cases)) throw new Error('the JSON has no "cases" list');
  return parsed.cases;
}

const REF = /^C(\d{1,4})$/;
const refNumber = (ref) => Number((REF.exec(String(ref)) || [])[1] || 0);

/** Clean rows, give every case a ref (psp: one ref per title group). */
function normalizeRows(conv, raw, existingRefs = new Set()) {
  const out = [];
  const used = new Set(existingRefs);
  const byTitle = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = { ...item };
    let ref = String(row.ref || '')
      .trim()
      .toUpperCase();
    if (conv.categoryId === 'psp') {
      const title = String(row.title || '').trim();
      if (byTitle.has(title)) ref = byTitle.get(title);
      else {
        if (!REF.test(ref) || used.has(ref)) ref = `C${conv.nextRef}`;
        byTitle.set(title, ref);
      }
    } else if (!REF.test(ref) || used.has(ref)) ref = `C${conv.nextRef}`;
    used.add(ref);
    conv.nextRef = Math.max(conv.nextRef, refNumber(ref) + 1);
    row.ref = ref;
    out.push(row);
  }
  return out;
}

/** Applies a refine answer to the conversation's rows. */
function applyChanges(conv, answer) {
  const has = (k) => Array.isArray(answer[k]);
  if (Array.isArray(answer.cases) && !has('add') && !has('update') && !has('remove')) {
    const before = new Set(conv.rows.map((r) => r.ref));
    conv.rows = normalizeRows(conv, answer.cases);
    return {
      added: conv.rows.filter((r) => !before.has(r.ref)).length,
      updated: conv.rows.filter((r) => before.has(r.ref)).length,
      removed: [...before].filter((ref) => !conv.rows.some((r) => r.ref === ref)).length,
      note: String(answer.note || ''),
    };
  }
  const removeRefs = new Set(
    (has('remove') ? answer.remove : []).map((r) => String(r).trim().toUpperCase()),
  );
  const refsBefore = new Set(conv.rows.map((r) => r.ref));
  let rows = conv.rows.filter((r) => !removeRefs.has(r.ref));
  const removed = [...removeRefs].filter((ref) => refsBefore.has(ref)).length;

  // Updates: replace every row of a known ref with the new version (psp: the whole group).
  const groups = new Map();
  const unknown = [];
  for (const item of has('update') ? answer.update : []) {
    const ref = String((item && item.ref) || '')
      .trim()
      .toUpperCase();
    if (!rows.some((r) => r.ref === ref)) unknown.push(item);
    else groups.set(ref, [...(groups.get(ref) || []), { ...item, ref }]);
  }
  let updated = 0;
  for (const [ref, items] of groups) {
    const at = rows.findIndex((r) => r.ref === ref);
    rows = rows.filter((r) => r.ref !== ref);
    rows.splice(at, 0, ...items);
    updated += 1;
  }
  const added = normalizeRows(
    conv,
    [...(has('add') ? answer.add : []), ...unknown],
    new Set(rows.map((r) => r.ref)),
  );
  conv.rows = [...rows, ...added];
  return {
    added: new Set(added.map((r) => r.ref)).size,
    updated,
    removed,
    note: String(answer.note || ''),
  };
}

/** Rows → upload-style preview (validation, duplicates, regex verdicts), each case tagged with its ref. */
function buildPreview(conv) {
  const { categoryId, ctx } = conv;
  const rows = conv.rows.slice(0, MAX_ROWS);
  const preview = caseImport.previewObjects(categoryId, rows, ctx.cardIds || []);
  for (const c of preview.cases) {
    const first = rows[Math.max(0, (c.rows[0] || 1) - 1)] || {};
    c.ref = first.ref;
    const why = String(first.why || '').slice(0, 200);
    c.info = why ? [why] : [];
    c.data.origin = 'ai';
    if (conv.rejected.has(c.ref)) c.include = false;
    if (categoryId !== 'regex' || c.issues.length) continue;
    // Regex: the bank's own regex decides Valid / Invalid, not the model.
    const pattern = (ctx.rules || {})[c.data.field];
    const bank = c.data.bank || ctx.bank;
    if (bank) c.data.bank = bank;
    if (pattern === undefined) {
      c.warnings.push(`${bank || 'the bank'} has no regex for ${c.data.field}`);
      continue;
    }
    const result = pgsRules.evaluate(
      c.data.field,
      c.data.value,
      pattern,
      c.data.country || ctx.country || 'AT',
    );
    const computed = result.verdict;
    if (c.data.expectation !== 'auto' && c.data.expectation !== computed) {
      c.warnings.push(
        `AI said ${c.data.expectation}, the bank regex says ${computed} – regex wins`,
      );
    }
    if (result.note) c.info.push(result.note);
    c.data.expectation = computed;
    c.data.regex = pattern;
    c.display[c.display.length - 1] = expectationLabel(computed);
  }
  return preview;
}

// ── conversations ───────────────────────────────────────────────────────────

/** Launcher-side conversations: id → state (rows live here, the gateway session is replaceable). */
const conversations = new Map();
const KEEP_MS = 60 * 60 * 1000;
/** Set when the gateway did not list the skill pack – inline sessions until it is deployed. */
let packMissingUntil = 0;

const sweeper = setInterval(() => {
  const now = Date.now();
  const { idleMs } = aiSettings();
  for (const [id, conv] of conversations) {
    if (conv.busy) continue;
    if (conv.gw && now - conv.lastUsed > idleMs) {
      conv.gw.close();
      conv.gw = undefined;
    }
    if (now - conv.lastUsed > KEEP_MS) conversations.delete(id);
  }
}, 30_000);
sweeper.unref?.();

async function openGateway(settings) {
  const base = { url: settings.url, token: settings.token, model: settings.model || undefined };
  if (settings.skills === 'pack' && Date.now() > packMissingUntil) {
    const gw = await GatewaySession.open({
      ...base,
      mode: 'agent',
      skills: [settings.pack],
      disallowedTools: DISALLOWED_TOOLS,
    });
    if (gw.skills.includes(`${settings.pack}__${SKILL_NAME}`)) return { gw, usePack: true };
    gw.close();
    packMissingUntil = Date.now() + 10 * 60 * 1000;
  }
  const gw = await GatewaySession.open({ ...base, mode: 'chat', appendSystemPrompt: skillText() });
  return { gw, usePack: false };
}

/** One turn; one in-session retry when the answer is not valid JSON. */
async function ask(conv, text, parse, settings) {
  const total = { input: 0, output: 0, costUsd: 0 };
  const turn = async (message) => {
    const r = await conv.gw.turn(message, settings.turnMs);
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.costUsd += r.costUsd || 0;
    return r.texts;
  };
  const pick = (texts) => {
    let lastError = new Error('empty answer');
    for (const t of [...texts].reverse()) {
      try {
        return parse(t);
      } catch (error) {
        lastError = error;
      }
    }
    return parse(texts.join('\n'), lastError);
  };
  let result;
  try {
    result = pick(await turn(text));
  } catch (first) {
    if (first.code) throw first; // gateway error, not a parse problem
    try {
      result = pick(
        await turn(
          `Your answer could not be read (${first.message}). Reply again with ONLY the JSON object described in the skill – no prose, no code fences.`,
        ),
      );
    } catch (second) {
      if (second.code) throw second;
      throw new Error(
        `The AI did not answer in the expected JSON (${second.message}) – try again`,
        {
          cause: second,
        },
      );
    }
  }
  conv.usage.input += total.input;
  conv.usage.output += total.output;
  conv.costUsd += total.costUsd;
  return { result, usage: total };
}

function modelLabel(conv) {
  return `${conv.model || 'Claude'} via AI gateway · ${conv.usePack ? 'skill pack' : 'inline skill'}`;
}

function response(conv, usage, extra) {
  return {
    ...buildPreview(conv),
    session: conv.id,
    model: modelLabel(conv),
    usage: { input: usage.input, output: usage.output },
    costUsd: Math.round(usage.costUsd * 10_000) / 10_000,
    total: {
      input: conv.usage.input,
      output: conv.usage.output,
      costUsd: Math.round(conv.costUsd * 10_000) / 10_000,
    },
    ...extra,
  };
}

function requireSettings() {
  const settings = aiSettings();
  if (settings.urlError) throw new Error(settings.urlError);
  if (!settings.url || !settings.token)
    throw new Error(
      'AI generation needs the AI gateway token on this computer – Test cases → "Add AI token…" (AI_GATEWAY_TOKEN in .env)',
    );
  return settings;
}

/** Ends every open conversation's gateway session (one seat per launcher at a time). */
function closeAllAiSessions() {
  for (const conv of conversations.values()) {
    conv.gw?.close();
    conv.gw = undefined;
  }
  conversations.clear();
}

function closeAiSession(id) {
  const conv = conversations.get(String(id));
  if (!conv) return false;
  conv.gw?.close();
  conversations.delete(conv.id);
  return true;
}

/**
 * Starts a conversation and generates cases for a category. Returns a preview (same shape as an
 * Excel upload preview) plus the conversation id for Refine. Nothing is saved here.
 */
async function generateCases(categoryId, options, ctx) {
  const settings = requireSettings();
  const category = caseImport.CATEGORIES[categoryId];
  if (!category) throw new Error('Choose a category');
  const min = Math.max(1, Math.min(MAX_CASES, Number(options.min) || 5));
  const max = Math.max(min, Math.min(MAX_CASES, Number(options.max) || min));
  const focus = String(options.focus || '')
    .slice(0, 500)
    .trim();

  closeAllAiSessions();
  const conv = {
    id: crypto.randomUUID(),
    categoryId,
    ctx,
    min,
    max,
    focus,
    rows: [],
    rejected: new Set(),
    nextRef: 1,
    gw: undefined,
    usePack: false,
    model: '',
    busy: true,
    lastUsed: Date.now(),
    usage: { input: 0, output: 0 },
    costUsd: 0,
  };
  conversations.set(conv.id, conv);
  try {
    const { gw, usePack } = await openGateway(settings);
    Object.assign(conv, { gw, usePack, model: gw.model });
    const message = taskHeader(conv, 'generate-test-cases', usePack, settings).join('\n');
    const { result: rows, usage } = await ask(conv, message, parseCasesJson, settings);
    conv.rows = normalizeRows(conv, rows);
    if (categoryId !== 'psp') conv.rows = conv.rows.slice(0, max);
    const count = new Set(conv.rows.map((r) => r.ref)).size;
    return response(conv, usage, {
      requested: { min, max },
      note:
        count < min
          ? `The AI returned ${count} case(s) – fewer than the minimum ${min}. Ask for more with Refine.`
          : '',
    });
  } catch (error) {
    closeAiSession(conv.id);
    throw error;
  } finally {
    conv.busy = false;
    conv.lastUsed = Date.now();
  }
}

class ConversationGoneError extends Error {}

/**
 * Applies a tester instruction to the conversation's cases ("add 3 negative amount cases",
 * "remove C4", "make C2 use the 3DS card"). Unticked refs are passed as rejected.
 */
async function refineCases(sessionId, options) {
  const settings = requireSettings();
  const conv = conversations.get(String(sessionId || ''));
  if (!conv)
    throw new ConversationGoneError(
      'This AI conversation has ended (launcher restarted or idle for an hour) – generate again',
    );
  if (conv.busy) throw new Error('The AI is still working on the previous request');
  const instruction = String(options.instruction || '')
    .slice(0, 1000)
    .trim();
  if (!instruction)
    throw new Error('Write what should change, e.g. "add 3 cases for unicode names"');
  conv.rejected = new Set(
    (Array.isArray(options.rejected) ? options.rejected : [])
      .map((r) => String(r).trim().toUpperCase())
      .filter((r) => REF.test(r)),
  );
  conv.busy = true;
  conv.lastUsed = Date.now();
  try {
    let message;
    let resumed = false;
    if (conv.gw && conv.gw.usable) {
      message = ['TASK: refine-test-cases', ...refineLines(conv, instruction)].join('\n');
    } else {
      // Gateway session ended – seed a new one with the current rows.
      conv.gw?.close();
      const { gw, usePack } = await openGateway(settings);
      Object.assign(conv, { gw, usePack, model: gw.model });
      resumed = true;
      message = [
        ...taskHeader(conv, 'refine-test-cases', usePack, settings),
        `CURRENT CASES: ${JSON.stringify(conv.rows)}`,
        ...refineLines(conv, instruction),
      ].join('\n');
    }
    const { result: answer, usage } = await ask(conv, message, parseJsonObject, settings);
    const changes = applyChanges(conv, answer);
    return response(conv, usage, { changes, resumed });
  } finally {
    conv.busy = false;
    conv.lastUsed = Date.now();
  }
}

const ENV_FILE = path.join(ROOT, '.env');
const readEnvFile = () => {
  try {
    return dotenv.parse(fs.readFileSync(ENV_FILE));
  } catch {
    return {};
  }
};
/** Sets KEY=value lines in the local .env (git-ignored), keeping every other line as it is. */
function writeEnvValues(values) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    /* no .env yet */
  }
  for (const [key, value] of Object.entries(values)) {
    const quoted = /[\s#"'=]/.test(value) ? JSON.stringify(value) : value;
    const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = `${key}=${quoted}`;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${quoted}`);
    }
  }
  fs.writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

/**
 * "Set up AI" window: saves the gateway link and token to this computer's .env
 * (never to settings or git) and checks that the gateway accepts them.
 * An empty token keeps the saved one.
 */
async function setupGateway(input) {
  const rawUrl = String(input.url || '').trim();
  const token = String(input.token || '').trim();
  if (!rawUrl) throw new Error('Enter the AI gateway link');
  try {
    websocketUrl(rawUrl);
  } catch {
    throw new Error(
      'The gateway link is not valid – it looks like http://host:8081/v1/agent/completions',
    );
  }
  if (!token && !aiSettings().token) throw new Error('Enter the AI gateway token');
  const ownUrl = rawUrl !== teamGatewayUrl() || readEnvFile().AI_GATEWAY_URL !== undefined;
  writeEnvValues({
    ...(ownUrl ? { AI_GATEWAY_URL: rawUrl } : {}),
    ...(token ? { AI_GATEWAY_TOKEN: token } : {}),
  });
  closeAllAiSessions();
  const settings = aiSettings();
  let check = { ok: true, message: 'Connected to the AI gateway.' };
  try {
    const gw = await GatewaySession.open({
      url: settings.url,
      token: settings.token,
      mode: 'chat',
      ...(settings.model ? { model: settings.model } : {}),
    });
    gw.close();
  } catch (error) {
    check = {
      ok: false,
      message: `Saved, but the gateway did not accept the connection: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ...aiStatus(), check };
}

module.exports = {
  aiStatus,
  setupGateway,
  generateCases,
  refineCases,
  closeAiSession,
  closeAllAiSessions,
  ConversationGoneError,
  buildContext,
  parseCasesJson,
  parseJsonObject,
  applyChanges,
  normalizeRows,
  skillText,
  /** Tests only: forget the "pack missing" memo and open conversations. */
  resetForTests() {
    packMissingUntil = 0;
    closeAllAiSessions();
  },
};
