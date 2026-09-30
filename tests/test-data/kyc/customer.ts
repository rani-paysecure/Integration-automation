import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { KycHttp } from '@clients/kyc-http';
import type { Customer } from './kyc-types';

export interface NewCustomerOptions {
  /** Defaults to a fresh one. Pass a value to create a deliberate duplicate. */
  merchantCustomerId?: string;
  country?: string;
  /** Omit fields to test what the KYC configs do with an incomplete customer. */
  omit?: (keyof Customer)[];
  /** Field overrides (uploaded KYC cases: `customer.city=Berlin`). */
  set?: Record<string, unknown>;
}

/**
 * Every id this suite creates carries this prefix, so a leftover record is
 * recognisable in Mongo and cannot be confused with a manual test.
 */
export const RUN_PREFIX = 'E2E';

export function newMerchantCustomerId(): string {
  return `${RUN_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}

/** Customer payload with every field the Sumsub applicant profile wants (dummy data). */
export function customerPayload(
  brandId: string,
  country: string,
  options: NewCustomerOptions = {},
): Record<string, unknown> {
  const merchantCustomerId = options.merchantCustomerId ?? newMerchantCustomerId();
  const seed = merchantCustomerId.slice(-6).toLowerCase();
  const payload: Record<string, unknown> = {
    merchantCustomerId,
    fullName: 'Ada Lovelace',
    emailId: `e2e.${seed}@example.com`,
    phoneNo: '+14155550123',
    dateOfBirth: '1990-01-15',
    address: '1 Test Street',
    city: 'San Francisco',
    stateCode: 'CA',
    zipCode: '94105',
    country: options.country ?? country,
    custRegDate: new Date().toISOString().slice(0, 10),
    brandID: brandId,
    ...options.set,
  };
  const omit = new Set<string>(options.omit ?? []);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !omit.has(key)));
}

/**
 * Create a customer (POST /api/v1/customer).
 *
 * KYC takes no personal details on the request — KycOrchestrationService builds
 * {{customer.*}} from the stored record — so an incomplete customer here is an
 * incomplete applicant at the provider. That is why this fills everything.
 * The legacy endpoint answers 202 ACCEPTED on success, not 200.
 */
export async function createCustomer(
  api: KycHttp,
  brandId: string,
  country: string,
  options: NewCustomerOptions = {},
): Promise<Customer> {
  const response = await api.post('/api/v1/customer', {
    data: customerPayload(brandId, country, options),
  });
  expect(
    response.status(),
    `customer create failed: ${String(response.status())} ${await response.text()}`,
  ).toBe(202);
  const body = (await response.json()) as Customer;
  expect(body.customerId, 'customer create returned no customerId').toBeTruthy();
  return body;
}
