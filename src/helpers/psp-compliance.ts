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
import type { CashierCard } from '../types/cashier.types';

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

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
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

/**
 * Card number, CVV, expiry, e-mail and phone must be masked in every stored
 * PSP request/response. Additionally the test card's full number must not
 * appear anywhere in clear (whatever the key).
 */
export function maskingChecks(
  bank: BankTransaction,
  card?: Pick<CashierCard, 'number'>,
): ComplianceResult {
  const leaves = pspLeaves(bank);
  const checks: ComplianceCheck[] = [];
  const notes: string[] = [];
  const pan = card === undefined ? '' : digits(card.number);

  for (const cls of SENSITIVE_CLASSES) {
    const found = leaves.filter((l) => cls.matches(l));
    const customer = cls.customerOnly ? found.filter((l) => !isMerchantLeaf(l)) : found;
    const clear = customer.filter((l) => !looksMasked(l.value)).map((l) => l.path);
    if (cls.id === 'card' && pan.length >= 12) {
      for (const l of leaves) {
        if (digits(l.value).includes(pan) && !clear.includes(l.path)) clear.push(l.path);
      }
    }
    const merchantClear = cls.customerOnly
      ? found.filter((l) => isMerchantLeaf(l) && !looksMasked(l.value)).map((l) => l.path)
      : [];
    if (merchantClear.length > 0) {
      notes.push(
        `Merchant ${cls.label.toLowerCase()} stored in clear at ${merchantClear.join(', ')}`,
      );
    }
    checks.push({
      name: `${cls.label} masked in PSP logs`,
      passed: clear.length === 0,
      expected: 'masked (***) in paymentInfo / cancelInfo / other requests / responses',
      actual:
        clear.length > 0
          ? `IN CLEAR at ${clear.join(', ')}`
          : customer.length > 0
            ? `masked at ${String(customer.length)} place(s)`
            : 'not sent to the PSP',
    });
  }

  const holder = leaves.filter(
    (l) =>
      /^(card)?holder(name)?$|^nameoncard$|^cardholdername$/.test(norm(l.key)) &&
      !looksMasked(l.value),
  );
  if (holder.length > 0) {
    notes.push(`Cardholder name stored in clear at ${holder.map((l) => l.path).join(', ')}`);
  }
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
  const leaves = pspLeaves(bank, ['paymentInfo']).filter((l) => !isMerchantLeaf(l));
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
  const notes = notSent.length > 0 ? [`Not in the PSP request: ${notSent.join(', ')}`] : [];
  return { checks, notes };
}

// ── amount / request presence ─────────────────────────────────────────────

/** `paymentInfo` must hold the transaction request with the purchase amount (major or minor units). */
export function paymentInfoChecks(
  bank: BankTransaction,
  expectedAmount: number,
  expectedCurrency: string,
): ComplianceResult {
  const leaves = pspLeaves(bank, ['paymentInfo']);
  const amounts = leaves.filter(
    (l) =>
      /^(amount|amt|totalamount|transactionamount|value)$/.test(norm(l.key)) &&
      !isMerchantLeaf(l),
  );
  const currencies = leaves.filter((l) => /^(currency|currencycode|curr)$/.test(norm(l.key)));
  const minor = Math.round(expectedAmount * 100);
  const checks: ComplianceCheck[] = [
    {
      name: 'paymentInfo filled (transaction request)',
      passed: leaves.length > 0,
      expected: 'masked request of the payment call',
      actual: leaves.length > 0 ? `${String(leaves.length)} field(s)` : 'empty',
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
  return { checks, notes: [] };
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

/** PSP → PGS webhooks: when the PSP sent any, PGS must have consumed them. */
export function pspWebhookChecks(webhooks: readonly PspWebhook[]): ComplianceResult {
  if (webhooks.length === 0) {
    return {
      checks: [],
      notes: [
        'No PSP webhook (Webhook in) logged for this purchase – this PSP answers synchronously or sends none for this flow',
      ],
    };
  }
  const bad = webhooks.filter((w) => !/^(already_)?consumed$/i.test(w.status));
  return {
    checks: [
      {
        name: 'PSP webhook received and consumed',
        passed: bad.length === 0,
        expected: 'status consumed / Already_Consumed',
        actual: webhooks.map((w) => `${w.pspName}: ${w.status}`).join(', '),
      },
    ],
    notes: [],
  };
}
