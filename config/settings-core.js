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

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS_FILE = path.join(__dirname, 'defaults.json');
const SETTINGS_FILE = path.join(ROOT, 'settings.local.json');

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
      action: z.enum(['none', 'otp', 'manual']),
      otp: z.string().trim().max(40).default(''),
      submit: z.string().trim().max(40).default(''),
    })
    .default({ action: 'none', otp: '', submit: '' }),
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
  cards: z.object({ uat: z.array(cardSettingSchema), local: z.array(cardSettingSchema) }),
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
  purchaseTemplateSchema,
  s2sTemplateSchema,
  sessionTemplateSchema,
  settingsSchema,
  mergeSettings,
  readJson,
  readDefaults,
  resolveSettings,
};
