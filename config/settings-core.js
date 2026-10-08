// @ts-check
/**
 * Settings schema + merge logic shared by the framework (config/settings.ts)
 * and the launcher UI server (tools/launcher/server.js). Plain CommonJS so the
 * launcher can use it without a TypeScript build.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const masking = require('./masking-rules');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS_FILE = path.join(__dirname, 'defaults.json');
/** LAUNCHER_DATA_DIR (server deployment) keeps the local files outside the code folder. */
const DATA_DIR = process.env.LAUNCHER_DATA_DIR ? path.resolve(process.env.LAUNCHER_DATA_DIR) : ROOT;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.local.json');

const OUTCOMES = /** @type {const} */ ([
  'success-redirect',
  'failure-redirect',
  'pending-redirect',
  'rejected',
  'other-page',
  'timeout',
]);

/** Host labels that indicate a live / production system. */
const BLOCKED_HOST_LABELS = new Set(['prod', 'production', 'prd', 'live']);

const safeUrl = z.url({ protocol: /^https?$/ }).refine(
  (url) =>
    !new URL(url).hostname
      .toLowerCase()
      .split(/[.-]/)
      .some((l) => BLOCKED_HOST_LABELS.has(l)),
  'production hosts are not allowed',
);
const urlOrEmpty = z.union([z.literal(''), safeUrl]);

const cardSettingSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id: lowercase letters, digits, "-"'),
  label: z.string().trim().min(1),
  number: z.string().regex(/^\d{12,19}$/, 'card number must be 12–19 digits'),
  expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'expiry must be MM/YY'),
  cvv: z.string().regex(/^\d{3,4}$/, 'CVV must be 3–4 digits'),
  holderName: z.string().trim().min(1),
  expectedOutcome: z.enum(OUTCOMES),
  expectedStatuses: z.array(z.string().trim().min(1)).min(1),
  enabled: z.boolean(),
  /**
   * What to do when the bank shows a 3DS challenge page (OTP / password):
   *   none   – nothing (frictionless card; a challenge ends the test as "other page")
   *   otp    – type `otp` (empty = read the "(OTP: 1234)" hint of test pages) and press `submit`
   *   manual – wait for the tester to complete it in the visible browser
   */
  challenge: z
    .object({
      action: z.enum(['none', 'otp', 'manual', 'flow']),
      otp: z.string().trim().max(40).default(''),
      submit: z.string().trim().max(40).default(''),
      /** action "flow": the bank's 3DS flow (3DS flows page) and which of its scenarios this card runs. */
      flowId: z.string().trim().max(48).default(''),
      scenarioId: z.string().trim().max(48).default(''),
    })
    .default({ action: 'none', otp: '', submit: '', flowId: '', scenarioId: '' }),
});

const purchaseTemplateSchema = z.object({
  client: z.object({
    email: z.string(),
    country: z.string(),
    city: z.string(),
    stateCode: z.string(),
    street_address: z.string(),
    zip_code: z.string(),
    date_of_birth: z.string(),
    phone: z.string(),
    full_name: z.string(),
  }),
  purchase: z.object({
    currency: z.string(),
    products: z.array(z.object({ name: z.string(), price: z.number() })).min(1),
    total: z.number(),
  }),
  success_redirect: z.string(),
  pending_redirect: z.string(),
  failure_redirect: z.string(),
  success_callback: z.string(),
  failure_callback: z.string(),
  /** Optional extraParam sent with every purchase (keys depend on the payment method). */
  extraParam: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional request fields per payment method, merged when the run (or a case) uses that
   * method – e.g. { "UPI": { "upiId": "pending@testbank", "extraParam": { "vpa": "…" } } }.
   * Keys are free-form: nothing is hardcoded per payment method.
   */
  methodFields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/**
 * Baseline S2S request (POST /api/v1/p/{purchaseId}/?s2s=true) – everything except the card,
 * which comes from the Test cards tab. browserData "device" = user agent and screen of the
 * device chosen on the Run tab; "custom" = the values below.
 */
const s2sTemplateSchema = z.object({
  browserData: z.enum(['device', 'custom']),
  remote_ip: z.string().trim().min(1),
  remember_card: z.enum(['on', 'off']),
  user_agent: z.string(),
  accept_header: z.string(),
  language: z.string(),
  java_enabled: z.enum(['true', 'false']),
  javascript_enabled: z.boolean(),
  color_depth: z.number().int(),
  utc_offset: z.number().int(),
  screen_width: z.number().int(),
  screen_height: z.number().int(),
  /** Further fields sent with every S2S request (e.g. deviceId) – free-form. */
  extraFields: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Baseline session payment: create-customer body (`{{unique}}` in merchantCustomerId = generated unique on every
 * run; other tokens: {{uuid}} {{timestamp}} {{date}} {{random}}) and create-session body (customerId is filled in; redirects/callbacks default to the Purchase
 * data tab). Keys are free-form – whatever the APIs accept.
 */
const sessionTemplateSchema = z.object({
  /** new = create customer first, then the session; existing = create the session for `existingCustomerId`. */
  mode: z.enum(['new', 'existing']).default('new'),
  existingCustomerId: z.string().default(''),
  customer: z.record(z.string(), z.unknown()),
  session: z.record(z.string(), z.unknown()),
});

const endpointsSchema = z.object({ baseUrl: urlOrEmpty, apiBaseUrl: urlOrEmpty });

/** A named, saved version of a baseline template (launcher → S2S data / Session data). */
const libraryOf = (/** @type {z.ZodTypeAny} */ template) =>
  z
    .object({
      activeId: z.string().default(''),
      items: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
            name: z.string().trim().min(1).max(80),
            type: z.string().trim().min(1).max(40),
            description: z.string().max(300).default(''),
            updatedAt: z.string().default(''),
            template,
          }),
        )
        .max(50)
        .default([]),
    })
    .default({ activeId: '', items: [] });

/**
 * 3DS flows (launcher → 3DS flows): per bank / PSP, what its 3DS page asks for and the
 * steps of each test scenario. Cards link to a scenario (card challenge action "flow").
 */
const flowSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'id: lowercase letters, digits, "-"');
const THREE_DS_ACTIONS = /** @type {const} */ ([
  'waitText', // wait until this text is on the 3DS page (identifies the page / next page)
  'fill', // type a value into the field with this label / placeholder / name
  'click', // click the button / link with this text
  'select', // choose an option (value) in the dropdown with this label ('' = first dropdown)
  'check', // tick the checkbox with this label
  'wait', // pause `value` seconds
  'expire', // do nothing more – let the 3DS page time out (timeout scenarios)
]);
const threeDsStepSchema = z.object({
  action: z.enum(THREE_DS_ACTIONS),
  /** Visible text / label / placeholder / name (or a CSS selector starting with "css="). */
  target: z.string().trim().max(200).default(''),
  /** Literal, or {key} of a 3DS detail, e.g. {otp}, {sortCode}. */
  value: z.string().trim().max(200).default(''),
});
const threeDsFlowSchema = z.object({
  id: flowSlug,
  /** Bank / PSP name as on the dashboard (Banks), e.g. trustpayments-card-json. */
  bank: z.string().trim().min(1).max(80),
  label: z.string().trim().max(80).default(''),
  methods: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  /** What the 3DS page asks for: OTP, sort code, account number, e-mail … – used as {key} in steps. */
  details: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'detail key: letters, digits, "_"'),
        label: z.string().trim().max(80).default(''),
        value: z.string().max(200).default(''),
      }),
    )
    .max(30)
    .default([]),
  docsUrl: z.string().trim().max(500).default(''),
  notes: z.string().max(4000).default(''),
  /** Screenshots, videos, PDFs in psp-flows/<id>/ (uploaded on the 3DS flows page). */
  attachments: z
    .array(
      z.object({
        file: z.string().regex(/^[\w.() -]{1,120}$/),
        caption: z.string().max(200).default(''),
      }),
    )
    .max(40)
    .default([]),
  scenarios: z
    .array(
      z.object({
        id: flowSlug,
        name: z.string().trim().min(1).max(80),
        outcome: z.enum(['success', 'failure', 'pending', 'timeout', 'other']),
        description: z.string().max(500).default(''),
        steps: z.array(threeDsStepSchema).max(30).default([]),
      }),
    )
    .max(40)
    .default([]),
});

/** Masking rule (launcher → Masking rules): fields that must be masked in stored PSP calls. */
const maskingRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'id: lowercase letters, digits, "-"'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(''),
    scope: z.enum(['all', 'card', 'methods']),
    methods: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
    fields: z.array(z.enum(masking.FIELD_IDS)).default([]),
    /** Extra key names, e.g. upiId, vpa – matched case-insensitively, "-" / "_" ignored. */
    customKeys: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    enabled: z.boolean().default(true),
  })
  .refine(
    (r) => r.fields.length + r.customKeys.length > 0,
    'a masking rule needs at least one field',
  )
  .refine(
    (r) => r.scope !== 'methods' || r.methods.length > 0,
    'list the payment methods of the rule',
  );

const settingsSchema = z.object({
  run: z.object({
    defaultEnvironment: z.enum(['uat', 'local']),
    logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    logHttpBodies: z.boolean(),
    trace: z.enum(['', 'on', 'off', 'retain-on-failure', 'on-first-retry', 'on-all-retries']),
    /** Past runs kept for the Report tab's run list (older ones are deleted). */
    keepRuns: z.number().int().min(1).max(100).default(5),
  }),
  auth: z.object({
    apiKeyHeader: z.string().trim().min(1),
    apiKeyPrefix: z.string(),
    tokenPath: z.string(),
  }),
  environments: z.object({ uat: endpointsSchema, local: endpointsSchema }),
  purchase: z.object({ uat: purchaseTemplateSchema, local: purchaseTemplateSchema }),
  s2s: z.object({ uat: s2sTemplateSchema, local: s2sTemplateSchema }),
  session: z.object({ uat: sessionTemplateSchema, local: sessionTemplateSchema }),
  /** Saved versions of the S2S / session baseline (launcher). The active one is copied to s2s / session. */
  s2sLibrary: z
    .object({ uat: libraryOf(s2sTemplateSchema), local: libraryOf(s2sTemplateSchema) })
    .default({ uat: { activeId: '', items: [] }, local: { activeId: '', items: [] } }),
  sessionLibrary: z
    .object({ uat: libraryOf(sessionTemplateSchema), local: libraryOf(sessionTemplateSchema) })
    .default({ uat: { activeId: '', items: [] }, local: { activeId: '', items: [] } }),
  cards: z.object({ uat: z.array(cardSettingSchema), local: z.array(cardSettingSchema) }),
  /** 3DS flows per bank / PSP – the same in every environment. */
  threeDsFlows: z
    .object({ flows: z.array(threeDsFlowSchema).max(50) })
    .refine(
      (t) => new Set(t.flows.map((f) => f.id)).size === t.flows.length,
      '3DS flow ids must be unique',
    )
    .default({ flows: [] }),
  /** Same for every environment: masking is a PGS rule, not an environment setting. */
  masking: z
    .object({ rules: z.array(maskingRuleSchema).max(50) })
    .refine(
      (m) => new Set(m.rules.map((r) => r.id)).size === m.rules.length,
      'masking rule ids must be unique',
    )
    .default({ rules: masking.DEFAULT_RULES }),
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep merge; arrays and primitives from `override` replace `base`. @returns {unknown} */
function mergeSettings(/** @type {unknown} */ base, /** @type {unknown} */ override) {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  /** @type {Record<string, unknown>} */
  const result = { ...base };
  for (const [key, value] of Object.entries(override))
    result[key] = mergeSettings(base[key], value);
  return result;
}

/** @returns {Record<string, unknown>} */
function readJson(/** @type {string} */ file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return isPlainObject(parsed) ? parsed : {};
}

function readDefaults() {
  const defaults = readJson(DEFAULTS_FILE);
  delete defaults.$comment;
  return defaults;
}

/** Validates merged settings; returns { success, data } or { success: false, error }. */
function resolveSettings(/** @type {string} */ file = SETTINGS_FILE) {
  return settingsSchema.safeParse(mergeSettings(readDefaults(), readJson(file)));
}

module.exports = {
  DEFAULTS_FILE,
  SETTINGS_FILE,
  OUTCOMES,
  cardSettingSchema,
  maskingRuleSchema,
  threeDsFlowSchema,
  purchaseTemplateSchema,
  s2sTemplateSchema,
  sessionTemplateSchema,
  settingsSchema,
  mergeSettings,
  readJson,
  readDefaults,
  resolveSettings,
};
