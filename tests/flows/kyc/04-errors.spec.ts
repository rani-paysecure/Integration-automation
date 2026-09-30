import { test, expect, expectKycError } from '@fixtures/kyc.fixture';
import { newMerchantCustomerId } from '@test-data/kyc/customer';

/**
 * Validation and auth on POST /kyc/create.
 *
 * These need no provider and no browser, so they are the fastest honest signal that
 * the deployment is the build you think it is. Run this group first.
 *
 * The order of the assertions below mirrors the order of the guards in
 * KycOrchestrationService.findOrCreate, and that order is itself under test: country
 * is validated before the customer ids, so an empty body reports the country, not
 * the customer. Asserting the *first* failure is what pins the order down.
 */
test.describe('KYC verification › 4. Validation & auth – validation', () => {
  test(
    'KYC-08 · given an empty body, when create is called, then 400 country_required comes before customer_required',
    { tag: '@KYC-08' },
    async ({ api }) => {
      const response = await api.post('/kyc/create', { data: {} });
      await expectKycError(response, 400, 'country_required');
    },
  );

  test(
    'KYC-09 · given a country but no customer id, when create is called, then it returns 400 customer_required',
    { tag: '@KYC-09' },
    async ({ api, kycEnv }) => {
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country, test: true },
      });
      const body = await expectKycError(response, 400, 'customer_required');
      // The message names both accepted fields so the caller knows the choice exists.
      expect(body.message).toContain('customer_id');
      expect(body.message).toContain('merchant_cust_id');
    },
  );

  test(
    'KYC-08a · given a blank country, when create is called, then it returns 400 country_required',
    { tag: '@KYC-08a' },
    async ({ api }) => {
      const response = await api.post('/kyc/create', {
        data: { country: '   ', merchant_cust_id: newMerchantCustomerId(), test: true },
      });
      await expectKycError(response, 400, 'country_required');
    },
  );

  test(
    'KYC-10 · given an unknown customer_id, when create is called, then it returns 404 customer_not_found',
    { tag: '@KYC-10' },
    async ({ api, kycEnv }) => {
      const response = await api.post('/kyc/create', {
        // A well-formed ObjectId that will not exist.
        data: { country: kycEnv.country, test: true, customer_id: '000000000000000000000000' },
      });

      // A kyc_not_enabled here instead means this merchant has no KYC MID configured
      // on the dashboard — a precondition failure, not a bug in this assertion.
      const body = (await response.json()) as { code?: string };
      expect(
        body.code,
        'got kyc_not_enabled: this merchant has no KYC provider configured, so no ' +
          'create case in this suite can pass. Configure the MID before reading further failures.',
      ).not.toBe('kyc_not_enabled');

      await expectKycError(response, 404, 'customer_not_found');
      expect(((await response.json()) as { message: string }).message).toContain('customer_id');
    },
  );

  test(
    'KYC-10a · given an unknown merchant_cust_id, when create is called, then the 404 echoes the field sent',
    { tag: '@KYC-10a' },
    async ({ api, kycEnv }) => {
      const unknown = newMerchantCustomerId();
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country, test: true, merchant_cust_id: unknown },
      });
      const body = await expectKycError(response, 404, 'customer_not_found');
      expect(body.message).toContain('merchant_cust_id');
      expect(body.message).toContain(unknown);
    },
  );

  test(
    'KYC-03 · given unknown fields in the body, when create is called, then they are ignored, not rejected',
    { tag: '@KYC-03' },
    async ({ api, newCustomer, kycEnv }) => {
      // @JsonIgnoreProperties(ignoreUnknown = true) — retiring a field must not start
      // rejecting a merchant's requests. `product` is the real case: it used to exist.
      const customer = await newCustomer();
      const response = await api.post('/kyc/create', {
        data: {
          country: kycEnv.country,
          test: true,
          customer_id: customer.customerId,
          product: 'IDV',
          provider: 'sumsub',
          not_a_real_field: 'x',
        },
      });
      expect(response.status(), await response.text()).toBe(200);
    },
  );
});

test.describe('KYC verification › 4. Validation & auth – authentication', () => {
  test(
    'KYC-11a · given no Authorization header, when create is called, then it returns 401 authentication_failed',
    { tag: '@KYC-11a' },
    async ({ anon, kycEnv }) => {
      const response = await anon.post('/kyc/create', { data: { country: kycEnv.country } });
      await expectKycError(response, 401, 'authentication_failed');
    },
  );

  test(
    'KYC-11b · given a key with no Bearer prefix, when create is called, then it returns 401 authentication_failed',
    { tag: '@KYC-11b' },
    async ({ api, kycEnv }) => {
      // LookupService.authenticate requires the literal "Bearer " prefix before it
      // even looks the key up, so a bare key is rejected as unauthenticated.
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country },
        headers: { Authorization: kycEnv.apiKey },
      });
      await expectKycError(response, 401, 'authentication_failed');
    },
  );

  test(
    'KYC-11c · given an unknown key, when create is called, then it returns 401 authentication_failed',
    { tag: '@KYC-11c' },
    async ({ api, kycEnv }) => {
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country },
        headers: { Authorization: 'Bearer not-a-real-key' },
      });
      await expectKycError(response, 401, 'authentication_failed');
    },
  );

  test(
    'KYC-11d · given no Brand-Id header, when create is called, then it returns 403 access_denied',
    { tag: '@KYC-11d' },
    async ({ api, kycEnv }) => {
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country },
        headers: { 'Brand-Id': null, brandid: null },
      });
      await expectKycError(response, 403, 'access_denied');
    },
  );

  test(
    'KYC-11e · given a brand the key does not own, when create is called, then it returns 403 access_denied',
    { tag: '@KYC-11e' },
    async ({ api, kycEnv }) => {
      const other = '00000000-0000-0000-0000-000000000000';
      const response = await api.post('/kyc/create', {
        data: { country: kycEnv.country },
        headers: { 'Brand-Id': other, brandid: other },
      });
      await expectKycError(response, 403, 'access_denied');
    },
  );
});

test.describe('KYC verification › 4. Validation & auth – status read errors', () => {
  test(
    'KYC-12 · given an unknown kyc id, when status is read, then it returns 404 record_not_found',
    { tag: '@KYC-12' },
    async ({ api }) => {
      const response = await api.get('/kyc/KYC00000000000000000000000000000000');
      await expectKycError(response, 404, 'record_not_found');
    },
  );

  test(
    'KYC-12a · given no Authorization header, when status is read, then it returns 401 authentication_failed',
    { tag: '@KYC-12a' },
    async ({ anon }) => {
      const response = await anon.get('/kyc/KYC00000000000000000000000000000000');
      await expectKycError(response, 401, 'authentication_failed');
    },
  );
});
