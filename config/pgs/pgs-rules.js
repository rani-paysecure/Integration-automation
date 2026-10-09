// @ts-check
/**
 * How PGS applies a bank's field regexes – a JavaScript port of
 * `org.pgs.client.validation.ClientDetailsValidator` (PGS repo), used by the
 * launcher, the AI generator and the regex tests so they judge a value
 * exactly like the backend does.
 *
 *   rule shapes (dashboard → PaymentBankJsonData → Field Regex)
 *     "^[A-Za-z]+$"                       flat regex (legacy)
 *     ["IN","US","default"]               per-country regex from the PGS catalog
 *                                         (config/pgs/country-validation-regex.json),
 *                                         "default" = catalog fallback for other countries
 *     {"enable":["IN"],"default":"^…$"}   per-country regex, bank's own fallback
 *   a value is INVALID (→ replaced before the PSP call) when it is null, empty / only spaces,
 *   a placeholder (NA, Na, na, nA, n/a, N/A – product rule confirmed 2026-10-09; the Java code
 *   checks only "NA" today, so the other spellings expose that gap),
 *   does not fully match (Java String.matches), the rule gives no usable regex,
 *   or the regex is malformed. Catalog phone rules first repair the number to
 *   +<cc><digits>; a number that cannot be repaired is invalid.
 *   Only banks whose integration class calls ClientDetailsValidator.validate
 *   apply the rules (commongateway Main and 17 others – see docs/pgs-behaviour.md).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CATALOG_FILE = path.join(__dirname, 'country-validation-regex.json');

/** "NA", "Na", "na", "nA", "n/a", "N/A" (spaces around ignored) – never a real customer value. */
const PLACEHOLDER = /^n\/?a$/i;
/** @param {unknown} value */
function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

/** @type {Record<string, Record<string, string>> | undefined} */
let catalogCache;
/** field → country → regex (comment keys starting with "_" skipped, as in PGS). */
/** @returns {Record<string, Record<string, string>>} */
function catalog() {
  if (catalogCache) return catalogCache;
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  try {
    const root = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    for (const [field, countries] of Object.entries(root)) {
      if (field.startsWith('_') || !countries || typeof countries !== 'object') continue;
      out[field] = Object.fromEntries(
        Object.entries(countries).filter(([c]) => !c.startsWith('_')),
      );
    }
  } catch {
    /* no catalog – country rules resolve to "no usable regex" */
  }
  catalogCache = out;
  return out;
}

/** ClientDetailsValidator.resolveRegex – which regex applies for this customer country. */
/**
 * @param {unknown} spec @param {string} country @param {string} field
 * @returns {{ regex: string | null, source: string, catalogDriven?: boolean, canonical?: boolean }}
 */
function resolveSpec(spec, country, field) {
  if (spec === null || spec === undefined || String(spec).trim() === '')
    return { regex: null, source: 'empty rule' };
  const trimmed = String(spec).trim();
  const fieldCatalog = catalog()[field] || {};
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (!Array.isArray(obj.enable))
        return { regex: null, source: 'object rule without "enable"' };
      if (obj.enable.includes(country) && fieldCatalog[country])
        return {
          regex: fieldCatalog[country],
          source: `catalog ${country}`,
          catalogDriven: true,
          canonical: true,
        };
      if (typeof obj.default === 'string')
        return { regex: obj.default, source: 'bank default', catalogDriven: true };
      return { regex: null, source: `${country} not enabled and no default` };
    } catch {
      return { regex: null, source: 'malformed object rule' };
    }
  }
  if (trimmed.startsWith('[')) {
    try {
      const list = JSON.parse(trimmed);
      if (list.includes(country) && fieldCatalog[country])
        return {
          regex: fieldCatalog[country],
          source: `catalog ${country}`,
          catalogDriven: true,
          canonical: true,
        };
      if (list.includes('default') && fieldCatalog.default)
        return { regex: fieldCatalog.default, source: 'catalog default', catalogDriven: true };
      return { regex: null, source: `${country} not enabled and no default` };
    } catch {
      return { regex: null, source: 'malformed list rule' };
    }
  }
  return { regex: trimmed, source: 'bank regex' };
}

/** Java regex (String.matches = whole value) → JS RegExp; leading inline flags become flags. */
/** @param {string} pattern */
function toJsRegExp(pattern) {
  let body = String(pattern);
  let flags = 'u';
  const inline = /^(\^?)\(\?([imsux]+)\)/.exec(body);
  if (inline) {
    const [whole, caret = '', letters = ''] = inline;
    body = caret + body.slice(whole.length);
    if (letters.includes('i')) flags += 'i';
    if (letters.includes('s')) flags += 's';
    if (letters.includes('m')) flags += 'm';
  }
  return new RegExp(`^(?:${body})$`, flags);
}

/** ClientDetailsValidator.tryNormalizePhone for catalog regexes of shape ^(?:\+?<cc>[ -]?)?\d{n[,m]}$ */
/** @param {unknown} value @param {string} country @returns {string | null} */
function normalizePhone(value, country) {
  const spec = (catalog().phone || {})[country];
  const shape = spec && /^\^\(\?:\\\+\?(\d+)\[ -\]\?\)\?\\d\{([\d,]+)\}\$$/.exec(spec);
  if (!shape || value === null || value === undefined || String(value).trim() === '') return null;
  const code = shape[1] ?? '';
  const counts = (shape[2] ?? '').split(',').map(Number);
  const min = counts[0] ?? 0;
  const max = counts[1] ?? min;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  for (let n = min; n <= max; n++)
    if (digits.length === code.length + n) return `+${code}${digits.slice(code.length)}`;
  for (let n = min; n <= max; n++) if (digits.length === n) return `+${code}${digits}`;
  return null;
}

/**
 * Would PGS keep this value for the bank?
 * @param {string} field @param {unknown} value @param {unknown} spec @param {string} country
 * @returns {{ verdict: 'valid' | 'invalid', regex: string | null, source: string, sentValue: string | null, note: string }}
 */
function evaluate(field, value, spec, country) {
  const resolved = resolveSpec(spec, country, field);
  const base = { regex: resolved.regex, source: resolved.source };
  if (resolved.regex === null)
    return {
      ...base,
      verdict: 'invalid',
      sentValue: null,
      note: `no usable regex (${resolved.source}) – PGS replaces the value`,
    };
  // PGS trims leading / trailing spaces before validating (confirmed 2026-10-09).
  let current = value === null || value === undefined ? null : String(value).trim();
  let note = '';
  if (
    resolved.canonical &&
    field.toLowerCase() === 'phone' &&
    current !== null &&
    !isPlaceholder(current)
  ) {
    const normalized = normalizePhone(current, country);
    if (normalized === null)
      return {
        ...base,
        verdict: 'invalid',
        sentValue: null,
        note: `cannot be repaired into a ${country} number`,
      };
    if (normalized !== current) note = `PGS rewrites it to ${normalized}`;
    current = normalized;
  }
  if (current === null || current.trim() === '' || isPlaceholder(current))
    return {
      ...base,
      verdict: 'invalid',
      sentValue: null,
      note: 'placeholder (NA / n/a …) or empty counts as invalid',
    };
  let matches;
  try {
    matches = toJsRegExp(resolved.regex).test(current);
  } catch (error) {
    return {
      ...base,
      verdict: 'invalid',
      sentValue: null,
      note: `malformed regex – PGS forces a replacement (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return {
    ...base,
    verdict: matches ? 'valid' : 'invalid',
    sentValue: matches ? current : null,
    note,
  };
}

/** Rule text for humans, e.g. "catalog IN: ^(?:\+?91[ -]?)?\d{10}$". */
/** @param {unknown} spec @param {string} country @param {string} field */
function describe(spec, country, field) {
  const r = resolveSpec(spec, country, field);
  return r.regex === null
    ? `${r.source}`
    : r.source === 'bank regex'
      ? r.regex
      : `${r.source}: ${r.regex}`;
}

module.exports = {
  CATALOG_FILE,
  PLACEHOLDER,
  isPlaceholder,
  catalog,
  resolveSpec,
  toJsRegExp,
  normalizePhone,
  evaluate,
  describe,
};
