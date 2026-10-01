// @ts-check
/**
 * Upload / AI categories for refunds (RC-xxx) and bank & MID configuration (BC-xxx).
 *
 *   refund       → Refund cases            (RC-xxx)  one or more refund requests on a purchase
 *   bank-config  → Bank & MID config cases (BC-xxx)  flip MID / merchant settings → pay or refund
 *
 * Plugged into test-case-import.js (same template / preview / duplicate / save flow).
 * Shared helpers (parseAssignments, norm) are passed in to avoid a require cycle.
 */
'use strict';

// ── refunds ────────────────────────────────────────────────────────────────────

/** Which purchase the refunds are sent for. */
const REFUND_PURCHASES = {
  'new payment': 'new',
  new: 'new',
  'unpaid purchase': 'unpaid',
  unpaid: 'unpaid',
  'settled purchase (run tab)': 'given',
  'settled purchase': 'given',
  given: 'given',
};
const REFUND_PURCHASE_LABELS = {
  new: 'New payment',
  unpaid: 'Unpaid purchase',
  given: 'Settled purchase (Run tab)',
};

/**
 * One refund amount: 30% · 5 · 5.50 · rest · rest+1 · total · 0 · -1 · "abc" · not sent.
 * percent / rest / total are resolved against the purchase at run time.
 */
function parseRefundAmount(raw) {
  const t = String(raw).trim();
  const low = t.toLowerCase();
  if (low === '') return { error: 'empty refund step' };
  if (/^(not sent|none|missing|no amount)$/.test(low)) return { kind: 'none' };
  if (low === 'total' || low === 'full') return { kind: 'total' };
  if (low === 'rest' || low === 'remaining') return { kind: 'rest' };
  let m = /^rest\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(low);
  if (m) return { kind: 'rest', delta: Number(`${m[1]}${m[2]}`) };
  m = /^(\d+(?:\.\d+)?)\s*%$/.exec(low);
  if (m) {
    const value = Number(m[1]);
    if (value <= 0 || value > 1000) return { error: `percentage "${t}" must be 0–1000 %` };
    return { kind: 'percent', value };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return { kind: 'fixed', value: Number(t) };
  // Anything else is sent as it is (wrong type tests): "abc", "1,5", ""
  m = /^"(.*)"$/.exec(t);
  return { kind: 'raw', value: m ? m[1] : t };
}

const describeRefundAmount = (a) => {
  switch (a.kind) {
    case 'none':
      return 'amount not sent';
    case 'total':
      return 'total';
    case 'rest':
      return a.delta ? `rest${a.delta > 0 ? '+' : ''}${a.delta}` : 'rest';
    case 'percent':
      return `${a.value}%`;
    case 'fixed':
      return String(a.value);
    default:
      return JSON.stringify(a.value);
  }
};

function parseReason(raw) {
  const t = String(raw || '').trim();
  if (t === '') return { kind: 'default' };
  if (/^(not sent|none|missing)$/i.test(t)) return { kind: 'none' };
  const m = /^"(.*)"$/.exec(t);
  return { kind: 'value', value: m ? m[1] : t };
}
const describeReason = (r) =>
  r.kind === 'none'
    ? 'reason not sent'
    : r.kind === 'value'
      ? `reason ${JSON.stringify(r.value)}`
      : '';

const describeRefundExpected = (e) =>
  [
    e.http ? `HTTP ${e.http}` : '',
    e.code,
    e.messageContains ? `message contains "${e.messageContains}"` : '',
    (e.statuses || []).length ? `status ${(e.statuses || []).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const splitStatuses = (raw) =>
  String(raw || '')
    .split(/[/,|]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

// ── bank & MID configuration ───────────────────────────────────────────────────

/** Settings column keys (aliases) → stored setting names. */
const BANK_SETTINGS = {
  '2d only': 'onlyTwoD',
  '2d': 'onlyTwoD',
  onlytwod: 'onlyTwoD',
  'partial refund': 'partial_refund_allowed',
  'partial refund allowed': 'partial_refund_allowed',
  partial_refund_allowed: 'partial_refund_allowed',
  'convert to': 'curr_convert_to',
  'convert to currency': 'curr_convert_to',
  curr_convert_to: 'curr_convert_to',
  'allowed currencies': 'allowed_curr',
  'allowed currency': 'allowed_curr',
  allowed_curr: 'allowed_curr',
  'allowed cards': 'allowed_card',
  'allowed card': 'allowed_card',
  allowed_card: 'allowed_card',
  'merchant conversion': 'merchant_conversion',
  'merchant conversion allowed': 'merchant_conversion',
  'conversion allowed': 'merchant_conversion',
  conversionallowed: 'merchant_conversion',
};
const SETTING_LABELS = {
  onlyTwoD: '2D only',
  partial_refund_allowed: 'Partial refund',
  curr_convert_to: 'Convert to',
  allowed_curr: 'Allowed currencies',
  allowed_card: 'Allowed cards',
  merchant_conversion: 'Merchant conversion',
};
const FLAG_SETTINGS = new Set(['onlyTwoD', 'partial_refund_allowed', 'merchant_conversion']);
const CARD_SCHEMES = [
  'VISA',
  'MASTER',
  'AMEX',
  'DISCOVER',
  'JCB',
  'DINERS',
  'MAESTRO',
  'UNIONPAY',
  'RUPAY',
];
/** {purchase} = the purchase currency · {other} = another currency · {card} / {other} for schemes. */
const CURRENCY_TOKEN = /^(\{purchase\}|\{other\}|[A-Z]{3,5})$/;
const CARD_TOKEN = new RegExp(`^(\\{card\\}|\\{other\\}|${CARD_SCHEMES.join('|')})$`);

const BANK_ACTIONS = {
  pay: 'pay',
  payment: 'pay',
  'partial refund': 'partial-refund',
  'full refund': 'full-refund',
  refund: 'full-refund',
};
const ACTION_LABELS = {
  pay: 'Pay',
  'partial-refund': 'Partial refund',
  'full-refund': 'Full refund',
};
const ROUTING = {
  'uses the mid': 'uses',
  uses: 'uses',
  routed: 'uses',
  'skips the mid': 'skips',
  skips: 'skips',
  skipped: 'skips',
};
const ROUTING_LABELS = { uses: 'Uses the MID', skips: 'Skips the MID' };

function parseBankSettings(raw, norm, issues) {
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const part of String(raw || '').split(/[;\n]/)) {
    if (!part.trim()) continue;
    const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m) {
      issues.push(`Cannot read setting "${part.trim()}" – use name=value, e.g. 2D only=1`);
      continue;
    }
    const key = BANK_SETTINGS[norm(m[1])] || BANK_SETTINGS[m[1].trim().toLowerCase()];
    if (!key) {
      issues.push(
        `Unknown setting "${m[1].trim()}" – use ${Object.values(SETTING_LABELS).join(', ')}`,
      );
      continue;
    }
    const value = m[2].replace(/^"(.*)"$/, '$1').trim();
    if (FLAG_SETTINGS.has(key)) {
      const flag = /^(1|on|yes|true|enabled?)$/i.test(value)
        ? 1
        : /^(0|off|no|false|disabled?)$/i.test(value)
          ? 0
          : -1;
      if (flag < 0) issues.push(`${SETTING_LABELS[key]} must be 1 / 0 (on / off)`);
      else out[key] = flag;
    } else if (key === 'curr_convert_to') {
      const v = value
        .toUpperCase()
        .replace('{PURCHASE}', '{purchase}')
        .replace('{OTHER}', '{other}');
      if (/^(|none|-|empty)$/i.test(value)) out[key] = '';
      else if (!CURRENCY_TOKEN.test(v))
        issues.push(`Convert to must be a currency code, {other}, {purchase} or none`);
      else out[key] = v;
    } else {
      const items = value
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (/^\{.*\}$/.test(x) ? x.toLowerCase() : x.toUpperCase()));
      const token = key === 'allowed_curr' ? CURRENCY_TOKEN : CARD_TOKEN;
      const bad = items.filter((x) => !token.test(x));
      if (items.length === 0) issues.push(`${SETTING_LABELS[key]} needs at least one value`);
      else if (bad.length)
        issues.push(
          `${SETTING_LABELS[key]}: unknown value ${bad.join(', ')}${key === 'allowed_card' ? ` – use ${CARD_SCHEMES.join(', ')}, {card} or {other}` : ' – use currency codes, {purchase} or {other}'}`,
        );
      else out[key] = items.join(',');
    }
  }
  return out;
}

const describeSettings = (s) =>
  Object.entries(s || {})
    .map(([k, v]) => `${SETTING_LABELS[k] || k}=${v === '' ? 'none' : v}`)
    .join('; ');

const describeBankExpected = (e) =>
  [
    e.routing ? ROUTING_LABELS[e.routing] : '',
    (e.statuses || []).length ? `status ${(e.statuses || []).join(' / ')}` : '',
    e.code ? `code ${e.code}` : '',
    e.errorContains ? `error contains "${e.errorContains}"` : '',
    e.currency ? `PSP currency ${e.currency}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const titleCase = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** @param {{ parseAssignments: Function, norm: (s: string) => string }} shared */
module.exports = function refundBankCases(shared) {
  const { parseAssignments, norm } = shared;

  const CATEGORIES = {
    refund: {
      label: 'Refund cases',
      prefix: 'RC',
      file: 'refund-cases.json',
      description:
        'One or more refund requests (POST /purchases/{id}/refund) on a new payment, an unpaid purchase or the settled purchase from the Run tab; the last answer and the final status must match.',
      columns: [
        {
          key: 'title',
          header: 'Test Case',
          required: true,
          width: 34,
          aliases: ['scenario', 'title'],
          guide: 'Short name of the case',
          example: 'Two partial refunds then the rest',
        },
        {
          key: 'purchase',
          header: 'Purchase',
          required: false,
          width: 26,
          aliases: ['purchase type', 'on'],
          options: Object.values(REFUND_PURCHASE_LABELS),
          guide:
            'Empty = New payment (paid with the card). Settled purchase = the purchase ID entered on the Run tab',
          example: 'New payment',
        },
        {
          key: 'card',
          header: 'Card',
          required: false,
          width: 22,
          aliases: ['test card', 'card id'],
          options: 'cards',
          guide: 'Test card ID for a new payment. Empty = the Run tab card',
          example: '',
        },
        {
          key: 'refunds',
          header: 'Refunds',
          required: true,
          width: 30,
          aliases: ['refund steps', 'amounts', 'steps'],
          guide:
            'Refund amounts in order, separated by ";": 30% · 2.50 · rest · rest+1 · total · 0 · -1 · "abc" · not sent. Every step waits until the previous refund is processed; the expectations apply to the LAST step',
          example: '30%; rest',
        },
        {
          key: 'reason',
          header: 'Reason',
          required: false,
          width: 22,
          aliases: ['refund reason'],
          guide: 'Empty = "QA refund". not sent · "" (empty) · any text',
          example: '',
        },
        {
          key: 'http',
          header: 'Expected HTTP',
          required: false,
          width: 14,
          aliases: ['http', 'http status'],
          guide: 'HTTP of the last refund: 202 accepted, 400 rejected',
          example: '202',
        },
        {
          key: 'code',
          header: 'Expected Code',
          required: false,
          width: 26,
          aliases: ['code', 'error code'],
          guide: 'Code of a rejection, e.g. invalid_amount, payment_can_not_be_refunded',
          example: '',
        },
        {
          key: 'message',
          header: 'Expected Message Contains',
          required: false,
          width: 30,
          aliases: ['message', 'error message'],
          guide: 'Text that must appear in the answer message',
          example: '',
        },
        {
          key: 'status',
          header: 'Expected Status',
          required: false,
          width: 22,
          aliases: ['purchase status', 'status'],
          guide: 'Final purchase status, e.g. REFUNDED, PARTIAL_REFUNDED, PAID (several with /)',
          example: 'REFUNDED',
        },
      ],
      examples: [
        [
          'Two partial refunds then the rest',
          'New payment',
          '',
          '20%; 30%; rest',
          '',
          '202',
          '',
          '',
          'REFUNDED',
        ],
        [
          'Refund more than the rest',
          'New payment',
          '',
          '50%; rest+1',
          '',
          '400',
          'invalid_amount',
          'exceeds refundable amount',
          'PARTIAL_REFUNDED',
        ],
        [
          'Refund without reason',
          'Unpaid purchase',
          '',
          '1',
          'not sent',
          '400',
          '',
          'reason for refund is required',
          '',
        ],
      ],
    },
    'bank-config': {
      label: 'Bank & MID config cases',
      prefix: 'BC',
      file: 'bank-config.json',
      description:
        "Temporarily changes the routed MID's settings (2D only, partial refund, convert to, allowed currencies / cards) and the merchant's conversion switch, pays or refunds, checks routing / status / code, then restores everything. Runs on its own, one worker.",
      columns: [
        {
          key: 'title',
          header: 'Test Case',
          required: true,
          width: 34,
          aliases: ['scenario', 'title'],
          guide: 'Short name of the case',
          example: 'Only Mastercard on the MID – Visa skipped',
        },
        {
          key: 'settings',
          header: 'Settings',
          required: true,
          width: 40,
          aliases: ['mid settings', 'changes', 'setting'],
          guide:
            'name=value; … – 2D only=1/0 · Partial refund=1/0 · Convert to=USD/{other}/none · Allowed currencies=EUR,{other} · Allowed cards=MASTER/{card}/{other} · Merchant conversion=1/0. {purchase}/{card} = the purchase currency / card scheme, {other} = a different one',
          example: 'Allowed cards={other}',
        },
        {
          key: 'action',
          header: 'Action',
          required: false,
          width: 16,
          aliases: ['do', 'step'],
          options: Object.values(ACTION_LABELS),
          guide:
            'Empty = Pay. Refund actions pay first with the current settings, then change them and refund',
          example: 'Pay',
        },
        {
          key: 'card',
          header: 'Card',
          required: false,
          width: 22,
          aliases: ['test card', 'card id'],
          options: 'cards',
          guide: 'Test card ID. Empty = the Run tab card',
          example: '',
        },
        {
          key: 'changes',
          header: 'Request Changes',
          required: false,
          width: 28,
          aliases: ['request'],
          guide: 'Purchase changes, e.g. purchase.total=20. Empty = standard request',
          example: '',
        },
        {
          key: 'routing',
          header: 'Expected Routing',
          required: false,
          width: 18,
          aliases: ['routing', 'mid'],
          options: Object.values(ROUTING_LABELS),
          guide: 'Pay only: whether the payment is processed on the MID under test',
          example: 'Skips the MID',
        },
        {
          key: 'status',
          header: 'Expected Status',
          required: false,
          width: 20,
          aliases: ['purchase status', 'status'],
          guide: 'Final purchase status (several with /)',
          example: 'ERROR',
        },
        {
          key: 'code',
          header: 'Expected Code',
          required: false,
          width: 26,
          aliases: ['code', 'error code'],
          guide: 'Refund answer code, e.g. payment_can_not_be_refunded',
          example: '',
        },
        {
          key: 'error',
          header: 'Expected Error Contains',
          required: false,
          width: 28,
          aliases: ['error', 'message'],
          guide: 'Text in the purchase error / refund message',
          example: 'can not be processed',
        },
        {
          key: 'currency',
          header: 'Expected PSP Currency',
          required: false,
          width: 18,
          aliases: ['psp currency', 'converted currency'],
          guide: 'Currency sent to the PSP (conversion), e.g. USD or {other}',
          example: '',
        },
      ],
      examples: [
        [
          'Only the other card scheme allowed – MID skipped',
          'Allowed cards={other}',
          'Pay',
          '',
          '',
          'Skips the MID',
          'ERROR',
          '',
          'can not be processed',
          '',
        ],
        [
          'Conversion to another currency',
          'Convert to={other}; Merchant conversion=1',
          'Pay',
          '',
          '',
          'Uses the MID',
          '',
          '',
          '',
          '{other}',
        ],
        [
          'Partial refund switched off',
          'Partial refund=0',
          'Partial refund',
          '',
          '',
          '',
          '',
          'payment_can_not_be_refunded',
          '',
          '',
        ],
      ],
    },
  };

  function parseRefundRows(rows, get, cardIds) {
    const cases = [];
    for (const { row, cells } of rows) {
      const v = get(cells);
      if (!v.title && !v.refunds && !v.http) continue;
      const issues = [];
      const warnings = [];
      if (!v.title) issues.push('Test Case is empty');
      const purchase = v.purchase ? REFUND_PURCHASES[norm(v.purchase)] : 'new';
      if (!purchase)
        issues.push(`Purchase must be one of: ${Object.values(REFUND_PURCHASE_LABELS).join(', ')}`);
      const steps = [];
      for (const part of String(v.refunds || '').split(/;|\n/)) {
        if (!part.trim()) continue;
        const amount = parseRefundAmount(part);
        if (amount.error) issues.push(amount.error);
        else steps.push({ amount });
      }
      if (steps.length === 0) issues.push('Refunds is empty – give at least one amount, e.g. 30%');
      if (steps.length > 6) issues.push('At most 6 refund steps per case');
      const http = v.http ? Number(v.http) : undefined;
      if (v.http && (!Number.isInteger(http) || Number(http) < 100 || Number(http) > 599))
        issues.push('Expected HTTP must be a status code, e.g. 202 or 400');
      const statuses = splitStatuses(v.status);
      if (!http && !v.code && !v.message && statuses.length === 0)
        issues.push('Give at least one expectation (HTTP, code, message or status)');
      if (purchase === 'unpaid' && statuses.some((s) => s.includes('REFUND')))
        warnings.push('An unpaid purchase cannot become refunded');
      if (v.card && purchase !== 'new') warnings.push('Card is only used for a new payment');
      if (v.card && cardIds.length && !cardIds.includes(v.card))
        warnings.push(`Card "${v.card}" is not on the Test cards tab of this environment`);
      const reason = parseReason(v.reason);
      const data = {
        title: v.title,
        purchase: purchase || 'new',
        ...(v.card ? { card: v.card } : {}),
        steps,
        ...(reason.kind === 'default' ? {} : { reason }),
        expected: {
          ...(http ? { http } : {}),
          ...(v.code ? { code: v.code.trim() } : {}),
          ...(v.message ? { messageContains: v.message } : {}),
          ...(statuses.length ? { statuses } : {}),
        },
      };
      cases.push({
        rows: [row],
        data,
        display: [
          v.title,
          `${REFUND_PURCHASE_LABELS[data.purchase]}${v.card ? ` · ${v.card}` : ''}`,
          [steps.map((s) => describeRefundAmount(s.amount)).join(' → '), describeReason(reason)]
            .filter(Boolean)
            .join(' · '),
          describeRefundExpected(data.expected),
        ],
        issues,
        warnings,
      });
    }
    return cases;
  }

  function parseBankRows(rows, get, cardIds) {
    const cases = [];
    for (const { row, cells } of rows) {
      const v = get(cells);
      if (!v.title && !v.settings) continue;
      const issues = [];
      const warnings = [];
      if (!v.title) issues.push('Test Case is empty');
      const settings = parseBankSettings(v.settings, norm, issues);
      if (Object.keys(settings).length === 0 && !issues.length) issues.push('Settings is empty');
      const action = v.action ? BANK_ACTIONS[norm(v.action)] : 'pay';
      if (!action) issues.push(`Action must be one of: ${Object.values(ACTION_LABELS).join(', ')}`);
      const routing = v.routing ? ROUTING[norm(v.routing)] : undefined;
      if (v.routing && !routing)
        issues.push(`Expected Routing must be: ${Object.values(ROUTING_LABELS).join(' or ')}`);
      if (routing && action !== 'pay') warnings.push('Expected Routing only applies to Pay');
      const currency = String(v.currency || '').trim();
      const currencyToken = currency
        .toUpperCase()
        .replace('{OTHER}', '{other}')
        .replace('{PURCHASE}', '{purchase}');
      if (currency && !CURRENCY_TOKEN.test(currencyToken))
        issues.push('Expected PSP Currency must be a currency code, {other} or {purchase}');
      const statuses = splitStatuses(v.status);
      if (!routing && statuses.length === 0 && !v.code && !v.error && !currency)
        issues.push('Give at least one expectation (routing, status, code, error or PSP currency)');
      if (action !== 'pay' && Object.keys(settings).some((k) => k !== 'partial_refund_allowed'))
        warnings.push(
          'Refunds only look at Partial refund – the other settings do not change a refund',
        );
      if (v.code && action === 'pay')
        warnings.push('Expected Code is the refund answer code – use Status / Error for payments');
      const changes = parseAssignments(v.changes, issues);
      if (v.card && cardIds.length && !cardIds.includes(v.card))
        warnings.push(`Card "${v.card}" is not on the Test cards tab of this environment`);
      const data = {
        title: v.title,
        settings,
        action: action || 'pay',
        ...(v.card ? { card: v.card } : {}),
        ...(Object.keys(changes.set).length ? { set: changes.set } : {}),
        ...(changes.remove.length ? { remove: changes.remove } : {}),
        expected: {
          ...(routing ? { routing } : {}),
          ...(statuses.length ? { statuses } : {}),
          ...(v.code ? { code: v.code.trim() } : {}),
          ...(v.error ? { errorContains: v.error } : {}),
          ...(currency ? { currency: currencyToken } : {}),
        },
      };
      cases.push({
        rows: [row],
        data,
        display: [
          v.title,
          describeSettings(settings),
          `${ACTION_LABELS[data.action]}${v.card ? ` · ${v.card}` : ''}${
            Object.keys(changes.set).length
              ? ` · ${Object.entries(changes.set)
                  .map(([k, x]) => `${k}=${JSON.stringify(x)}`)
                  .join('; ')}`
              : ''
          }`,
          describeBankExpected(data.expected),
        ],
        issues,
        warnings,
      });
    }
    return cases;
  }

  const PARSERS = { refund: parseRefundRows, 'bank-config': parseBankRows };
  const PREVIEW_COLUMNS = {
    refund: ['Test case', 'Purchase', 'Refunds', 'Expected'],
    'bank-config': ['Test case', 'Settings', 'Action', 'Expected'],
  };

  function signature(categoryId, c) {
    if (categoryId === 'refund')
      return JSON.stringify([c.purchase, c.card || '', c.steps, c.reason || null, c.expected]);
    return JSON.stringify([
      c.settings,
      c.action,
      c.card || '',
      c.set || {},
      [...(c.remove || [])].sort(),
      c.expected,
    ]);
  }

  const str = (v, max) => String(v ?? '').slice(0, max);
  const PATH_RE = /^[A-Za-z_]\w*(\.\w+)*$/;

  function validate(categoryId, d, need) {
    const e = d.expected || {};
    const statuses =
      Array.isArray(e.statuses) && e.statuses.length
        ? { statuses: e.statuses.map((s) => str(s, 40).toUpperCase()) }
        : {};
    if (categoryId === 'refund') {
      need(Object.values(REFUND_PURCHASES).includes(d.purchase), 'invalid purchase');
      need(
        Array.isArray(d.steps) && d.steps.length >= 1 && d.steps.length <= 6,
        'needs 1–6 refund steps',
      );
      const steps = d.steps.map((s) => {
        const a = (s && s.amount) || {};
        need(
          ['none', 'total', 'rest', 'percent', 'fixed', 'raw'].includes(a.kind),
          'invalid refund amount',
        );
        if (a.kind === 'percent' || a.kind === 'fixed')
          need(Number.isFinite(a.value), 'invalid refund amount');
        return {
          amount: {
            kind: a.kind,
            ...(a.kind === 'raw'
              ? { value: str(a.value, 60) }
              : a.value !== undefined
                ? { value: Number(a.value) }
                : {}),
            ...(a.kind === 'rest' && Number.isFinite(a.delta) ? { delta: Number(a.delta) } : {}),
          },
        };
      });
      const r = d.reason;
      need(!r || ['none', 'value'].includes(r.kind), 'invalid reason');
      need(
        !e.http || (Number.isInteger(e.http) && e.http >= 100 && e.http <= 599),
        'invalid expected HTTP',
      );
      return {
        title: str(d.title, 200),
        purchase: d.purchase,
        ...(d.card ? { card: str(d.card, 60) } : {}),
        steps,
        ...(r
          ? {
              reason:
                r.kind === 'value' ? { kind: 'value', value: str(r.value, 200) } : { kind: 'none' },
            }
          : {}),
        expected: {
          ...(e.http ? { http: e.http } : {}),
          ...(e.code ? { code: str(e.code, 60) } : {}),
          ...(e.messageContains ? { messageContains: str(e.messageContains, 300) } : {}),
          ...statuses,
        },
      };
    }
    const settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
    const clean = {};
    for (const [k, v] of Object.entries(settings)) {
      need(Object.prototype.hasOwnProperty.call(SETTING_LABELS, k), `invalid setting "${k}"`);
      if (FLAG_SETTINGS.has(k)) {
        need(v === 0 || v === 1, `${SETTING_LABELS[k]} must be 0 or 1`);
        clean[k] = v;
      } else {
        const text = str(v, 600);
        const items = text.split(',').filter(Boolean);
        const token = k === 'allowed_card' ? CARD_TOKEN : CURRENCY_TOKEN;
        need(
          items.every((x) => token.test(x)) &&
            (k === 'curr_convert_to' ? items.length <= 1 : items.length >= 1),
          `invalid ${SETTING_LABELS[k]}`,
        );
        clean[k] = text;
      }
    }
    need(Object.keys(clean).length > 0, 'no settings');
    need(Object.values(BANK_ACTIONS).includes(d.action), 'invalid action');
    const set = d.set && typeof d.set === 'object' ? d.set : {};
    for (const k of Object.keys(set)) need(PATH_RE.test(k), `invalid field "${k}"`);
    const remove = Array.isArray(d.remove) ? d.remove.filter((k) => PATH_RE.test(k)) : [];
    need(!e.routing || ['uses', 'skips'].includes(e.routing), 'invalid expected routing');
    need(!e.currency || CURRENCY_TOKEN.test(e.currency), 'invalid expected currency');
    return {
      title: str(d.title, 200),
      settings: clean,
      action: d.action,
      ...(d.card ? { card: str(d.card, 60) } : {}),
      ...(Object.keys(set).length ? { set } : {}),
      ...(remove.length ? { remove } : {}),
      expected: {
        ...(e.routing ? { routing: e.routing } : {}),
        ...statuses,
        ...(e.code ? { code: str(e.code, 60) } : {}),
        ...(e.errorContains ? { errorContains: str(e.errorContains, 300) } : {}),
        ...(e.currency ? { currency: e.currency } : {}),
      },
    };
  }

  function summarize(categoryId, c) {
    if (categoryId === 'refund')
      return [
        `${REFUND_PURCHASE_LABELS[c.purchase] || c.purchase}${c.card ? ` · ${c.card}` : ''}`,
        [
          c.steps.map((s) => describeRefundAmount(s.amount)).join(' → '),
          c.reason ? describeReason(c.reason) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        describeRefundExpected(c.expected),
      ];
    return [
      describeSettings(c.settings),
      `${ACTION_LABELS[c.action] || c.action}${c.card ? ` · ${c.card}` : ''}`,
      describeBankExpected(c.expected),
    ];
  }

  return { CATEGORIES, PARSERS, PREVIEW_COLUMNS, signature, validate, summarize, titleCase };
};

module.exports.parseRefundAmount = parseRefundAmount;
module.exports.describeRefundAmount = describeRefundAmount;
module.exports.SETTING_LABELS = SETTING_LABELS;
module.exports.ACTION_LABELS = ACTION_LABELS;
module.exports.REFUND_PURCHASE_LABELS = REFUND_PURCHASE_LABELS;
