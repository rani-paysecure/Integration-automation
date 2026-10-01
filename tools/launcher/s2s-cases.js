// @ts-check
/**
 * Upload / AI category for S2S card payments (S2-xxx):
 *   purchase (new / unknown id / second call) + auth variant + changes to the S2S body
 *   (any field of POST /api/v1/p/{purchaseId}/?s2s=true – on top of the launcher's S2S data)
 *   → expected HTTP, code, message, purchase status, and the browser outcome when the payment
 *   goes ahead (202 pending → callback → 3DS / redirect).
 * Plugged into test-case-import.js like the refund / bank-config categories.
 */
'use strict';

const S2S_PURCHASES = {
  'new purchase': 'new',
  new: 'new',
  'unknown purchaseid': 'unknown',
  'unknown purchase id': 'unknown',
  unknown: 'unknown',
  'second call (payment already started)': 'second',
  'second call': 'second',
  second: 'second',
};
const S2S_PURCHASE_LABELS = {
  new: 'New purchase',
  unknown: 'Unknown purchaseId',
  second: 'Second call (payment already started)',
};
const S2S_AUTH = {
  valid: 'valid',
  'no authorization header': 'none',
  'key without bearer': 'no-bearer',
  'content-type text/plain': 'text-plain',
};
const S2S_AUTH_LABELS = {
  valid: 'Valid',
  none: 'No Authorization header',
  'no-bearer': 'Key without Bearer',
  'text-plain': 'Content-Type text/plain',
};
const OUTCOMES = {
  'success redirect': 'success-redirect',
  'failure redirect': 'failure-redirect',
  'pending redirect': 'pending-redirect',
};
const OUTCOME_LABELS = {
  'success-redirect': 'Success redirect',
  'failure-redirect': 'Failure redirect',
  'pending-redirect': 'Pending redirect',
};
/** Fields of the S2S body (any other name is still sent – e.g. deviceId). */
const S2S_FIELDS = [
  'cardholder_name',
  'card_number',
  'expires',
  'cvc',
  'remember_card',
  'remote_ip',
  'user_agent',
  'accept_header',
  'language',
  'java_enabled',
  'javascript_enabled',
  'color_depth',
  'utc_offset',
  'screen_width',
  'screen_height',
];
const KEY_RE = /^[A-Za-z_][\w]*$/;

/** One value of the Changes column: "x" / 12 / true / null / {"a":1} / text / not sent. */
function parseS2sValue(raw) {
  const t = String(raw).trim();
  if (/^(not sent|field not sent|missing)$/i.test(t)) return { remove: true };
  const quoted = /^"(.*)"$/s.exec(t);
  if (quoted) return { value: quoted[1] };
  if (t === 'null') return { value: null };
  if (/^(true|false)$/i.test(t)) return { value: t.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  if (/^[[{]/.test(t)) {
    try {
      return { value: JSON.parse(t) };
    } catch {
      return { value: t, warning: `"${t}" looks like JSON but is not valid – sent as text` };
    }
  }
  const long = /^(\d+) characters$/i.exec(t);
  if (long) return { value: 'x'.repeat(Math.min(5000, Number(long[1]))) };
  return { value: t };
}

/** "expires=\"13/31\"; cvc not sent; screen_width=0" → { set, remove }. */
function parseS2sChanges(raw, issues, warnings) {
  /** @type {Record<string, unknown>} */
  const set = {};
  const remove = [];
  for (const part of String(raw || '').split(/;|\n/)) {
    const p = part.trim();
    if (!p) continue;
    const notSent = /^([A-Za-z_]\w*)\s+not sent$/i.exec(p);
    if (notSent) {
      remove.push(notSent[1]);
      continue;
    }
    const m = /^([A-Za-z_]\w*)\s*=\s*(.*)$/s.exec(p);
    if (!m) {
      issues.push(`Cannot read "${p}" – use field=value or "field not sent"`);
      continue;
    }
    const v = parseS2sValue(m[2]);
    if (v.warning) warnings.push(v.warning);
    if (v.remove) remove.push(m[1]);
    else set[m[1]] = v.value;
    if (!S2S_FIELDS.includes(m[1]))
      warnings.push(`"${m[1]}" is not a standard S2S field – sent as an extra field`);
  }
  return { set, remove };
}

const show = (v) =>
  typeof v === 'string' && v.length > 30
    ? `"${v.slice(0, 10)}…" (${v.length} chars)`
    : JSON.stringify(v);
const describeChanges = (c) =>
  [
    ...Object.entries(c.set || {}).map(
      ([k, v]) => `${k}=${k === 'card_number' || k === 'cvc' ? '***' : show(v)}`,
    ),
    ...(c.remove || []).map((k) => `${k} not sent`),
  ].join('; ');
const describeExpected = (e) =>
  [
    `HTTP ${e.http}`,
    e.code || '',
    e.messageContains ? `message contains "${e.messageContains}"` : '',
    (e.statuses || []).length ? `status ${(e.statuses || []).join(' / ')}` : '',
    e.outcome ? OUTCOME_LABELS[e.outcome] : '',
  ]
    .filter(Boolean)
    .join(' · ');

/** @param {{ norm: (s: string) => string }} shared */
module.exports = function s2sCases(shared) {
  const { norm } = shared;
  const CATEGORIES = {
    s2s: {
      label: 'S2S cases',
      prefix: 'S2',
      file: 's2s-cases.json',
      description:
        'S2S card payment: purchase + auth variant + changes to the S2S request (on top of the S2S data tab) → HTTP, code, message, purchase status, and the browser outcome when the payment goes ahead. Card payment methods only.',
      columns: [
        {
          key: 'title',
          header: 'Test Case',
          required: true,
          width: 34,
          aliases: ['scenario', 'title'],
          guide: 'Short name of the case',
          example: 'Expiry with two-digit year only',
        },
        {
          key: 'card',
          header: 'Card',
          required: false,
          width: 22,
          aliases: ['test card', 'card id'],
          options: 'cards',
          guide: 'Test card ID from the Test cards tab. Empty = the Run tab card',
          example: '',
        },
        {
          key: 'purchase',
          header: 'Purchase',
          required: false,
          width: 26,
          aliases: ['purchase type'],
          options: Object.values(S2S_PURCHASE_LABELS),
          guide:
            'Empty = New purchase. Second call = a valid S2S call first, then this one on the same purchase',
          example: 'New purchase',
        },
        {
          key: 'auth',
          header: 'Authentication',
          required: false,
          width: 24,
          aliases: ['auth', 'headers'],
          options: Object.values(S2S_AUTH_LABELS),
          guide: 'Empty = Valid (merchant key with Bearer, JSON)',
          example: 'Valid',
        },
        {
          key: 'changes',
          header: 'Request Changes',
          required: false,
          width: 40,
          aliases: ['changes', 'request'],
          guide:
            'S2S body changes separated by ";": expires="12/3"; cvc not sent; remember_card=on; screen_width=0; java_enabled=true; card_number="4000000000002702"; deviceId="QA-1"; cardholder_name=256 characters. "..." = text, 12 = number, true/false, null, {"a":1} = JSON',
          example: 'expires="12/3"',
        },
        {
          key: 'http',
          header: 'Expected HTTP',
          required: true,
          width: 14,
          aliases: ['http', 'http status'],
          guide: '202 = accepted (pending + callback, or 2D result), 400 / 401 / 415 = rejected',
          example: '400',
        },
        {
          key: 'code',
          header: 'Expected Code',
          required: false,
          width: 22,
          aliases: ['code', 'error code'],
          guide: 'e.g. transaction_error, Invalid_Parameter, authentication_failed, invalid_json',
          example: 'transaction_error',
        },
        {
          key: 'message',
          header: 'Expected Message Contains',
          required: false,
          width: 30,
          aliases: ['message'],
          guide: 'Text the answer message must contain',
          example: 'Invalid Card Expiry',
        },
        {
          key: 'status',
          header: 'Expected Purchase Status',
          required: false,
          width: 22,
          aliases: ['status', 'purchase status'],
          guide:
            'Rejected call: status after it (CREATED = still payable, ERROR = ended). 202: final status (PAID, ERROR …). Several with /',
          example: 'ERROR',
        },
        {
          key: 'outcome',
          header: 'Expected Browser Outcome',
          required: false,
          width: 20,
          aliases: ['outcome', 'cashier result', 'redirect'],
          options: Object.values(OUTCOME_LABELS),
          guide: 'Only for 202: where the callback ends (after 3DS)',
          example: '',
        },
      ],
      examples: [
        [
          'Expiry with two-digit year only',
          '',
          'New purchase',
          'Valid',
          'expires="12/3"',
          '400',
          'transaction_error',
          'Invalid Card Expiry',
          'ERROR',
          '',
        ],
        [
          'Card saved for the customer',
          '',
          'New purchase',
          'Valid',
          'remember_card=on',
          '202',
          '',
          '',
          'PAID',
          'Success redirect',
        ],
        [
          'Screen size 0 is still accepted',
          '',
          'New purchase',
          'Valid',
          'screen_width=0; screen_height=0',
          '202',
          '',
          '',
          'PAID',
          'Success redirect',
        ],
        [
          'Second S2S call on the same purchase',
          '',
          'Second call (payment already started)',
          'Valid',
          '',
          '400',
          'transaction_error',
          'can be paid for',
          '',
          '',
        ],
      ],
    },
  };

  function parseRows(rows, get, cardIds) {
    const cases = [];
    for (const { row, cells } of rows) {
      const v = get(cells);
      if (!v.title && !v.changes && !v.http) continue;
      const issues = [];
      const warnings = [];
      if (!v.title) issues.push('Test Case is empty');
      const purchase = v.purchase ? S2S_PURCHASES[norm(v.purchase)] : 'new';
      if (!purchase)
        issues.push(`Purchase must be one of: ${Object.values(S2S_PURCHASE_LABELS).join(', ')}`);
      const auth = v.auth ? S2S_AUTH[norm(v.auth)] : 'valid';
      if (!auth)
        issues.push(`Authentication must be one of: ${Object.values(S2S_AUTH_LABELS).join(', ')}`);
      const http = Number(v.http);
      if (!Number.isInteger(http) || http < 100 || http > 599)
        issues.push('Expected HTTP must be a status code, e.g. 202 or 400');
      const statuses = String(v.status || '')
        .split(/[/,|]/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean);
      const outcome = v.outcome ? OUTCOMES[norm(v.outcome)] : undefined;
      if (v.outcome && !outcome)
        issues.push(
          `Expected Browser Outcome must be one of: ${Object.values(OUTCOME_LABELS).join(', ')}`,
        );
      if (outcome && http !== 202)
        warnings.push('A browser outcome only follows an accepted (202) S2S call');
      if (v.card && cardIds.length && !cardIds.includes(v.card))
        warnings.push(`Card "${v.card}" is not on the Test cards tab of this environment`);
      const changes = parseS2sChanges(v.changes, issues, warnings);
      const data = {
        title: v.title,
        ...(v.card ? { card: v.card } : {}),
        purchase: purchase || 'new',
        auth: auth || 'valid',
        ...(Object.keys(changes.set).length ? { set: changes.set } : {}),
        ...(changes.remove.length ? { remove: changes.remove } : {}),
        expected: {
          http,
          ...(v.code ? { code: v.code.trim() } : {}),
          ...(v.message ? { messageContains: v.message } : {}),
          ...(statuses.length ? { statuses } : {}),
          ...(outcome ? { outcome } : {}),
        },
      };
      cases.push({
        rows: [row],
        data,
        display: [
          v.title,
          `${S2S_PURCHASE_LABELS[data.purchase]} · ${S2S_AUTH_LABELS[data.auth]}${v.card ? ` · ${v.card}` : ''}`,
          describeChanges(data) || 'Baseline S2S request',
          describeExpected(data.expected),
        ],
        issues,
        warnings,
      });
    }
    return cases;
  }

  const str = (x, max) => String(x ?? '').slice(0, max);
  function validate(_categoryId, d, need) {
    const e = d.expected || {};
    need(Object.values(S2S_PURCHASES).includes(d.purchase), 'invalid purchase');
    need(Object.values(S2S_AUTH).includes(d.auth), 'invalid authentication');
    need(Number.isInteger(e.http) && e.http >= 100 && e.http <= 599, 'invalid expected HTTP');
    need(!e.outcome || Object.values(OUTCOMES).includes(e.outcome), 'invalid browser outcome');
    const set = d.set && typeof d.set === 'object' && !Array.isArray(d.set) ? d.set : {};
    for (const k of Object.keys(set)) need(KEY_RE.test(k), `invalid field "${k}"`);
    const remove = Array.isArray(d.remove) ? d.remove.filter((k) => KEY_RE.test(k)) : [];
    return {
      title: str(d.title, 200),
      ...(d.card ? { card: str(d.card, 60) } : {}),
      purchase: d.purchase,
      auth: d.auth,
      ...(Object.keys(set).length ? { set } : {}),
      ...(remove.length ? { remove } : {}),
      expected: {
        http: e.http,
        ...(e.code ? { code: str(e.code, 60) } : {}),
        ...(e.messageContains ? { messageContains: str(e.messageContains, 300) } : {}),
        ...(Array.isArray(e.statuses) && e.statuses.length
          ? { statuses: e.statuses.map((x) => str(x, 40).toUpperCase()) }
          : {}),
        ...(e.outcome ? { outcome: e.outcome } : {}),
      },
    };
  }

  return {
    CATEGORIES,
    PARSERS: { s2s: parseRows },
    PREVIEW_COLUMNS: { s2s: ['Test case', 'Purchase · auth', 'Request changes', 'Expected'] },
    signature: (_id, c) =>
      JSON.stringify([
        c.card || '',
        c.purchase,
        c.auth,
        c.set || {},
        [...(c.remove || [])].sort(),
        c.expected,
      ]),
    validate,
    summarize: (_id, c) => [
      `${S2S_PURCHASE_LABELS[c.purchase] || c.purchase} · ${S2S_AUTH_LABELS[c.auth] || c.auth}${c.card ? ` · ${c.card}` : ''}`,
      describeChanges(c) || 'Baseline S2S request',
      describeExpected(c.expected),
    ],
  };
};

module.exports.S2S_FIELDS = S2S_FIELDS;
module.exports.parseS2sValue = parseS2sValue;
