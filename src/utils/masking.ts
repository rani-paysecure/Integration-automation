import {
  EMAIL_KEYS,
  FULLY_MASKED_KEYS,
  MASK,
  PARTIALLY_MASKED_KEYS,
} from '../constants/sensitive-fields';

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

const FULL = new Set(FULLY_MASKED_KEYS);
const PARTIAL = new Set(PARTIALLY_MASKED_KEYS);
const EMAIL = new Set(EMAIL_KEYS);

/** 13–19 consecutive digits (optionally separated by spaces/dashes) – likely a card number. */
const PAN_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_DEPTH = 20;

export function maskKeepLast4(value: string): string {
  const compact = value.replace(/[\s-]/g, '');
  if (compact.length <= 4) return MASK;
  return `${MASK}${compact.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return MASK;
  return `${value.charAt(0)}${MASK}${value.slice(at)}`;
}

/** Luhn checksum – used to avoid masking ordinary long numbers (ids, timestamps). */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits.charAt(i));
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Masks card-number-like digit runs and bearer/basic credentials inside free text. */
export function maskString(value: string): string {
  return value
    .replace(PAN_PATTERN, (match) =>
      passesLuhn(match.replace(/[\s-]/g, '')) ? maskKeepLast4(match) : match,
    )
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${MASK}`);
}

function maskValueForKey(key: string, value: unknown, depth: number): unknown {
  const normalised = normaliseKey(key);
  if (value === null || value === undefined) return value;
  if (FULL.has(normalised)) return MASK;
  if (typeof value === 'string' || typeof value === 'number') {
    if (PARTIAL.has(normalised)) return maskKeepLast4(String(value));
    if (EMAIL.has(normalised)) return maskEmail(String(value));
  }
  return maskSensitiveData(value, depth + 1);
}

/**
 * Returns a deep copy of `value` with sensitive data masked.
 * The input is never mutated.
 */
export function maskSensitiveData<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return '[MaxDepth]' as T;
  if (typeof value === 'string') return maskString(value) as T;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskSensitiveData(item, depth + 1)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = maskValueForKey(key, entry, depth);
    }
    return result as T;
  }
  return value;
}

export function maskHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!headers) return {};
  return maskSensitiveData({ ...headers });
}

/** Masks sensitive query-string parameters in a URL. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      const masked = maskValueForKey(key, parsed.searchParams.get(key), 0);
      parsed.searchParams.set(key, String(masked));
    }
    return decodeURIComponent(parsed.toString());
  } catch {
    return maskString(url);
  }
}
