import type { TestInfo } from '@playwright/test';
import type { KycHttp } from '@clients/kyc-http';
import type { KycEnv } from '@fixtures/kyc.fixture';
import { newMerchantCustomerId, type NewCustomerOptions } from './customer';
import type { Customer, KycErrorBody, KycRecordView } from './kyc-types';
import type { KycCase } from '@test-data/uploaded-cases/uploaded-cases';
import { omitPath, setPath } from '@utils/object';

export interface KycCaseResult {
  readonly http: number;
  readonly code: string | undefined;
  readonly status: string | undefined;
  readonly message: string;
  readonly kycId: string | undefined;
  /** "HTTP 400 · country_required · 'country' is required." */
  readonly summary: string;
}

const UNKNOWN_CUSTOMER_ID = '000000000000000000000000';
const OTHER_BRAND = '00000000-0000-0000-0000-000000000000';

export function describeKycExpectation(expected: KycCase['expected']): string {
  return [
    `HTTP ${String(expected.http)}`,
    expected.code,
    expected.statuses?.join(' / '),
    expected.messageContains === undefined
      ? undefined
      : `message contains "${expected.messageContains}"`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Header overrides for the auth variant (null removes a default header). */
function authHeaders(auth: KycCase['auth'], env: KycEnv): Record<string, string | null> {
  switch (auth) {
    case 'no-bearer':
      return { Authorization: env.apiKey };
    case 'invalid-key':
      return { Authorization: 'Bearer not-a-real-key' };
    case 'no-brand':
      return { 'Brand-Id': null, brandid: null };
    case 'other-brand':
      return { 'Brand-Id': OTHER_BRAND, brandid: OTHER_BRAND };
    default:
      return {};
  }
}

/** Runs one uploaded KYC case (KV-xxx) and records what came back for the report. */
export async function runUploadedKycCase(
  kycCase: KycCase,
  deps: {
    readonly api: KycHttp;
    readonly anon: KycHttp;
    readonly newCustomer: (options?: NewCustomerOptions) => Promise<Customer>;
    readonly kycEnv: KycEnv;
  },
  testInfo: TestInfo,
): Promise<KycCaseResult> {
  let body: Record<string, unknown> = { country: deps.kycEnv.country, test: true };
  if (kycCase.customer === 'new' || kycCase.customer === 'by-merchant-id') {
    const customer = await deps.newCustomer({
      ...(kycCase.customerSet === undefined ? {} : { set: kycCase.customerSet }),
      ...(kycCase.customerRemove === undefined
        ? {}
        : { omit: kycCase.customerRemove as (keyof Customer)[] }),
    });
    testInfo.annotations.push({ type: 'customer id', description: customer.customerId });
    body =
      kycCase.customer === 'new'
        ? { ...body, customer_id: customer.customerId }
        : { ...body, merchant_cust_id: customer.merchantCustomerId };
  } else if (kycCase.customer === 'unknown-customer-id') {
    body = { ...body, customer_id: UNKNOWN_CUSTOMER_ID };
  } else if (kycCase.customer === 'unknown-merchant-id') {
    body = { ...body, merchant_cust_id: newMerchantCustomerId() };
  }
  for (const [path, value] of Object.entries(kycCase.set ?? {})) body = setPath(body, path, value);
  for (const path of kycCase.remove ?? []) body = omitPath(body, path);

  const client = kycCase.auth === 'none' ? deps.anon : deps.api;
  const headers =
    kycCase.auth === 'none'
      ? { 'Brand-Id': deps.kycEnv.brandId }
      : authHeaders(kycCase.auth, deps.kycEnv);
  const response = await client.post('/kyc/create', { data: body, headers });
  const json = (await response.json().catch(() => ({}))) as Partial<KycRecordView> &
    Partial<Omit<KycErrorBody, 'status'>>;
  const ok = response.status() < 300;
  const result: KycCaseResult = {
    http: response.status(),
    code: ok ? undefined : json.code,
    status: ok ? (json.status ?? undefined) : undefined,
    message: json.message ?? '',
    kycId: json.kyc_id,
    summary: [
      `HTTP ${String(response.status())}`,
      ok ? undefined : json.code,
      ok ? (json.status ?? undefined) : undefined,
      json.message ?? undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  };
  testInfo.annotations.push({ type: 'kyc result', description: result.summary });
  return result;
}
