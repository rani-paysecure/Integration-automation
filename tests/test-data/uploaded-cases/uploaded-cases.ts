/**
 * Test cases added from the launcher ("Test cases" tab → upload Excel/CSV),
 * one JSON file per category next to this file:
 *
 *   field-validation.json  FV-xxx   request field rules      → 01-api-field-validation.spec.ts
 *   regex-validation.json  RX-xxx   bank field regex         → 02-regex-validation.spec.ts
 *   psp-validation.json    PR-xxx   PSP request/response     → 04-psp-field-checks.spec.ts
 *   edge-cases.json        EC-xxx   end-to-end scenarios     → 05-edge-cases.spec.ts
 *   kyc-validation.json    KV-xxx   KYC create cases         → kyc/20-uploaded-kyc-cases.spec.ts
 *   refund-cases.json      RC-xxx   refund steps             → 08-uploaded-refund-cases.spec.ts
 *   s2s-cases.json         S2-xxx   S2S card payments        → s2s-purchase/03-uploaded-s2s-cases.spec.ts
 *   bank-config.json       BC-xxx   bank / MID settings      → 09-uploaded-bank-config-cases.spec.ts
 *
 * Every file is validated on load, so a broken entry fails fast with its id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FieldTestCase } from '@helpers/field-testing';
import type { CashierOutcome } from '@app-types/cashier.types';

/** Saved cases – UPLOADED_CASES_DIR points the server deployment at its git working copy. */
export function uploadedCasesDir(): string {
  const dir = process.env.UPLOADED_CASES_DIR;
  return dir !== undefined && dir !== '' ? dir : __dirname;
}

/** Request path; payment-method keys may contain '-' (extraParam.account-no). */
const fieldPath = z.string().regex(/^[A-Za-z_][\w-]*(\.[\w-]+)*$/);
const source = z
  .object({ file: z.string(), rows: z.array(z.number()), importedAt: z.string() })
  .optional();
const mutation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), value: z.unknown() }),
  z.object({ type: z.literal('remove') }),
  z.object({ type: z.literal('none') }),
]);
const context = z.record(z.string(), z.unknown()).optional();

const fieldCase = z.object({
  id: z.string().regex(/^FV-\d{3,}$/),
  parameter: z.string().min(1),
  path: fieldPath,
  title: z.string().min(1),
  mutation,
  context,
  expectation: z.enum(['accepted', 'rejected', 'observe', 'sanitized']),
  expectedResult: z.string(),
  apiNote: z.string().optional(),
  source,
});

const regexCase = z
  .object({
    id: z.string().regex(/^RX-\d{3,}$/),
    /** Bank whose regex applies; empty = the bank the payment is routed to. */
    bank: z.string().optional(),
    /** Field name as in the dashboard Field Regex list (full_name, city …). */
    field: z.string().min(1),
    path: fieldPath,
    title: z.string().min(1),
    /** Text sent; empty when `send` is empty / null / missing. */
    value: z.string(),
    /** How the value is sent: text (default), empty string, JSON null or the field left out. */
    send: z.enum(['value', 'empty', 'null', 'missing']).optional(),
    /** Customer country for this case (client.country); empty = standard request. */
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    /** auto = decided by the bank's regex at run time. */
    expectation: z.enum(['valid', 'invalid', 'observe', 'auto']),
    /** Pattern when the case was created (for reference – the live rule is used at run time). */
    regex: z.string().optional(),
    origin: z.enum(['dashboard', 'upload', 'ai']),
    source,
  })
  .refine((c) => (c.send ?? 'value') !== 'value' || c.value !== '', {
    message: 'value is empty – use send "empty" for an empty string',
    path: ['value'],
  });

export const PSP_CHECKS = [
  'equals',
  'not equals',
  'contains',
  'matches',
  'present',
  'absent',
  'masked',
] as const;
const pspCase = z.object({
  id: z.string().regex(/^PR-\d{3,}$/),
  title: z.string().min(1),
  card: z.string().optional(),
  checks: z
    .array(
      z.object({
        source: z.enum(['request', 'response']),
        field: z.string().min(1),
        check: z.enum(PSP_CHECKS),
        value: z.string(),
      }),
    )
    .min(1),
  source,
});

const outcomes = [
  'success-redirect',
  'failure-redirect',
  'pending-redirect',
  'rejected',
  'other-page',
] as const;
const edgeCase = z.object({
  id: z.string().regex(/^EC-\d{3,}$/),
  title: z.string().min(1),
  card: z.string().optional(),
  set: z.record(fieldPath, z.unknown()).optional(),
  remove: z.array(fieldPath).optional(),
  expected: z.object({
    outcome: z.enum(outcomes).optional(),
    statuses: z.array(z.string()).optional(),
    errorContains: z.string().optional(),
  }),
  source,
});

const kycCase = z.object({
  id: z.string().regex(/^KV-\d{3,}$/),
  title: z.string().min(1),
  /** new = customer created first and sent as customer_id; by-merchant-id sends merchant_cust_id. */
  customer: z.enum(['new', 'by-merchant-id', 'unknown-customer-id', 'unknown-merchant-id', 'none']),
  auth: z.enum(['valid', 'none', 'no-bearer', 'invalid-key', 'no-brand', 'other-brand']),
  /** KYC create body changes (snake_case, dotted paths allowed: metadata.order). */
  set: z.record(fieldPath, z.unknown()).optional(),
  remove: z.array(fieldPath).optional(),
  /** Customer record changes (camelCase, e.g. fullName). */
  customerSet: z.record(z.string(), z.unknown()).optional(),
  customerRemove: z.array(z.string()).optional(),
  expected: z.object({
    http: z.number().int(),
    code: z.string().optional(),
    statuses: z.array(z.string()).optional(),
    messageContains: z.string().optional(),
  }),
  source,
});

const refundAmount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('total') }),
  z.object({ kind: z.literal('rest'), delta: z.number().optional() }),
  z.object({ kind: z.literal('percent'), value: z.number().positive() }),
  z.object({ kind: z.literal('fixed'), value: z.number() }),
  z.object({ kind: z.literal('raw'), value: z.string() }),
]);
const refundCase = z.object({
  id: z.string().regex(/^RC-\d{3,}$/),
  title: z.string().min(1),
  /** new = paid with the card first · unpaid = created, not paid · given = REFUND_PURCHASE_ID. */
  purchase: z.enum(['new', 'unpaid', 'given']),
  card: z.string().optional(),
  steps: z
    .array(z.object({ amount: refundAmount }))
    .min(1)
    .max(6),
  /** Absent = "QA refund". */
  reason: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('value'), value: z.string() }),
    ])
    .optional(),
  /** Applies to the LAST step. */
  expected: z.object({
    http: z.number().int().optional(),
    code: z.string().optional(),
    messageContains: z.string().optional(),
    statuses: z.array(z.string()).optional(),
  }),
  source,
});

const flag = z.union([z.literal(0), z.literal(1)]);
const bankConfigCase = z.object({
  id: z.string().regex(/^BC-\d{3,}$/),
  title: z.string().min(1),
  /**
   * MID fields as in the dashboard form + merchant_conversion (Merchant Details switch).
   * Tokens: {purchase} / {card} = the purchase currency / card scheme, {other} = a different one.
   */
  settings: z
    .object({
      onlyTwoD: flag.optional(),
      partial_refund_allowed: flag.optional(),
      curr_convert_to: z.string().optional(),
      allowed_curr: z.string().optional(),
      allowed_card: z.string().optional(),
      merchant_conversion: flag.optional(),
    })
    .strict(),
  action: z.enum(['pay', 'partial-refund', 'full-refund']),
  card: z.string().optional(),
  set: z.record(fieldPath, z.unknown()).optional(),
  remove: z.array(fieldPath).optional(),
  expected: z.object({
    routing: z.enum(['uses', 'skips']).optional(),
    statuses: z.array(z.string()).optional(),
    code: z.string().optional(),
    errorContains: z.string().optional(),
    currency: z.string().optional(),
  }),
  source,
});

const s2sCase = z.object({
  id: z.string().regex(/^S2-\d{3,}$/),
  title: z.string().min(1),
  card: z.string().optional(),
  /** new = fresh purchase · unknown = purchaseId that does not exist · second = valid S2S call first. */
  purchase: z.enum(['new', 'unknown', 'second']),
  auth: z.enum(['valid', 'none', 'no-bearer', 'text-plain']),
  /** S2S body changes on top of the S2S data tab (any field name). */
  set: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.unknown()).optional(),
  remove: z.array(z.string()).optional(),
  expected: z.object({
    http: z.number().int(),
    code: z.string().optional(),
    messageContains: z.string().optional(),
    statuses: z.array(z.string()).optional(),
    outcome: z.enum(['success-redirect', 'failure-redirect', 'pending-redirect']).optional(),
  }),
  source,
});

export type S2sCase = z.infer<typeof s2sCase>;
export type RefundCase = z.infer<typeof refundCase>;
export type RefundAmount = z.infer<typeof refundAmount>;
export type BankConfigCase = z.infer<typeof bankConfigCase>;
export type KycCase = z.infer<typeof kycCase>;
export type RegexCase = z.infer<typeof regexCase>;
export type PspFieldCheck = z.infer<typeof pspCase>['checks'][number];
export type PspCase = z.infer<typeof pspCase>;
export type EdgeCase = z.infer<typeof edgeCase> & {
  readonly expected: { readonly outcome?: CashierOutcome };
};

function load<T>(file: string, schema: z.ZodType<T>): T[] {
  const full = path.isAbsolute(file) ? file : path.join(uploadedCasesDir(), file);
  if (!fs.existsSync(full)) return [];
  const parsed = z
    .object({ cases: z.array(schema) })
    .safeParse(JSON.parse(fs.readFileSync(full, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${path.basename(full)} is invalid at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`,
    );
  }
  return parsed.data.cases;
}

const sourceNote = (s: z.infer<typeof source>): string =>
  s ? `Uploaded from ${s.file}${s.rows.length ? ` (row ${s.rows.join(', ')})` : ''}` : '';

/**
 * Built-in cases (in code, e.g. FT-001a) removed in the launcher (Test cases → Remove).
 * Listed in removed-builtin-cases.json next to the uploaded cases; the specs skip them.
 */
export function removedBuiltinCaseIds(file = 'removed-builtin-cases.json'): Set<string> {
  const full = path.isAbsolute(file) ? file : path.join(uploadedCasesDir(), file);
  if (!fs.existsSync(full)) return new Set();
  const parsed = z
    .object({ removed: z.array(z.looseObject({ id: z.string() })) })
    .safeParse(JSON.parse(fs.readFileSync(full, 'utf8')));
  if (!parsed.success) throw new Error(`${path.basename(full)} is invalid`);
  return new Set(parsed.data.removed.map((r) => r.id));
}

/** FV-xxx cases in the shape of the built-in field cases. */
export function loadUploadedFieldCases(file = 'field-validation.json'): FieldTestCase[] {
  return load(file, fieldCase).map((c) => {
    const apiNote = [c.apiNote, sourceNote(c.source)].filter(Boolean).join(' · ');
    return {
      id: c.id,
      parameter: c.parameter,
      path: c.path,
      title: c.title,
      mutation: c.mutation.type === 'set' ? { type: 'set', value: c.mutation.value } : c.mutation,
      ...(c.context ? { context: c.context } : {}),
      expectation: c.expectation,
      expectedResult: c.expectedResult,
      ...(apiNote ? { apiNote } : {}),
    };
  });
}

export const loadUploadedRegexCases = (file = 'regex-validation.json'): RegexCase[] =>
  load(file, regexCase);
export const loadUploadedPspCases = (file = 'psp-validation.json'): PspCase[] =>
  load(file, pspCase);
export const loadUploadedEdgeCases = (file = 'edge-cases.json'): EdgeCase[] =>
  load(file, edgeCase) as EdgeCase[];
export const loadUploadedKycCases = (file = 'kyc-validation.json'): KycCase[] =>
  load(file, kycCase);
export const loadUploadedRefundCases = (file = 'refund-cases.json'): RefundCase[] =>
  load(file, refundCase);
export const loadUploadedBankConfigCases = (file = 'bank-config.json'): BankConfigCase[] =>
  load(file, bankConfigCase);
export const loadUploadedS2sCases = (file = 's2s-cases.json'): S2sCase[] => load(file, s2sCase);
