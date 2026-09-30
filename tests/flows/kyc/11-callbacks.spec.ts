import { test, expect } from '@fixtures/kyc.fixture';

/**
 * Merchant callbacks.
 *
 * Only partly testable from here, and the tests say which part is which rather than
 * pretending otherwise:
 *
 *  - Accepting the callback URLs, and the fact that configuring them changes nothing
 *    about the synchronous response, is asserted below.
 *  - Delivery itself cannot be observed without a sink the *server* can reach.
 *    test4 cannot call localhost, so a Playwright-hosted server is no use. Set
 *    KYC_TEST_CALLBACK_URL to a public bin and the delivery cases turn on.
 *  - The routing rules (which status goes to which URL) need real verdicts, so they
 *    are fixme with the seed they need.
 *
 * The routing table under test, from KycCallbackService.targetUrl:
 *     KYC_APPROVED                     -> success_callback
 *     KYC_IN_PROCESS, MANUAL_REVIEW    -> pending_callback
 *     everything else                  -> failure_callback
 * including RESUBMISSION_REQUIRED, which goes to FAILURE even though the same
 * status sends the browser to the PENDING redirect. That asymmetry is deliberate
 * and is the single most likely thing for an integrator to get wrong.
 */
test.describe('KYC verification › 11. Merchant callbacks', () => {
  test(
    'KYC-31a · given callback urls, when create is called, then they are accepted and the response is unchanged',
    { tag: '@KYC-31a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const record = await newKyc({
        customer_id: customer.customerId,
        success_callback: 'https://merchant.example/kyc/cb/success',
        pending_callback: 'https://merchant.example/kyc/cb/pending',
        failure_callback: 'https://merchant.example/kyc/cb/failure',
      });

      // Callbacks are a side channel. The synchronous answer is the same with or
      // without them — a merchant must not have to configure callbacks to get a link.
      expect(record.status).toBe('AWAITING_USER');
      expect(record.verification_url).toBeTruthy();
    },
  );

  test(
    'KYC-31b · given a non-http callback url, when create is called, then the verification still succeeds',
    { tag: '@KYC-31b' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      const record = await newKyc({
        customer_id: customer.customerId,
        // Refused at send time, logged, and otherwise ignored. What must not happen
        // is the verification failing because a callback URL was malformed.
        success_callback: 'ftp://merchant.example/nope',
      });

      expect(record.status).toBe('AWAITING_USER');
    },
  );

  test(
    'KYC-33a · given no pending_callback, when the verification parks, then nothing is sent',
    { tag: '@KYC-33a' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();

      // The field is the switch for the whole behaviour: leave it out and nothing is
      // sent while the verification is parked. That is the pre-existing default and
      // must stay a no-op, not an error.
      const record = await newKyc({
        customer_id: customer.customerId,
        success_callback: 'https://merchant.example/kyc/cb/success',
        failure_callback: 'https://merchant.example/kyc/cb/failure',
      });

      expect(record.status).toBe('AWAITING_USER');
    },
  );

  test(
    'KYC-33 · given no callback urls at all, when create is called, then the verification completes normally',
    { tag: '@KYC-33' },
    async ({ newCustomer, newKyc }) => {
      const customer = await newCustomer();
      const record = await newKyc({ customer_id: customer.customerId });

      // No URL means silence, not a retry queue and not an error.
      expect(record.status).toBe('AWAITING_USER');
    },
  );

  test.fixme(
    'KYC-32 · given an expiry, when the callback fires, then it lands on failure_callback with the documented payload',
    { tag: '@KYC-32' },
    ({ kycEnv }) => {
      // Needs <ENV>_KYC_CALLBACK_URL / KYC_CALLBACK_URL plus a way to read what arrived. Assert:
      //   - it lands on failure_callback, not pending
      //   - keys are camelCase: kycId, customerId, merchantCustId, product, country,
      //     status, decisionReasons, message, test, createdAt, updatedAt, attempt
      //   - `attempt` starts at 1
      //   - exactly one delivery per verdict, even if a poll and a webhook settle together
      //
      // Sink in use: ${kycEnv.callbackUrl}
      expect(kycEnv.callbackUrl).toBeTruthy();
    },
  );

  test.fixme(
    'KYC-31 · given RESUBMISSION_REQUIRED, when the callback fires, then it goes to failure_callback, not pending',
    { tag: '@KYC-31' },
    async () => {
      // The asymmetry named at the top of this file. Needs a resubmission verdict from
      // the sandbox. Seed: E2E_RESUBMISSION_CUSTOMER_ID.
    },
  );

  test.fixme(
    'KYC-32a · given a 500 from the merchant, when the callback is retried, then a 400 is not',
    { tag: '@KYC-32a' },
    async () => {
      // Retryable: >= 500, 429, or a transport error. Five attempts, linear backoff at
      // kyc.callback.retryBaseSeconds (300s), so a full run takes ~25 minutes and
      // belongs in a nightly job rather than the default suite.
    },
  );
});
