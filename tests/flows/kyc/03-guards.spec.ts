import { test, expect, expectKycError } from '@fixtures/kyc.fixture';
import { getKyc, waitForStatus, kycJson } from '@test-data/kyc/kyc';
import type { KycRecordView } from '@test-data/kyc/kyc-types';

/**
 * The guards at the top of create, in the order KycOrchestrationService applies them.
 *
 * Several of these need a record already sitting in a state only the provider can
 * put it in — approved, rejected, resubmission-required. Those are marked fixme with
 * what they need, rather than faked: a guard test that does not reach the guard is
 * worse than no test, because it reports green.
 *
 * To turn them on, seed a customer through the full Sumsub sandbox flow to each
 * verdict once, then set the env vars named in each test.
 */
test.describe('KYC verification › 3. Guards on existing records', () => {
  test(
    'KYC-22a · given an expired verification, when create is called again, then the expired record is not reused @slow',
    { tag: '@KYC-22a' },
    async ({ api, newCustomer, newKyc }) => {
      test.setTimeout(300_000);

      const customer = await newCustomer();

      // One minute, so the expiry sweep reaches it inside the test. The deadline is
      // anchored to created_at.
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
      });

      // Never open the link, so this is the "never opened" flavour of expiry.
      const expired = await waitForStatus(api, created.kyc_id, ['KYC_EXPIRED'], 240_000);

      expect(expired.message).toContain('never opened');

      // The guard: a terminal record is not resumed and not silently replaced.
      const again = await api.post('/kyc/create', {
        data: { customer_id: customer.customerId, country: 'US', test: true },
      });

      if (again.status() === 200) {
        // An expired record leaves IN_FLIGHT, so a later create legitimately mints a
        // new one. What must not happen is the expired record being reused.
        expect((await kycJson(again)).kyc_id).not.toBe(created.kyc_id);
      } else {
        await expectKycError(again, 409, 'record_terminal');
      }
    },
  );

  test(
    'KYC-07 · given create is re-posted in a loop, when the deadline passes, then the record still expires @slow',
    { tag: '@KYC-07' },
    async ({ api, newCustomer, newKyc }) => {
      test.setTimeout(300_000);

      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
      });

      // Re-post create repeatedly. If the deadline moved with each call, the record
      // would never expire and this test would time out — which is the point.
      const deadline = Date.now() + 180_000;
      let last = created;
      while (Date.now() < deadline && last.status !== 'KYC_EXPIRED') {
        await new Promise((r) => setTimeout(r, 15_000));
        const response = await api.post('/kyc/create', {
          data: {
            customer_id: customer.customerId,
            country: 'US',
            test: true,
            kyc_expiry_in_minutes: 1,
          },
        });
        if (response.status() !== 200) break;
        last = (await response.json()) as KycRecordView;
        if (last.kyc_id !== created.kyc_id) break;
      }

      const final = await getKyc(api, created.kyc_id);
      expect(
        final.status,
        'the record never expired while create was being re-posted — the deadline is being walked forward',
      ).toBe('KYC_EXPIRED');
    },
  );

  test.fixme(
    'KYC-35a · given an in-process verification, when create is called, then it is returned as-is',
    { tag: '@KYC-35a' },
    async () => {
      // Needs a record in KYC_IN_PROCESS. Reachable only after the subject finishes
      // the provider's pages, so it depends on spec 12 or a manual run.
      // Seed: set E2E_IN_PROCESS_CUSTOMER_ID to a customer sitting in that state.
    },
  );

  test.fixme(
    'KYC-35b · given an approved verification, when create is called, then the provider is re-asked',
    { tag: '@KYC-35b' },
    async () => {
      // Needs an approved applicant. The interesting part is the failure path: if the
      // re-check throws, the stored approval is served rather than an error, because
      // KYC_APPROVED may not transition to KYC_FAILED.
      // Seed: E2E_APPROVED_CUSTOMER_ID.
    },
  );

  test.fixme(
    'KYC-35c · given a declined verification, when create is called, then it returns 409 already_decided',
    { tag: '@KYC-35c' },
    async () => {
      // Needs a KYC_REJECTED record. Blocks retry-until-approved; reopening is an
      // operator decision.
      // Seed: E2E_REJECTED_CUSTOMER_ID. Expect 409 already_decided naming the product.
    },
  );

  test.fixme(
    'KYC-35d · given RESUBMISSION_REQUIRED, when create is called, then a new verification is opened',
    { tag: '@KYC-35d' },
    async () => {
      // Needs a RESUBMISSION_REQUIRED record — a blurry document or a failed liveness
      // in the sandbox. A new create must mint a NEW kyc_id, unlike every other
      // settled state.
      // Seed: E2E_RESUBMISSION_CUSTOMER_ID.
    },
  );
});
