import type { BankTransaction } from '../schemas/backoffice.schema';
import type { FieldTestCase } from './field-testing';
import { customerFieldLeaves, isPlaceholder } from './pgs-rules';
import { customerRequestLeaves, looksMasked, type Leaf } from './psp-compliance';
import type { PspCheck, PspSummary } from './psp-validation';

/**
 * Verdict for a field validation case that was also paid ("Also pay for accepted field
 * cases"): the case is about ONE request field, so only that field decides PASS / FAIL –
 * is its value carried unchanged into the API response, the stored purchase and the PSP
 * request? The rest of the payment (authorisation result, purchase-ID mapping, other
 * fields …) is reported as "not part of this case" and never fails it.
 */
export interface FieldPaymentVerdict {
  /** Checks about the case's field – asserted. */
  readonly checks: readonly PspCheck[];
  /** Places where the field could not be compared (not echoed, not sent, masked …). */
  readonly info: readonly string[];
  /** Failed checks / payment problems that are not about the field – reported only. */
  readonly separate: readonly string[];
  /** A customer field with no place to compare it – the report shows the case as OBSERVED. */
  readonly unverifiable: boolean;
  /** What the PSP answered and whether the payment passed – the case's remarks. */
  readonly pspResponse: string;
}

export interface FieldPaymentInput {
  readonly testCase: FieldTestCase;
  /** Purchase request that was sent (context + mutation applied). */
  readonly request: Record<string, unknown>;
  /** Body of the create-purchase answer. */
  readonly created: unknown;
  /** Body of GET purchase after the payment (undefined if it could not be read). */
  readonly stored: unknown;
  readonly psp: PspSummary;
  readonly bank: BankTransaction | undefined;
  readonly finalStatus: string;
  readonly cashierOutcome: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** PSP checks (names from `summarizePsp`) that are about a request field. */
const RELATED_PSP_CHECKS: Readonly<Record<string, readonly string[]>> = {
  'client.email': ['Mapping: E-mail'],
  'client.phone': ['Mapping: Phone'],
  'client.street_address': ['Mapping: Street'],
  'client.city': ['Mapping: City'],
  'client.zip_code': ['Mapping: Zip code'],
  'client.stateCode': ['Mapping: State'],
  'client.country': ['Mapping: Country'],
  'purchase.currency': ['Currency sent to PSP', 'Mapping: currency in PSP request'],
  'purchase.total': ['Amount sent to PSP', 'Mapping: amount in PSP request'],
  'purchase.products': ['Amount sent to PSP', 'Mapping: amount in PSP request'],
  'purchase.products.0.price': ['Amount sent to PSP', 'Mapping: amount in PSP request'],
};
/** The full name is checked here as a whole – the per-part mapping checks belong to it. */
const FULL_NAME_PSP_CHECKS = ['Mapping: First name', 'Mapping: Last name'];

const FIRST = new Set(['firstname', 'fname', 'givenname']);
const MIDDLE = new Set(['middlename', 'mname']);
const LAST = new Set(['lastname', 'lname', 'surname', 'familyname']);
const FULL = new Set(['fullname', 'customername', 'payername', 'billingname', 'accountholdername']);
const MIDDLE_NAME = /^m(iddle)?_?name$/i;

/** "NA", "Na", "na", "nA", "n/a", "N/A" – placeholders PGS replaces from its DB pool. */
const PLACEHOLDER = /^n\/?a$/i;

const keyOf = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');
const squash = (value: string): string => value.trim().replace(/\s+/g, ' ');

function valueAt(body: unknown, path: string): unknown {
  let node: unknown = body;
  for (const key of path.split('.')) {
    if (Array.isArray(node) && /^\d+$/.test(key)) {
      node = node[Number(key)];
      continue;
    }
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

/**
 * The case expects PGS to replace the value (a placeholder, or the sheet says so –
 * "NA replaced with DB default value", "replaced from DB at payment").
 */
export function expectsReplacement(testCase: FieldTestCase): boolean {
  const sent = testCase.mutation.type === 'set' ? testCase.mutation.value : undefined;
  return (
    (typeof sent === 'string' && PLACEHOLDER.test(sent.trim())) ||
    /replac/i.test(testCase.expectedResult)
  );
}

/** The name the PSP received: a full-name field, else first + middle + last joined. */
export function pspFullName(
  bank: BankTransaction,
): { readonly value: string; readonly paths: readonly string[] } | undefined {
  const leaves = customerRequestLeaves(bank);
  const pick = (keys: ReadonlySet<string>): Leaf | undefined =>
    leaves.find((l) => keys.has(keyOf(l.key)) && l.value.trim() !== '');
  const full = pick(FULL);
  if (full) return { value: squash(full.value), paths: [full.path] };
  const parts = [pick(FIRST), pick(MIDDLE), pick(LAST)].filter((l): l is Leaf => l !== undefined);
  if (parts.length === 0) return undefined;
  return { value: squash(parts.map((l) => l.value).join(' ')), paths: parts.map((l) => l.path) };
}

function echoCheck(
  label: string,
  body: unknown,
  path: string,
  expected: string,
  info: string[],
): PspCheck | undefined {
  const actual = asText(valueAt(body, path));
  if (actual === undefined) {
    info.push(`${label}: ${path} not returned – not compared`);
    return undefined;
  }
  return {
    name: `${label}: ${path}`,
    passed: squash(actual) === expected,
    expected,
    actual,
  };
}

/**
 * Splits the result of a paid field case into checks about the field (asserted) and
 * everything else (reported only). See `FieldPaymentVerdict`.
 */
export function fieldPaymentVerdict(input: FieldPaymentInput): FieldPaymentVerdict {
  const { testCase, psp } = input;
  const path = testCase.path;
  const checks: PspCheck[] = [];
  const info: string[] = [];
  const related = new Set<string>(RELATED_PSP_CHECKS[path] ?? []);
  if (path === 'client.full_name') FULL_NAME_PSP_CHECKS.forEach((n) => related.add(n));

  const sentRaw = asText(valueAt(input.request, path));
  const sent = sentRaw === undefined ? undefined : squash(sentRaw);
  const replaced = expectsReplacement(testCase);
  const customerField = path.startsWith('client.');
  const pspResponse = describePspResponse(input);

  // NA / null / empty / not sent: must not reach the PSP – with or without a bank regex.
  const invalid = invalidInput(testCase, sentRaw);
  if (customerField && invalid !== undefined) {
    const field = path.slice('client.'.length);
    info.push(
      `${path} sent as ${invalid} – API response and stored purchase recorded, not compared`,
    );
    const leaves = customerFieldLeaves(input.bank, field).filter(
      (l) => !(field === 'full_name' && MIDDLE_NAME.test(l.key)),
    );
    if (input.bank === undefined) info.push('PSP request: not recorded');
    else if (leaves.length === 0)
      info.push(`PSP request: no ${field} field (this PSP does not take it)`);
    else {
      const leaked = leaves.filter(
        (l) => l.value.trim() === '' || /^null$/i.test(l.value.trim()) || isPlaceholder(l.value),
      );
      checks.push({
        name: `PSP request: ${field} not passed as ${invalid}`,
        passed: leaked.length === 0,
        expected: 'a real value (DB value or rejected), never NA / null / empty',
        actual: (leaked.length > 0 ? leaked : leaves)
          .slice(0, 4)
          .map((l) => `${l.path}="${l.value}"`)
          .join(', '),
      });
    }
    return {
      checks,
      info,
      separate: separateIssues(input, new Set([...related, ...FULL_NAME_PSP_CHECKS])),
      unverifiable: checks.length === 0,
      pspResponse,
    };
  }

  // 1. API response and stored purchase – the value as sent (PGS trims; replacement is at payment).
  if (customerField && sent !== undefined && sent !== '') {
    if (replaced) {
      info.push(
        `Placeholder / replaced value – API response and stored purchase recorded, not compared`,
      );
    } else {
      const created = echoCheck('API response', input.created, path, sent, info);
      if (created) checks.push(created);
      if (input.stored !== undefined) {
        const stored = echoCheck('Stored purchase', input.stored, path, sent, info);
        if (stored) checks.push(stored);
      }
    }
  }

  // 2. PSP request.
  if (path === 'client.full_name' && sent !== undefined && sent !== '') {
    const received = input.bank === undefined ? undefined : pspFullName(input.bank);
    if (received === undefined) {
      info.push('PSP request: no name field (this PSP does not take the customer name)');
    } else if (looksMasked(received.value)) {
      info.push(`PSP request: name masked at ${received.paths.join(', ')} – not compared`);
    } else {
      const same = received.value.toLowerCase() === sent.toLowerCase();
      checks.push({
        name: replaced ? 'PSP request: full name replaced' : 'PSP request: full name',
        passed: replaced ? !same : same,
        expected: replaced ? `a DB value, not "${sent}"` : sent,
        actual: `"${received.value}" at ${received.paths.join(', ')}`,
      });
      if (!replaced && same && received.value !== sent) {
        info.push(`PSP request: name case differs ("${received.value}")`);
      }
    }
  } else {
    for (const name of RELATED_PSP_CHECKS[path] ?? []) {
      const check = psp.checks.find((c) => c.name === name);
      if (check === undefined) {
        info.push(`PSP request: ${name.replace(/^Mapping: /, '')} not sent – not compared`);
        continue;
      }
      const masked = check.actual.startsWith('masked');
      if (replaced && customerField && !masked) {
        checks.push({
          ...check,
          name: `${check.name} replaced`,
          passed: !check.passed,
          expected: `a DB value, not "${sent ?? ''}"`,
        });
      } else {
        checks.push(check);
      }
    }
  }

  return {
    checks,
    info,
    // 3. Everything else of the payment – not part of this case.
    separate: separateIssues(input, related),
    unverifiable: customerField && sent !== undefined && sent !== '' && checks.length === 0,
    pspResponse,
  };
}

/** Failed checks and payment problems that are not about the case's field. */
function separateIssues(input: FieldPaymentInput, related: ReadonlySet<string>): string[] {
  const separate = input.psp.checks
    .filter((c) => !c.passed && !related.has(c.name))
    .map((c) => `${c.name}: expected ${c.expected}, got ${c.actual || '(empty)'}`);
  if (input.finalStatus !== 'PAID') {
    const reason = [input.psp.pspStatus, input.psp.gatewayMessage, input.psp.errorMessage]
      .filter((v) => v !== '')
      .join(' · ');
    separate.unshift(
      `Payment: cashier ${input.cashierOutcome}, final status ${input.finalStatus}${reason ? ` (${reason})` : ''}`,
    );
  }
  return separate;
}

/** "PSP answered … → payment PASSED / FAILED" – recorded as the case's remarks. */
export function describePspResponse(
  input: Pick<FieldPaymentInput, 'psp' | 'finalStatus' | 'cashierOutcome'>,
): string {
  const { psp } = input;
  const parts = [
    psp.pspStatus && `status ${psp.pspStatus}`,
    psp.gatewayCode && `code ${psp.gatewayCode}`,
    psp.gatewayMessage && `"${psp.gatewayMessage}"`,
    psp.errorMessage && `PGS error ${psp.errorMessage}`,
  ].filter(Boolean);
  const answer = psp.attempted
    ? parts.length > 0
      ? `PSP answered ${parts.join(' · ')}`
      : 'PSP answered (no status / message in the response)'
    : 'PSP not called';
  const passed = input.finalStatus === 'PAID';
  return `${answer} – final status ${input.finalStatus}, cashier ${input.cashierOutcome} → payment ${passed ? 'PASSED' : 'FAILED'}`;
}

/** NA / null / empty / not sent – the inputs that must never reach the PSP. */
function invalidInput(testCase: FieldTestCase, sentRaw: string | undefined): string | undefined {
  const m = testCase.mutation;
  if (m.type === 'remove') return 'not sent';
  if (m.type === 'set' && m.value === null) return 'null';
  // The case's own value wins; the request value covers baseline (unchanged) cases.
  const text = m.type === 'set' ? asText(m.value) : sentRaw;
  if (text === undefined) return undefined;
  if (text.trim() === '') return 'empty';
  if (isPlaceholder(text)) return `"${text.trim()}"`;
  return undefined;
}

// ── Field validation › Customer data at PSP ────────────────────────────────────

/**
 * Customer fields the purchase API does not validate: create answers 202 / CREATED for any
 * value (confirmed on test4, 2026-10-09 – NA, blank, digits …). Their rules only show in what
 * reaches the PSP, so these cases are always paid and judged on the PSP request.
 */
export const PSP_CHECKED_PATHS: ReadonlySet<string> = new Set([
  'client.full_name',
  'client.street_address',
  'client.city',
  'client.zip_code',
  'client.stateCode',
  'client.phone',
  'client.date_of_birth',
]);

export const isPspCheckedCase = (testCase: Pick<FieldTestCase, 'path'>): boolean =>
  PSP_CHECKED_PATHS.has(testCase.path);

/**
 * What a customer-data case checks at the PSP:
 * - not-passed – NA / null / empty / not sent: never reaches the PSP (DB value instead)
 * - unchanged  – a valid value (sheet: accepted): reaches the PSP as sent
 * - sanitized  – injection: the raw input does not reach the PSP
 * - record     – anything else (digits, special characters …): what the PSP got is recorded
 */
export type CustomerDataRule = 'not-passed' | 'unchanged' | 'sanitized' | 'record';

export function customerDataRule(testCase: FieldTestCase): CustomerDataRule {
  const sent = testCase.mutation.type === 'set' ? testCase.mutation.value : undefined;
  if (invalidInput(testCase, asText(sent)) !== undefined) return 'not-passed';
  if (testCase.expectation === 'sanitized') return 'sanitized';
  if (testCase.expectation === 'accepted' && !expectsReplacement(testCase)) return 'unchanged';
  return 'record';
}

export const CUSTOMER_DATA_RULE_TEXT: Readonly<Record<CustomerDataRule, string>> = {
  'not-passed': 'API accepts it · must NOT reach the PSP (DB value or rejected)',
  unchanged: 'API accepts it · reaches the PSP unchanged',
  sanitized: 'API accepts it · raw input must not reach the PSP',
  record: 'API accepts it · what the PSP receives is recorded',
};

/** Values of the field in the PSP request – "sent to PSP" in the report. */
export function describeSentToPsp(bank: BankTransaction | undefined, path: string): string {
  if (bank === undefined) return 'no PSP request recorded';
  const leaves = customerFieldLeaves(bank, path.replace(/^client\./, ''));
  return leaves.length === 0
    ? 'field not in the PSP request'
    : leaves
        .slice(0, 4)
        .map((l) => `${l.path}="${l.value}"`)
        .join(', ');
}

export interface CustomerDataVerdict extends FieldPaymentVerdict {
  readonly rule: CustomerDataRule;
  /** Nothing to assert (rule "record") – the report shows OBSERVED. */
  readonly recordOnly: boolean;
  readonly sentToPsp: string;
}

/** Verdict of a paid customer-data case (see `customerDataRule`). */
export function customerDataVerdict(input: FieldPaymentInput): CustomerDataVerdict {
  const rule = customerDataRule(input.testCase);
  const base = fieldPaymentVerdict(input);
  const sentToPsp = describeSentToPsp(input.bank, input.testCase.path);
  if (rule === 'sanitized') {
    const raw = asText(
      input.testCase.mutation.type === 'set' ? input.testCase.mutation.value : undefined,
    );
    const leaves = customerFieldLeaves(input.bank, input.testCase.path.replace(/^client\./, ''));
    const leaked = leaves.filter((l) => raw !== undefined && squash(l.value) === squash(raw));
    const checks: PspCheck[] =
      raw === undefined || leaves.length === 0
        ? []
        : [
            {
              name: 'PSP request: raw input not passed',
              passed: leaked.length === 0,
              expected: 'sanitised, replaced or dropped',
              actual: sentToPsp,
            },
          ];
    return {
      ...base,
      checks,
      unverifiable: checks.length === 0,
      rule,
      recordOnly: false,
      sentToPsp,
    };
  }
  if (rule === 'record') {
    return {
      ...base,
      checks: [],
      info: [...base.info, ...base.checks.map((c) => `${c.name}: ${c.actual}`)],
      unverifiable: false,
      rule,
      recordOnly: true,
      sentToPsp,
    };
  }
  return { ...base, rule, recordOnly: false, sentToPsp };
}
