// @ts-check
/**
 * Field validation cases (FV-xxx) for a payment method's own parameters, built from the
 * dashboard's payment-method configuration (GET /admin/getAllPaymentMethods):
 *
 *   mandatoryParams        top-level / customer fields the method needs (client.full_name …)
 *   extraMandatoryParams   extraParam keys – group 1
 *   extraMandatoryParams2  extraParam keys – group 2 (alternative to group 1)
 *
 * Nothing is hardcoded per payment method: keys come from the live configuration.
 * PGS first uses a per-country override (PaymentMethodCountryExtraMandatoryParam, the
 * customer's country) when one exists – the global keys here may then differ for that country.
 * Expectations follow PGS (docs/pgs-behaviour.md § 1): the create call stores extraParam
 * as sent and does not reject missing / empty keys (the cashier asks for missing ones);
 * extraParam that is not an object → 400 invalid_json; for methods without user input,
 * keys from BOTH groups → 400 "Only one is allowed, Extra Mandatory Param group 1 or group 2".
 */
'use strict';

const list = (v) =>
  String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Dashboard row → what the tests need (no other fields leave the dashboard module). */
function toMethod(row) {
  return {
    name: String(row.name || '').trim(),
    isCard: String(row.is_Card) === '1',
    userInputRequired: String(row.user_input_required) === '1',
    mandatory: list(row.mandatoryParams),
    group1: list(row.extraMandatoryParams).filter((k) => /^[\w-]+$/.test(k)),
    group2: list(row.extraMandatoryParams2).filter((k) => /^[\w-]+$/.test(k)),
  };
}

/** Neutral test value for a key – the key name is never interpreted. */
const sample = (key) => `QA-${key}-001`;
const obj = (keys) => Object.fromEntries(keys.map((k) => [k, sample(k)]));

/** Customer / top-level fields PGS checks for mandatoryParams (PurchaseService.validateParameter). */
const CLIENT_PARAMS = new Set([
  'phone',
  'full_name',
  'tax_number',
  'bankAccountNumber',
  'customerId',
  'date_of_birth',
  'personal_code',
  'registration_number',
  'documentId',
  'documentType',
  'bankAccountCurrency',
  'bankAccountName',
  'bankCountryCode',
  'bankName',
  'swiftCode',
  'client_type',
  'bankAccount',
  'bankCode',
  'description',
  'gender',
  'avatarUrl',
  'stateCode',
  'email',
  'country',
  'city',
  'zip_code',
  'street_address',
]);

/**
 * Sheet rows (field-validation template columns) for one payment method. They go through
 * the same parser / duplicate check as an upload.
 */
function rowsForMethod(method) {
  const m = method.name;
  const ctx = (extra = '') => [`paymentMethod=${m}`, extra].filter(Boolean).join('; ');
  const rows = [];
  const add = (parameter, title, data, expected, expectation, context = ctx()) =>
    rows.push({ parameter, title: `${m}: ${title}`, data, expected, expectation, context });
  /** Context with the other keys of the group set, so only one key changes. */
  const others = (group, key) =>
    ctx(
      group
        .filter((k) => k !== key)
        .map((k) => `extraParam.${k}="${sample(k)}"`)
        .join('; '),
    );
  const noInput = !method.isCard && !method.userInputRequired;

  for (const [label, group] of [
    ['group 1', method.group1],
    ['group 2', method.group2],
  ]) {
    if (group.length === 0) continue;
    add(
      'extraParam',
      `all ${label} parameters (${group.join(', ')})`,
      JSON.stringify(obj(group)),
      'Accepted – extraParam stored as sent',
      'accepted',
    );
    for (const key of group) {
      add(
        `extraParam.${key}`,
        `${key} missing (${label})`,
        'Field not sent',
        'Accepted – PGS does not reject at create; the cashier asks for the missing parameter',
        'accepted',
        others(group, key),
      );
      add(
        `extraParam.${key}`,
        `${key} empty (${label})`,
        '""',
        'Accepted – an empty value counts as present',
        'accepted',
        others(group, key),
      );
      add(
        `extraParam.${key}`,
        `${key} null (${label})`,
        'null',
        'Accepted – stored as null; the cashier asks for it (confirmed on test4)',
        'accepted',
        others(group, key),
      );
      add(
        `extraParam.${key}`,
        `${key} as a number (${label})`,
        '12345 (no quotes)',
        'Accepted – stored as a number (format is checked by the PSP, not PGS)',
        'accepted',
        others(group, key),
      );
      add(
        `extraParam.${key}`,
        `${key} as an object (${label})`,
        '{"value":"x"}',
        'Accepted or rejected – wrong type for a parameter',
        'observe',
        others(group, key),
      );
      add(
        `extraParam.${key}`,
        `${key} 256 characters (${label})`,
        '256 characters',
        'Accepted – no length limit at create (confirmed on test4); the PSP may limit it later',
        'accepted',
        others(group, key),
      );
    }
  }
  if (method.group1.length && method.group2.length) {
    add(
      'extraParam',
      'parameters of BOTH groups',
      JSON.stringify({ ...obj(method.group1), ...obj(method.group2) }),
      noInput
        ? 'Validation error – "Only one is allowed, Extra Mandatory Param group 1 or group 2"'
        : 'Accepted – the both-groups rule only applies to methods without user input',
      noInput ? 'rejected' : 'observe',
    );
  }
  for (const param of method.mandatory) {
    if (!CLIENT_PARAMS.has(param)) continue; // e.g. "upi" – not checked by PGS validateParameter
    add(
      `client.${param}`,
      `required ${param} missing`,
      'Field not sent',
      'Accepted or rejected – the cashier asks for required customer data',
      'observe',
    );
  }
  add(
    'extraParam.qaNotRequired',
    'parameter the method does not need',
    '"QA-extra"',
    'Accepted – unknown keys are stored and ignored',
    'accepted',
  );
  add('extraParam', 'empty extraParam object', '{}', 'Accepted', 'accepted');
  add(
    'extraParam',
    'extraParam as text instead of an object',
    '"iban=QA"',
    'Validation error – 400 invalid_json',
    'rejected',
  );
  add(
    'extraParam',
    'extraParam as a list',
    '["QA"]',
    'Validation error – 400 invalid_json',
    'rejected',
  );
  return rows;
}

/** Short description of a method's parameters for the AI context. */
function describeMethods(methods) {
  return methods
    .filter((m) => m.mandatory.length || m.group1.length || m.group2.length)
    .map(
      (m) =>
        `- ${m.name}${m.isCard ? ' (card)' : ''}${m.userInputRequired ? '' : ' (no user input)'}: ` +
        [
          m.mandatory.length ? `required ${m.mandatory.join(', ')}` : '',
          m.group1.length ? `extraParam group 1: ${m.group1.join(', ')}` : '',
          m.group2.length ? `extraParam group 2: ${m.group2.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
    );
}

module.exports = { toMethod, rowsForMethod, describeMethods, sample };
