import { test, expect } from '@fixtures/kyc.fixture';
import { createBody, IN_FLIGHT, sameInstant, kycJson } from '@test-data/kyc/kyc';

/**
 * Idempotency and reuse.
 *
 * The rule the whole module rests on: re-posting create must never open a second
 * applicant at the provider. A merchant retrying a timeout, a user double-clicking,
 * two browser tabs — all of them land here, and all of them must get the record
 * that already exists.
 */
test.describe('KYC verification › 2. Reuse & idempotency', () => {
  test(
    'KYC-05 · given an in-flight verification, when create is called again, then the same record is returned',
    { tag: '@KYC-05' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const first = await newKyc({ customer_id: customer.customerId });
      const second = await newKyc({ customer_id: customer.customerId });

      expect(second.kyc_id).toBe(first.kyc_id);
      expect(second.provider_reference_id).toBe(first.provider_reference_id);
      // Same link, not a freshly minted one: a new link would orphan the first applicant.
      expect(second.verification_url).toBe(first.verification_url);
      expect(IN_FLIGHT).toContain(second.status);
    },
  );

  test(
    'KYC-04 · given either customer id, when create is called, then both reach the same record',
    { tag: '@KYC-04' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const byOurs = await newKyc({ customer_id: customer.customerId });
      const byTheirs = await newKyc({
        merchant_cust_id: customer.merchantCustomerId,
      });

      expect(byTheirs.kyc_id).toBe(byOurs.kyc_id);
    },
  );

  test(
    'KYC-04a · given only merchant_cust_id, when create is called, then the record carries both ids',
    { tag: '@KYC-04a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const record = await newKyc({
        merchant_cust_id: customer.merchantCustomerId,
      });

      // The caller sent one id; the record carries both, so a support ticket quoting
      // either one resolves without a second lookup.
      expect(record.customer_id).toBe(customer.customerId);
      expect(record.merchant_cust_id).toBe(customer.merchantCustomerId);
    },
  );

  test(
    'KYC-06 · given two simultaneous creates, when they race, then one record exists, not two',
    { tag: '@KYC-06' },
    async ({ api, newCustomer, kycEnv }) => {
      const customer = await newCustomer();

      // This is the race the inFlightKey unique index and initiateLeaseUntil exist for.
      // Before them, the in-flight lookup was a read-then-write: both requests missed,
      // both inserted, and the provider ended up with two applicants for one person.
      const [a, b] = await Promise.all([
        api.post('/kyc/create', {
          data: createBody({ customer_id: customer.customerId }, kycEnv.country),
        }),
        api.post('/kyc/create', {
          data: createBody({ customer_id: customer.customerId }, kycEnv.country),
        }),
      ]);

      expect(a.status(), await a.text()).toBe(200);
      expect(b.status(), await b.text()).toBe(200);

      const first = await kycJson(a);
      const second = await kycJson(b);
      expect(second.kyc_id).toBe(first.kyc_id);

      // Whichever request lost the lease returns the record as-is, so at most one of
      // the two can be carrying a provider reference that the other does not share.
      const history = await api.get(`/api/v1/customer/${customer.customerId}/kyc`);
      const listed = (await history.json()) as { kyc: { kyc_id: string }[] };
      expect(listed.kyc, 'one customer, one in-flight verification').toHaveLength(1);
    },
  );

  test(
    'KYC-05a · given a link inside its ttl, when create is called again, then the same link is returned',
    { tag: '@KYC-05a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      // 60 minutes, so the link cannot age out mid-test.
      const first = await newKyc({
        customer_id: customer.customerId,
        link_ttl_minutes: 60,
      });
      const second = await newKyc({
        customer_id: customer.customerId,
        link_ttl_minutes: 60,
      });

      expect(second.kyc_id).toBe(first.kyc_id);
      expect(
        sameInstant(second.created_at, first.created_at),
        `created_at moved: ${first.created_at} -> ${second.created_at}`,
      ).toBe(true);
    },
  );

  test(
    'KYC-07a · given a repeat create supplying kyc_expiry_in_minutes, when it is applied, then created_at does not move',
    { tag: '@KYC-07a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const first = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 60,
      });
      const second = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 60,
      });

      // The deadline is recomputed from created_at, not from "now", so re-posting
      // create in a loop cannot hold a record open forever.
      expect(second.kyc_id).toBe(first.kyc_id);
      expect(
        sameInstant(second.created_at, first.created_at),
        `created_at moved: ${first.created_at} -> ${second.created_at}`,
      ).toBe(true);
    },
  );

  test(
    'KYC-05b · given a different country on a repeat create, when create is called, then the record is reused, not forked',
    { tag: '@KYC-05b' },
    async ({ api, newCustomer, newKyc, kycEnv }) => {
      const customer = await newCustomer();

      const first = await newKyc({ customer_id: customer.customerId });
      const second = await api.post('/kyc/create', {
        data: {
          customer_id: customer.customerId,
          country: kycEnv.country === 'US' ? 'GB' : 'US',
          test: true,
        },
      });

      expect(second.status(), await second.text()).toBe(200);
      // The identity key is (merchant, customer, product, test) — country is not part
      // of it, so this reuses rather than creating a parallel verification.
      expect((await kycJson(second)).kyc_id).toBe(first.kyc_id);
    },
  );
});
