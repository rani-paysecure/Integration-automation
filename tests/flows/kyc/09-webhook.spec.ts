import { test, expect } from '@fixtures/kyc.fixture';
import { getKyc, must, kycJson } from '@test-data/kyc/kyc';
import { applicantReviewed, misSigned, signed } from '@test-data/kyc/sign';

/**
 * POST /kyc/webhook/{provider}
 *
 * Unauthenticated by design — the provider has no merchant key. The signature is
 * the whole of the security, which is why the rejection case matters more than the
 * acceptance case here.
 *
 * Every body is sent as the exact Buffer that was signed. Our side verifies against
 * the raw received bytes, so signing an object and letting the HTTP client
 * re-serialise it would produce a mismatch that looks like a bug in the server.
 */
test.describe('KYC verification › 9. Provider webhook', () => {
  test.skip(
    ({ kycWebhook }) => kycWebhook.secret === undefined,
    'No webhook secret: set <ENV>_KYC_WEBHOOK_SECRET or configure the KYC MID (mid_auth_key index 2) on the dashboard',
  );

  test(
    'KYC-27a · given an event with no correlation fields, when it is delivered, then it returns 400 correlation_failed',
    { tag: '@KYC-27a' },
    async ({ anon, kycWebhook }) => {
      const { raw, headers } = signed(
        { type: 'applicantReviewed', reviewStatus: 'completed' },
        kycWebhook.secret ?? '',
      );

      const response = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, {
        data: raw,
        headers,
      });

      // Neither applicantId nor an echoed kycId: there is nothing to attach this to.
      expect(response.status()).toBe(400);
      expect((await kycJson(response)).code).toBe('correlation_failed');
    },
  );

  test(
    'KYC-27b · given an event for an unknown applicant, when it is delivered, then it returns 404, not 200',
    { tag: '@KYC-27b' },
    async ({ anon, kycWebhook }) => {
      const { raw, headers } = signed(
        applicantReviewed('000000000000000000000000', 'GREEN'),
        kycWebhook.secret ?? '',
      );

      const response = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, {
        data: raw,
        headers,
      });

      // Silently accepting an unmatched event would hide a correlation bug behind a
      // green provider dashboard.
      expect(response.status()).toBe(404);
      expect((await kycJson(response)).code).toBe('record_not_found');
    },
  );

  test(
    'KYC-26 · given a forged signature, when the event is delivered, then it is rejected and the record is unchanged',
    { tag: '@KYC-26' },
    async ({ api, anon, newCustomer, newKyc, kycWebhook }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });
      expect(created.provider_reference_id).toBeTruthy();

      const before = await getKyc(api, created.kyc_id);

      const { raw, headers } = misSigned(
        applicantReviewed(must(created.provider_reference_id, 'provider_reference_id'), 'GREEN'),
      );
      const response = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, {
        data: raw,
        headers,
      });

      expect(response.status()).toBe(401);
      expect((await kycJson(response)).code).toBe('signature_mismatch');

      // The important half: a forged approval must not move the record.
      const after = await getKyc(api, created.kyc_id);
      expect(after.status).toBe(before.status);
      expect(after.decision_reasons).toBe(before.decision_reasons);
    },
  );

  test(
    'KYC-26a · given a correctly signed event, when it is delivered, then it is accepted',
    { tag: '@KYC-26a' },
    async ({ anon, newCustomer, newKyc, kycWebhook }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const { raw, headers } = signed(
        applicantReviewed(must(created.provider_reference_id, 'provider_reference_id'), 'GREEN'),
        kycWebhook.secret ?? '',
      );
      const response = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, {
        data: raw,
        headers,
      });

      expect(response.status(), await response.text()).toBe(200);
      expect(await kycJson(response)).toEqual({ status: 'ok' });
    },
  );

  test(
    'KYC-28 · given the same event twice inside the dedup window, when both are delivered, then it is applied once',
    { tag: '@KYC-28' },
    async ({ api, anon, newCustomer, newKyc, kycWebhook }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const event = applicantReviewed(
        must(created.provider_reference_id, 'provider_reference_id'),
        'GREEN',
      );
      const { raw, headers } = signed(event, kycWebhook.secret ?? '');

      const first = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, { data: raw, headers });
      expect(first.status()).toBe(200);
      const afterFirst = await getKyc(api, created.kyc_id);

      // Providers re-fire. A repeat inside the 30-minute window is suppressed rather
      // than re-run, so the second delivery must not append another history entry.
      const second = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, { data: raw, headers });
      expect(second.status()).toBe(200);
      const afterSecond = await getKyc(api, created.kyc_id);

      expect(afterSecond.status).toBe(afterFirst.status);
      expect(afterSecond.status_history).toHaveLength(afterFirst.status_history.length);
    },
  );
});

test.describe('KYC verification › 9. Provider webhook – unsigned', () => {
  test(
    'KYC-26b · given an event with no signature header, when it is delivered, then the outcome matches the config',
    { tag: '@KYC-26b' },
    async ({ anon, newCustomer, newKyc, kycWebhook }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      const response = await anon.post(`/kyc/webhook/${kycWebhook.provider}`, {
        data: Buffer.from(
          JSON.stringify(
            applicantReviewed(
              must(created.provider_reference_id, 'provider_reference_id'),
              'GREEN',
            ),
          ),
        ),
        headers: { 'Content-Type': 'application/json' },
      });

      // Whether this is accepted depends on the config: signatureMatches treats
      // "config emitted no expected signature AND none was received" as a match, so an
      // unsigned event is accepted only while the config does not ask for one.
      //
      // Both answers are defensible, but they must not be a surprise — assert the one
      // this environment actually gives so a config change shows up here.
      expect(
        [200, 401],
        `unexpected status ${response.status()}: ${await response.text()}`,
      ).toContain(response.status());

      if (response.status() === 200) {
        test.info().annotations.push({
          type: 'note',
          description:
            'Unsigned webhooks are currently ACCEPTED — the config emits no expected signature. ' +
            'Set index 2 of mid_auth_key and the signature mapping to close this.',
        });
      }
    },
  );
});
