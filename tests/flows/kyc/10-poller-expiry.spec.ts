import { test, expect } from '@fixtures/kyc.fixture';
import { getKyc, waitForStatus } from '@test-data/kyc/kyc';

/**
 * Expiry, driven by the real poller.
 *
 * PRECONDITION: the environment must have `kyc.poll.enabled=true`. Today that
 * property is set in application-test.properties and nowhere else, so if these fail
 * with a timeout and the record is still AWAITING_USER, check the running profile
 * before looking for a bug.
 *
 * Tagged @slow: these wait on a scheduler that ticks every 30 seconds and on a
 * one-minute deadline, so they take minutes, not seconds. Excluded from `npm test`.
 */
test.describe('KYC verification › 10. Expiry (poller) @slow', () => {
  test.describe.configure({ timeout: 360_000 });

  test(
    'KYC-29 · given a link nobody opened, when the deadline passes, then the expiry says it was never opened',
    { tag: '@KYC-29' },
    async ({ api, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
      });
      expect(created.status).toBe('AWAITING_USER');

      const expired = await waitForStatus(api, created.kyc_id, ['KYC_EXPIRED'], 300_000);

      // The two expiry flavours read differently on purpose: an operator seeing
      // "never opened" knows to resend the link, not to chase the provider.
      expect(expired.message).toContain('never opened');
      expect(expired).not.toHaveProperty('verification_url_opened_at');

      // The expiry is recorded as a transition, not just a field change.
      expect(expired.status_history.map((h) => h.status)).toContain('KYC_EXPIRED');
    },
  );

  test(
    'KYC-30 · given an opened but abandoned link, when the deadline passes, then the message differs and the open stamp survives',
    { tag: '@KYC-30' },
    async ({ api, anon, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
      });

      // Open the hosted page once. No browser needed — the stamp and the
      // AWAITING_USER -> KYC_PENDING move happen on the GET itself.
      const opened = await anon.get(`/kyc/redirect/${created.kyc_id}`, { maxRedirects: 0 });
      expect([200, 302]).toContain(opened.status());

      const afterOpen = await getKyc(api, created.kyc_id);
      expect(afterOpen.status).toBe('KYC_PENDING');
      expect(afterOpen.verification_url_opened_at).toBeTruthy();

      const expired = await waitForStatus(api, created.kyc_id, ['KYC_EXPIRED'], 300_000);

      expect(expired.message).toContain('verdict');
      expect(expired.message).not.toContain('never opened');
      // The open stamp survives the expiry — it is how you tell abandonment from a
      // link that was never delivered.
      expect(expired.verification_url_opened_at).toBe(afterOpen.verification_url_opened_at);
    },
  );

  test(
    'KYC-22b · given an expired verification, when the link is opened, then the subject is redirected to failure_redirect',
    { tag: '@KYC-22b' },
    async ({ api, anon, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
        pending_redirect: 'https://merchant.example/kyc/pending',
        failure_redirect: 'https://merchant.example/kyc/failed',
      });

      await waitForStatus(api, created.kyc_id, ['KYC_EXPIRED'], 300_000);

      // The hosted page must not relaunch a verification that has run out of time.
      const response = await anon.get(`/kyc/redirect/${created.kyc_id}`, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toBe('https://merchant.example/kyc/failed');
    },
  );
});
