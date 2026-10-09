/**
 * PSP compliance checks on the bank record of a purchase (dashboard
 * GET /trans/getBankTrans) and on the webhooks around it.
 *
 * PGS (commongateway/Main.createPayload) stores every call it makes to a PSP:
 *   transaction call → `paymentInfo`, refund call → `cancelInfo`,
 *   everything else → `allOtherRequest`; PSP answers → `response`.
 * All of them are passed through `maskJsonObject(keysToMask)` (default keys
 * cvv, number, expiry_month, expiry_year, card_exp_*, card_cvv, card_number;
 * masked value "***"), so card data, and per bank config e-mail / phone, must
 * never be readable there.
 *
 * Checks never put the sensitive VALUES in their output – only where they were found.
 */
import type { BankTransaction, MerchantWebhook, PspWebhook } from '../schemas/backoffice.schema';
import * as maskingCatalog from '../../config/masking-rules';
import * as bankProfiles from '../../config/bank-profiles';
import type { CashierCard } from '../types/cashier.types';
import { KNOWN_CARD_METHODS } from './card-methods';

export interface ComplianceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface ComplianceResult {
  readonly checks: ComplianceCheck[];
  readonly notes: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Leaf {
  /** e.g. `paymentInfo.card.cardExpiry.month` */
  readonly path: string;
  readonly key: string;
  readonly parent: string;
  readonly value: string;
}

/** Parts of the bank record that hold PSP requests / responses. */
export const PSP_RECORD_PARTS = [
  'paymentInfo',
  'cancelInfo',
  'allOtherRequest',
  'response',
  'response3ds',
  'allOtherRequest3ds',
  'beforeCasCading',
  'previousRetry',
] as const;

/** `a=1&b=2` (URL-encoded form, as many PSPs post) → { a: '1', b: '2' }. */
function parseFormString(text: string): Json | undefined {
  if (/\s/.test(text) || !/^[^=&]+=[^&]*(&[^=&]+=[^&]*)+$/.test(text)) return undefined;
  const out: Json = {};
  try {
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  } catch {
    return undefined;
  }
  return Object.keys(out).length > 1 ? out : undefined;
}

/** `<a><cvv>123</cvv></a>` (XML / SOAP) → leaf elements and attributes as keys. */
function parseXmlString(text: string): Json | undefined {
  if (!text.startsWith('<') || !text.endsWith('>')) return undefined;
  const out: Json = {};
  let n = 0;
  const put = (key: string, value: string): void => {
    const name = key.replace(/^[\w.-]+:/, ''); // drop namespace prefix
    const k = name in out ? `${name}[${String(n++)}]` : name;
    out[k] = value;
  };
  for (const m of text.matchAll(/<([\w:.-]+)(\s[^>]*)?>([^<]*)<\/\1>/g)) {
    if (m[1] !== undefined && m[3] !== undefined && m[3].trim() !== '') put(m[1], m[3].trim());
  }
  for (const m of text.matchAll(/\s([\w:.-]+)="([^"]*)"/g)) {
    if (m[1] !== undefined && m[2] !== undefined && !m[1].startsWith('xmlns')) put(m[1], m[2]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A string value that holds a whole payload (JSON, form-encoded or XML) → parsed object. */
export function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  return parseFormString(trimmed) ?? parseXmlString(trimmed);
}

function collectLeaves(
  value: unknown,
  path: string,
  key: string,
  parent: string,
  out: Leaf[],
  depth = 0,
): void {
  if (depth > 12 || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      collectLeaves(item, `${path}[${String(i)}]`, key, parent, out, depth + 1);
    });
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value))
      collectLeaves(v, `${path}.${k}`, k, key, out, depth + 1);
    return;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const nested = typeof value === 'string' ? parseJsonString(text) : undefined;
  if (nested !== undefined) {
    collectLeaves(nested, path, key, parent, out, depth + 1);
    return;
  }
  out.push({ path, key, parent, value: text });
}

/** Every primitive value of the PSP request/response parts of the bank record. */
export function pspLeaves(
  bank: BankTransaction,
  parts: readonly string[] = PSP_RECORD_PARTS,
): Leaf[] {
  const out: Leaf[] = [];
  const record = bank as Json;
  for (const part of parts) collectLeaves(record[part], part, part, '', out);
  return out;
}

const norm = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');
/** Merchant / facilitator data is not customer data. */
const MERCHANT_BLOCK = /merchant|facilitator|provider|beneficiary/i;
/** Leaf inside a merchant / facilitator object, or a merchant* key (not `merchantRefNum`). */
const isMerchantLeaf = (l: Leaf): boolean =>
  MERCHANT_BLOCK.test(l.path.replace(/\.[^.]*$/, '')) ||
  /^merchant(e?mail|phone|name|address)/i.test(l.key);

export function looksMasked(value: string): boolean {
  return value.trim() === '' || value.includes('*') || /x{4,}/i.test(value) || /#{3,}/.test(value);
}

const digits = (value: string): string => value.replace(/\D/g, '');

interface SensitiveClass {
  readonly id: 'card' | 'cvv' | 'expiry' | 'email' | 'phone';
  readonly label: string;
  /** Is this leaf a value of this class (by key name and value shape)? */
  readonly matches: (leaf: Leaf) => boolean;
  /** Only the customer's data counts (merchant e-mail / phone are not PII). */
  readonly customerOnly?: boolean;
}

const CARD_KEYS = new Set([
  'cardnum',
  'cardnumber',
  'number',
  'pan',
  'accountnumber',
  'ccnumber',
  'cardno',
  'primaryaccountnumber',
]);
const CVV_KEYS = new Set([
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'cvn',
  'cardcvv',
  'securitycode',
  'cardsecuritycode',
  'cid',
]);
const EXPIRY_KEYS = new Set([
  'expirymonth',
  'expiryyear',
  'expmonth',
  'expyear',
  'cardexpmonth',
  'cardexpyear',
  'expirationmonth',
  'expirationyear',
  'expiry',
  'expirydate',
  'expirationdate',
  'cardexpiry',
  'expdate',
  'cardexpirydate',
]);

export const SENSITIVE_CLASSES: readonly SensitiveClass[] = [
  {
    id: 'card',
    label: 'Card number',
    matches: (l) =>
      CARD_KEYS.has(norm(l.key)) &&
      (looksMasked(l.value) ||
        (/^\d{12,19}$/.test(digits(l.value)) &&
          digits(l.value).length === l.value.replace(/[\s-]/g, '').length)),
  },
  {
    id: 'cvv',
    label: 'CVV',
    matches: (l) => CVV_KEYS.has(norm(l.key)),
  },
  {
    id: 'expiry',
    label: 'Card expiry',
    matches: (l) => {
      const k = norm(l.key);
      const shape = looksMasked(l.value) || /^\d{1,4}([/-]\d{2,4})?$/.test(l.value.trim());
      if (EXPIRY_KEYS.has(k)) return shape;
      // { cardExpiry: { month, year } } / { expiry: { month, year } }
      return (k === 'month' || k === 'year') && /exp/i.test(l.parent) && shape;
    },
  },
  {
    id: 'email',
    label: 'E-mail',
    customerOnly: true,
    matches: (l) =>
      norm(l.key).includes('email') && (looksMasked(l.value) || l.value.includes('@')),
  },
  {
    id: 'phone',
    label: 'Phone',
    customerOnly: true,
    matches: (l) =>
      /phone|mobile|msisdn/.test(norm(l.key)) &&
      (looksMasked(l.value) || digits(l.value).length >= 6),
  },
];

/** A masking rule (launcher → Masking rules; config/masking-rules.js). */
export interface MaskingRule {
  readonly id: string;
  readonly name: string;
  readonly scope: 'all' | 'card' | 'methods';
  readonly methods: readonly string[];
  readonly fields: readonly string[];
  readonly customKeys: readonly string[];
  readonly enabled: boolean;
}

/** Which payment the stored record belongs to – decides which rules apply. */
export interface MaskingPayment {
  readonly paymentMethod?: string | undefined;
  /** Card payment method? Default: a card was used, or the method is a known card scheme. */
  readonly isCard?: boolean | undefined;
  /** Rules to apply. Default: the predefined rule sets (config/masking-rules.js). */
  readonly rules?: readonly MaskingRule[] | undefined;
}

export const DEFAULT_MASKING_RULES = maskingCatalog.DEFAULT_RULES as readonly MaskingRule[];

/** How a leaf is recognised as a value of a masking field. */
function fieldMatcher(fieldId: string): ((leaf: Leaf) => boolean) | undefined {
  const builtIn = SENSITIVE_CLASSES.find(
    (c) =>
      c.id ===
      (
        {
          cardNumber: 'card',
          cvv: 'cvv',
          expiry: 'expiry',
          email: 'email',
          phone: 'phone',
        } as Record<string, string>
      )[fieldId],
  );
  if (builtIn !== undefined) return builtIn.matches;
  const field = maskingCatalog.FIELDS.find((f) => f.id === fieldId);
  if (field === undefined) return undefined;
  const keys = new Set(field.keys);
  const contains = field.contains ?? [];
  return (l) => {
    const k = norm(l.key);
    return keys.has(k) || contains.some((c) => k.includes(c));
  };
}

/** What the test sent – the values the masking check searches for under ANY key / format. */
export interface SentValues {
  readonly card?: Partial<Pick<CashierCard, 'number' | 'cvv' | 'expiry'>> | undefined;
  /** Purchase request (client e-mail / phone, extraParam, method fields …). */
  readonly request?: object | undefined;
}

interface FieldTarget {
  readonly label: string;
  readonly customerOnly: boolean;
  readonly matches: (l: Leaf) => boolean;
  /** Clear values the test sent for this field (searched everywhere). */
  readonly values: readonly string[];
  /** Does this leaf carry one of `values` in readable form? */
  readonly carries: (l: Leaf) => boolean;
}

const lower = (v: string): string => v.trim().toLowerCase();
const compact = (v: string): string => v.replace(/[\s-]/g, '').toLowerCase();

/** Expiry MM/YY → every common way a PSP writes it together (12/30, 1230, 12/2030, 2030-12 …). */
function expiryForms(expiry: string): string[] {
  const m = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(expiry.trim());
  if (m?.[1] === undefined || m[2] === undefined) return [];
  const mm = m[1].padStart(2, '0');
  const yy = m[2].slice(-2);
  const yyyy = m[2].length === 4 ? m[2] : `20${yy}`;
  return [
    `${mm}/${yy}`,
    `${mm}/${yyyy}`,
    `${mm}${yy}`,
    `${mm}${yyyy}`,
    `${yy}${mm}`,
    `${yyyy}-${mm}`,
    `${yyyy}${mm}`,
    `${mm}-${yy}`,
    `${mm}-${yyyy}`,
  ];
}

/** Leaves of the purchase request that a field's key matcher recognises → clear values sent. */
function requestValues(request: object | undefined, matches: (l: Leaf) => boolean): string[] {
  if (request === undefined) return [];
  const out: Leaf[] = [];
  collectLeaves(request, 'request', 'request', '', out);
  return out
    .filter(
      (l) =>
        !isMerchantLeaf(l) && matches(l) && !looksMasked(l.value) && l.value.trim().length >= 4,
    )
    .map((l) => l.value.trim());
}

/** Value-based detection per field: what counts as "this leaf shows the sent value in clear". */
const containerOf = (path: string): string => path.replace(/(\.[^.[\]]+|\[\d+\])$/, '');

function carriesFor(
  fieldId: string,
  values: readonly string[],
  all: readonly Leaf[] = [],
  pan = '',
): (l: Leaf) => boolean {
  if (values.length === 0) return () => false;
  switch (fieldId) {
    case 'cardNumber': {
      const pans = values.map(digits).filter((v) => v.length >= 12);
      return (l) => pans.some((pan) => digits(l.value).includes(pan));
    }
    case 'cvv': {
      // 3–4 digits are common: only as the whole value, and only in a card / security-code context.
      const cvvs = values.map((v) => v.trim()).filter((v) => /^\d{3,4}$/.test(v));
      // Card block = the object that holds a card number / expiry (by key or by the PAN value).
      const cardBlocks = new Set(
        all
          .filter(
            (x) =>
              CARD_KEYS.has(norm(x.key)) ||
              EXPIRY_KEYS.has(norm(x.key)) ||
              (pan.length >= 12 && digits(x.value).includes(pan)),
          )
          .map((x) => containerOf(x.path)),
      );
      return (l) =>
        cvvs.includes(l.value.trim()) &&
        !/amount|amt|total|price|currency|status|error|reason|response|result|qty|quantity|count/i.test(
          l.key,
        ) &&
        (/card|cv|csc|cid|sec|code|verif/i.test(`${l.path}.${l.parent}`) ||
          cardBlocks.has(containerOf(l.path)));
    }
    case 'expiry': {
      const forms = new Set(values.flatMap(expiryForms).map(compact));
      return (l) => forms.has(compact(l.value));
    }
    case 'email': {
      const mails = values.map(lower).filter((v) => v.includes('@'));
      return (l) => {
        const v = l.value.toLowerCase();
        return mails.some((m) => v.includes(m) || v.includes(encodeURIComponent(m).toLowerCase()));
      };
    }
    case 'phone': {
      // PGS normalises phones (+<country code>…) – compare the last 8 digits of a phone-sized number.
      const tails = values
        .map(digits)
        .filter((d) => d.length >= 8)
        .map((d) => d.slice(-8));
      return (l) => {
        const d = digits(l.value);
        return d.length >= 8 && d.length <= 16 && tails.some((t) => d.endsWith(t));
      };
    }
    default: {
      const wanted = values.map(compact).filter((v) => v.length >= 4);
      return (l) => wanted.some((w) => compact(l.value).includes(w));
    }
  }
}

/**
 * Masking rules applied to the PSP requests / responses PGS stored for a
 * transaction (paymentInfo, cancelInfo, other requests, responses, 3DS calls –
 * JSON, form-encoded and XML payloads are all read).
 *
 * A field is found two ways:
 *  - by key name (catalog synonyms + the rule's own key names) – masked or not;
 *  - by VALUE: the clear value the test actually sent (card number / CVV / expiry of
 *    the test card, e-mail / phone / bank fields of the purchase request) is searched
 *    under any key, so a PSP calling the CVV `sc` or the PAN `pan_no` is still caught.
 * Readable anywhere → the check fails with "NOT MASKED" and where it was found.
 * Neither found by key nor value known → "could not verify" (passes, with a warning).
 * Checks never contain the sensitive values – only where they were found.
 */
export function maskingChecks(
  bank: BankTransaction,
  sent?: SentValues | Pick<CashierCard, 'number'>,
  payment: MaskingPayment = {},
): ComplianceResult {
  const leaves = pspLeaves(bank);
  const checks: ComplianceCheck[] = [];
  const notes: string[] = [];
  const given: SentValues = sent !== undefined && 'number' in sent ? { card: sent } : (sent ?? {});
  const card = given.card;
  const method = (payment.paymentMethod ?? '').trim().toUpperCase();
  const isCard =
    payment.isCard ?? (card?.number !== undefined || KNOWN_CARD_METHODS.includes(method));
  const rules = maskingCatalog.applicableRules(payment.rules ?? DEFAULT_MASKING_RULES, {
    paymentMethod: method,
    isCard,
  });
  let holderRuled = false;
  const unverified: string[] = [];

  const cardValues = (id: string): string[] => {
    if (card === undefined) return [];
    if (id === 'cardNumber') return card.number ? [card.number] : [];
    if (id === 'cvv') return card.cvv ? [card.cvv] : [];
    if (id === 'expiry') return card.expiry ? [card.expiry] : [];
    return [];
  };

  for (const rule of rules) {
    const targets: FieldTarget[] = [];
    for (const id of rule.fields) {
      const matches = fieldMatcher(id);
      const field = maskingCatalog.FIELDS.find((f) => f.id === id);
      if (matches === undefined || field === undefined) continue;
      if (id === 'cardHolder') holderRuled = true;
      const values = [...new Set([...cardValues(id), ...requestValues(given.request, matches)])];
      targets.push({
        label: field.label,
        customerOnly: field.customerOnly === true,
        matches,
        values,
        carries: carriesFor(id, values, leaves, digits(card?.number ?? '')),
      });
    }
    for (const key of rule.customKeys) {
      const wanted = norm(key);
      const matches = (l: Leaf): boolean => norm(l.key) === wanted;
      const values = requestValues(given.request, matches);
      targets.push({
        label: key,
        customerOnly: false,
        matches,
        values,
        carries: carriesFor('custom', values),
      });
    }
    for (const t of targets) {
      const byKey = leaves.filter((l) => t.matches(l));
      const customer = t.customerOnly ? byKey.filter((l) => !isMerchantLeaf(l)) : byKey;
      const clearByKey = customer.filter((l) => !looksMasked(l.value)).map((l) => l.path);
      const clearByValue = leaves
        .filter((l) => !clearByKey.includes(l.path) && !looksMasked(l.value) && t.carries(l))
        .map((l) => l.path);
      const clear = [...clearByKey, ...clearByValue];
      const merchantClear = t.customerOnly
        ? byKey.filter((l) => isMerchantLeaf(l) && !looksMasked(l.value)).map((l) => l.path)
        : [];
      if (merchantClear.length > 0) {
        notes.push(
          `Merchant ${t.label.toLowerCase()} stored in clear at ${merchantClear.join(', ')}`,
        );
      }
      const masked = customer.filter((l) => looksMasked(l.value)).length;
      // Only a merchant / sub-merchant block carries the field (e.g. paymentFacilitator.subMerchant.phone)
      // and it is masked → the stored request shows it masked; nothing readable to report.
      const merchantMasked = t.customerOnly
        ? byKey.filter((l) => isMerchantLeaf(l) && looksMasked(l.value)).length
        : 0;
      let actual: string;
      if (clear.length > 0) {
        actual = `NOT MASKED – ${t.label} is readable at ${clear.join(', ')}${clearByValue.length > 0 ? ` (${clearByKey.length > 0 ? 'by key and ' : ''}found by the value the test sent)` : ''}`;
      } else if (masked > 0) {
        actual = `masked at ${String(masked)} place(s)${t.values.length > 0 ? ' · sent value not readable anywhere' : ''}`;
      } else if (t.values.length > 0) {
        actual = 'not sent to the PSP (sent value searched in every request / response)';
      } else if (merchantMasked > 0) {
        actual = `masked at ${String(merchantMasked)} place(s) (merchant / sub-merchant block) · no customer ${t.label.toLowerCase()} sent to the PSP`;
      } else {
        actual =
          'could not verify – no field with a known key name, and the value is not known to the test';
        unverified.push(t.label);
      }
      checks.push({
        name: `Masking · ${rule.name} · ${t.label}`,
        passed: clear.length === 0,
        expected: `${t.label} masked (***) in every stored PSP request / response`,
        actual,
      });
    }
  }

  if (unverified.length > 0) {
    notes.push(
      `Warning: masking could not be verified for ${[...new Set(unverified)].join(', ')} – the PSP uses no known key name and the test does not know the value; add the PSP's key name to the rule (Masking rules → Other key names)`,
    );
  }
  if (!holderRuled) {
    const holder = leaves.filter(
      (l) =>
        /^(card)?holder(name)?$|^nameoncard$|^cardholdername$/.test(norm(l.key)) &&
        !looksMasked(l.value),
    );
    if (holder.length > 0) {
      notes.push(`Cardholder name stored in clear at ${holder.map((l) => l.path).join(', ')}`);
    }
  }
  if (rules.length === 0)
    notes.push(`No masking rule applies to payment method ${method || '(unknown)'}`);
  return { checks, notes };
}

// ── purchase ↔ PSP field mapping ──────────────────────────────────────────

interface MappingRule {
  readonly label: string;
  readonly keys: ReadonlySet<string>;
  readonly expected: (request: Json) => string;
  readonly compare?: (expected: string, actual: string) => boolean;
}

const clientOf = (request: Json): Json => (isObject(request.client) ? request.client : {});
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const nameParts = (request: Json): string[] =>
  str(clientOf(request).full_name).split(/\s+/).filter(Boolean);
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export const MAPPING_RULES: readonly MappingRule[] = [
  {
    label: 'First name',
    keys: new Set(['firstname', 'fname', 'givenname']),
    expected: (r) => nameParts(r)[0] ?? '',
  },
  {
    label: 'Last name',
    keys: new Set(['lastname', 'lname', 'surname', 'familyname']),
    expected: (r) => {
      const parts = nameParts(r);
      return parts.length > 1 ? (parts.at(-1) ?? '') : '';
    },
  },
  {
    label: 'E-mail',
    keys: new Set(['email', 'emailaddress', 'customeremail']),
    expected: (r) => str(clientOf(r).email),
  },
  {
    label: 'Phone',
    keys: new Set(['phone', 'phonenumber', 'mobile', 'mobilenumber', 'cellphone']),
    expected: (r) => str(clientOf(r).phone),
    // PGS normalises phones to +<country code><digits>.
    compare: (e, a) =>
      digits(e).length > 0 &&
      (digits(a).endsWith(digits(e).slice(-8)) || digits(e).endsWith(digits(a).slice(-8))),
  },
  {
    label: 'Street',
    keys: new Set(['street', 'streetaddress', 'street1', 'address1', 'addressline1', 'line1']),
    expected: (r) => str(clientOf(r).street_address),
  },
  { label: 'City', keys: new Set(['city', 'town']), expected: (r) => str(clientOf(r).city) },
  {
    label: 'Zip code',
    keys: new Set(['zip', 'zipcode', 'postalcode', 'postcode']),
    expected: (r) => str(clientOf(r).zip_code),
  },
  {
    label: 'State',
    keys: new Set(['state', 'statecode', 'province']),
    expected: (r) => str(clientOf(r).state),
  },
  {
    label: 'Country',
    keys: new Set(['country', 'countrycode', 'billingcountry']),
    expected: (r) => str(clientOf(r).country),
  },
];

/**
 * Purchase request → PSP request (`paymentInfo`): each customer field the PSP
 * received must carry the purchase's value. Fields the PSP does not take are
 * listed as a note. Masked values cannot be compared and count as mapped.
 *
 * Note: PGS replaces values that fail the bank's Field Regex with a value from
 * its random-data pool – a mismatch on such a case is expected (see Regex validation).
 */
export function mappingChecks(
  request: Json,
  bank: BankTransaction,
  purchaseId: string,
): ComplianceResult {
  const leaves = pspLeaves(bank, requestParts(bank)).filter((l) => !isMerchantLeaf(l));
  const checks: ComplianceCheck[] = [];
  const notSent: string[] = [];

  checks.push({
    name: 'Mapping: purchase ID sent to PSP',
    passed: leaves.some((l) => l.value.includes(purchaseId)),
    expected: `a request field carries ${purchaseId}`,
    actual:
      leaves
        .filter((l) => l.value.includes(purchaseId))
        .map((l) => l.path)
        .join(', ') || 'not found',
  });

  for (const rule of MAPPING_RULES) {
    const expected = rule.expected(request);
    if (expected === '') continue;
    const found = leaves.filter((l) => rule.keys.has(norm(l.key)));
    if (found.length === 0) {
      notSent.push(rule.label.toLowerCase());
      continue;
    }
    const compare = rule.compare ?? same;
    const mismatched = found.filter((l) => !looksMasked(l.value) && !compare(expected, l.value));
    const countryCodeLength =
      rule.label === 'Country' &&
      mismatched.every((l) => l.value.trim().length !== expected.length);
    if (countryCodeLength && mismatched.length > 0) {
      notSent.push(
        `country (PSP uses a ${String(mismatched[0]?.value.trim().length)}-letter code)`,
      );
      continue;
    }
    checks.push({
      name: `Mapping: ${rule.label}`,
      passed: mismatched.length === 0,
      expected:
        rule.label === 'E-mail' || rule.label === 'Phone' ? 'purchase value (masked)' : expected,
      actual:
        mismatched.length === 0
          ? found.every((l) => looksMasked(l.value))
            ? `masked at ${found.map((l) => l.path).join(', ')}`
            : `same at ${found.map((l) => l.path).join(', ')}`
          : rule.label === 'E-mail' || rule.label === 'Phone'
            ? `different value at ${mismatched.map((l) => l.path).join(', ')}`
            : mismatched.map((l) => `${l.path}="${l.value}"`).join(', '),
    });
  }
  const notes =
    notSent.length > 0
      ? [
          `Customer fields not sent to the PSP (not in paymentInfo or allOtherRequest): ${notSent.join(', ')}`,
        ]
      : [];
  return { checks, notes };
}

// ── amount / request presence ─────────────────────────────────────────────

/** `paymentInfo` must hold the transaction request with the purchase amount (major or minor units). */
/**
 * Where PGS stored the payment request. Depending on the PSP flow it is in
 * `paymentInfo`, in `allOtherRequest` (the list of requests of the payment's
 * subsequent API calls), or in both – every non-empty one is checked.
 */
export function requestParts(bank: BankTransaction): ('paymentInfo' | 'allOtherRequest')[] {
  return (['paymentInfo', 'allOtherRequest'] as const).filter(
    (part) => pspLeaves(bank, [part]).length > 0,
  );
}

export function paymentInfoChecks(
  bank: BankTransaction,
  expectedAmount: number,
  expectedCurrency: string,
): ComplianceResult {
  const parts = requestParts(bank);
  const leaves = pspLeaves(bank, parts);
  const count = (part: string): number => pspLeaves(bank, [part]).length;
  const notes: string[] = [];
  if (!parts.includes('paymentInfo') && parts.includes('allOtherRequest')) {
    notes.push(
      'Warning: paymentInfo is missing – the payment request was taken from allOtherRequest (this PSP flow stores its API calls there)',
    );
  }
  const amounts = leaves.filter(
    (l) =>
      /^(amount|amt|totalamount|transactionamount|value)$/.test(norm(l.key)) && !isMerchantLeaf(l),
  );
  const currencies = leaves.filter((l) => /^(currency|currencycode|curr)$/.test(norm(l.key)));
  const minor = Math.round(expectedAmount * 100);
  const checks: ComplianceCheck[] = [
    {
      name: 'PSP request recorded (paymentInfo / allOtherRequest)',
      passed: parts.length > 0,
      expected: 'masked request of the payment call in paymentInfo or allOtherRequest',
      actual:
        parts.length > 0
          ? `paymentInfo: ${count('paymentInfo') > 0 ? `${String(count('paymentInfo'))} field(s)` : 'missing'} · allOtherRequest: ${count('allOtherRequest') > 0 ? `${String(count('allOtherRequest'))} field(s)` : 'empty'}`
          : 'paymentInfo and allOtherRequest both empty',
    },
  ];
  if (amounts.length > 0) {
    const ok = amounts.some((l) => {
      const n = Number(l.value);
      return Math.abs(n - expectedAmount) < 0.011 || Math.round(n) === minor;
    });
    checks.push({
      name: 'Mapping: amount in PSP request',
      passed: ok,
      expected: `${String(expectedAmount)} (or ${String(minor)} minor units)`,
      actual: amounts.map((l) => `${l.path}=${l.value}`).join(', '),
    });
  }
  if (currencies.length > 0 && expectedCurrency !== '') {
    checks.push({
      name: 'Mapping: currency in PSP request',
      passed: currencies.some((l) => same(l.value, expectedCurrency)),
      expected: expectedCurrency,
      actual: currencies.map((l) => `${l.path}=${l.value}`).join(', '),
    });
  }
  return { checks, notes };
}

/** Refund call: PGS stores the (masked) refund request in `cancelInfo`. */
export function cancelInfoChecks(
  bank: BankTransaction | undefined,
  refundAmount?: number,
): ComplianceResult {
  const leaves = bank === undefined ? [] : pspLeaves(bank, ['cancelInfo']);
  const checks: ComplianceCheck[] = [
    {
      name: 'Refund request recorded in cancelInfo',
      passed: leaves.length > 0,
      expected: 'masked request of the refund call',
      actual: leaves.length > 0 ? `${String(leaves.length)} field(s)` : 'cancelInfo empty',
    },
  ];
  if (refundAmount !== undefined && leaves.length > 0) {
    const amounts = leaves.filter((l) => /^(amount|amt|refundamount|value)$/.test(norm(l.key)));
    if (amounts.length > 0) {
      const minor = Math.round(refundAmount * 100);
      checks.push({
        name: 'Refund amount in cancelInfo',
        passed: amounts.some(
          (l) =>
            Math.abs(Number(l.value) - refundAmount) < 0.011 ||
            Math.round(Number(l.value)) === minor,
        ),
        expected: `${String(refundAmount)} (or ${String(minor)} minor units)`,
        actual: amounts.map((l) => `${l.path}=${l.value}`).join(', '),
      });
    }
  }
  return { checks, notes: [] };
}

// ── webhooks ──────────────────────────────────────────────────────────────

/** Statuses PGS sends a merchant webhook for (PurchaseService.callWebhook). */
export const WEBHOOK_STATUSES = new Set([
  'paid',
  'partial_paid',
  'over_paid',
  'error',
  'expired',
  'cancelled',
  'refunded',
  'partial_refunded',
  'refund_in_process',
  'chargeback',
  'chargeback_initiate',
  'fraud_refunded',
  'payment_in_process',
  'preauthorized',
]);

export interface WebhookExpectation {
  readonly status: string;
  /** success_callback for paid, failure_callback for error/expired; other statuses use the dashboard webhook URL. */
  readonly callbackUrl?: string | undefined;
}

export function merchantWebhookChecks(
  webhooks: readonly MerchantWebhook[],
  expectation: WebhookExpectation,
): ComplianceResult {
  const status = expectation.status.toLowerCase();
  const matching = webhooks.filter((w) => (w.transactionStatus ?? '').toLowerCase() === status);
  const checks: ComplianceCheck[] = [
    {
      name: `Merchant webhook sent (${status})`,
      passed: matching.length > 0,
      expected: `webhook with status "${status}" in Transaction log → Webhook out`,
      actual:
        matching.length > 0
          ? `${String(matching.length)} sent to ${[...new Set(matching.map((w) => w.callback_url ?? ''))].join(', ')}`
          : webhooks.length > 0
            ? `only: ${webhooks.map((w) => w.transactionStatus ?? '?').join(', ')}`
            : 'no webhook sent',
    },
  ];
  const notes: string[] = [];
  if (matching.length > 0 && expectation.callbackUrl) {
    checks.push({
      name: 'Merchant webhook URL = purchase callback',
      passed: matching.some((w) => (w.callback_url ?? '') === expectation.callbackUrl),
      expected: expectation.callbackUrl,
      actual: [...new Set(matching.map((w) => w.callback_url ?? ''))].join(', '),
    });
  }
  const failed = matching.filter((w) => (w.callStatus ?? '') !== 'Successful');
  if (failed.length > 0) {
    notes.push(
      `Merchant endpoint did not accept the "${status}" webhook: ${[...new Set(failed.map((w) => w.callStatus ?? ''))].join(', ')}` +
        ' (expected with a test callback URL that does not accept POST)',
    );
  }
  return { checks, notes };
}

/**
 * PSP → PGS webhooks (Webhook in), from Monitoring → PSP Webhook log.
 *
 * A PSP can have several webhook configs on its side (one per bank, e.g.
 * `trustpayments-card-json` and `trustpayment-json`) and then posts every event to
 * each of them. PGS consumes the one whose bank processed the purchase; the others
 * cannot find the purchase for their bank and are `zombied` – expected, shown as a note.
 *
 * - at least one consumed / Already_Consumed → passes (zombied siblings = note)
 * - received but none consumed → passes as "received" with a warning: the redirect /
 *   synchronous answer may have completed the purchase first – look at the log
 * - none received → note only (this PSP answers synchronously or sends none)
 * `loggedIn` = number of `webhook:IN` lines in the Transaction Log (when it could be read).
 */
export function pspWebhookChecks(
  webhooks: readonly PspWebhook[],
  loggedIn?: number,
): ComplianceResult {
  if (webhooks.length === 0 && (loggedIn ?? 0) === 0) {
    return {
      checks: [],
      notes: [
        'No PSP webhook (Webhook in) logged for this purchase – this PSP answers synchronously or sends none for this flow',
      ],
    };
  }
  const isConsumed = (w: PspWebhook): boolean => /^(already_)?consumed$/i.test(w.status);
  const consumed = webhooks.filter(isConsumed);
  const others = webhooks.filter((w) => !isConsumed(w));
  const list = (ws: readonly PspWebhook[]): string =>
    ws.map((w) => `${w.pspName}: ${w.status}`).join(', ');
  const notes: string[] = [];
  if (consumed.length > 0 && others.length > 0) {
    notes.push(
      `Other PSP webhook config(s) zombied – expected: the PSP posts to every webhook it has for PGS and only the bank of this purchase (${[...new Set(consumed.map((w) => w.pspName))].join(', ')}) can match it (${list(others)})`,
    );
  } else if (consumed.length === 0 && others.length > 0) {
    notes.push(
      `Warning: no PSP webhook was consumed (${list(others)}) – if the redirect / synchronous answer completed the purchase this is fine; otherwise the webhook config of this bank did not match the purchase`,
    );
  }
  return {
    checks: [
      {
        name: 'PSP webhook received (Webhook in)',
        passed: true,
        expected: 'webhook in logged for the purchase',
        actual: [
          loggedIn ? `${String(loggedIn)}× webhook:IN in Transaction Log` : '',
          webhooks.length ? `PSP webhook log: ${list(webhooks)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      },
      ...(webhooks.length > 0
        ? [
            {
              name: 'PSP webhook consumed by the matching bank config',
              passed: true,
              expected: 'one webhook consumed / already consumed; other configs may be zombied',
              actual: consumed.length > 0 ? list(consumed) : `none consumed (${list(others)})`,
            },
          ]
        : []),
    ],
    notes,
  };
}

// ── bank profile: mandatory field mapping (launcher → Bank profiles) ─────────────

export type BankProfile = ReturnType<typeof bankProfiles.readProfiles>[number];
export type BankMappingRow = BankProfile['mapping'][number];

/** Profile of the transaction's bank / payment method (config/bank-profiles.json). */
export function bankProfileFor(bankName: string, method: string): BankProfile | undefined {
  try {
    return bankProfiles.profileFor(bankName, method);
  } catch {
    return undefined;
  }
}

/** a.b[0].c → a.b.c, lower case – PSP paths are compared without array indexes. */
const plainPath = (p: string): string => p.replace(/\[\d+\]/g, '').toLowerCase();

/** PSP leaves of the request parts whose path (without "paymentInfo." / index) ends with `psp`. */
function pspValues(leaves: readonly Leaf[], psp: string): Leaf[] {
  const want = plainPath(psp).replace(/^\.+/, '');
  return leaves.filter((l) => {
    const inner = plainPath(l.path).replace(
      /^(paymentinfo|allotherrequest|allotherrequest3ds)\.?/,
      '',
    );
    return inner === want || inner.endsWith(`.${want}`);
  });
}

/** Value of a dot path (a.b[0].c) in our purchase request. */
function ourValue(request: unknown, dotted: string): string | undefined {
  let cur: unknown = request;
  for (const part of dotted.split('.').filter(Boolean)) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
    if (m === null || !isObject(cur)) return undefined;
    cur = cur[m[1] ?? ''];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return undefined;
}

/** Short, masked display of a value for the report (never a full e-mail / phone / card). */
function shown(value: string): string {
  const v = value.trim();
  if (v.includes('@')) return `${v.slice(0, 2)}***@${v.split('@')[1] ?? ''}`;
  if (/^\+?[\d\s-]{7,}$/.test(v)) return `***${v.replace(/\D/g, '').slice(-3)}`;
  return v.length > 40 ? `${v.slice(0, 37)}…` : v;
}

const sameValue = (a: string, b: string): boolean => {
  const x = a.trim();
  const y = b.trim();
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const nx = Number(x);
  const ny = Number(y);
  return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
};

/**
 * Compares each mapped field of the bank profile with the request PGS sent to the PSP
 * (paymentInfo / allOtherRequest): mismatch or missing mandatory field → failed check.
 */
export function profileMappingChecks(
  bank: BankTransaction,
  request: Json | undefined,
  profile: BankProfile,
  purchaseId: string,
): ComplianceResult {
  const leaves = pspLeaves(bank, requestParts(bank));
  const checks: ComplianceCheck[] = [];
  const notes: string[] = [];
  for (const row of profile.mapping) {
    const found = pspValues(leaves, row.psp);
    const sent = found.find((l) => l.value.trim() !== '');
    const label = row.ours ? `${row.ours} → ${row.psp}` : row.psp;
    const name = `Mapping · ${label}`;
    const expected = {
      equals: `${row.psp} = our ${row.ours || '(field)'}`,
      'minor-units': `${row.psp} = our ${row.ours || 'amount'} × 100`,
      'purchase-id': `${row.psp} = purchase ID`,
      present: `${row.psp} sent`,
      masked: `${row.psp} sent and masked`,
    }[row.check];
    if (sent === undefined) {
      checks.push({
        name,
        passed: !row.mandatory,
        expected: `${expected}${row.mandatory ? ' (mandatory)' : ' (optional)'}`,
        actual: row.mandatory
          ? `MISSING – mandatory field ${row.psp} is not in the PSP request`
          : 'not sent (optional)',
      });
      continue;
    }
    const where = sent.path;
    let passed = true;
    let actual = `match at ${where}`;
    if (row.check === 'present') actual = `sent at ${where}`;
    else if (row.check === 'masked') {
      passed = looksMasked(sent.value);
      actual = passed ? `masked at ${where}` : `NOT MASKED at ${where}`;
    } else if (row.check === 'purchase-id') {
      passed = sent.value.trim() === purchaseId;
      if (!passed)
        actual = `MISMATCH – PSP got "${shown(sent.value)}", purchase ID is ${purchaseId}`;
    } else {
      const ours = row.ours ? ourValue(request, row.ours) : undefined;
      if (ours === undefined) {
        actual = `sent at ${where} · our ${row.ours || 'field'} not in the purchase request – not compared`;
      } else {
        const want = row.check === 'minor-units' ? String(Math.round(Number(ours) * 100)) : ours;
        passed = looksMasked(sent.value) ? true : sameValue(want, sent.value);
        actual = looksMasked(sent.value)
          ? `sent masked at ${where} – value not compared`
          : passed
            ? `match at ${where}`
            : `MISMATCH – we sent "${shown(want)}", PSP got "${shown(sent.value)}" (${where})`;
      }
    }
    checks.push({ name, passed, expected, actual });
  }
  if (profile.mapping.length === 0) {
    notes.push(`Bank profile "${profile.bank}" has no field mapping yet – add it on Bank profiles`);
  }
  return { checks, notes };
}

// ── service config: COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS (all PSPs, every method) ─────────

/**
 * Every field whose name is in the service config list (exact, case-sensitive – as PGS matches)
 * must be stored masked (***) in the PSP requests / responses. One check per listed name that
 * the record contains; none present → one passed check saying so.
 */
export function serviceConfigMaskingChecks(
  bank: BankTransaction,
  keys: readonly string[],
  configName = 'COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS',
): ComplianceResult {
  const wanted = new Set(keys);
  const byKey = new Map<string, Leaf[]>();
  for (const leaf of pspLeaves(bank)) {
    if (!wanted.has(leaf.key)) continue;
    byKey.set(leaf.key, [...(byKey.get(leaf.key) ?? []), leaf]);
  }
  const checks: ComplianceCheck[] = [];
  for (const [key, leaves] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const clear = leaves.filter((l) => !looksMasked(l.value)).map((l) => l.path);
    checks.push({
      name: `Masking · Service config · ${key}`,
      passed: clear.length === 0,
      expected: `${key} masked (***) – listed in ${configName}`,
      actual:
        clear.length > 0
          ? `NOT MASKED – ${key} is readable at ${clear.join(', ')}`
          : `masked at ${String(leaves.length)} place(s)`,
    });
  }
  if (checks.length === 0) {
    checks.push({
      name: 'Masking · Service config · listed keys',
      passed: true,
      expected: `fields named in ${configName} masked`,
      actual: `none of the ${String(wanted.size)} listed names is in this PSP's requests / responses`,
    });
  }
  return { checks, notes: [] };
}
