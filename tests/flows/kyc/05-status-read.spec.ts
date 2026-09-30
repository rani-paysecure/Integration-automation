import { test, expect, expectKycError } from '@fixtures/kyc.fixture';
import { getKyc, expectRecordShape } from '@test-data/kyc/kyc';

/**
 * GET /kyc/{kycId}
 *
 * Note what is *not* tested here: the 30-second inquiry throttle
 * (kyc.inquiry.minIntervalSeconds). Whether the provider was re-asked is invisible
 * from outside — the response is identical either way — so asserting it would mean
 * asserting a timing coincidence. It belongs in the log-based checks in the QA
 * document, not in a spec that would go flaky.
 */
test.describe('KYC verification › 5. Status read', () => {
  test(
    'KYC-13 · given a verification, when status is read, then it returns the same projection as create',
    { tag: '@KYC-13' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const read = await getKyc(api, created.kyc_id);

      expectRecordShape(read);
      expect(read.kyc_id).toBe(created.kyc_id);
      expect(read.customer_id).toBe(customer.customerId);
      expect(read.merchant_cust_id).toBe(customer.merchantCustomerId);
      // product left the request but is still on the record, defaulted from
      // kyc.product.default, because it is part of the record identity key.
      expect(read.product).toBeTruthy();
    },
  );

  test(
    'KYC-14a · given an unopened link, when status is read, then verification_url_opened_at is absent, not null',
    { tag: '@KYC-14a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      // Absent says "no open recorded" without the caller having to treat a null as
      // meaningful — and it is the only way to tell an untouched link from a
      // half-finished one, since both read AWAITING_USER.
      expect(Object.keys(created)).not.toContain('verification_url_opened_at');
    },
  );

  test(
    'KYC-13a · given a verification, when status is read, then verification_url points at our origin, never the provider',
    { tag: '@KYC-13a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      expect(
        created.verification_url,
        'no verification_url — the provider did not hand over a link or page',
      ).toBeTruthy();
      // Naming the provider in a merchant-facing URL tells an attacker what to spoof,
      // and the provider's own link is usually signed and replayable.
      expect(created.verification_url).toContain(`/kyc/redirect/${created.kyc_id}`);
      expect(created.verification_url).not.toMatch(/sumsub|persona|onfido/i);
    },
  );

  test(
    'KYC-13b · given a new verification, when status is read, then status_history is oldest first starting at CREATED',
    { tag: '@KYC-13b' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const history = created.status_history;
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]?.status).toBe('CREATED');
      expect(history.at(-1)?.status).toBe(created.status);

      const times = history.map((h) => Date.parse(h.changed_at));
      const sorted = [...times].sort((a, b) => a - b);
      expect(times, 'status_history must be oldest first').toEqual(sorted);
    },
  );

  test(
    'KYC-13c · given a history entry with no message, when status is read, then the message key is omitted',
    { tag: '@KYC-13c' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      // Most transitions carry no message, and a null on every entry is noise the
      // caller has to filter. Absent is the contract.
      for (const entry of created.status_history) {
        if ('message' in entry) {
          expect(entry.message).not.toBeNull();
        }
      }
    },
  );
});

/**
 * Cross-merchant isolation.
 *
 * Its own describe with a describe-level skip, not an in-test one: the `apiOther`
 * fixture is built before the test body runs, so a skip inside the body would come
 * too late and the fixture would throw on the missing key first.
 */
test.describe('KYC verification › 5. Status read – cross-merchant isolation', () => {
  test.skip(({ kycEnv }) => !kycEnv.hasSecondMerchant, '<ENV>_KYC_API_KEY_2 is not configured');

  test("KYC-15 · given another merchant's kyc id, when status is read, then it returns 404, not 403", async ({
    apiOther,
    newCustomer,
    newKyc,
  }) => {
    const customer = await newCustomer();
    const created = await newKyc({ customer_id: customer.customerId });

    // 404 rather than 403 on purpose: a 403 would confirm the id exists.
    const response = await apiOther.get(`/kyc/${created.kyc_id}`);
    await expectKycError(response, 404, 'record_not_found');
  });
});
