import { expect } from '@playwright/test';
import type { KycHttp } from '@clients/kyc-http';
import type { CreateKycBody, KycRecordView, KycStatus } from './kyc-types';

/**
 * `test: true` on every verification this suite starts. It is part of the
 * record identity key, so a test run can never be handed an in-flight live
 * record for the same customer, and vice versa.
 */
export function createBody(body: CreateKycBody, country: string): CreateKycBody {
  return { country, test: true, ...body };
}

export async function createKyc(
  api: KycHttp,
  body: CreateKycBody,
  country: string,
): Promise<KycRecordView> {
  const response = await api.post('/kyc/create', { data: createBody(body, country) });
  expect(
    response.status(),
    `create failed: ${String(response.status())} ${await response.text()}`,
  ).toBe(200);
  return (await response.json()) as KycRecordView;
}

export async function getKyc(api: KycHttp, kycId: string): Promise<KycRecordView> {
  const response = await api.get(`/kyc/${kycId}`);
  expect(
    response.status(),
    `status read failed: ${String(response.status())} ${await response.text()}`,
  ).toBe(200);
  return (await response.json()) as KycRecordView;
}

/**
 * Wait for the record to reach one of `wanted`. The interval is 3s because
 * GET /kyc/{id} re-asks the provider at most once every
 * kyc.inquiry.minIntervalSeconds (30s) – polling faster only costs requests.
 */
export async function waitForStatus(
  api: KycHttp,
  kycId: string,
  wanted: KycStatus[],
  timeoutMs = 120_000,
): Promise<KycRecordView> {
  await expect
    .poll(
      async () => {
        const response = await api.get(`/kyc/${kycId}`);
        if (response.status() !== 200) return `HTTP ${String(response.status())}`;
        return ((await response.json()) as KycRecordView).status ?? 'null';
      },
      {
        message: `waiting for ${kycId} to reach one of ${wanted.join(', ')}`,
        timeout: timeoutMs,
        intervals: [3_000],
      },
    )
    .toMatch(new RegExp(`^(${wanted.join('|')})$`));
  return getKyc(api, kycId);
}

/** Statuses the module treats as still in flight (KycOrchestrationService.IN_FLIGHT). */
export const IN_FLIGHT: KycStatus[] = [
  'CREATED',
  'AWAITING_USER',
  'KYC_PENDING',
  'KYC_IN_PROCESS',
  'MANUAL_REVIEW',
];

/** A decision was actually made about the person. */
export const SETTLED: KycStatus[] = ['KYC_APPROVED', 'KYC_REJECTED', 'RESUBMISSION_REQUIRED'];

/** Ended with nobody having assessed the person. */
export const TERMINAL: KycStatus[] = ['KYC_EXPIRED', 'KYC_CANCELLED'];

/**
 * Wire contract of a record view: every documented key present, snake_case.
 * Catches a serialisation regression a status-only assertion would miss.
 */
export function expectRecordShape(record: KycRecordView): void {
  for (const key of [
    'kyc_id',
    'customer_id',
    'merchant_cust_id',
    'product',
    'status',
    'provider_reference_id',
    'decision_reasons',
    'verification_url',
    'message',
    'created_at',
    'updated_at',
    'status_history',
  ]) {
    expect(record, `missing key '${key}' in the record view`).toHaveProperty(key);
  }
  expect(record.kyc_id).toMatch(/^KYC[0-9a-f]{32}$/);
  expect(Array.isArray(record.status_history)).toBe(true);
  // status_history is oldest first, and a null message is omitted rather than sent.
  for (const entry of record.status_history) {
    expect(entry).toHaveProperty('status');
    expect(entry).toHaveProperty('changed_at');
    if ('message' in entry) {
      expect(entry.message, 'a present message must not be null').not.toBeNull();
    }
  }
}

/**
 * Same instant at millisecond precision: the create response carries Java's
 * nanosecond LocalDateTime, later reads come back from Mongo in milliseconds.
 */
export function sameInstant(a: string | null, b: string | null): boolean {
  const ms = (t: string | null): string | null =>
    t === null ? null : t.replace(/(\.\d{3})\d+$/, '$1');
  return ms(a) === ms(b);
}

/** Value that must be present (e.g. `verification_url`) – fails with a readable message otherwise. */
export function must<T>(value: T | null | undefined, what: string): T {
  expect(value, `${what} is missing`).toBeTruthy();
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

/** JSON body of a KYC answer, typed loosely (status / code / kyc_id …). */
export async function kycJson(response: { json(): Promise<unknown> }): Promise<{
  kyc_id?: string;
  status?: string | null;
  code?: string;
  message?: string;
}> {
  return (await response.json()) as {
    kyc_id?: string;
    status?: string | null;
    code?: string;
    message?: string;
  };
}
