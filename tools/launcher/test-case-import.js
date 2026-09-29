// @ts-check
/**
 * Upload of additional test cases from Excel / CSV, by category:
 *
 *   field  → Field validation          (FV-xxx)  request field rules
 *   regex  → Regex validation          (RX-xxx)  value vs regex + API behaviour
 *   psp    → PSP request / response    (PR-xxx)  checks on what was sent to / received from the PSP
 *   edge   → Custom & edge cases       (EC-xxx)  end-to-end scenarios with an expected outcome
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
  'platform',
  'paymentMethod',
  'send_receipt',
  'skip_capture',
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

  // "110001 with country=IN", "+91 9876543210 with country=DE"
  const withCtx = /^(.*?)\s+with\s+([a-z_.]+)\s*=\s*(\S+)$/i.exec(text);
  if (withCtx) {
    const key = withCtx[2].includes('.') ? withCtx[2] : `client.${withCtx[2]}`;
    context[mapParameter(key).path || key] = withCtx[3];
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
  if (text === '[]') return { mutation: { type: 'set', value: [] }, context };
  if (NUMERIC_PATHS.has(targetPath) && /^-?\d+(\.\d+)?$/.test(text)) {
    return { mutation: { type: 'set', value: Number(text) }, context };
  }
  if (/^(true|false)$/i.test(text) && /send_receipt|skip_capture/.test(targetPath)) {
    return { mutation: { type: 'set', value: text.toLowerCase() === 'true' }, context };
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
const CHECKS = ['equals', 'not equals', 'contains', 'matches', 'present', 'absent'];

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
        guide: 'Request field',
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
          'Value to send. "Field not sent" removes the field, "" sends an empty string, "256 characters" generates a long value',
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
        guide: 'Other fields to set first, e.g. client.country=US (separate several with ;)',
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
      ['paysafe_payfac', 'full_name', 'Name with digits', 'John123', 'Invalid'],
      ['', 'full_name', 'Name with hyphen', 'Jean-Luc Picard', ''],
      ['', 'city', 'City with digits', 'Wien1', ''],
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
        guide: 'equals · not equals · contains · matches (regex) · present · absent',
        example: 'equals',
      },
      {
        key: 'value',
        header: 'Expected Value',
        required: false,
        width: 26,
        aliases: ['expected', 'value'],
        guide:
          'Text, number or a value from the purchase: {purchaseId} {amount} {amountMinor} (amount in cents) {currency} {email} {country} {city} {zip} {phone} {fullName}. Empty for present / absent',
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
};

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
        warnings: mapped.warning ? [mapped.warning] : [],
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
    const canonical =
      Object.keys(FIELD_PATHS).find(
        (k) => FIELD_PATHS[k] === path && k.toLowerCase() === field.toLowerCase(),
      ) || field;
    const data = {
      ...(v.bank ? { bank: v.bank } : {}),
      field: canonical,
      path: path || '',
      title: v.title || `${canonical} – ${v.data}`,
      value: v.data,
      expectation,
      origin: 'upload',
    };
    cases.push({
      rows: [row],
      data,
      display: [
        v.bank || 'Routed bank',
        canonical,
        `"${v.data}"`,
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

const PARSERS = {
  field: parseFieldRows,
  regex: parseRegexRows,
  psp: parsePspRows,
  edge: parseEdgeRows,
};
const PREVIEW_COLUMNS = {
  field: ['Parameter', 'Test case', 'Test data', 'Expected'],
  regex: ['Bank', 'Field', 'Test data', 'Expected'],
  psp: ['Test case', 'Card', 'Checks'],
  edge: ['Test case', 'Card', 'Request changes', 'Expected'],
};

// ── duplicates ─────────────────────────────────────────────────────────────────

/** Content signature – ignores id, title and source so renamed copies are caught too. */
function signature(categoryId, c) {
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
  const known = knownSignatures(categoryId);
  const seen = new Set();
  const cases = PARSERS[categoryId](body, get, cardIds).map((c) => {
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

const PATH_RE = /^[A-Za-z_]\w*(\.\w+)*$/;
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
        expectation: d.expectation,
        ...(d.regex ? { regex: str(d.regex, 500) } : {}),
        origin: d.origin === 'dashboard' ? 'dashboard' : 'upload',
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
};
