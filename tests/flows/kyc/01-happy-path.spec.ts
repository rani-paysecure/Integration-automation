import { test, expect } from '@fixtures/kyc.fixture';
import { newMerchantCustomerId } from '@test-data/kyc/customer';
import { expectRecordShape } from '@test-data/kyc/kyc';

/**
 * The first half of the happy path: everything up to the point where a human (or
 * spec 12) has to work through the provider's pages.
 *
 * Split deliberately. This half is deterministic and must always pass; the provider
 * half depends on Sumsub's DOM and sandbox behaviour and is allowed to fail on its
 * own. Keeping them in one test would make a Sumsub change look like a regression
 * in our API.
 */
test.describe('KYC verification › 1. Create – happy path', () => {
  test(
    'KYC-01 · given a new customer, when create is called, then the record is AWAITING_USER with a verification link',
    { tag: '@KYC-01' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const record = await newKyc({ customer_id: customer.customerId });

      expectRecordShape(record);
      expect(record.status).toBe('AWAITING_USER');
      expect(record.customer_id).toBe(customer.customerId);
      expect(record.merchant_cust_id).toBe(customer.merchantCustomerId);

      // A link exists and points at us.
      expect(record.verification_url).toContain(`/kyc/redirect/${record.kyc_id}`);

      // The provider has been called and gave us its own id for this check — this is
      // what makes a support ticket searchable in their dashboard.
      expect(
        record.provider_reference_id,
        'no provider_reference_id: the provider was never reached, or the config did not map it',
      ).toBeTruthy();

      // Nothing has been decided yet.
      expect(record.decision_reasons).toBeNull();

      // CREATED then AWAITING_USER, in that order, in one synchronous call.
      const statuses = record.status_history.map((h) => h.status);
      expect(statuses).toEqual(['CREATED', 'AWAITING_USER']);
    },
  );

  test(
    'KYC-02 · given a stored customer, when create sends no personal details, then the provider is still reached',
    { tag: '@KYC-02' },
    async ({ newCustomer, newKyc }) => {
      // The request carries no name, email, date of birth or address — that moved to
      // the customer record. If this create succeeds and reaches the provider, the
      // {{customer.*}} context did its job.
      const customer = await newCustomer();

      const record = await newKyc({ customer_id: customer.customerId });

      expect(record.status).toBe('AWAITING_USER');
      expect(record.provider_reference_id).toBeTruthy();
    },
  );

  test(
    'KYC-02a · given a customer with no fullName, when it is created, then the customer API refuses it',
    { tag: '@KYC-02a' },
    async ({ api }) => {
      // Personal details now come from the stored customer, so the customer record is
      // where completeness has to be enforced. Verified live: POST /api/v1/customer
      // refuses a customer with no fullName, which means a KYC verification can never
      // be started against one — the subject cannot reach a dead-ended provider page.
      const response = await api.post('/api/v1/customer', {
        data: {
          merchantCustomerId: newMerchantCustomerId(),
          emailId: 'no.name@example.com',
          country: 'US',
        },
      });

      expect(response.status(), await response.text()).not.toBe(202);
      const body = (await response.json()) as { code?: string; message?: string };
      expect(body.code, `unhelpful refusal: ${JSON.stringify(body)}`).toBeTruthy();
      expect(body.message).toBeTruthy();
    },
  );
});
