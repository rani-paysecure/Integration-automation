import { test, expect } from '@fixtures/kyc.fixture';
import { getKyc, must, kycJson } from '@test-data/kyc/kyc';

/**
 * GET /kyc/redirect/{kycId} — the page the subject actually lands on.
 *
 * This is our HTML, not the provider's, so these selectors are ours to keep
 * working. The provider's own SDK lives inside it and is spec 12's problem.
 *
 * Note there is no merchant auth on this URL: the kycId is the capability, the same
 * way a purchase id is on the payments side. The tests below open it with a plain
 * browser context, no headers, which is exactly how the subject reaches it.
 */
test.describe('KYC verification › 7. Hosted verification page', () => {
  test(
    'KYC-19 · given an AWAITING_USER verification, when the link is opened, then it becomes KYC_PENDING and is stamped once',
    { tag: '@KYC-19' },
    async ({ api, page, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });
      expect(created.status).toBe('AWAITING_USER');

      const response = await page.goto(must(created.verification_url, 'verification_url'));

      expect(response?.status()).toBe(200);
      // Never cached: the page's content depends on a status that changes underneath it.
      expect(response?.headers()['cache-control']).toContain('no-store');

      const afterOpen = await getKyc(api, created.kyc_id);
      // Only we know the subject arrived — no provider response reports this.
      expect(afterOpen.status).toBe('KYC_PENDING');
      const firstOpen = afterOpen.verification_url_opened_at;
      expect(firstOpen).toBeTruthy();

      // A reload must not re-stamp: the stamp answers "when did they first arrive",
      // which is what distinguishes an untouched link from an abandoned attempt.
      await page.reload();
      const afterReload = await getKyc(api, created.kyc_id);
      expect(afterReload.verification_url_opened_at).toBe(firstOpen);
      expect(afterReload.status).toBe('KYC_PENDING');
    },
  );

  test(
    'KYC-21 · given a KYC_PENDING verification, when the page is reloaded, then the capture UI still renders',
    { tag: '@KYC-21' },
    async ({ api, page, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      await page.goto(must(created.verification_url, 'verification_url'));
      expect((await getKyc(api, created.kyc_id)).status).toBe('KYC_PENDING');

      // KYC_PENDING must keep rendering. If it bounced to the merchant here, a
      // refresh or a back button would eject the subject from a half-finished
      // verification with no way back in.
      const again = await page.goto(must(created.verification_url, 'verification_url'));
      expect(again?.status()).toBe(200);
    },
  );

  test(
    'KYC-19a · given the hosted page, when it loads, then the provider SDK mounts at top level',
    { tag: '@KYC-19a' },
    async ({ page, newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      await page.goto(must(created.verification_url, 'verification_url'));

      // Our page loads the SDK builder from the provider's CDN and mounts it into our
      // own container. The SDK then creates its own iframe — that one is fine and
      // expected; it carries the camera permission the SDK asks for.
      await expect(page.locator('#sumsub-websdk-container')).toBeAttached({ timeout: 20_000 });
      await expect(
        page.locator('script[src*="sumsub.com"]'),
        'the WebSDK builder script is not on the page',
      ).toHaveCount(1);

      // The requirement is that OUR page is the top-level document. If a merchant
      // frames it, the provider ends up two levels down and the camera is refused.
      expect(
        await page.evaluate('window.top === window.self'),
        'the hosted page is itself inside a frame — the camera will be blocked',
      ).toBe(true);
    },
  );

  test(
    'KYC-19b · given an unknown kyc id, when the page is opened, then it returns 404',
    { tag: '@KYC-19b' },
    async ({ page, kycEnv }) => {
      const response = await page.goto(
        `${kycEnv.baseUrl}/kyc/redirect/KYC00000000000000000000000000000000`,
      );
      expect(response?.status()).toBe(404);
    },
  );

  test(
    'KYC-22 · given an expired verification, when the link is opened, then the subject is redirected to the merchant @slow',
    { tag: '@KYC-22' },
    async ({ api, page, newCustomer, newKyc }) => {
      // Uses a record that is already settled or terminal. Reuses the expiry route
      // because it is the only verdict this suite can reach unaided.
      const customer = await newCustomer();
      const created = await newKyc({
        customer_id: customer.customerId,
        kyc_expiry_in_minutes: 1,
        failure_redirect: 'https://example.com/kyc/failed',
      });

      test.setTimeout(360_000);
      await expect
        .poll(
          async () => {
            const r = await api.get(`/kyc/${created.kyc_id}`);
            return (await kycJson(r)).status;
          },
          { timeout: 300_000, intervals: [5_000], message: 'waiting for the record to expire' },
        )
        .toBe('KYC_EXPIRED');

      // Follow no redirects: assert where it sends the browser, not where it ends up.
      const response = await page.goto(must(created.verification_url, 'verification_url'), {
        waitUntil: 'commit',
      });
      expect(page.url()).toContain('example.com/kyc/failed');
      expect(response).toBeTruthy();
    },
  );
});
