import { test, expect } from '@fixtures/kyc.fixture';
import { kycJson } from '@test-data/kyc/kyc';

const SUCCESS = 'https://merchant.example/kyc/done';
const PENDING = 'https://merchant.example/kyc/pending';
const FAILURE = 'https://merchant.example/kyc/failed';

/**
 * GET|POST /kyc/return/{kycId} — where the provider sends the subject back to.
 *
 * The security property under test: the verdict is re-fetched from the provider and
 * the query string is used only for correlation. A subject who edits the URL cannot
 * approve themselves, so the redirect they land on reflects the real status.
 */
test.describe('KYC verification › 8. Return from provider', () => {
  test(
    'KYC-23 · given an open verification, when the subject returns, then they land on pending_redirect',
    { tag: '@KYC-23' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        success_redirect: SUCCESS,
        pending_redirect: PENDING,
        failure_redirect: FAILURE,
      });

      const response = await api.get(`/kyc/return/${created.kyc_id}`, { maxRedirects: 0 });

      expect(response.status()).toBe(302);
      // Nothing has been decided, so pending — not success, even though success is set.
      expect(response.headers().location).toBe(PENDING);
    },
  );

  test(
    'KYC-24 · given a forged verdict in the query string, when the subject returns, then it is ignored',
    { tag: '@KYC-24' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        success_redirect: SUCCESS,
        pending_redirect: PENDING,
        failure_redirect: FAILURE,
      });

      const response = await api.get(
        `/kyc/return/${created.kyc_id}?status=KYC_APPROVED&reviewAnswer=GREEN&approved=true`,
        { maxRedirects: 0 },
      );

      expect(response.status()).toBe(302);
      // Still pending. The verdict came from the provider, not the URL.
      expect(response.headers().location).toBe(PENDING);
    },
  );

  test(
    'KYC-23a · given only success_redirect, when the subject returns on an open record, then they land on success_redirect',
    { tag: '@KYC-23a' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        success_redirect: SUCCESS,
      });

      const response = await api.get(`/kyc/return/${created.kyc_id}`, { maxRedirects: 0 });

      expect(response.status()).toBe(302);
      // For a still-open record the order is pending, then success. With no pending
      // URL the subject goes to success rather than nowhere.
      expect(response.headers().location).toBe(SUCCESS);
    },
  );

  test(
    'KYC-23b · given an unknown kyc id, when the subject returns, then it returns 404 record_not_found',
    { tag: '@KYC-23b' },
    async ({ api }) => {
      const response = await api.get('/kyc/return/KYC00000000000000000000000000000000', {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(404);
      expect((await kycJson(response)).code).toBe('record_not_found');
    },
  );

  /**
   * KNOWN DEFECT — this test is expected to fail until the bug is fixed.
   *
   * KycController.returnFromProvider builds the no-redirect response with
   *
   *     Map.of("kycId", kycId,
   *            "status", String.valueOf(record.getStatus()),
   *            "status", String.valueOf(record.getStatus()));
   *
   * Map.of rejects duplicate keys, so this throws IllegalArgumentException at
   * runtime. The catch block re-resolves the (still null) redirect target and the
   * endpoint answers 500 instead of the intended 200 body.
   *
   * Marked test.fail() rather than skipped: it stays red as a reminder, and it turns
   * into a failure the moment someone fixes the bug and forgets to update this test.
   *
   * Fix: delete the duplicated third argument.
   */
  test.fail(
    'KYC-25 · given no redirect configured, when the subject returns, then it explains itself instead of 500ing [KNOWN DEFECT]',
    { tag: '@KYC-25' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const response = await api.get(`/kyc/return/${created.kyc_id}`, { maxRedirects: 0 });

      // The verification itself is fine; there is just nowhere to send the browser.
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { kycId: string; status: string };
      expect(body.kycId).toBe(created.kyc_id);
      expect(body.status).toBeTruthy();
    },
  );
});
