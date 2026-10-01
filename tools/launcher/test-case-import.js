// @ts-check
/**
 * Upload of additional test cases from Excel / CSV, by category:
 *
 *   field  → Field validation          (FV-xxx)  request field rules
 *   regex  → Regex validation          (RX-xxx)  value vs regex + API behaviour
 *   psp    → PSP request / response    (PR-xxx)  checks on what was sent to / received from the PSP
 *   edge   → Custom & edge cases       (EC-xxx)  end-to-end scenarios with an expected outcome
 *   kyc    → KYC validation            (KV-xxx)  POST /kyc/create: request / customer / auth → HTTP, code, status
 *   refund → Refund cases              (RC-xxx)  refund steps on a purchase → HTTP, code, final status
 *   s2s    → S2S cases                 (S2-xxx)  S2S card payment: purchase + auth + body changes → HTTP, status, outcome
 *   bank-config → Bank & MID config    (BC-xxx)  flip MID / merchant settings → pay / refund → routing, status
 *
 * Each category has its own template (download from the launcher), parser and
 * JSON file under tests/test-data/uploaded-cases/. Nothing is saved on preview.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { FIELD_PATHS, expectationLabel } = require('./regex-cases');

const ROOT = path.resolve(__dirname, '..', '..');
/** UPLOADED_CASES_DIR lets the framework self-tests use an empty folder. */
const DATA_DIR =
  process.env.UPLOADED_CASES_DIR || path.join(ROOT, 'tests', 'test-data', 'uploaded-cases');
const MAX_ROWS = 1000;
const EXPECTATIONS = ['accepted', 'rejected', 'observe', 'sanitized'];

// ── request field mapping (shared) ─────────────────────────────────────────────

const TOP_LEVEL = [
  'brand_id',
  'paymentMethod',
  'success_redirect',
  'pending_redirect',
  'failure_redirect',
  'success_callback',
  'failure_callback',
];
const CLIENT = [
  'email',
  'country',
  'city',
  'stateCode',
  'street_address',
  'zip_code',
  'date_of_birth',
  'phone',
  'full_name',
];
const PRICE_PATH = 'purchase.products.0.price';
const NUMERIC_PATHS = new Set([PRICE_PATH, 'purchase.total']);

/** Maps a sheet parameter (e.g. "cashier.full_name", "purchase.products.price") to a request path. */
function mapParameter(raw) {
  const param = String(raw || '').trim();
  const lower = param.toLowerCase().replace(/\s+/g, '');
  if (!lower) return { error: 'Parameter is empty' };
  const note = lower.startsWith('cashier.')
    ? 'Sheet targets a cashier field; the API case sends it on the purchase request.'
    : undefined;
  const key = lower.replace(/^(client|cashier)\./, '');
  const clientKey = CLIENT.find((k) => k.toLowerCase() === key);
  if ((lower.startsWith('client.') || lower.startsWith('cashier.')) && clientKey) {
    return { path: `client.${clientKey}`, note };
  }
  const top = TOP_LEVEL.find((k) => k.toLowerCase() === lower);
  if (top) return { path: top };
  if (lower === 'purchase.currency' || lower === 'currency') return { path: 'purchase.currency' };
  if (lower === 'purchase.total' || lower === 'total') return { path: 'purchase.total' };
  if (lower === 'purchase.products') return { path: 'purchase.products' };
  if (lower === 'purchase.products.name') return { path: 'purchase.products.0.name' };
  if (lower === 'purchase.products.price') return { path: PRICE_PATH };
  // Payment-method parameters: any key inside extraParam (keys differ per payment method).
  const extra = /^extra_?params?\.(.+)$/i.exec(param);
  if (extra) {
    if (!/^[\w-]+$/.test(extra[1]))
      return { error: `extraParam key "${extra[1]}" may only use letters, digits, _ and -` };
    return { path: `extraParam.${extra[1]}`, dynamic: true };
  }
  if (/^extra_?params?$/i.test(param)) return { path: 'extraParam', dynamic: true };
  // A bare customer field ("country") means client.country.
  if (clientKey && !lower.includes('.')) return { path: `client.${clientKey}` };
  // Other payment-method fields at the top level (upiId, invoiceNo, …) – sent as written.
  if (/^[a-z_][\w-]*$/i.test(param)) return { path: param, dynamic: true };
  if (/^[a-z_]\w*(\.\w+)+$/i.test(param))
    return { path: param, warning: `"${param}" is not a known field – sent as written` };
  return { error: `Unknown parameter "${param}"` };
}

/** Infers the expectation type from the "Expected Result" text. */
function inferExpectation(expected) {
  const text = String(expected || '').toLowerCase();
  if (/sanitiz/.test(text)) return 'sanitized';
  if (/\bif\b|according to|otherwise|\bor\b|if supported|if mandatory/.test(text)) return 'observe';
  if (/^\s*accept/.test(text)) return 'accepted';
  if (/validation|error|reject|not allowed|not enabled|blocked|invalid/.test(text))
    return 'rejected';
  return 'observe';
}

/** Parses one "Test Data" value into a mutation (+ optional context). */
function parseValue(raw, targetPath) {
  let text = String(raw ?? '').trim();
  /** @type {Record<string, unknown>} */
  const context = {};

  // "110001 with country=IN", "AE07… with paymentMethod=BANKTRANSFER; extraParam.name=QA"
  const withCtx = /^(.*?)\s+with\s+([a-z_][\w.-]*\s*=.*)$/i.exec(text);
  if (withCtx) {
    for (const part of withCtx[2].split(';')) {
      const m = /^\s*([a-z_][\w.-]*)\s*=\s*(.*?)\s*$/i.exec(part);
      if (!m) continue;
      const key = mapParameter(m[1]).path || m[1];
      const parsed = parseValue(m[2], key);
      if (parsed.mutation.type === 'set') context[key] = parsed.mutation.value;
    }
    text = withCtx[1].trim();
  }
  if (/^(field )?not sent$|^missing$|^omit(ted)?$|^remove$/i.test(text))
    return { mutation: { type: 'remove' }, context };
  if (/valid .*from dashboard|^baseline$|^\(baseline\)$|valid name and price/i.test(text)) {
    return { mutation: { type: 'none' }, context };
  }
  if (/^null$/i.test(text)) return { mutation: { type: 'set', value: null }, context };
  const quoted = /^"(.*)"$/s.exec(text) || /^'(.*)'$/s.exec(text);
  if (quoted) return { mutation: { type: 'set', value: quoted[1] }, context };
  const noQuotes = /^(-?\d+(?:\.\d+)?)\s*\(no quotes\)$/i.exec(text);
  if (noQuotes) return { mutation: { type: 'set', value: Number(noQuotes[1]) }, context };
  const length = /^(\d+)(\+)?\s*characters?$/i.exec(text);
  if (length) {
    const n = Number(length[1]) + (length[2] ? 1 : 0);
    return {
      mutation: { type: 'set', value: 'x'.repeat(n) },
      context,
      generated: `${n} characters`,
    };
  }
  // JSON object / array, e.g. {"iban":"AE07…","accountNumber":"123"} for the whole extraParam.
  if (/^[[{]/.test(text)) {
    try {
      return { mutation: { type: 'set', value: JSON.parse(text) }, context };
    } catch {
      return {
        mutation: { type: 'set', value: text },
        context,
        warning: 'Looks like JSON but is not valid JSON – sent as text',
      };
    }
  }
  const literal = /^(true|false|-?\d+(?:\.\d+)?)\s*\((?:no quotes|boolean|number)\)$/i.exec(text);
  if (literal) {
    const v = literal[1].toLowerCase();
    return {
      mutation: { type: 'set', value: v === 'true' ? true : v === 'false' ? false : Number(v) },
      context,
    };
  }
  if (NUMERIC_PATHS.has(targetPath) && /^-?\d+(\.\d+)?$/.test(text)) {
    return { mutation: { type: 'set', value: Number(text) }, context };
  }
  return { mutation: { type: 'set', value: text }, context };
}

/** "client.country=US; purchase.total=5" → { 'client.country': 'US', 'purchase.total': 5 } */
function parseAssignments(raw, issues) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const removed = [];
  for (const part of String(raw || '').split(/[;\n]/)) {
    if (!part.trim()) continue;
    const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m) {
      issues.push(`Cannot read "${part.trim()}" – use field=value`);
      continue;
    }
    const mapped = mapParameter(m[1]);
    if (mapped.error) {
      issues.push(mapped.error);
      continue;
    }
    const target = mapped.path || m[1];
    const parsed = parseValue(m[2], target);
    if (parsed.mutation.type === 'remove') removed.push(target);
    else if (parsed.mutation.type === 'set') out[target] = parsed.mutation.value;
  }
  return { set: out, remove: removed };
}

const describeValue = (mutation) =>
  mutation.type === 'remove'
    ? '(field not sent)'
    : mutation.type === 'none'
      ? '(baseline value)'
      : typeof mutation.value === 'string' && mutation.value.length > 40
        ? `"${mutation.value.slice(0, 12)}…" (${mutation.value.length} chars)`
        : JSON.stringify(mutation.value);
const describeContext = (context) =>
  context && Object.keys(context).length
    ? Object.entries(context)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
    : '';

// ── KYC ──────────────────────────────────────────────────────────────────────
/** Who the KYC create is for (the customer is created first with complete dummy data). */
const KYC_CUSTOMERS = {
  'new customer': 'new',
  'new customer (merchant_cust_id)': 'by-merchant-id',
  'unknown customer_id': 'unknown-customer-id',
  'unknown merchant_cust_id': 'unknown-merchant-id',
  'no customer id': 'none',
};
/** Authentication variant of the request. */
const KYC_AUTH = {
  valid: 'valid',
  'no authorization header': 'none',
  'key without bearer': 'no-bearer',
  'unknown key': 'invalid-key',
  'no brand-id': 'no-brand',
  'brand not owned': 'other-brand',
};
const KYC_STATUSES = [
  'CREATED',
  'AWAITING_USER',
  'KYC_PENDING',
  'KYC_IN_PROCESS',
  'MANUAL_REVIEW',
  'KYC_APPROVED',
  'KYC_REJECTED',
  'RESUBMISSION_REQUIRED',
  'KYC_EXPIRED',
  'KYC_FAILED',
  'KYC_CANCELLED',
];
const KYC_NUMERIC = new Set(['link_ttl_minutes', 'kyc_expiry_in_minutes']);
/** Customer record fields (POST /api/v1/customer, camelCase) – `customer.<field>` in Request Changes. */
const KYC_CUSTOMER_FIELDS = [
  'merchantCustomerId',
  'fullName',
  'emailId',
  'phoneNo',
  'dateOfBirth',
  'address',
  'city',
  'stateCode',
  'zipCode',
  'country',
];
const labelOf = (map, id) => {
  const label = Object.keys(map).find((k) => map[k] === id) || id;
  return label.replace(/^./, (c) => c.toUpperCase());
};

/** "country=GB; link_ttl_minutes=5; customer.fullName not sent" → kyc body / customer changes. */
function parseKycChanges(raw, issues) {
  const body = { set: {}, remove: [] };
  const customer = { set: {}, remove: [] };
  for (const part of String(raw || '').split(/[;\n]/)) {
    const text = part.trim();
    if (!text) continue;
    const notSent = /^([A-Za-z_][\w.]*)\s+(not sent|removed?|missing)$/i.exec(text);
    const m = notSent ? null : /^([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(text);
    if (!notSent && !m) {
      issues.push(`Cannot read "${text}" – use field=value or "field not sent"`);
      continue;
    }
    const field = (notSent || m)[1];
    const isCustomer = field.startsWith('customer.');
    const name = isCustomer ? field.slice('customer.'.length) : field;
    if (isCustomer && !KYC_CUSTOMER_FIELDS.includes(name)) {
      issues.push(`Unknown customer field "${name}" – use ${KYC_CUSTOMER_FIELDS.join(', ')}`);
      continue;
    }
    if (!isCustomer && name === 'test') {
      issues.push('"test" cannot be changed – every KYC case runs with test=true');
      continue;
    }
    const target = isCustomer ? customer : body;
    if (notSent) {
      target.remove.push(name);
      continue;
    }
    const parsed = parseValue(m[2], name);
    if (parsed.mutation.type === 'remove') target.remove.push(name);
    else if (parsed.mutation.type === 'set') {
      let value = parsed.mutation.value;
      if (KYC_NUMERIC.has(name) && typeof value === 'string' && /^-?\d+$/.test(value))
        value = Number(value);
      target.set[name] = value;
    }
  }
  return { body, customer };
}

// ── categories ─────────────────────────────────────────────────────────────────

const CASHIER_RESULTS = {
  'success redirect': 'success-redirect',
  'failure redirect': 'failure-redirect',
  'pending redirect': 'pending-redirect',
  'rejected by cashier': 'rejected',
  'stays on another page': 'other-page',
};
const OUTCOME_LABELS = Object.fromEntries(
  Object.entries(CASHIER_RESULTS).map(([label, id]) => [
    id,
    label.replace(/^./, (ch) => ch.toUpperCase()),
  ]),
);
const CHECKS = ['equals', 'not equals', 'contains', 'matches', 'present', 'absent', 'masked'];

/**
 * Column definitions drive the template, the header detection and the guide.
 * `required` columns have a dark header in the template, optional ones a light one.
 */
const CATEGORIES = {
  field: {
    label: 'Field validation',
    prefix: 'FV',
    file: 'field-validation.json',
    description:
      'One request field is changed per case; the API response must match the expectation.',
    columns: [
      {
        key: 'parameter',
        header: 'Parameter',
        required: true,
        width: 24,
        aliases: ['param'],
        guide:
          'Request field – client.zip_code, purchase.total … Payment-method parameters: extraParam.<any key> (e.g. extraParam.iban), extraParam (whole object) or a top-level name (upiId, invoiceNo)',
        example: 'client.zip_code',
      },
      {
        key: 'title',
        header: 'Test Case',
        required: true,
        width: 34,
        aliases: ['scenario', 'title'],
        guide: 'Short name of the case',
        example: 'Letters in US ZIP code',
      },
      {
        key: 'data',
        header: 'Test Data',
        required: true,
        width: 28,
        aliases: ['test data / example', 'example', 'value'],
        guide:
          'Value to send. "Field not sent" removes the field, "" sends an empty string, null, 123 (no quotes) = number, true (boolean), {"k":"v"} / ["x"] = JSON, "256 characters" generates a long value',
        example: '12AB5',
      },
      {
        key: 'expected',
        header: 'Expected Result',
        required: true,
        width: 32,
        aliases: [],
        guide: 'What should happen',
        example: 'Validation error',
      },
      {
        key: 'expectation',
        header: 'Expectation',
        required: false,
        width: 16,
        aliases: [],
        options: EXPECTATIONS,
        guide:
          'Leave empty to derive it from Expected Result. accepted = 2xx · rejected = 4xx · observe = record only · sanitized = injection handled',
        example: 'rejected',
      },
      {
        key: 'context',
        header: 'Context',
        required: false,
        width: 26,
        aliases: [],
        guide:
          'Other fields to set first, separated by ; – e.g. client.country=US, or paymentMethod=UPI; extraParam.accountNumber="123" for payment-method parameters',
        example: 'client.country=US',
      },
    ],
    examples: [
      [
        'client.zip_code',
        'Letters in US ZIP code',
        '12AB5',
        'Validation error',
        'rejected',
        'client.country=US',
      ],
      ['client.email', 'Email not sent', 'Field not sent', 'Validation error', 'rejected', ''],
      [
        'extraParam.iban',
        'IBAN empty for bank transfer',
        '""',
        'Accepted – the cashier asks for it',
        'accepted',
        'paymentMethod=VISA; extraParam.accountNumber="123456789"',
      ],
      [
        'extraParam',
        'extraParam as text instead of an object',
        '"iban=AE07"',
        'Validation error',
        'rejected',
        '',
      ],
      [
        'purchase.products.price',
        'Price with three decimals',
        '10.999',
        'Validation error or rounded',
        'observe',
        '',
      ],
    ],
  },
  regex: {
    label: 'Regex validation',
    prefix: 'RX',
    file: 'regex-validation.json',
    description:
      "Uses the bank's field regex (dashboard → PaymentBankJsonData): a matching value must reach the PSP unchanged, a non-matching one must not.",
    columns: [
      {
        key: 'bank',
        header: 'Bank',
        required: false,
        width: 20,
        aliases: ['psp', 'bank name'],
        guide:
          'Bank whose regex applies, as named in the dashboard. Empty = the bank the payment is routed to',
        example: 'paysafe_payfac',
      },
      {
        key: 'parameter',
        header: 'Field',
        required: true,
        width: 18,
        aliases: ['parameter', 'param', 'field name'],
        guide:
          'Field name as in the dashboard Field Regex list: full_name, phone, city, zip_code, stateCode, street_address, date_of_birth, gender, email',
        example: 'full_name',
      },
      {
        key: 'title',
        header: 'Test Case',
        required: true,
        width: 30,
        aliases: ['scenario', 'title'],
        guide: 'Short name of the case',
        example: 'Name with digits',
      },
      {
        key: 'data',
        header: 'Test Data',
        required: true,
        width: 26,
        aliases: ['value', 'example'],
        guide: 'Value to send on the purchase',
        example: 'John123',
      },
      {
        key: 'country',
        header: 'Country',
        required: false,
        width: 10,
        aliases: ['customer country'],
        guide:
          'Customer country (ISO alpha-2, e.g. IN) – per-country rules like phone use it. Empty = the standard request country',
        example: 'IN',
      },
      {
        key: 'result',
        header: 'Expected Result',
        required: false,
        width: 16,
        aliases: ['expected'],
        options: ['Valid', 'Invalid'],
        guide:
          "Valid = must reach the PSP unchanged · Invalid = must not reach the PSP. Empty = decided by the bank's regex at run time",
        example: 'Invalid',
      },
    ],
    examples: [
      ['paysafe_payfac', 'full_name', 'Name with digits', 'John123', '', 'Invalid'],
      ['', 'full_name', 'Name with hyphen', 'Jean-Luc Picard', '', ''],
      ['', 'phone', 'Indian number without +91', '9876543210', 'IN', ''],
    ],
  },
  psp: {
    label: 'PSP request / response',
    prefix: 'PR',
    file: 'psp-validation.json',
    description:
      'Pays with the card, reads the PSP log from the dashboard and checks fields of the PSP request / response. Rows with the same Test Case form one transaction.',
    columns: [
      {
        key: 'title',
        header: 'Test Case',
        required: true,
        width: 30,
        aliases: ['scenario', 'title'],
        guide: 'Rows with the same name are checked on one transaction',
        example: 'Order sent to PSP',
      },
      {
        key: 'card',
        header: 'Card',
        required: false,
        width: 22,
        aliases: ['test card', 'card id'],
        options: 'cards',
        guide: 'Test card ID from the Test cards tab. Empty = the card chosen on the Run tab',
        example: 'risk-rule-3ds-u',
      },
      {
        key: 'source',
        header: 'Source',
        required: true,
        width: 12,
        aliases: ['in'],
        options: ['Request', 'Response'],
        guide: 'Request = sent to the PSP · Response = received from the PSP',
        example: 'Request',
      },
      {
        key: 'field',
        header: 'PSP Field',
        required: true,
        width: 28,
        aliases: ['field', 'key', 'path'],
        guide: 'Field name or path in the PSP payload, found at any depth',
        example: 'currencyCode',
      },
      {
        key: 'check',
        header: 'Check',
        required: true,
        width: 13,
        aliases: ['condition', 'rule'],
        options: CHECKS,
        guide:
          'equals · not equals · contains · matches (regex) · present · absent · masked (stored as ***)',
        example: 'equals',
      },
      {
        key: 'value',
        header: 'Expected Value',
        required: false,
        width: 26,
        aliases: ['expected', 'value'],
        guide:
          'Text, number or a value from the purchase: {purchaseId} {amount} {amountMinor} (amount in cents) {currency} {email} {country} {city} {zip} {phone} {fullName}. Empty for present / absent / masked',
        example: '{currency}',
      },
    ],
    examples: [
      ['Order sent to PSP', '', 'Request', 'merchantRefNum', 'equals', '{purchaseId}'],
      ['Order sent to PSP', '', 'Request', 'amount', 'equals', '{amountMinor}'],
      ['Order sent to PSP', '', 'Request', 'currencyCode', 'equals', '{currency}'],
      [
        'Customer address sent to PSP',
        '',
        'Request',
        'billingDetails.country',
        'equals',
        '{country}',
      ],
      ['Customer address sent to PSP', '', 'Request', 'billingDetails.zip', 'equals', '{zip}'],
      ['PSP returns a status', '', 'Response', 'status', 'present', ''],
      ['Card data masked in PSP log', '', 'Request', 'card.cvv', 'masked', ''],
      ['Card data masked in PSP log', '', 'Request', 'card.cardNum', 'masked', ''],
    ],
  },
  edge: {
    label: 'Custom & edge cases',
    prefix: 'EC',
    file: 'edge-cases.json',
    description:
      'End-to-end scenarios: optional request changes, pay with the card, then compare cashier result, purchase status and error message.',
    columns: [
      {
        key: 'title',
        header: 'Test Case',
        required: true,
        width: 32,
        aliases: ['scenario', 'title'],
        guide: 'Short name of the scenario',
        example: '3DS result U is blocked',
      },
      {
        key: 'card',
        header: 'Card',
        required: false,
        width: 22,
        aliases: ['test card', 'card id'],
        options: 'cards',
        guide: 'Test card ID from the Test cards tab. Empty = the card chosen on the Run tab',
        example: 'risk-rule-3ds-u',
      },
      {
        key: 'changes',
        header: 'Request Changes',
        required: false,
        width: 34,
        aliases: ['changes', 'request'],
        guide:
          'Fields to change on the purchase, e.g. purchase.total=0.5; client.country=IN. Empty = standard request',
        example: 'purchase.total=0.5',
      },
      {
        key: 'cashier',
        header: 'Expected Cashier Result',
        required: false,
        width: 24,
        aliases: ['cashier result', 'cashier'],
        options: Object.keys(CASHIER_RESULTS).map((k) => k.replace(/^./, (c) => c.toUpperCase())),
        guide: 'Where the customer ends up after PAY',
        example: 'Failure redirect',
      },
      {
        key: 'status',
        header: 'Expected Status',
        required: false,
        width: 18,
        aliases: ['purchase status', 'status'],
        guide: 'Final purchase status; several allowed with /, e.g. ERROR / CANCELLED',
        example: 'ERROR',
      },
      {
        key: 'error',
        header: 'Expected Error Contains',
        required: false,
        width: 30,
        aliases: ['error', 'error message'],
        guide: 'Text that must appear in the error / PSP message',
        example: 'threeDResult is U',
      },
    ],
    examples: [
      [
        '3DS result U is blocked',
        'risk-rule-3ds-u',
        '',
        'Failure redirect',
        'ERROR',
        'threeDResult is U',
      ],
      [
        'Small amount with 3DS card',
        'risk-rule-3ds-u',
        'purchase.total=0.5; purchase.products.0.price=0.5',
        'Failure redirect',
        'ERROR',
        '',
      ],
    ],
  },
  kyc: {
    label: 'KYC validation',
    prefix: 'KV',
    file: 'kyc-validation.json',
    description:
      'POST /kyc/create with a customer, request changes and an auth variant; the answer (HTTP, code, KYC status) must match. Runs with test=true.',
    columns: [
      {
        key: 'title',
        header: 'Test Case',
        required: true,
        width: 34,
        aliases: ['scenario', 'title'],
        guide: 'Short name of the case',
        example: 'Lowercase country is accepted',
      },
      {
        key: 'customer',
        header: 'Customer',
        required: false,
        width: 30,
        aliases: ['customer id', 'subject'],
        options: Object.keys(KYC_CUSTOMERS).map((k) => k.replace(/^./, (c) => c.toUpperCase())),
        guide:
          'Empty = New customer (created first, sent as customer_id). (merchant_cust_id) sends the merchant id instead',
        example: 'New customer',
      },
      {
        key: 'changes',
        header: 'Request Changes',
        required: false,
        width: 40,
        aliases: ['changes', 'request'],
        guide:
          'KYC fields: country=GB; link_ttl_minutes=5; kyc_expiry_in_minutes=30; success_redirect=https://…; metadata.order=A1; "country not sent". Customer record: customer.fullName="Ann Lee"; customer.phoneNo not sent',
        example: 'country=gb',
      },
      {
        key: 'auth',
        header: 'Authentication',
        required: false,
        width: 24,
        aliases: ['auth', 'headers'],
        options: Object.keys(KYC_AUTH).map((k) => k.replace(/^./, (c) => c.toUpperCase())),
        guide: 'Empty = Valid (merchant key + Brand-Id)',
        example: 'Valid',
      },
      {
        key: 'http',
        header: 'Expected HTTP',
        required: true,
        width: 14,
        aliases: ['http', 'http status', 'status code'],
        guide: 'HTTP status of the answer, e.g. 200, 400, 401, 403, 404, 409',
        example: '200',
      },
      {
        key: 'code',
        header: 'Expected Code',
        required: false,
        width: 24,
        aliases: ['code', 'error code'],
        guide: 'Error code of a failure, e.g. country_required, customer_not_found, access_denied',
        example: '',
      },
      {
        key: 'status',
        header: 'Expected KYC Status',
        required: false,
        width: 22,
        aliases: ['kyc status'],
        guide: 'Status of the record on success, e.g. AWAITING_USER (several allowed with /)',
        example: 'AWAITING_USER',
      },
      {
        key: 'message',
        header: 'Expected Message Contains',
        required: false,
        width: 30,
        aliases: ['message', 'error message'],
        guide: 'Text that must appear in the message',
        example: '',
      },
    ],
    examples: [
      [
        'New customer gets a verification link',
        'New customer',
        '',
        'Valid',
        '200',
        '',
        'AWAITING_USER',
        '',
      ],
      [
        'Blank country is rejected',
        'New customer',
        'country="   "',
        'Valid',
        '400',
        'country_required',
        '',
        '',
      ],
      [
        'Unknown merchant customer id',
        'Unknown merchant_cust_id',
        '',
        'Valid',
        '404',
        'customer_not_found',
        '',
        'merchant_cust_id',
      ],
      [
        'Brand the key does not own',
        'New customer',
        '',
        'Brand not owned',
        '403',
        'access_denied',
        '',
        '',
      ],
    ],
  },
};

// Refund (RC) and bank & MID config (BC) categories – see refund-bank-cases.js.
// Defined lazily below the shared helpers (parseAssignments, norm).
let extra;
function extraCategories() {
  if (!extra) extra = require('./refund-bank-cases')({ parseAssignments, norm: (x) => norm(x) });
  return extra;
}
Object.assign(CATEGORIES, extraCategories().CATEGORIES);
// S2S card payment category (S2-xxx) – see s2s-cases.js.
let s2sExtra;
function s2sCategory() {
  if (!s2sExtra) s2sExtra = require('./s2s-cases')({ norm: (x) => norm(x) });
  return s2sExtra;
}
Object.assign(CATEGORIES, s2sCategory().CATEGORIES);

const categoryOf = (id) => {
  const c = CATEGORIES[id];
  if (!c) throw new Error(`Unknown category "${id}"`);
  return c;
};
const categoryForCaseId = (caseId) =>
  Object.keys(CATEGORIES).find((k) => caseId.startsWith(`${CATEGORIES[k].prefix}-`));

// ── reading files ──────────────────────────────────────────────────────────────

const cellText = (cell) => {
  const v = cell && cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
};

/** Reads rows from an .xlsx (first sheet that is not the guide) or .csv buffer. */
async function readRows(buffer, filename) {
  const rows = [];
  if (/\.csv$/i.test(filename)) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    let field = '';
    let record = [];
    let inQuotes = false;
    let line = 1;
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') inQuotes = false;
        else field += ch ?? '';
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        record.push(field);
        field = '';
      } else if (ch === '\n' || ch === undefined) {
        record.push(field.replace(/\r$/, ''));
        field = '';
        if (record.some((c) => c.trim()))
          rows.push({ row: line, cells: record.map((c) => c.trim()) });
        record = [];
        line++;
        if (ch === undefined) break;
      } else field += ch;
    }
    return rows;
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((s) => !/^guide$/i.test(s.name)) || workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets');
  sheet.eachRow({ includeEmpty: false }, (r, number) => {
    const cells = [];
    for (let c = 1; c <= Math.max(8, r.cellCount); c++) cells.push(cellText(r.getCell(c)).trim());
    if (cells.some(Boolean)) rows.push({ row: number, cells });
  });
  return rows;
}

const norm = (s) => String(s).toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();

/** Finds the header row (first row naming all required columns) and column positions. */
function locateColumns(rows, category) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const cells = rows[i].cells.map(norm);
    const index = {};
    for (const col of category.columns) {
      const names = [norm(col.header), ...col.aliases.map(norm)];
      index[col.key] = cells.findIndex((c) => names.includes(c));
      if (index[col.key] < 0)
        index[col.key] = cells.findIndex((c) => c.startsWith(norm(col.header)));
    }
    if (category.columns.filter((c) => c.required).every((c) => index[c.key] >= 0)) {
      return { index, bodyStart: i + 1 };
    }
  }
  const missing = category.columns
    .filter((c) => c.required)
    .map((c) => c.header)
    .join(', ');
  throw new Error(
    `Header row not found – the ${category.label} sheet needs the columns: ${missing}. Download the template to see the layout.`,
  );
}

// ── per-category row parsing ───────────────────────────────────────────────────

function parseFieldRows(rows, get) {
  const cases = [];
  for (const { row, cells } of rows) {
    const v = get(cells);
    if (!v.parameter && !v.title && !v.data) continue;
    const mapped = mapParameter(v.parameter);
    const explicit = String(v.expectation || '').toLowerCase();
    const expectation = EXPECTATIONS.includes(explicit) ? explicit : inferExpectation(v.expected);
    const values = String(v.data)
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x, i, all) => x || all.length === 1);
    values.forEach((value, i) => {
      const parsed = parseValue(value, mapped.path || '');
      const issues = [];
      const context = { ...parsed.context, ...parseAssignments(v.context, issues).set };
      if (
        mapped.path === PRICE_PATH &&
        parsed.mutation.type === 'set' &&
        !('purchase.total' in context)
      ) {
        context['purchase.total'] = parsed.mutation.value; // keep total = price so only the price rule is tested
      }
      if (mapped.error) issues.push(mapped.error);
      if (!v.expected) issues.push('Expected Result is empty');
      if (explicit && !EXPECTATIONS.includes(explicit))
        issues.push(`Expectation must be one of ${EXPECTATIONS.join(', ')}`);
      const data = {
        parameter: v.parameter,
        path: mapped.path || '',
        title:
          values.length > 1
            ? `${v.title || v.parameter} (${i + 1})`
            : v.title || `${v.parameter} – ${value}`,
        mutation: parsed.mutation,
        ...(Object.keys(context).length ? { context } : {}),
        expectation,
        expectedResult: v.expected,
        ...(mapped.note ? { apiNote: mapped.note } : {}),
      };
      cases.push({
        rows: [row],
        data,
        display: [
          v.parameter,
          data.title,
          describeValue(data.mutation) +
            (describeContext(context) ? `  · ${describeContext(context)}` : ''),
          `${v.expected} → ${expectation}`,
        ],
        issues,
        warnings: [mapped.warning, parsed.warning].filter(Boolean),
      });
    });
  }
  return cases;
}

function parseRegexRows(rows, get) {
  const cases = [];
  for (const { row, cells } of rows) {
    const v = get(cells);
    if (!v.parameter && !v.title && !v.data) continue;
    const issues = [];
    const field = String(v.parameter)
      .replace(/^(client|cashier)\./i, '')
      .trim();
    const path =
      FIELD_PATHS[field] ||
      FIELD_PATHS[
        Object.keys(FIELD_PATHS).find((k) => k.toLowerCase() === field.toLowerCase()) || ''
      ];
    if (!path)
      issues.push(`Unknown field "${v.parameter}" – use a dashboard field name, e.g. full_name`);
    if (v.data === '') issues.push('Test Data is empty');
    const result = norm(v.result);
    if (result && !['valid', 'invalid'].includes(result))
      issues.push('Expected Result must be Valid, Invalid or empty');
    const expectation = result === 'valid' ? 'valid' : result === 'invalid' ? 'invalid' : 'auto';
    const country = String(v.country || '')
      .trim()
      .toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country))
      issues.push('Country must be a 2-letter code, e.g. IN');
    const canonical =
      Object.keys(FIELD_PATHS).find(
        (k) => FIELD_PATHS[k] === path && k.toLowerCase() === field.toLowerCase(),
      ) || field;
    const data = {
      ...(v.bank ? { bank: v.bank } : {}),
      field: canonical,
      path: path || '',
      title: v.title || `${canonical} – ${v.data}`,
      // "…" keeps leading / trailing spaces that a spreadsheet cell would lose.
      value: /^".*"$/s.test(v.data) ? v.data.slice(1, -1) : v.data,
      ...(country ? { country } : {}),
      expectation,
      origin: 'upload',
    };
    cases.push({
      rows: [row],
      data,
      display: [
        v.bank || 'Routed bank',
        canonical + (country ? ` (${country})` : ''),
        `"${data.value}"`,
        expectation === 'auto' ? "Bank's regex decides" : expectationLabel(expectation),
      ],
      issues,
      warnings: [],
    });
  }
  return cases;
}

function parsePspRows(rows, get, cardIds) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const { row, cells } of rows) {
    const v = get(cells);
    if (!v.title && !v.field) continue;
    const key = `${v.title}\u0000${v.card}`;
    if (!groups.has(key))
      groups.set(key, {
        rows: [],
        title: v.title,
        card: v.card,
        checks: [],
        issues: [],
        warnings: [],
      });
    const g = groups.get(key);
    g.rows.push(row);
    const source = norm(v.source);
    const check = norm(v.check);
    if (!v.title) g.issues.push(`Row ${row}: Test Case is empty`);
    if (!['request', 'response'].includes(source))
      g.issues.push(`Row ${row}: Source must be Request or Response`);
    if (!v.field) g.issues.push(`Row ${row}: PSP Field is empty`);
    if (!CHECKS.includes(check))
      g.issues.push(`Row ${row}: Check must be one of ${CHECKS.join(', ')}`);
    if (['equals', 'not equals', 'contains', 'matches'].includes(check) && v.value === '')
      g.issues.push(`Row ${row}: Expected Value is empty`);
    if (check === 'matches') {
      try {
        new RegExp(v.value);
      } catch {
        g.issues.push(`Row ${row}: Expected Value is not a valid regex`);
      }
    }
    g.checks.push({ source, field: v.field, check, value: v.value });
  }
  return [...groups.values()].map((g) => {
    if (g.card && cardIds.length && !cardIds.includes(g.card))
      g.warnings.push(`Card "${g.card}" is not on the Test cards tab of this environment`);
    return {
      rows: g.rows,
      data: { title: g.title, ...(g.card ? { card: g.card } : {}), checks: g.checks },
      display: [
        g.title,
        g.card || 'Run tab card',
        g.checks
          .map(
            (c) =>
              `${c.source === 'request' ? 'Request' : 'Response'} · ${c.field} ${c.check}${c.value ? ` ${c.value}` : ''}`,
          )
          .join('\n'),
      ],
      issues: g.issues,
      warnings: g.warnings,
    };
  });
}

function parseEdgeRows(rows, get, cardIds) {
  const cases = [];
  for (const { row, cells } of rows) {
    const v = get(cells);
    if (!v.title && !v.changes && !v.cashier && !v.status) continue;
    const issues = [];
    const warnings = [];
    if (!v.title) issues.push('Test Case is empty');
    const changes = parseAssignments(v.changes, issues);
    const outcome = v.cashier ? CASHIER_RESULTS[norm(v.cashier)] : undefined;
    if (v.cashier && !outcome)
      issues.push(
        `Expected Cashier Result must be one of: ${Object.keys(CASHIER_RESULTS).join(', ')}`,
      );
    const statuses = String(v.status || '')
      .split(/[/,|]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!outcome && statuses.length === 0 && !v.error)
      issues.push('Give at least one expectation (cashier result, status or error)');
    if (v.card && cardIds.length && !cardIds.includes(v.card))
      warnings.push(`Card "${v.card}" is not on the Test cards tab of this environment`);
    const data = {
      title: v.title,
      ...(v.card ? { card: v.card } : {}),
      ...(Object.keys(changes.set).length ? { set: changes.set } : {}),
      ...(changes.remove.length ? { remove: changes.remove } : {}),
      expected: {
        ...(outcome ? { outcome } : {}),
        ...(statuses.length ? { statuses } : {}),
        ...(v.error ? { errorContains: v.error } : {}),
      },
    };
    const changeText = [
      ...Object.entries(changes.set).map(([k, val]) => `${k}=${JSON.stringify(val)}`),
      ...changes.remove.map((k) => `${k} not sent`),
    ].join('; ');
    cases.push({
      rows: [row],
      data,
      display: [
        v.title,
        v.card || 'Run tab card',
        changeText || 'Standard request',
        [v.cashier, statuses.join(' / '), v.error ? `error contains "${v.error}"` : '']
          .filter(Boolean)
          .join(' · '),
      ],
      issues,
      warnings,
    });
  }
  return cases;
}

function parseKycRows(rows, get) {
  const cases = [];
  for (const { row, cells } of rows) {
    const v = get(cells);
    if (!v.title && !v.changes && !v.http) continue;
    const issues = [];
    const warnings = [];
    if (!v.title) issues.push('Test Case is empty');
    const customer = v.customer ? KYC_CUSTOMERS[norm(v.customer)] : 'new';
    if (!customer) issues.push(`Customer must be one of: ${Object.keys(KYC_CUSTOMERS).join(', ')}`);
    const auth = v.auth ? KYC_AUTH[norm(v.auth)] : 'valid';
    if (!auth) issues.push(`Authentication must be one of: ${Object.keys(KYC_AUTH).join(', ')}`);
    const http = Number(v.http);
    if (!Number.isInteger(http) || http < 100 || http > 599)
      issues.push('Expected HTTP must be a status code, e.g. 200 or 400');
    const statuses = String(v.status || '')
      .split(/[/,|]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const unknown = statuses.filter((s) => !KYC_STATUSES.includes(s));
    if (unknown.length)
      issues.push(`Unknown KYC status ${unknown.join(', ')} – use ${KYC_STATUSES.join(', ')}`);
    if (statuses.length && http >= 300)
      warnings.push('A KYC status is only returned on success (HTTP 200)');
    if (!['new', 'by-merchant-id'].includes(customer || '') && /customer\./.test(v.changes || ''))
      warnings.push('customer.* changes only apply when a new customer is created');
    const changes = parseKycChanges(v.changes, issues);
    const data = {
      title: v.title,
      customer: customer || 'new',
      auth: auth || 'valid',
      ...(Object.keys(changes.body.set).length ? { set: changes.body.set } : {}),
      ...(changes.body.remove.length ? { remove: changes.body.remove } : {}),
      ...(Object.keys(changes.customer.set).length ? { customerSet: changes.customer.set } : {}),
      ...(changes.customer.remove.length ? { customerRemove: changes.customer.remove } : {}),
      expected: {
        http,
        ...(v.code ? { code: v.code.trim() } : {}),
        ...(statuses.length ? { statuses } : {}),
        ...(v.message ? { messageContains: v.message } : {}),
      },
    };
    cases.push({
      rows: [row],
      data,
      display: [
        v.title,
        `${labelOf(KYC_CUSTOMERS, data.customer)} · ${labelOf(KYC_AUTH, data.auth)}`,
        describeKycChanges(data) || 'Standard request',
        describeKycExpected(data.expected),
      ],
      issues,
      warnings,
    });
  }
  return cases;
}

const describeKycChanges = (c) =>
  [
    ...Object.entries(c.set || {}).map(([k, val]) => `${k}=${JSON.stringify(val)}`),
    ...(c.remove || []).map((k) => `${k} not sent`),
    ...Object.entries(c.customerSet || {}).map(
      ([k, val]) => `customer.${k}=${JSON.stringify(val)}`,
    ),
    ...(c.customerRemove || []).map((k) => `customer.${k} not sent`),
  ].join('; ');
const describeKycExpected = (e) =>
  [
    `HTTP ${e.http}`,
    e.code,
    (e.statuses || []).join(' / '),
    e.messageContains ? `message contains "${e.messageContains}"` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const PARSERS = {
  ...extraCategories().PARSERS,
  ...s2sCategory().PARSERS,
  kyc: parseKycRows,
  field: parseFieldRows,
  regex: parseRegexRows,
  psp: parsePspRows,
  edge: parseEdgeRows,
};
const PREVIEW_COLUMNS = {
  ...extraCategories().PREVIEW_COLUMNS,
  ...s2sCategory().PREVIEW_COLUMNS,
  field: ['Parameter', 'Test case', 'Test data', 'Expected'],
  regex: ['Bank', 'Field', 'Test data', 'Expected'],
  psp: ['Test case', 'Card', 'Checks'],
  edge: ['Test case', 'Card', 'Request changes', 'Expected'],
  kyc: ['Test case', 'Customer · auth', 'Request changes', 'Expected'],
};

// ── duplicates ─────────────────────────────────────────────────────────────────

/** Content signature – ignores id, title and source so renamed copies are caught too. */
function signature(categoryId, c) {
  if (categoryId === 's2s') return s2sCategory().signature(categoryId, c);
  if (categoryId === 'refund' || categoryId === 'bank-config')
    return extraCategories().signature(categoryId, c);
  switch (categoryId) {
    case 'field':
      return JSON.stringify([
        String(c.path).toLowerCase(),
        c.mutation,
        c.context || {},
        c.expectation,
      ]);
    case 'regex':
      // Same bank + field + value is the same test, whatever the expectation says.
      return JSON.stringify([
        String(c.bank || '').toLowerCase(),
        String(c.field).toLowerCase(),
        c.value,
      ]);
    case 'psp':
      return JSON.stringify([c.card || '', [...c.checks].map((x) => JSON.stringify(x)).sort()]);
    case 'kyc':
      return JSON.stringify([
        c.customer,
        c.auth,
        c.set || {},
        [...(c.remove || [])].sort(),
        c.customerSet || {},
        [...(c.customerRemove || [])].sort(),
        c.expected,
      ]);
    default:
      return JSON.stringify([c.card || '', c.set || {}, [...(c.remove || [])].sort(), c.expected]);
  }
}

/**
 * Built-in field cases (FT-xxx) live in TypeScript. They only import types, so
 * the file is transpiled in memory and evaluated in a sandbox – duplicate
 * detection only.
 */
let builtinCache = null;
function builtinFieldCases() {
  const file = path.join(ROOT, 'tests', 'test-data', 'cashier-purchase', 'api-field-cases.ts');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (builtinCache && builtinCache.mtime === mtime) return builtinCache.cases;
    const ts = require('typescript');
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    require('node:vm').runInNewContext(js, {
      module: mod,
      exports: mod.exports,
      require: () => {
        throw new Error('api-field-cases.ts must not have runtime imports');
      },
    });
    const cases = Array.isArray(mod.exports.fieldTestCases) ? mod.exports.fieldTestCases : [];
    builtinCache = { mtime, cases };
    return cases;
  } catch {
    return [];
  }
}

function knownSignatures(categoryId) {
  const stored = loadCases(categoryId);
  const builtin = categoryId === 'field' ? builtinFieldCases() : [];
  return new Set([...stored, ...builtin].map((c) => signature(categoryId, c)));
}

// ── storage ────────────────────────────────────────────────────────────────────

const fileOf = (categoryId) => path.join(DATA_DIR, categoryOf(categoryId).file);

function readFile(categoryId) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(categoryId), 'utf8'));
    return {
      cases: Array.isArray(data.cases) ? data.cases : [],
      nextNumber: Number.isInteger(data.nextNumber) ? data.nextNumber : 1,
    };
  } catch {
    return { cases: [], nextNumber: 1 };
  }
}

const loadCases = (categoryId) => readFile(categoryId).cases;

/** IDs are never reused: `nextNumber` keeps counting after deletes. */
function saveCases(categoryId, cases, nextNumber) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileOf(categoryId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ nextNumber, cases }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ── public API ─────────────────────────────────────────────────────────────────

/** Parses an uploaded sheet into preview rows. Nothing is saved here. */
async function previewImport(categoryId, buffer, filename, cardIds = []) {
  const category = categoryOf(categoryId);
  const rows = await readRows(buffer, filename);
  if (rows.length === 0) throw new Error('The file is empty');
  const { index, bodyStart } = locateColumns(rows, category);
  const body = rows.slice(bodyStart);
  if (body.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} rows per upload`);
  const get = (cells) =>
    Object.fromEntries(
      category.columns.map((c) => [
        c.key,
        index[c.key] >= 0 ? String(cells[index[c.key]] ?? '').trim() : '',
      ]),
    );
  return previewParsed(categoryId, PARSERS[categoryId](body, get, cardIds));
}

/**
 * Rows given as objects keyed by the category's column keys (e.g. generated
 * by AI) – validated exactly like an upload. Row numbers are 1-based positions.
 */
function previewObjects(categoryId, objects, cardIds = []) {
  const category = categoryOf(categoryId);
  if (!Array.isArray(objects)) throw new Error('Expected a list of test cases');
  const body = objects.slice(0, MAX_ROWS).map((o, i) => ({
    row: i + 1,
    cells: category.columns.map((c) => String((o && o[c.key]) ?? '').trim()),
  }));
  const get = (cells) =>
    Object.fromEntries(category.columns.map((c, i) => [c.key, cells[i] ?? '']));
  return previewParsed(categoryId, PARSERS[categoryId](body, get, cardIds));
}

function previewParsed(categoryId, parsed) {
  const known = knownSignatures(categoryId);
  const seen = new Set();
  const cases = parsed.map((c) => {
    const sig = signature(categoryId, c.data);
    const duplicate = known.has(sig);
    const repeated = !duplicate && seen.has(sig);
    seen.add(sig);
    if (repeated) c.warnings.push('Same as another row in this file');
    return { ...c, duplicate, include: c.issues.length === 0 && !duplicate && !repeated };
  });
  return { category: categoryId, columns: PREVIEW_COLUMNS[categoryId], cases };
}

/** Flags duplicates on generated rows (e.g. regex cases from the dashboard) like on an upload. */
function markDuplicates(categoryId, rows) {
  const known = knownSignatures(categoryId);
  const cases = rows.map((c) => {
    const duplicate = known.has(signature(categoryId, c.data));
    return { rows: [], ...c, duplicate, include: c.issues.length === 0 && !duplicate };
  });
  return { category: categoryId, columns: PREVIEW_COLUMNS[categoryId], cases };
}

/** Appends the chosen preview rows with new ids (FV-001, RX-001 …). */
function appendCases(categoryId, chosen, sourceName) {
  const category = categoryOf(categoryId);
  if (!Array.isArray(chosen) || chosen.length === 0) throw new Error('Nothing to append');
  if (chosen.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} cases at once`);
  const stored = readFile(categoryId);
  const cases = stored.cases;
  const highest = cases.reduce(
    (max, c) => Math.max(max, Number(String(c.id).replace(/\D/g, '')) || 0),
    0,
  );
  let next = Math.max(stored.nextNumber, highest + 1);
  const known = knownSignatures(categoryId);
  const ids = [];
  let duplicates = 0;
  for (const item of chosen) {
    const data = validateCase(categoryId, item && item.data);
    const sig = signature(categoryId, data);
    if (known.has(sig)) {
      duplicates++;
      continue;
    }
    known.add(sig);
    const id = `${category.prefix}-${String(next++).padStart(3, '0')}`;
    const rowsList = Array.isArray(item.rows) ? item.rows.map(Number).filter(Number.isFinite) : [];
    cases.push({
      id,
      ...data,
      source: {
        file: String(sourceName || 'upload').slice(0, 120),
        rows: rowsList,
        importedAt: new Date().toISOString(),
      },
    });
    ids.push(id);
  }
  saveCases(categoryId, cases, next);
  return { added: ids.length, duplicates, ids };
}

const PATH_RE = /^[A-Za-z_][\w-]*(\.[\w-]+)*$/;
const str = (v, max) => String(v ?? '').slice(0, max);

/** Re-validates what the browser sends back (never trust the preview payload). */
function validateCase(categoryId, d) {
  if (!d || typeof d !== 'object') throw new Error('Invalid case');
  const need = (cond, msg) => {
    if (!cond) throw new Error(`${d.title || 'Case'}: ${msg}`);
  };
  const mutation = () => {
    const t = d.mutation && d.mutation.type;
    need(['set', 'remove', 'none'].includes(t), 'invalid test data');
    return t === 'set' ? { type: t, value: d.mutation.value } : { type: t };
  };
  const context = () => (d.context && typeof d.context === 'object' ? { context: d.context } : {});
  if (categoryId === 'refund' || categoryId === 'bank-config')
    return extraCategories().validate(categoryId, d, need);
  if (categoryId === 's2s') return s2sCategory().validate(categoryId, d, need);
  switch (categoryId) {
    case 'field':
      need(PATH_RE.test(d.path), 'invalid request field');
      need(EXPECTATIONS.includes(d.expectation), 'invalid expectation');
      return {
        parameter: str(d.parameter, 120),
        path: d.path,
        title: str(d.title, 200) || d.path,
        mutation: mutation(),
        ...context(),
        expectation: d.expectation,
        expectedResult: str(d.expectedResult, 300),
        ...(d.apiNote ? { apiNote: str(d.apiNote, 300) } : {}),
      };
    case 'regex':
      need(PATH_RE.test(d.path), 'invalid request field');
      need(typeof d.value === 'string' && d.value !== '', 'test data is empty');
      need(['valid', 'invalid', 'observe', 'auto'].includes(d.expectation), 'invalid expectation');
      return {
        ...(d.bank ? { bank: str(d.bank, 80) } : {}),
        field: str(d.field, 60),
        path: d.path,
        title: str(d.title, 200) || d.field,
        value: str(d.value, 500),
        ...(typeof d.country === 'string' && /^[A-Z]{2}$/.test(d.country)
          ? { country: d.country }
          : {}),
        expectation: d.expectation,
        ...(d.regex ? { regex: str(d.regex, 500) } : {}),
        origin: ['dashboard', 'ai'].includes(d.origin) ? d.origin : 'upload',
      };
    case 'psp':
      need(
        Array.isArray(d.checks) && d.checks.length > 0 && d.checks.length <= 50,
        'needs 1–50 checks',
      );
      return {
        title: str(d.title, 200),
        ...(d.card ? { card: str(d.card, 60) } : {}),
        checks: d.checks.map((c) => {
          need(
            ['request', 'response'].includes(c.source) && CHECKS.includes(c.check) && c.field,
            'invalid check',
          );
          return {
            source: c.source,
            field: str(c.field, 200),
            check: c.check,
            value: str(c.value, 500),
          };
        }),
      };
    case 'kyc': {
      const e = d.expected || {};
      need(Object.values(KYC_CUSTOMERS).includes(d.customer), 'invalid customer');
      need(Object.values(KYC_AUTH).includes(d.auth), 'invalid authentication');
      need(Number.isInteger(e.http) && e.http >= 100 && e.http <= 599, 'invalid expected HTTP');
      const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
      const list = (x) => (Array.isArray(x) ? x.filter((k) => PATH_RE.test(k)) : []);
      const set = obj(d.set);
      for (const k of Object.keys(set))
        need(PATH_RE.test(k) && k !== 'test', `invalid field "${k}"`);
      const customerSet = obj(d.customerSet);
      for (const k of Object.keys(customerSet))
        need(KYC_CUSTOMER_FIELDS.includes(k), `invalid customer field "${k}"`);
      const customerRemove = list(d.customerRemove).filter((k) => KYC_CUSTOMER_FIELDS.includes(k));
      return {
        title: str(d.title, 200),
        customer: d.customer,
        auth: d.auth,
        ...(Object.keys(set).length ? { set } : {}),
        ...(list(d.remove).length ? { remove: list(d.remove) } : {}),
        ...(Object.keys(customerSet).length ? { customerSet } : {}),
        ...(customerRemove.length ? { customerRemove } : {}),
        expected: {
          http: e.http,
          ...(e.code ? { code: str(e.code, 60) } : {}),
          ...(Array.isArray(e.statuses) && e.statuses.length
            ? {
                statuses: e.statuses
                  .map((x) => str(x, 40).toUpperCase())
                  .filter((x) => KYC_STATUSES.includes(x)),
              }
            : {}),
          ...(e.messageContains ? { messageContains: str(e.messageContains, 300) } : {}),
        },
      };
    }
    default: {
      const outcomes = Object.values(CASHIER_RESULTS);
      const e = d.expected || {};
      need(!e.outcome || outcomes.includes(e.outcome), 'invalid cashier result');
      const set = d.set && typeof d.set === 'object' ? d.set : {};
      for (const k of Object.keys(set)) need(PATH_RE.test(k), `invalid field "${k}"`);
      const remove = Array.isArray(d.remove) ? d.remove.filter((k) => PATH_RE.test(k)) : [];
      return {
        title: str(d.title, 200),
        ...(d.card ? { card: str(d.card, 60) } : {}),
        ...(Object.keys(set).length ? { set } : {}),
        ...(remove.length ? { remove } : {}),
        expected: {
          ...(e.outcome ? { outcome: e.outcome } : {}),
          ...(Array.isArray(e.statuses) && e.statuses.length
            ? { statuses: e.statuses.map((s) => str(s, 40).toUpperCase()) }
            : {}),
          ...(e.errorContains ? { errorContains: str(e.errorContains, 300) } : {}),
        },
      };
    }
  }
}

function deleteCase(caseId) {
  const categoryId = categoryForCaseId(caseId);
  if (!categoryId) throw new Error('Test case not found');
  const stored = readFile(categoryId);
  const remaining = stored.cases.filter((c) => c.id !== caseId);
  if (remaining.length === stored.cases.length) throw new Error('Test case not found');
  saveCases(categoryId, remaining, stored.nextNumber);
}

/** Short one-line description of a stored case for the launcher list. */
function summarize(categoryId, c) {
  if (categoryId === 's2s') return s2sCategory().summarize(categoryId, c);
  if (categoryId === 'refund' || categoryId === 'bank-config')
    return extraCategories().summarize(categoryId, c);
  switch (categoryId) {
    case 'field':
      return [
        c.parameter,
        describeValue(c.mutation) +
          (describeContext(c.context) ? `  · ${describeContext(c.context)}` : ''),
        `${c.expectedResult} → ${c.expectation}`,
      ];
    case 'regex':
      return [
        `${c.bank || 'Routed bank'} · ${c.field}`,
        c.value.length > 40
          ? `"${c.value.slice(0, 14)}…" (${c.value.length} chars)`
          : `"${c.value}"`,
        `${c.expectation === 'auto' ? "Bank's regex decides" : expectationLabel(c.expectation)}${c.origin === 'dashboard' ? ' · from dashboard' : ''}`,
      ];
    case 'psp':
      return [
        c.card || 'Run tab card',
        `${c.checks.length} check(s)`,
        c.checks
          .map((x) => `${x.source} · ${x.field} ${x.check}${x.value ? ` ${x.value}` : ''}`)
          .join('\n'),
      ];
    case 'kyc':
      return [
        `${labelOf(KYC_CUSTOMERS, c.customer)} · ${labelOf(KYC_AUTH, c.auth)}`,
        describeKycChanges(c) || 'Standard request',
        describeKycExpected(c.expected),
      ];
    default:
      return [
        c.card || 'Run tab card',
        [
          ...Object.entries(c.set || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
          ...(c.remove || []).map((k) => `${k} not sent`),
        ].join('; ') || 'Standard request',
        [
          OUTCOME_LABELS[c.expected.outcome],
          (c.expected.statuses || []).join(' / '),
          c.expected.errorContains ? `error contains "${c.expected.errorContains}"` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ];
  }
}

function listCategories() {
  return Object.entries(CATEGORIES).map(([id, c]) => ({
    id,
    label: c.label,
    prefix: c.prefix,
    description: c.description,
    file: path.relative(ROOT, fileOf(id)),
    columns: c.columns.map((col) => ({ header: col.header, required: col.required })),
    cases: loadCases(id).map((x) => ({
      id: x.id,
      title: x.title,
      summary: summarize(id, x),
      source: x.source
        ? `${x.source.file}${x.source.rows && x.source.rows.length ? ` · row ${x.source.rows.join(', ')}` : ''}`
        : '',
    })),
  }));
}

// ── templates ──────────────────────────────────────────────────────────────────

const HEADER_REQUIRED = 'FF1F2A44';
const HEADER_OPTIONAL = 'FFE4E7EE';
const BORDER = { style: 'thin', color: { argb: 'FFD0D5DD' } };

/** Clean, ready-to-fill workbook: "Test Cases" (header + examples) and a short "Guide". */
async function templateBuffer(categoryId, cardIds = []) {
  const category = categoryOf(categoryId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Integration QA Automation';

  const pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  const sheet = workbook.addWorksheet('Test Cases', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup,
  });
  sheet.columns = category.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const header = sheet.getRow(1);
  header.height = 30;
  category.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, size: 11, color: { argb: c.required ? 'FFFFFFFF' : 'FF1F2A44' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c.required ? HEADER_REQUIRED : HEADER_OPTIONAL },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
    cell.note = { texts: [{ text: `${c.required ? 'Required' : 'Optional'} – ${c.guide}` }] };
  });
  for (const example of category.examples) {
    const row = sheet.addRow(example);
    row.alignment = { vertical: 'top', wrapText: true };
    row.font = { size: 11 };
  }
  const lastRow = 500;
  category.columns.forEach((c, i) => {
    const options = c.options === 'cards' ? cardIds : c.options;
    if (!options || options.length === 0) return;
    const letter = sheet.getColumn(i + 1).letter;
    for (let r = 2; r <= lastRow; r++) {
      sheet.getCell(`${letter}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${options.join(',')}"`],
        showErrorMessage: c.options !== 'cards',
        errorTitle: c.header,
        error: `Choose one of: ${options.join(', ')}`,
      };
    }
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: category.columns.length },
  };

  const guide = workbook.addWorksheet('Guide', { pageSetup });
  guide.columns = [
    { header: 'Column', key: 'col', width: 26 },
    { header: 'Required', key: 'req', width: 11 },
    { header: 'What to enter', key: 'what', width: 78 },
    { header: 'Example', key: 'ex', width: 30 },
  ];
  const gh = guide.getRow(1);
  gh.height = 26;
  gh.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_REQUIRED } };
    cell.alignment = { vertical: 'middle', indent: 1 };
  });
  for (const c of category.columns) {
    const options = c.options === 'cards' ? (cardIds.length ? cardIds.join(', ') : '') : '';
    const row = guide.addRow({
      col: c.header,
      req: c.required ? 'Yes' : 'No',
      what: options ? `${c.guide}. Cards: ${options}` : c.guide,
      ex: c.example,
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(1).font = { bold: true };
  }
  guide.addRow({});
  const note = guide.addRow({
    col: `${category.label}: ${category.description} Replace the example rows on "Test Cases" with your own, then upload the file on the launcher's Test cases tab.`,
  });
  guide.mergeCells(`A${note.number}:D${note.number}`);
  note.alignment = { wrapText: true, vertical: 'top' };
  note.height = 34;
  note.font = { italic: true, color: { argb: 'FF475467' } };

  // One font everywhere so Excel, Numbers and Google Sheets show the same thing.
  for (const ws of workbook.worksheets) {
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: 'Calibri', size: 11, ...(cell.font || {}) };
      });
    });
  }
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  CATEGORIES,
  markDuplicates,
  previewObjects,
  DATA_DIR,
  listCategories,
  previewImport,
  appendCases,
  deleteCase,
  loadCases,
  templateBuffer,
  builtinFieldCases,
  mapParameter,
  parseValue,
  inferExpectation,
  summarize,
};
