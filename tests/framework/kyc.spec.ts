import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { customerPayload, newMerchantCustomerId } from '@test-data/kyc/customer';
import { createBody, sameInstant } from '@test-data/kyc/kyc';
import { applicantReviewed, misSigned, signed } from '@test-data/kyc/sign';

test.describe('KYC helpers (offline)', () => {
  test('webhook is signed over the exact bytes that are sent', () => {
    const event = applicantReviewed('abc123', 'RED', 'RETRY');
    const { raw, headers } = signed(event, 'secret');
    expect(headers['x-payload-digest']).toBe(
      createHmac('sha256', 'secret').update(raw).digest('hex'),
    );
    expect(JSON.parse(raw.toString('utf8'))).toMatchObject({
      applicantId: 'abc123',
      reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' },
    });
    expect(misSigned(event).headers['x-payload-digest']).not.toBe(headers['x-payload-digest']);
  });

  test('create body always has test=true and the run country', () => {
    expect(createBody({ customer_id: 'c1' }, 'GB')).toEqual({
      country: 'GB',
      test: true,
      customer_id: 'c1',
    });
  });

  test('customer payload: complete dummy data, overrides and omitted fields', () => {
    const id = newMerchantCustomerId();
    expect(id).toMatch(/^E2E[0-9A-F]{20}$/);
    const payload = customerPayload('brand-1', 'US', {
      merchantCustomerId: id,
      set: { city: 'Berlin' },
      omit: ['phoneNo'],
    });
    expect(payload).toMatchObject({ merchantCustomerId: id, brandID: 'brand-1', city: 'Berlin' });
    expect(payload).not.toHaveProperty('phoneNo');
    expect(String(payload.emailId)).toMatch(/@example\.com$/);
  });

  test('timestamps compare at millisecond precision', () => {
    expect(sameInstant('2026-09-28T07:41:49.531607928', '2026-09-28T07:41:49.531')).toBe(true);
    expect(sameInstant('2026-09-28T07:41:49.532', '2026-09-28T07:41:49.531')).toBe(false);
  });
});
