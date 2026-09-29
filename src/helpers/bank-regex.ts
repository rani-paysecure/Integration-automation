import type { BankTransaction } from '../schemas/backoffice.schema';

/**
 * Field regexes configured per bank in the dashboard
 * (PaymentBankJsonData → "Field Regex", GET /admin/getFieldValidationRules).
 *
 * Behaviour observed on test4: a value that does NOT match is not rejected –
 * it is replaced (e.g. cardholder name / a default) before the request goes to
 * the PSP. A regex test therefore checks the PSP request:
 *   matches the regex        → value reaches the PSP unchanged
 *   does not match the regex → value does not reach the PSP
 */
export type BankRule =
  | { readonly kind: 'regex'; readonly pattern: string; readonly regex: RegExp }
  /** e.g. phone: ["IN","US","GB","default"] – validated per country, not by a regex. */
  | {
      readonly kind: 'country-list';
      readonly pattern: string;
      readonly countries: readonly string[];
    }
  | { readonly kind: 'invalid'; readonly pattern: string; readonly problem: string };

/** Java patterns (`String.matches`) → JS: leading inline flags become flags, whole value must match. */
export function compileBankRule(pattern: string): BankRule {
  const trimmed = pattern.trim();
  if (trimmed.startsWith('[')) {
    try {
      const list = JSON.parse(trimmed) as unknown;
      if (Array.isArray(list)) {
        return { kind: 'country-list', pattern, countries: list.map(String) };
      }
    } catch {
      /* not a list – treat as a regex below */
    }
  }
  let body = trimmed;
  let flags = 'u';
  const inline = /^(\^?)\(\?([imsux]+)\)/.exec(body);
  if (inline) {
    const [, caret = '', letters = ''] = inline;
    body = caret + body.slice(inline[0].length);
    if (letters.includes('i')) flags += 'i';
    if (letters.includes('s')) flags += 's';
    if (letters.includes('m')) flags += 'm';
  }
  try {
    return { kind: 'regex', pattern, regex: new RegExp(`^(?:${body})$`, flags) };
  } catch (error) {
    return { kind: 'invalid', pattern, problem: (error as Error).message };
  }
}

const digits = (s: string): string => s.replace(/\D/g, '');
const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Paths in the PSP request where `value` was sent (phone numbers compared by digits). */
export function findSentValue(
  bank: BankTransaction | undefined,
  value: string,
  field: string,
): string[] {
  if (bank === undefined || value.trim() === '') return [];
  const payload: unknown = [bank.paymentInfo, bank.allOtherRequest];
  const isPhone = /phone|mobile|msisdn/i.test(field);
  const wanted = normalise(value);
  const wantedDigits = digits(value);
  const hits: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node);
      const same = isPhone
        ? wantedDigits.length >= 7 &&
          digits(text).length >= 7 &&
          (wantedDigits.endsWith(digits(text)) || digits(text).endsWith(wantedDigits))
        : normalise(text) === wanted;
      if (same) hits.push(path || '(root)');
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`, depth + 1);
      });
      return;
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  walk(payload, '', 0);
  // The same field often appears in several logged calls – list each path once.
  return [
    ...new Set(
      hits.map((p) => p.replace(/^(\[\d+\]|\d+)\.?/, '').replace(/^(\[\d+\]|\d+)\.?/, '')),
    ),
  ];
}
