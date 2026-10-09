import {
  FIELD_PSP_RULE_ANNOTATION,
  type FieldCaseMeta,
  type FieldResultMeta,
} from '../helpers/field-testing';
import type { PspFieldCheckResult } from '../helpers/psp-field-checks';
import type { PspSummary } from '../helpers/psp-validation';

/**
 * Presentation data for the launcher report: which category a test belongs
 * to, whether it is a positive or negative case, and Expected / Actual as
 * labelled lines instead of one long string.
 */
export type CategoryId =
  | 'field'
  | 'regex'
  | 'psp'
  | 'edge'
  | 'card'
  | 'refund'
  | 'bank-config'
  | 's2s'
  | 'kyc'
  | 'psp-check'
  | 'other';
export type Polarity = 'positive' | 'negative' | 'neutral';

export interface ReportItem {
  readonly label: string;
  readonly value: string;
}

/** Field validation sub-category: customer data judged on the PSP request. */
export const CUSTOMER_DATA_LABEL = 'Field validation › Customer data at PSP';

export const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = {
  field: 'Field validation',
  regex: 'Regex validation',
  psp: 'PSP request / response',
  edge: 'Custom & edge cases',
  card: 'Card transactions',
  refund: 'Refunds',
  'bank-config': 'Bank & MID configuration',
  s2s: 'S2S purchase',
  kyc: 'KYC verification',
  'psp-check': 'PSP check (existing purchases)',
  other: 'Other',
};

export function categoryOf(key: string): CategoryId {
  if (/^@(FT|FV)-/.test(key)) return 'field';
  if (key.startsWith('@RX-')) return 'regex';
  if (key.startsWith('@PR-')) return 'psp';
  if (key.startsWith('@EC-')) return 'edge';
  if (key.startsWith('@card-')) return 'card';
  if (key.startsWith('@RF-') || key.startsWith('@RC-')) return 'refund';
  if (key.startsWith('@BM-') || key.startsWith('@BC-')) return 'bank-config';
  if (/^@(S2S|S2|s2s-card)-/.test(key)) return 's2s';
  if (key.startsWith('@KYC-') || key.startsWith('@KV-')) return 'kyc';
  if (key === '@psp-by-id' || key === '@backoffice-smoke') return 'psp-check';
  return 'other';
}

const OUTCOMES: Readonly<Record<string, string>> = {
  'success-redirect': 'Success redirect',
  'failure-redirect': 'Failure redirect',
  'pending-redirect': 'Pending redirect',
  rejected: 'Rejected by cashier',
  'other-page': 'Stayed on another page',
  timeout: 'Timed out',
};
/** "failure-redirect: msg (via host)" → "Failure redirect: msg" */
export function outcomeLabel(raw: string): string {
  const text = raw.replace(/\s*\(via .*\)$/, '');
  const [id = '', ...rest] = text.split(':');
  const label = OUTCOMES[id.trim()] ?? id.trim();
  return rest.length ? `${label}:${rest.join(':')}` : label;
}

const FIELD_RULES: Readonly<Record<string, string>> = {
  accepted: 'Accepted (HTTP 2xx)',
  rejected: 'Rejected (HTTP 4xx validation error)',
  sanitized: 'Rejected, or accepted without echoing the input',
  observe: 'Recorded only (behaviour not specified)',
};

export interface ClassifyInput {
  readonly key: string;
  readonly values: Readonly<Record<string, string>>;
  readonly fieldCase: FieldCaseMeta | undefined;
  readonly fieldResult: FieldResultMeta | undefined;
  readonly psp: PspSummary | undefined;
  readonly pspFieldChecks: readonly PspFieldCheckResult[];
}

export interface Classification {
  readonly category: CategoryId;
  readonly categoryLabel: string;
  readonly polarity: Polarity;
  readonly expectedItems: readonly ReportItem[];
  readonly actualItems: readonly ReportItem[];
}

function polarityOf(category: CategoryId, input: ClassifyInput): Polarity {
  const expected = input.values.expected ?? '';
  switch (category) {
    case 'field':
      // Customer data at the PSP: polarity follows the PSP rule, not the create answer.
      if (input.values[FIELD_PSP_RULE_ANNOTATION] !== undefined) {
        const rule = input.values[FIELD_PSP_RULE_ANNOTATION];
        if (rule.toLowerCase().includes('must not')) return 'negative';
        return rule.includes('unchanged') ? 'positive' : 'neutral';
      }
      if (input.fieldCase?.expectation === 'accepted') return 'positive';
      if (input.fieldCase?.expectation === 'observe') return 'neutral';
      return 'negative';
    case 'regex':
      return expected.startsWith('Valid')
        ? 'positive'
        : expected.startsWith('Invalid')
          ? 'negative'
          : 'neutral';
    case 'psp':
      return 'positive';
    case 'refund':
      return /rejected|error/i.test(expected) ? 'negative' : 'positive';
    case 'kyc':
      // Built-in KYC titles say "then it returns 4xx …"; uploaded cases carry the expected HTTP.
      return /\b[45]\d\d\b|rejected|refuse|forged|ignored|unknown/i.test(
        `${expected} ${input.values.title ?? ''}`,
      )
        ? 'negative'
        : 'positive';
    case 'edge':
    case 'card':
      return /success|PAID/i.test(expected) ? 'positive' : 'negative';
    default:
      return 'neutral';
  }
}

/** "failure-redirect · ERROR · error contains "x"" / "success-redirect, status PAID" → labelled items. */
export function expectedParts(text: string): ReportItem[] {
  return text
    .split(/ · |, /)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): ReportItem => {
      const outcome = OUTCOMES[part];
      if (outcome !== undefined) return { label: 'Cashier', value: outcome };
      if (/^HTTP \d{3}$/.test(part)) return { label: 'HTTP', value: part.slice(5) };
      if (/^status /i.test(part)) return { label: 'Final status', value: part.slice(7) };
      if (/^error contains /i.test(part))
        return { label: 'Message contains', value: part.slice(15) };
      if (/^[A-Z_]+( \/ [A-Z_]+)*$/.test(part)) return { label: 'Final status', value: part };
      return { label: 'Expected', value: part };
    });
}

const pspCheckLabel = (name: string): string =>
  name.replace(
    /^PSP (request|response)/,
    (_m, w: string) => w.charAt(0).toUpperCase() + w.slice(1),
  );

const item = (label: string, value: string | undefined): ReportItem[] =>
  value === undefined || value === '' ? [] : [{ label, value }];

/** "PSP webhook log: a: zombied, b: consumed" → [{ name, status }]. */
function webhookList(actual: string): { name: string; status: string }[] {
  const list = /PSP webhook log: (.*)$/.exec(actual)?.[1] ?? '';
  return list
    .split(', ')
    .map((part) => /^(.*): ([\w-]+)$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1] ?? '', status: m[2] ?? '' }));
}

/**
 * PSP notes as named rows instead of generic "Note" lines:
 *  - Warning: … is shown as the yellow warning on the card – not repeated here;
 *  - customer fields the PSP did not get → "Not sent to PSP";
 *  - merchant webhook (webhook:out) and PSP webhook (webhook:in) each get their own row,
 *    a zombied webhook of another bank as "Other bank's webhook".
 */
function structuredPspNotes(psp: PspSummary): ReportItem[] {
  const items: ReportItem[] = [];
  const used = new Set<string>();
  const find = (re: RegExp): string | undefined => psp.notes.find((n) => re.test(n));
  const take = (note: string | undefined): string | undefined => {
    if (note !== undefined) used.add(note);
    return note;
  };

  const notSent = take(find(/^Customer fields not sent to the PSP|^Not in the PSP request/));
  if (notSent !== undefined) {
    items.push({
      label: 'Not sent to PSP',
      value: `${notSent.replace(/^[^:]*:\s*/, '')} – not in paymentInfo or allOtherRequest (this PSP's request does not include them)`,
    });
  }

  const out = psp.checks.find((c) => c.name.startsWith('Merchant webhook sent'));
  const refused = take(find(/^Merchant endpoint did not accept/));
  if (out !== undefined) {
    const answer = refused === undefined ? '' : /webhook: ([^(]*)/.exec(refused)?.[1]?.trim();
    items.push({
      label: 'Merchant webhook (webhook:out)',
      value: `${out.passed ? 'Sent' : 'NOT sent'} – ${out.actual}${answer ? ` · merchant URL answered ${answer} (expected with a test callback URL that does not accept POST)` : ''}`,
    });
  }

  const received = psp.checks.find((c) => c.name.startsWith('PSP webhook received'));
  take(find(/^Other PSP webhook config/));
  const none = take(find(/^No PSP webhook/));
  const hooks = received === undefined ? [] : webhookList(received.actual);
  const consumed = hooks.filter((h) => /^(already_)?consumed$/i.test(h.status));
  const others = hooks.filter((h) => !/^(already_)?consumed$/i.test(h.status));
  if (none !== undefined) {
    items.push({
      label: 'PSP webhook (webhook:in)',
      value: 'None received – this PSP answers synchronously or sends no webhook for this flow',
    });
  } else if (hooks.length > 0) {
    items.push({
      label: 'PSP webhook (webhook:in)',
      value:
        consumed.length > 0
          ? `Passed – ${consumed.map((h) => `${h.name}: ${h.status === 'consumed' ? 'Consumed' : 'Already consumed'}`).join(', ')} (bank of this transaction)`
          : `Not consumed – ${others.map((h) => `${h.name}: ${h.status}`).join(', ')}`,
    });
    if (consumed.length > 0) {
      for (const h of others) {
        items.push({
          label: "Other bank's webhook",
          value: `${h.name}: ${h.status === 'zombied' ? 'Zombied' : h.status} – posted to another bank's webhook config; it does not belong to this transaction's bank (expected)`,
        });
      }
    }
  } else if (received !== undefined) {
    items.push({ label: 'PSP webhook (webhook:in)', value: received.actual });
  }

  for (const note of psp.notes) {
    if (used.has(note) || /^warning:/i.test(note)) continue; // warnings: yellow box on the card
    items.push({ label: 'Note', value: note });
  }
  return items;
}

export function classify(input: ClassifyInput): Classification {
  const category = categoryOf(input.key);
  const { values, fieldCase, fieldResult, psp, pspFieldChecks } = input;

  const expectedItems: ReportItem[] = [];
  if (fieldCase) {
    expectedItems.push(
      ...item('Test data', fieldCase.testData),
      ...item('Sheet says', fieldCase.expectedResult),
      ...item('Rule', values[FIELD_PSP_RULE_ANNOTATION] ?? FIELD_RULES[fieldCase.expectation]),
    );
  } else if (category === 'regex') {
    const [field = '', ...rest] = (values['test value'] ?? '').split(' = ');
    expectedItems.push(
      ...item('Field', field),
      ...item('Test data', rest.join(' = ')),
      ...item('Rule', values.expected),
      ...item('Regex', values.regex),
    );
  } else if (category === 'psp') {
    expectedItems.push(
      ...pspFieldChecks.map((c) => ({ label: pspCheckLabel(c.name), value: c.expected })),
    );
    if (pspFieldChecks.length === 0) expectedItems.push(...item('Checks', values.expected));
  } else if (values.expected) {
    expectedItems.push(...expectedParts(values.expected));
  }

  const actualItems: ReportItem[] = [];
  if (fieldResult) {
    actualItems.push(
      { label: 'HTTP', value: String(fieldResult.httpStatus) },
      ...item('Error code', fieldResult.errorCode),
      ...item('Message', fieldResult.message),
      ...item('Status', fieldResult.status),
    );
  }
  actualItems.push(
    ...item('Regex', values['regex result']),
    ...item('Sent to PSP', values['sent to PSP']),
    ...item('Bank', category === 'regex' ? values.bank : undefined),
  );
  if (category === 'psp') {
    actualItems.push(
      ...pspFieldChecks.map((c) => ({
        label: pspCheckLabel(c.name),
        value: `${c.passed ? '✓' : '✗'} ${c.actual}`,
      })),
    );
  }
  // S2S calls: "HTTP 400 · transaction_error: Invalid Card Expiry …" → HTTP / Result / Message.
  const s2s = /^HTTP (\d{3})(?: · ([\w.-]+)(?::\s*([\s\S]*))?)?$/.exec(
    values['s2s response'] ?? '',
  );
  if (s2s) {
    actualItems.push(
      { label: 'HTTP', value: s2s[1] ?? '' },
      ...item('Result', s2s[2]),
      ...item('Message', s2s[3]?.trim()),
    );
  } else actualItems.push(...item('S2S response', values['s2s response']));
  actualItems.push(...item('Final status', values['purchase status after']));
  actualItems.push(
    ...item('Device', values.device),
    ...item('Device data to PGS', values['device data to PGS']),
    ...item('3DS challenge', values['3ds challenge']),
    ...item(
      'Cashier',
      values['cashier outcome'] ? outcomeLabel(values['cashier outcome']) : undefined,
    ),
    ...item('Final status', values['final status']),
    ...item('Message', values['error message']),
  );
  if (psp && category !== 'regex') {
    actualItems.push({
      label: 'PSP checks',
      value: `${String(psp.checks.filter((c) => c.passed).length)}/${String(psp.checks.length)} passed${psp.pspStatus ? ` · PSP status ${psp.pspStatus}` : ''}`,
    });
    // What the PSP answered on an unsuccessful payment (its own code / message).
    if (!/^(PAID|SETTLED|PARTIAL_PAID|OVER_PAID)$/i.test(psp.purchaseStatus)) {
      const pspText = [psp.gatewayCode, psp.gatewayMessage].filter(Boolean).join(' – ');
      actualItems.push(...item('PSP message', pspText));
      if (psp.errorMessage && psp.errorMessage !== psp.gatewayMessage) {
        actualItems.push(...item('PGS error', psp.errorMessage));
      }
    }
    // Failed checks by name (masking, mapping, webhooks …) so the reader sees WHAT failed.
    for (const check of psp.checks.filter((c) => !c.passed).slice(0, 8)) {
      actualItems.push({ label: `✗ ${check.name}`, value: check.actual || '(empty)' });
    }
    actualItems.push(...structuredPspNotes(psp));
  }
  actualItems.push(
    ...item('KYC', values['kyc result'] ?? values['kyc response']),
    ...item('KYC id', values['kyc id']),
    ...item('Refund', values.refund),
    ...item('Refund history', values['refund history']),
  );
  for (const note of (values.note ?? '').split('\n').filter(Boolean)) {
    actualItems.push({ label: 'Note', value: note });
  }

  return {
    category,
    categoryLabel:
      category === 'field' && values[FIELD_PSP_RULE_ANNOTATION] !== undefined
        ? CUSTOMER_DATA_LABEL
        : CATEGORY_LABELS[category],
    polarity: polarityOf(category, input),
    expectedItems,
    actualItems,
  };
}
