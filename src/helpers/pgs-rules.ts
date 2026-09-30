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
  evaluate(field: string, value: string, spec: string, country: string): PgsEvaluation;
  describe(spec: string, country: string, field: string): string;
}

const rules = createRequire(__filename)('../../config/pgs/pgs-rules.js') as PgsRulesModule;

export const evaluatePgsRule = (
  field: string,
  value: string,
  spec: string,
  country: string,
): PgsEvaluation => rules.evaluate(field, value, spec, country);

export const describePgsRule = (spec: string, country: string, field: string): string =>
  rules.describe(spec, country, field);

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
