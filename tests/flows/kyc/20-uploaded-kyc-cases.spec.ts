import { expect, test } from '@fixtures/kyc.fixture';
import { runUploadedKycCase, describeKycExpectation } from '@test-data/kyc/kyc-cases';
import { loadUploadedKycCases } from '@test-data/uploaded-cases/uploaded-cases';

/**
 * KYC validation – cases uploaded in the launcher (Test cases → KYC validation, KV-xxx).
 * Per case: optional new customer (with customer.* changes) → POST /kyc/create with
 * the request changes and the auth variant → HTTP, error code, KYC status, message.
 * Every create is sent with test=true.
 */
test.describe('KYC verification › 20. Uploaded KYC validation cases', () => {
  for (const kycCase of loadUploadedKycCases()) {
    test(
      `${kycCase.id} ${kycCase.title}`,
      {
        tag: [`@${kycCase.id}`],
        annotation: [{ type: 'expected', description: describeKycExpectation(kycCase.expected) }],
      },
      async ({ api, anon, newCustomer, kycEnv }, testInfo) => {
        const result = await runUploadedKycCase(
          kycCase,
          { api, anon, newCustomer, kycEnv },
          testInfo,
        );
        expect.soft(result.http, `HTTP (${result.summary})`).toBe(kycCase.expected.http);
        if (kycCase.expected.code !== undefined) {
          expect.soft(result.code, 'error code').toBe(kycCase.expected.code);
        }
        if (kycCase.expected.statuses !== undefined) {
          expect.soft(kycCase.expected.statuses, 'KYC status').toContain(result.status);
        }
        if (kycCase.expected.messageContains !== undefined) {
          expect.soft(result.message, 'message').toContain(kycCase.expected.messageContains);
        }
      },
    );
  }
});
