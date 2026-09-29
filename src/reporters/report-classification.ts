import type { FieldCaseMeta, FieldResultMeta } from '../helpers/field-testing';
import type { PspFieldCheckResult } from '../helpers/psp-field-checks';
import type { PspSummary } from '../helpers/psp-validation';

/**
 * Presentation data for the launcher report: which category a test belongs
 * to, whether it is a positive or negative case, and Expected / Actual as
 * labelled lines instead of one long string.
 */
export type CategoryId = 'field' | 'regex' | 'psp' | 'edge' | 'card' | 'psp-check' | 'other';
export type Polarity = 'positive' | 'negative' | 'neutral';

export interface ReportItem {
  readonly label: string;
  readonly value: string;
}

export const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = {
  field: 'Field validation',
  regex: 'Regex validation',
  psp: 'PSP request / response',
  edge: 'Custom & edge cases',
  card: 'Card transactions',
  'psp-check': 'PSP check (existing purchases)',
  other: 'Other',
};

export function categoryOf(key: string): CategoryId {
  if (/^@(FT|FV)-/.test(key)) return 'field';
  if (key.startsWith('@RX-')) return 'regex';
  if (key.startsWith('@PR-')) return 'psp';
  if (key.startsWith('@EC-')) return 'edge';
  if (key.startsWith('@card-')) return 'card';
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

export function classify(input: ClassifyInput): Classification {
  const category = categoryOf(input.key);
  const { values, fieldCase, fieldResult, psp, pspFieldChecks } = input;

  const expectedItems: ReportItem[] = [];
  if (fieldCase) {
    expectedItems.push(
      ...item('Test data', fieldCase.testData),
      ...item('Sheet says', fieldCase.expectedResult),
      ...item('Rule', FIELD_RULES[fieldCase.expectation]),
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
  actualItems.push(
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
  }

  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    polarity: polarityOf(category, input),
    expectedItems,
    actualItems,
  };
}
