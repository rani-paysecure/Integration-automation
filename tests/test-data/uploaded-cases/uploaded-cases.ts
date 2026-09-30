/**
 * Test cases added from the launcher ("Test cases" tab → upload Excel/CSV),
 * one JSON file per category next to this file:
 *
 *   field-validation.json  FV-xxx   request field rules      → 01-api-field-validation.spec.ts
 *   regex-validation.json  RX-xxx   bank field regex         → 02-regex-validation.spec.ts
 *   psp-validation.json    PR-xxx   PSP request/response     → 04-psp-field-checks.spec.ts
 *   edge-cases.json        EC-xxx   end-to-end scenarios     → 05-edge-cases.spec.ts
 *   kyc-validation.json    KV-xxx   KYC create cases         → kyc/20-uploaded-kyc-cases.spec.ts
 *
 * Every file is validated on load, so a broken entry fails fast with its id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FieldTestCase } from '@helpers/field-testing';
import type { CashierOutcome } from '@app-types/cashier.types';

export const UPLOADED_CASES_DIR = __dirname;

const fieldPath = z.string().regex(/^[A-Za-z_]\w*(\.\w+)*$/);
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

const regexCase = z.object({
  id: z.string().regex(/^RX-\d{3,}$/),
  /** Bank whose regex applies; empty = the bank the payment is routed to. */
  bank: z.string().optional(),
  /** Field name as in the dashboard Field Regex list (full_name, city …). */
  field: z.string().min(1),
  path: fieldPath,
  title: z.string().min(1),
  value: z.string().min(1),
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

export type KycCase = z.infer<typeof kycCase>;
export type RegexCase = z.infer<typeof regexCase>;
export type PspFieldCheck = z.infer<typeof pspCase>['checks'][number];
export type PspCase = z.infer<typeof pspCase>;
export type EdgeCase = z.infer<typeof edgeCase> & {
  readonly expected: { readonly outcome?: CashierOutcome };
};

function load<T>(file: string, schema: z.ZodType<T>): T[] {
  const full = path.isAbsolute(file) ? file : path.join(UPLOADED_CASES_DIR, file);
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
