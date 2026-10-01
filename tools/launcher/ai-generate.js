// @ts-check
/**
 * AI-generated test cases for the launcher's Test cases tab.
 *
 * Claude (Anthropic Messages API) gets the category's template (columns,
 * allowed values, guide), the context it needs – request fields, the bank's
 * field regexes, test-card IDs, PSP field names seen in earlier runs, existing
 * cases – and returns rows through a tool call in the template shape. The rows
 * then go through the SAME parser / validation / duplicate check as an Excel
 * upload and are only saved after the tester ticks and adds them.
 *
 * Settings (shell env or .env): ANTHROPIC_API_KEY (required), AI_MODEL
 * (default claude-haiku-4-5-20251001 – fast and low-cost). Nothing secret is sent: no API keys, card
 * numbers, passwords or dashboard data other than field regexes.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const caseImport = require('./test-case-import');
const { expectationLabel, FIELD_PATHS } = require('./regex-cases');
const pgsRules = require('../../config/pgs/pgs-rules');

const ROOT = path.resolve(__dirname, '..', '..');
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 180_000;
const MAX_CASES = 50;

/** Reads only the AI settings from .env – the key is never passed on to test runs. */
function aiSettings() {
  let file = {};
  try {
    file = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
  } catch {
    /* no .env */
  }
  const apiKey = (process.env.ANTHROPIC_API_KEY || file.ANTHROPIC_API_KEY || '').trim();
  const model = (process.env.AI_MODEL || file.AI_MODEL || DEFAULT_MODEL).trim();
  return { apiKey, model };
}

function aiStatus() {
  const { apiKey, model } = aiSettings();
  return { configured: apiKey !== '', model };
}

const FOCUS_HINTS = {
  field:
    'missing / empty / null values, wrong types, length limits, formats (email, phone, dates, ISO codes), unicode, whitespace, injection strings; payment-method parameters in extraParam (valid, missing, empty, null, wrong type, several keys, keys the method does not need, extraParam not an object)',
  regex:
    'values just inside and just outside every pattern: length boundaries, allowed vs forbidden characters, leading/trailing spaces, unicode letters, look-alike characters, words the pattern blocks',
  psp: 'amount (major vs minor units), currency, order reference = purchase ID, customer / billing data, 3DS fields, status and IDs in the response',
  edge: 'amount boundaries, currency / country mismatches, missing optional customer data, different test cards (approved, declined, 3DS challenge)',
  s2s: 'expiry formats (MM/YY, MMYY, past, month 00 / 13, two-digit year), missing / empty / wrong-type card fields, Luhn failures, browser data values (screen 0, negative utc_offset, unknown language, java_enabled true), remember_card on / off / empty, extra fields, auth and content-type variants, second call on the same purchase',
  refund:
    'partial refunds in several steps, the exact rest, more than the rest (rest+0.01, rest+1), total twice, zero / negative / non-numeric amounts, amount or reason not sent, empty reason, refunds of an unpaid purchase, many small refunds, refunds after a full refund',
  'bank-config':
    'each setting on and off against the current value: 2D only, partial refund (partial vs full refund), convert to {other} with merchant conversion on / off, allowed currencies with and without {purchase}, allowed cards with and without {card}, combinations of two settings',
  kyc: 'auth variants (no key, no Bearer, unknown key, no / foreign Brand-Id), missing or blank country, missing / unknown customer ids, merchant_cust_id vs customer_id, link_ttl_minutes and kyc_expiry_in_minutes boundaries, incomplete customer records (customer.* not sent), unknown extra fields',
};

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

function toolSchema(category) {
  const properties = {};
  for (const col of category.columns) {
    const options = Array.isArray(col.options) ? col.options : undefined;
    properties[col.key] = {
      type: 'string',
      description: `${col.header}${col.required ? '' : ' (optional, may be empty)'}: ${col.guide}${options ? `. One of: ${options.join(', ')}` : ''}`,
    };
  }
  properties.why = { type: 'string', description: 'One short sentence: what this case proves' };
  return {
    name: 'submit_test_cases',
    description: 'Return the generated test cases as rows of the template.',
    input_schema: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties,
            required: [...category.columns.filter((c) => c.required).map((c) => c.key), 'why'],
          },
        },
      },
      required: ['cases'],
    },
  };
}

async function callClaude({ apiKey, model }, system, user, tool) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body && body.error && body.error.message) || `HTTP ${res.status}`;
    throw new Error(
      res.status === 401
        ? 'The Anthropic API key was rejected – check ANTHROPIC_API_KEY in .env'
        : `AI request failed: ${message}`,
    );
  }
  const block = (body.content || []).find((c) => c.type === 'tool_use' && c.name === tool.name);
  if (!block || !Array.isArray(block.input && block.input.cases))
    throw new Error('The AI returned no test cases – try again');
  return { cases: block.input.cases, usage: body.usage || {} };
}

/**
 * Generates cases for a category and returns a preview (same shape as an
 * Excel upload preview). Nothing is saved here.
 */
async function generateCases(categoryId, options, ctx) {
  const settings = aiSettings();
  if (!settings.apiKey)
    throw new Error(
      'AI generation needs ANTHROPIC_API_KEY in .env (or the shell) – then restart the launcher',
    );
  const category = caseImport.CATEGORIES[categoryId];
  if (!category) throw new Error('Choose a category');
  const min = Math.max(1, Math.min(MAX_CASES, Number(options.min) || 5));
  const max = Math.max(min, Math.min(MAX_CASES, Number(options.max) || min));
  const focus = String(options.focus || '')
    .slice(0, 500)
    .trim();

  const system = [
    'You are a senior QA engineer testing a payment gateway (Paysecure PGS) integration: a purchase API, a hosted cashier and PSP (bank) connections.',
    'You write precise, non-overlapping test cases that find real defects. Mix positive (should succeed) and negative (should be rejected / fail) cases.',
    'Use only test data: never real card numbers, real people or real contact details (use example.com, 555 numbers, invented names).',
    'Every value must fit the column rules exactly; leave optional columns empty when not needed.',
  ].join('\n');
  const user = [
    `Category: ${category.label} – ${category.description}`,
    `Generate between ${min} and ${max} test cases (aim for ${max} if there is enough distinct ground to cover).`,
    `Focus: ${focus || FOCUS_HINTS[categoryId]}`,
    categoryId === 'regex'
      ? 'For each case set Bank to the bank below, Field to a field name from the list, and Expected Result to Valid or Invalid according to the regex.'
      : '',
    categoryId === 'psp'
      ? 'Rows with the same Test Case are checked on one transaction – group 2–5 related checks per test case; count test cases, not rows.'
      : '',
    '',
    buildContext(categoryId, ctx),
  ]
    .filter((l) => l !== '')
    .join('\n');

  const { cases: rows, usage } = await callClaude(settings, system, user, toolSchema(category));
  const why = rows.map((r) => String((r && r.why) || '').slice(0, 200));
  const preview = caseImport.previewObjects(
    categoryId,
    rows.slice(0, categoryId === 'psp' ? MAX_CASES * 5 : max),
    ctx.cardIds || [],
  );

  // Regex: the bank's own regex decides Valid / Invalid, not the model.
  for (const c of preview.cases) {
    const first = Math.max(0, (c.rows[0] || 1) - 1);
    c.info = why[first] ? [why[first]] : [];
    c.data.origin = 'ai';
    if (categoryId !== 'regex' || c.issues.length) continue;
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
  const count = categoryId === 'psp' ? preview.cases.length : preview.cases.length;
  return {
    ...preview,
    model: settings.model,
    requested: { min, max },
    note:
      count < min
        ? `The AI returned ${count} case(s) – fewer than the minimum ${min}. Generate again for more.`
        : '',
    usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 },
  };
}

module.exports = { aiStatus, generateCases, buildContext, toolSchema };
