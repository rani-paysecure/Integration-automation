import type { BankTransaction } from '../schemas/backoffice.schema';
import { maskSensitiveData } from '../utils/masking';
import { looksMasked } from './psp-compliance';

/**
 * Checks on fields of the PSP request / response recorded by the dashboard
 * (GET /trans/getBankTrans). Payloads are PSP-specific and often contain
 * several calls (token, payment, inquiry…), so a field is searched at any
 * depth in every call; the check passes when ANY occurrence satisfies it.
 */
export type PspCheckType =
  | 'equals'
  | 'not equals'
  | 'contains'
  | 'matches'
  | 'present'
  | 'absent'
  /** Field is stored masked (***) wherever it appears – for card data, e-mail, phone. */
  | 'masked';

export interface PspFieldCheckInput {
  readonly source: 'request' | 'response';
  /** Key (`currencyCode`) or dotted path (`extraData.beneficiaryCountryCode`). */
  readonly field: string;
  readonly check: PspCheckType;
  /** Literal or placeholder such as `{amount}`; empty for present / absent. */
  readonly value: string;
}

export interface PspFieldCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export const PSP_FIELD_CHECKS_ANNOTATION = 'psp-field-checks';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function resolvePath(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** Every value found for `field` anywhere inside `payload`. */
export function findFieldValues(payload: unknown, field: string): unknown[] {
  const segments = field.split('.').filter(Boolean);
  const found: unknown[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (isObject(node)) {
      const hit = resolvePath(node, segments);
      if (hit !== undefined) found.push(hit);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, depth + 1);
  };
  walk(payload, 0);
  return found;
}

const asText = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);

function sameValue(actual: unknown, expected: string): boolean {
  const a = asText(actual).trim();
  const e = expected.trim();
  const numA = Number(a);
  const numE = Number(e);
  if (a !== '' && e !== '' && Number.isFinite(numA) && Number.isFinite(numE)) {
    return Math.abs(numA - numE) < 1e-9;
  }
  return a === e;
}

/** Replaces `{amount}`, `{currency}`, `{purchaseId}` … with values from the purchase. */
export function resolvePlaceholders(value: string, vars: Readonly<Record<string, string>>): string {
  return value.replace(/\{(\w+)\}/g, (match, name: string) => {
    const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? match : (vars[key] ?? '');
  });
}

/** Masks a value found under a sensitive key (e.g. a PSP secret) before it is reported. */
function reportable(field: string, value: unknown): string {
  const key = field.split('.').at(-1) ?? field;
  const masked = maskSensitiveData({ [key]: value });
  return asText(masked[key]).slice(0, 200);
}

export function payloadFor(
  bank: BankTransaction | undefined,
  source: 'request' | 'response',
): unknown {
  if (bank === undefined) return undefined;
  return source === 'request'
    ? [bank.paymentInfo, bank.allOtherRequest]
    : [bank.response, bank.response3ds];
}

export function evaluatePspFieldChecks(
  bank: BankTransaction | undefined,
  checks: readonly PspFieldCheckInput[],
  vars: Readonly<Record<string, string>>,
): PspFieldCheckResult[] {
  return checks.map((c) => {
    const where = c.source === 'request' ? 'PSP request' : 'PSP response';
    const expectedValue = resolvePlaceholders(c.value, vars);
    const values = findFieldValues(payloadFor(bank, c.source), c.field);
    const present = values.filter((v) => asText(v) !== '');
    const actual =
      bank === undefined
        ? 'no PSP record'
        : values.length === 0
          ? 'field not found'
          : [...new Set(values.map((v) => reportable(c.field, v)))].join(' | ');
    let passed: boolean;
    switch (c.check) {
      case 'present':
        passed = present.length > 0;
        break;
      case 'absent':
        passed = bank !== undefined && present.length === 0;
        break;
      case 'masked':
        passed = values.length > 0 && values.every((v) => looksMasked(asText(v)));
        break;
      case 'equals':
        passed = values.some((v) => sameValue(v, expectedValue));
        break;
      case 'not equals':
        passed = values.length > 0 && !values.some((v) => sameValue(v, expectedValue));
        break;
      case 'contains':
        passed = values.some((v) => asText(v).toLowerCase().includes(expectedValue.toLowerCase()));
        break;
      case 'matches': {
        const re = new RegExp(expectedValue);
        passed = values.some((v) => re.test(asText(v)));
        break;
      }
    }
    const shownExpected =
      c.check === 'present' || c.check === 'absent' || c.check === 'masked'
        ? c.check
        : `${c.check} ${reportable(c.field, expectedValue)}${expectedValue !== c.value ? ` (${c.value})` : ''}`;
    return { name: `${where} · ${c.field}`, passed, expected: shownExpected, actual };
  });
}

/** Values of the purchase request usable as `{placeholders}` in expected values. */
export function purchaseVars(request: unknown, purchaseId: string): Record<string, string> {
  const get = (p: string): string => asText(resolvePath(request, p.split('.')));
  return {
    purchaseId,
    amount: get('purchase.total'),
    /** Amount in minor units (cents) – many PSPs send 2.00 EUR as 200. */
    amountMinor: Number.isFinite(Number(get('purchase.total')))
      ? String(Math.round(Number(get('purchase.total')) * 100))
      : '',
    currency: get('purchase.currency'),
    email: get('client.email'),
    country: get('client.country'),
    city: get('client.city'),
    zip: get('client.zip_code'),
    phone: get('client.phone'),
    fullName: get('client.full_name'),
    brandId: get('brand_id'),
    paymentMethod: get('paymentMethod'),
  };
}
