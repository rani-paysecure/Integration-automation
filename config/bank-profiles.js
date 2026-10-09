// @ts-check
/**
 * Bank profiles – per bank / PSP (and its payment methods): the mandatory field mapping between
 * our purchase request and the request PGS sends to the PSP, the Jira ticket, API doc links and
 * notes. Shared with the team: config/bank-profiles.json is committed (not per machine).
 *
 * Never put credentials here – the PSP's API keys and dashboard logins stay in each tester's
 * local profile / .env (the launcher refuses values that look like secrets).
 *
 * Used by the launcher (Bank profiles page) and the PSP checks (src/helpers/psp-compliance.ts).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..');
/** BANK_PROFILES_FILE lets the framework self-tests use their own file. */
const FILE = () =>
  process.env.BANK_PROFILES_FILE || path.join(ROOT, 'config', 'bank-profiles.json');

/**
 * How a mapped field is checked in the PSP request:
 *   equals       – the PSP field has the value of our field
 *   minor-units  – the PSP field is our amount × 100 (e.g. 10.00 → 1000)
 *   purchase-id  – the PSP field carries the purchase ID
 *   present      – the PSP field is sent and not empty (values from the MID config …)
 *   masked       – the PSP field is sent and stored masked (***)
 */
const CHECKS = /** @type {const} */ (['equals', 'minor-units', 'purchase-id', 'present', 'masked']);

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'id: lowercase letters, digits, "-"');
const mappingSchema = z.object({
  /** Our purchase request field (dot path, e.g. client.email) – empty for PSP-only fields. */
  ours: z.string().trim().max(160).default(''),
  /** Field in the PSP request (dot path inside paymentInfo / allOtherRequest, e.g. profile.email). */
  psp: z.string().trim().min(1).max(200),
  check: z.enum(CHECKS).default('equals'),
  mandatory: z.boolean().default(true),
  note: z.string().max(200).default(''),
});
const profileSchema = z.object({
  id: slug,
  /** Bank name as on the dashboard (Banks), e.g. paysafe-payfac. */
  bank: z.string().trim().min(1).max(80),
  methods: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  jiraUrl: z.string().trim().max(300).default(''),
  docs: z
    .array(
      z.object({
        title: z.string().trim().max(120).default(''),
        url: z.string().trim().min(1).max(500),
      }),
    )
    .max(50)
    .default([]),
  notes: z.string().max(6000).default(''),
  mapping: z.array(mappingSchema).max(300).default([]),
  updatedAt: z.string().max(40).default(''),
});
const fileSchema = z
  .object({ profiles: z.array(profileSchema).max(100) })
  .refine(
    (f) => new Set(f.profiles.map((p) => p.id)).size === f.profiles.length,
    'profile ids must be unique',
  );

/** Values that look like credentials – refused so they never get committed. */
const SECRET =
  /(password|passwd|secret|api[_-]?key|token|private[_ -]?api|bearer)\s*[:=]\s*\S{6,}|\bB-qa\d-|\b[A-Za-z0-9+/]{60,}={0,2}\b/i;

/** @returns {z.infer<typeof fileSchema>['profiles']} */
function readProfiles() {
  const file = FILE();
  if (!fs.existsSync(file)) return [];
  const parsed = fileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${path.basename(file)} is invalid at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`,
    );
  }
  return parsed.data.profiles;
}

/** Validates and writes all profiles; throws a readable error. */
function writeProfiles(/** @type {unknown} */ profiles) {
  const parsed = fileSchema.safeParse({ profiles });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Bank profile ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`);
  }
  for (const p of parsed.data.profiles) {
    if (SECRET.test(JSON.stringify(p))) {
      throw new Error(
        `Bank profile "${p.bank}" looks like it contains a password or API key – credentials must not be stored here (keep them in your local tester profile / .env)`,
      );
    }
  }
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    $comment:
      'Bank profiles (launcher → Bank profiles): field mapping our request → PSP request, Jira, docs. Committed for the team – never put credentials here.',
    profiles: parsed.data.profiles,
  };
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return parsed.data.profiles;
}

/**
 * Profile of a transaction: same bank (case-insensitive); a profile that lists the payment
 * method wins over one without methods.
 */
function profileFor(
  /** @type {string} */ bankName,
  /** @type {string} */ method = '',
  profiles = readProfiles(),
) {
  const bank = bankName.trim().toLowerCase();
  const m = method.trim().toUpperCase();
  const same = profiles.filter((p) => p.bank.toLowerCase() === bank);
  return (
    same.find((p) => m !== '' && p.methods.some((x) => x.toUpperCase() === m)) ??
    same.find((p) => p.methods.length === 0) ??
    same[0]
  );
}

module.exports = { CHECKS, SECRET, profileSchema, readProfiles, writeProfiles, profileFor, FILE };
