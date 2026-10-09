import { createRequire } from 'node:module';
import type { BankTransaction } from '../schemas/backoffice.schema';

/**
 * Typed access to config/pgs/pgs-rules.js – the JavaScript port of PGS's
 * ClientDetailsValidator (shared with the launcher so both judge values alike).
 */
export interface PgsEvaluation {
  readonly verdict: 'valid' | 'invalid';
  readonly regex: string | null;
  readonly source: string;
  /** Value PGS keeps (after phone repair), null when it replaces it. */
  readonly sentValue: string | null;
  readonly note: string;
}

interface PgsRulesModule {
  evaluate(field: string, value: string | null, spec: string, country: string): PgsEvaluation;
  isPlaceholder(value: unknown): boolean;
  describe(spec: string, country: string, field: string): string;
}

const rules = createRequire(__filename)('../../config/pgs/pgs-rules.js') as PgsRulesModule;

export const evaluatePgsRule = (
  field: string,
  value: string | null,
  spec: string,
  country: string,
): PgsEvaluation => rules.evaluate(field, value, spec, country);

export const describePgsRule = (spec: string, country: string, field: string): string =>
  rules.describe(spec, country, field);

/** "NA", "Na", "na", "nA", "n/a", "N/A" (spaces around ignored). */
export const isPlaceholder = (value: unknown): boolean => rules.isPlaceholder(value);

/** How a regex case sends its value: text, empty string, JSON null or field left out. */
export type RegexSend = 'value' | 'empty' | 'null' | 'missing';

/**
 * Product standard that holds with or without a bank Field Regex (confirmed 2026-10-09):
 * - full_name: empty, null, missing and placeholders (NA / n/a …) must never reach the PSP
 * - every other customer field: empty, null and missing must never reach the PSP
 * PGS either rejects the purchase or sends a value from its DB pool instead.
 * Returns the reason when the standard applies, otherwise undefined.
 */
export function standardRule(field: string, send: RegexSend, value: string): string | undefined {
  const blank = send !== 'value' || value.trim() === '';
  if (blank) {
    const what = send === 'missing' ? 'not sent' : send === 'null' ? 'null' : 'empty';
    return `${field} ${what} – must never reach the PSP empty (standard rule, with or without a bank regex)`;
  }
  if (field === 'full_name' && isPlaceholder(value)) {
    return `full_name placeholder "${value.trim()}" – must never reach the PSP (standard rule, with or without a bank regex)`;
  }
  return undefined;
}

/** Key names a PSP payload uses for each client field – to tell "not sent to this PSP at all". */
const FIELD_KEYS: Readonly<Record<string, RegExp>> = {
  full_name: /name/i,
  phone: /phone|mobile|msisdn/i,
  email: /mail/i,
  city: /city|town/i,
  zip_code: /zip|postal|postcode/i,
  stateCode: /state|region|province/i,
  street_address: /street|address|line1/i,
  date_of_birth: /birth|dob/i,
  country: /country/i,
  gender: /gender|sex/i,
};

/** True when the PSP request has no key for this field – the PSP simply does not receive it. */
export function pspLacksField(bank: BankTransaction | undefined, field: string): boolean {
  const pattern = FIELD_KEYS[field];
  if (bank === undefined || pattern === undefined) return false;
  let found = false;
  const walk = (node: unknown, depth: number): void => {
    if (found || depth > 12 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      // Merchant / sub-merchant blocks carry the merchant's own phone, address … – not the customer's.
      if (/merchant|facilitator|provider|beneficiary/i.test(key)) continue;
      if (pattern.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        found = true;
        return;
      }
      walk(value, depth + 1);
    }
  };
  walk([bank.paymentInfo, bank.allOtherRequest], 0);
  return !found;
}

const MERCHANT_BLOCK = /merchant|facilitator|provider|beneficiary/i;
const NAME_KEYS = new Set([
  'firstname',
  'fname',
  'givenname',
  'middlename',
  'lastname',
  'lname',
  'surname',
  'familyname',
  'fullname',
  'customername',
  'payername',
  'billingname',
  'accountholdername',
]);
/** A plain `name` key counts only inside a customer block (not product / bank / card names). */
const CUSTOMER_BLOCK = /customer|billing|payer|client|buyer|consumer|shopper|user|person/i;
/** Exact key shapes per customer field – stricter than FIELD_KEYS so other data is not mistaken for it. */
const FIELD_KEY_SHAPES: Readonly<Record<string, RegExp>> = {
  phone: /phone|mobile|msisdn/,
  email: /^(customer|billing|payer)?e?mail(address)?$/,
  city: /^(billing|customer)?(city|town)$/,
  zip_code: /zip|postal|postcode/,
  stateCode: /^(billing|customer)?(state|statecode|stateprovince|province|region)$/,
  street_address: /street|addressline|^(billing)?address\d?$|^line1$/,
  date_of_birth: /birth|^dob$/,
  country: /^(billing|customer)?country(code)?$/,
  gender: /gender|^sex$/,
};

export interface FieldLeaf {
  readonly path: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Customer values the PSP request (paymentInfo / allOtherRequest) carries for one field –
 * merchant / facilitator blocks left out. An empty or null value is returned as "".
 */
export function customerFieldLeaves(bank: BankTransaction | undefined, field: string): FieldLeaf[] {
  if (bank === undefined) return [];
  const norm = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');
  const shape = FIELD_KEY_SHAPES[field];
  const matches = (key: string, parent: string): boolean => {
    const k = norm(key);
    if (field === 'full_name')
      return NAME_KEYS.has(k) || (k === 'name' && CUSTOMER_BLOCK.test(parent));
    return shape?.test(k) === true;
  };
  const out: FieldLeaf[] = [];
  const walk = (node: unknown, path: string, parent: string, depth: number): void => {
    if (depth > 12 || node === undefined) return;
    if (typeof node === 'string' && /^\s*[[{]/.test(node)) {
      try {
        walk(JSON.parse(node) as unknown, path, parent, depth + 1);
        return;
      } catch {
        /* plain text */
      }
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`, parent, depth + 1);
      });
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (MERCHANT_BLOCK.test(key)) continue;
        const childPath = path ? `${path}.${key}` : key;
        const isLeaf = child === null || typeof child !== 'object';
        if (isLeaf && matches(key, path)) {
          out.push({
            path: childPath,
            key,
            value: child === null || child === undefined ? '' : String(child),
          });
        } else {
          walk(child, childPath, key, depth + 1);
        }
      }
    }
  };
  walk({ paymentInfo: bank.paymentInfo, allOtherRequest: bank.allOtherRequest }, '', '', 0);
  return out;
}
