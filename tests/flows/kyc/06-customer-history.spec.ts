import { test, expect } from '@fixtures/kyc.fixture';
import type { ApiErrorBody, KycRecordView } from '@test-data/kyc/kyc-types';
import { newMerchantCustomerId } from '@test-data/kyc/customer';
import { expectRecordShape, must } from '@test-data/kyc/kyc';

interface CustomerKycView {
  customer: { customerId: string; merchantCustomerId: string };
  kyc: KycRecordView[];
}

/**
 * GET /api/v1/customer/{id}/kyc
 *
 * This endpoint is the odd one out and the tests say so explicitly: it lives on the
 * legacy APIController, so it answers 202 rather than 200, its errors are ApiError
 * rather than the KYC {status, code, message} envelope, and its customer object is
 * camelCase while the kyc array beside it is snake_case. A frontend that assumes the
 * /kyc/* conventions here will break, so each of those is asserted rather than
 * quietly accommodated.
 */
test.describe('KYC verification › 6. Customer KYC history', () => {
  test(
    'KYC-16 · given a customer with no verifications, when history is read, then it returns 202 with an empty array',
    { tag: '@KYC-16' },
    async ({ api, newCustomer }) => {
      const customer = await newCustomer();

      const response = await api.get(`/api/v1/customer/${customer.merchantCustomerId}/kyc`);

      // 202 ACCEPTED, matching the other legacy customer endpoints.
      expect(response.status(), await response.text()).toBe(202);

      const body = (await response.json()) as CustomerKycView;
      expect(body.customer.customerId).toBe(customer.customerId);
      // "Exists and has never been checked" is a real answer, distinct from "no such person".
      expect(body.kyc).toEqual([]);
    },
  );

  test(
    'KYC-16a · given our customerId, when history is read, then the customer resolves',
    { tag: '@KYC-16a' },
    async ({ api, newCustomer }) => {
      const customer = await newCustomer();

      const byOurs = await api.get(`/api/v1/customer/${customer.customerId}/kyc`);
      expect(byOurs.status()).toBe(202);
      expect(((await byOurs.json()) as CustomerKycView).customer.customerId).toBe(
        customer.customerId,
      );
    },
  );

  test(
    'KYC-16b · given one verification, when history is read, then it is listed in the same record shape',
    { tag: '@KYC-16b' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const response = await api.get(`/api/v1/customer/${customer.customerId}/kyc`);
      const body = (await response.json()) as CustomerKycView;

      expect(body.kyc).toHaveLength(1);
      expect(body.kyc[0]?.kyc_id).toBe(created.kyc_id);
      // Same projection as /kyc/create and /kyc/{id} — one shape to learn, not three.
      expectRecordShape(must(body.kyc[0], 'listed verification'));
    },
  );

  test(
    'KYC-17 · given a status filter, when history is read, then it is case-insensitive and accepts a list',
    { tag: '@KYC-17' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });
      const actual = created.status;

      const matching = await api.get(
        `/api/v1/customer/${customer.customerId}/kyc?status=${String(actual).toLowerCase()}`,
      );
      expect(matching.status()).toBe(202);
      expect(((await matching.json()) as CustomerKycView).kyc).toHaveLength(1);

      const list = await api.get(
        `/api/v1/customer/${customer.customerId}/kyc?status=KYC_APPROVED,${actual}`,
      );
      expect(((await list.json()) as CustomerKycView).kyc).toHaveLength(1);

      // A filter that excludes the only record empties the array; the customer stays.
      const excluded = await api.get(
        `/api/v1/customer/${customer.customerId}/kyc?status=KYC_APPROVED`,
      );
      const excludedBody = (await excluded.json()) as CustomerKycView;
      expect(excludedBody.kyc).toEqual([]);
      expect(excludedBody.customer.customerId).toBe(customer.customerId);
    },
  );

  test(
    'KYC-17a · given an unknown status, when history is read, then it returns 400 invalid_status listing the allowed values',
    { tag: '@KYC-17a' },
    async ({ api, newCustomer }) => {
      const customer = await newCustomer();

      const response = await api.get(
        `/api/v1/customer/${customer.customerId}/kyc?status=NOT_A_STATUS`,
      );

      // A wrong filter is an error, not an empty list — otherwise a typo reads as
      // "this customer has no approved verifications".
      expect(response.status()).toBe(400);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.code).toBe('invalid_status');
      // The message enumerates the valid values so the caller can fix it without the docs.
      expect(body.message).toContain('KYC_APPROVED');
      expect(body.message).toContain('KYC_PENDING');
    },
  );

  test(
    'KYC-16c · given an unknown customer, when history is read, then it returns 400 customer_does_not_exist',
    { tag: '@KYC-16c' },
    async ({ api }) => {
      const response = await api.get(`/api/v1/customer/${newMerchantCustomerId()}/kyc`);
      expect(response.status()).toBe(400);
      expect(((await response.json()) as ApiErrorBody).code).toBe('customer_does_not_exist');
    },
  );

  test(
    'KYC-18 · given no Authorization header, when history is read, then the error is ApiError, not the KYC envelope',
    { tag: '@KYC-18' },
    async ({ anon, kycEnv }) => {
      const response = await anon.get('/api/v1/customer/anything/kyc', {
        headers: { 'Brand-Id': kycEnv.brandId },
      });
      expect(response.status()).toBe(401);

      const body = (await response.json()) as ApiErrorBody & { status?: string };
      expect(body.code).toBe('authentication_failed');
      // The distinguishing bit: no `"status": "fail"` wrapper. Branching code that
      // reads body.status here to decide success would misread this response.
      expect(body.status).not.toBe('fail');
    },
  );
});
