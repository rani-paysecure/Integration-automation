// @ts-check
/**
 * Masking rules – which sensitive values must never be readable in the PSP
 * requests / responses PGS stores for a transaction (dashboard bank record:
 * paymentInfo, cancelInfo, other requests, responses, 3DS calls …).
 *
 * FIELDS is the catalog the launcher offers ("Masking rules" page); a rule picks
 * fields from it (and may add its own key names) and says where it applies:
 *   all      – every payment
 *   card     – card payment methods
 *   methods  – the listed payment methods (APMs, e.g. bank transfer)
 *
 * Shared by config/settings-core.js (schema), the test framework
 * (src/helpers/psp-compliance.ts) and the launcher.
 */
'use strict';

/**
 * @typedef {{ id: string, label: string, group: string, hint: string, keys: string[],
 *   contains?: string[], customerOnly?: boolean }} MaskingField
 */

/** @type {MaskingField[]} */
const FIELDS = [
  {
    id: 'email',
    label: 'E-mail',
    group: 'Customer contact',
    hint: 'email, customerEmail …',
    keys: [],
    contains: ['email'],
    customerOnly: true,
  },
  {
    id: 'phone',
    label: 'Phone number',
    group: 'Customer contact',
    hint: 'phone, mobile, msisdn …',
    keys: [],
    contains: ['phone', 'mobile', 'msisdn'],
    customerOnly: true,
  },
  {
    id: 'cardNumber',
    label: 'Card number',
    group: 'Card',
    hint: 'number, cardNumber, pan … and the test card number anywhere',
    keys: [
      'cardnum',
      'cardnumber',
      'number',
      'pan',
      'accountnumber',
      'ccnumber',
      'cardno',
      'primaryaccountnumber',
    ],
  },
  {
    id: 'cvv',
    label: 'CVV',
    group: 'Card',
    hint: 'cvv, cvc, securityCode …',
    keys: [
      'cvv',
      'cvv2',
      'cvc',
      'cvc2',
      'cvn',
      'cardcvv',
      'securitycode',
      'cardsecuritycode',
      'cid',
    ],
  },
  {
    id: 'expiry',
    label: 'Expiry date',
    group: 'Card',
    hint: 'expiry_month / _year, cardExpiry.month …',
    keys: [
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
    ],
  },
  {
    id: 'cardHolder',
    label: 'Cardholder name',
    group: 'Card',
    hint: 'holderName, cardholderName, nameOnCard …',
    keys: ['holder', 'holdername', 'cardholder', 'cardholdername', 'nameoncard'],
  },
  {
    id: 'accountNumber',
    label: 'Bank account number',
    group: 'Bank',
    hint: 'accountNumber, bankAccount, acctNo …',
    keys: [
      'accountnumber',
      'accountno',
      'accountnum',
      'bankaccount',
      'bankaccountnumber',
      'acctnumber',
      'acctno',
      'customeraccount',
      'payeraccount',
    ],
    customerOnly: true,
  },
  {
    id: 'iban',
    label: 'IBAN',
    group: 'Bank',
    hint: 'iban, bankIban …',
    keys: ['iban', 'bankiban', 'customeriban', 'payeriban'],
    customerOnly: true,
  },
  {
    id: 'routingNumber',
    label: 'Routing number / sort code',
    group: 'Bank',
    hint: 'routingNumber, sortCode, bsb, ifsc …',
    keys: [
      'routingnumber',
      'sortcode',
      'bsb',
      'aba',
      'abanumber',
      'transitnumber',
      'ifsc',
      'ifsccode',
      'branchcode',
    ],
    customerOnly: true,
  },
  {
    id: 'dateOfBirth',
    label: 'Date of birth',
    group: 'Identity',
    hint: 'date_of_birth, dob, birthDate …',
    keys: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
    customerOnly: true,
  },
  {
    id: 'nationalId',
    label: 'National ID / document number',
    group: 'Identity',
    hint: 'documentNumber, nationalId, cpf, ssn, passport …',
    keys: [
      'nationalid',
      'documentnumber',
      'documentid',
      'idnumber',
      'ssn',
      'cpf',
      'taxid',
      'passport',
      'passportnumber',
    ],
    customerOnly: true,
  },
];

const FIELD_IDS = /** @type {[string, ...string[]]} */ (FIELDS.map((f) => f.id));

/**
 * @typedef {{ id: string, name: string, description: string, scope: 'all' | 'card' | 'methods',
 *   methods: string[], fields: string[], customKeys: string[], enabled: boolean }} MaskingRuleSetting
 */

/** Predefined rule sets – the team default (config/defaults.json holds the same). @type {MaskingRuleSetting[]} */
const DEFAULT_RULES = [
  {
    id: 'general',
    name: 'General – customer contact data',
    description:
      'Every payment: the customer’s e-mail and phone must be masked in every PSP request and response.',
    scope: 'all',
    methods: [],
    fields: ['email', 'phone'],
    customKeys: [],
    enabled: true,
  },
  {
    id: 'card-payments',
    name: 'Card payments – card details',
    description: 'Card payment methods: card number, CVV and expiry date must be masked.',
    scope: 'card',
    methods: [],
    fields: ['cardNumber', 'cvv', 'expiry'],
    customKeys: [],
    enabled: true,
  },
  {
    id: 'bank-transfer',
    name: 'Bank transfer – bank details',
    description: 'Bank-transfer APMs: account number, IBAN and routing / sort code must be masked.',
    scope: 'methods',
    methods: ['BANKTRANSFER'],
    fields: ['accountNumber', 'iban', 'routingNumber'],
    customKeys: [],
    enabled: true,
  },
];

/** Normalised key name: lower case, no "-", "_" or spaces. @param {string} key */
const normKey = (key) =>
  String(key)
    .toLowerCase()
    .replace(/[-_\s]/g, '');

/**
 * Rules that apply to a payment.
 * @template {{ scope: string, methods: readonly string[], enabled: boolean }} T
 * @param {readonly T[]} rules
 * @param {{ paymentMethod?: string, isCard?: boolean }} payment
 * @returns {T[]}
 */
function applicableRules(rules, payment) {
  const method = String(payment.paymentMethod || '')
    .trim()
    .toUpperCase();
  return rules.filter(
    (r) =>
      r.enabled &&
      (r.scope === 'all' ||
        (r.scope === 'card' && payment.isCard === true) ||
        (r.scope === 'methods' &&
          method !== '' &&
          r.methods.some((m) => m.trim().toUpperCase() === method))),
  );
}

module.exports = { FIELDS, FIELD_IDS, DEFAULT_RULES, normKey, applicableRules };
