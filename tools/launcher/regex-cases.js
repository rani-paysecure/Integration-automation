// @ts-check
/**
 * Regex validation cases generated from a bank's field regexes
 * (dashboard → PaymentBankJsonData → Field Regex).
 *
 * For every field with a rule, a curated set of test values plus boundary
 * values (from `{min,max}` in the pattern) is classified with the bank's own
 * regex: Valid (matches → must reach the PSP unchanged) or Invalid (does not
 * match → must not reach the PSP). Country-list rules (phone) cannot be
 * evaluated locally and become "observe" cases.
 */
'use strict';

/** Dashboard field name → purchase request path. */
const FIELD_PATHS = {
  full_name: 'client.full_name',
  phone: 'client.phone',
  email: 'client.email',
  date_of_birth: 'client.date_of_birth',
  gender: 'client.gender',
  street_address: 'client.street_address',
  city: 'client.city',
  stateCode: 'client.stateCode',
  state: 'client.stateCode',
  zip_code: 'client.zip_code',
  country: 'client.country',
};

/** Test values per field (distinct from the standard request so a pass-through is detectable). */
const CANDIDATES = {
  full_name: [
    ['Two words', 'Maria Lopez'],
    ['Three words', 'Anna Marie Smith'],
    ['Hyphenated name', 'Jean-Luc Picard'],
    ['Apostrophe', "Sean O'Connor"],
    ['Accented letters', 'José Álvarez'],
    ['Digits in name', 'John123'],
    ['Special characters', 'Test@User'],
    ['"N/A"', 'N/A'],
    ['"null"', 'null'],
    ['Single letter', 'Q'],
  ],
  phone: [
    ['Austria, international', '+436641112233'],
    ['India, international', '+919876543210'],
    ['US, international', '+14155552671'],
    ['UK with spaces', '+44 20 7946 0958'],
    ['Too short', '12345'],
    ['Letters', 'abcdefghij'],
  ],
  email: [
    ['Plain address', 'qa.regex@example.com'],
    ['No domain', 'qa.regex@'],
  ],
  date_of_birth: [
    ['ISO date', '1990-05-15'],
    ['Day first', '15/05/1990'],
    ['Month 13', '1990-13-01'],
    ['Text', 'yesterday'],
  ],
  gender: [
    ['M', 'M'],
    ['F', 'F'],
    ['Word', 'male'],
    ['Digit', '1'],
  ],
  street_address: [
    ['Street and number', 'Ringstrasse 5'],
    ['With flat number', 'Hauptstraße 12/3'],
    ['Two characters', 'No'],
    ['Only digits', '12'],
  ],
  city: [
    ['One word', 'Vienna'],
    ['Hyphenated', 'Graz-West'],
    ['Two words', 'Sankt Poelten'],
    ['Digits', '12345'],
    ['Letters and digits', 'Wien1'],
    ['Special character', '@Home'],
    ['Single letter', 'V'],
  ],
  stateCode: [
    ['Two letters', 'NY'],
    ['With hyphen', 'AT-9'],
    ['Special character', '#9'],
    ['Space first', ' NY'],
  ],
  zip_code: [
    ['Digits', '1020'],
    ['UK format', 'SW1A 1AA'],
    ['With hyphen', '1020-AB'],
    ['Special character', '#1020'],
    ['Single character', '7'],
  ],
  country: [
    ['Alpha-2', 'DE'],
    ['Alpha-3', 'DEU'],
    ['Digits', '12'],
  ],
};
const GENERIC = [
  ['Letters and digits', 'Test Value 123'],
  ['Special characters', '!@#$%'],
];

/** Values in the standard request – a candidate equal to one of them would prove nothing. */
const BASELINE = new Set([
  'dummy user',
  'jaipur',
  'wi',
  '1010',
  'kärntner straße 10',
  'at',
  '+436601234567',
  '2011-04-25',
]);

/** Java → JS (see src/helpers/bank-regex.ts – keep both in sync). */
function compileRule(pattern) {
  const trimmed = String(pattern).trim();
  if (trimmed.startsWith('[')) {
    try {
      const list = JSON.parse(trimmed);
      if (Array.isArray(list)) return { kind: 'country-list', countries: list.map(String) };
    } catch {
      /* regex */
    }
  }
  let body = trimmed;
  let flags = 'u';
  const inline = /^(\^?)\(\?([imsux]+)\)/.exec(body);
  if (inline) {
    body = inline[1] + body.slice(inline[0].length);
    if (inline[2].includes('i')) flags += 'i';
    if (inline[2].includes('s')) flags += 's';
    if (inline[2].includes('m')) flags += 'm';
  }
  try {
    return { kind: 'regex', regex: new RegExp(`^(?:${body})$`, flags) };
  } catch (error) {
    return { kind: 'invalid', problem: error.message };
  }
}

/** Length boundaries around the last `{min,max}` quantifier, e.g. `.{2,120}` → 1, 2, 120, 121 characters (the regex decides which are valid). */
function boundaryCandidates(pattern) {
  const quantifiers = [...String(pattern).matchAll(/\{(\d+)(,(\d*))?\}/g)];
  const last = quantifiers.at(-1);
  if (!last) return [];
  const min = Number(last[1]);
  const max = last[2] === undefined ? min : last[3] === '' ? undefined : Number(last[3]);
  const make = (n) => 'Abcdefghij'.repeat(Math.ceil(n / 10) + 1).slice(0, n);
  const out = [];
  if (min > 1) out.push([`${min - 1} characters`, make(min - 1)]);
  if (min > 0) out.push([`${min} characters`, make(min)]);
  if (max !== undefined && max <= 300) {
    out.push([`${max} characters`, make(max)]);
    out.push([`${max + 1} characters`, make(max + 1)]);
  }
  return out;
}

/**
 * Cases for one bank: [{ data, display, issues, warnings }] in the same shape
 * as an Excel preview, so the launcher shows and appends them the same way.
 */
function casesForBank(bank, rules) {
  const cases = [];
  const summary = [];
  for (const [field, pattern] of Object.entries(rules)) {
    const rule = compileRule(pattern);
    const requestPath = FIELD_PATHS[field];
    summary.push({
      field,
      pattern,
      kind: rule.kind,
      path: requestPath || '',
      note:
        rule.kind === 'invalid'
          ? `Pattern cannot be used: ${rule.problem}`
          : rule.kind === 'country-list'
            ? `Validated per country (${rule.countries.join(', ')}) – cases are recorded, not judged`
            : requestPath
              ? ''
              : 'Field is not on the purchase request – no cases',
    });
    if (!requestPath || rule.kind === 'invalid') continue;
    const seen = new Set();
    const candidates = [
      ...(CANDIDATES[field] || GENERIC),
      ...(rule.kind === 'regex' ? boundaryCandidates(pattern) : []),
    ];
    for (const [label, value] of candidates) {
      if (seen.has(value) || BASELINE.has(value.toLowerCase())) continue;
      seen.add(value);
      const expectation =
        rule.kind === 'country-list' ? 'observe' : rule.regex.test(value) ? 'valid' : 'invalid';
      const data = {
        bank,
        field,
        path: requestPath,
        title: `${field} – ${label}`,
        value,
        expectation,
        regex: pattern,
        origin: 'dashboard',
      };
      cases.push({
        data,
        display: [
          bank,
          field,
          value.length > 40 ? `"${value.slice(0, 14)}…" (${value.length} chars)` : `"${value}"`,
          expectationLabel(expectation),
        ],
        issues: [],
        warnings: [],
      });
    }
  }
  return { rules: summary, cases };
}

function expectationLabel(e) {
  return e === 'valid'
    ? 'Valid → sent unchanged'
    : e === 'invalid'
      ? 'Invalid → not sent'
      : 'Observe';
}

/** Guesses the bank of a MID from its name (`paysafe_payfac_mid` → `paysafe_payfac`). */
function bankForMid(midName, bankNames) {
  const mid = String(midName || '').toLowerCase();
  return (
    bankNames
      .filter(
        (b) =>
          mid === b.toLowerCase() ||
          mid.startsWith(`${b.toLowerCase()}_`) ||
          mid.startsWith(`${b.toLowerCase()}-`),
      )
      .sort((a, b) => b.length - a.length)[0] || ''
  );
}

module.exports = { FIELD_PATHS, compileRule, casesForBank, bankForMid, expectationLabel };
