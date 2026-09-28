import { HttpStatus } from '@constants/http';
import { paymentResponseSchema, refundResponseSchema } from '@schemas/payment.schema';
import { expect, test } from '@fixtures/api.fixture';
import { buildPaymentRequest } from '@test-data/payment/payment-request.factory';

/**
 * End-to-end integration flow: create → wait for authorisation → capture → refund.
 * Steps share state, so the flow runs serially inside one test.
 */
test.describe('Payment lifecycle', { tag: ['@integration', '@payment'] }, () => {
  test('card payment can be authorised, captured and refunded', async ({
    paymentApi,
    envData,
    testConfig,
  }) => {
    test.skip(
      !testConfig.settings.allowDestructiveTests,
      `Destructive tests are disabled in ${testConfig.settings.displayName}`,
    );

    const request = buildPaymentRequest(envData, { amount: 2_500 });

    const paymentId = await test.step('create payment', async () => {
      const response = await paymentApi.createPayment(request);
      expect(response).toHaveStatus(HttpStatus.CREATED);
      expect(response).toMatchSchema(paymentResponseSchema);
      return response.body.paymentId;
    });

    await test.step('wait until authorised', async () => {
      // Async processing: poll with Playwright's built-in retrying assertion.
      await expect
        .poll(async () => (await paymentApi.getPayment(paymentId)).body.status, {
          message: `payment ${paymentId} should reach AUTHORIZED`,
          intervals: [1_000, 2_000, 5_000],
          timeout: 60_000,
        })
        .toBe('AUTHORIZED');
    });

    await test.step('capture payment', async () => {
      const response = await paymentApi.capturePayment(paymentId);
      expect(response).toHaveStatus([HttpStatus.OK, HttpStatus.ACCEPTED]);
      expect(response.body.status).toMatch(/CAPTURED|SETTLED/);
    });

    await test.step('refund full amount', async () => {
      const response = await paymentApi.refundPayment(paymentId, {
        amount: request.amount,
        reason: 'Automated lifecycle test',
      });
      expect(response).toHaveStatus([HttpStatus.CREATED, HttpStatus.ACCEPTED]);
      expect(response).toMatchSchema(refundResponseSchema);
      expect(response.body.amount).toBe(request.amount);
    });

    await test.step('payment reflects the refund', async () => {
      await expect
        .poll(async () => (await paymentApi.getPayment(paymentId)).body.status, {
          timeout: 60_000,
        })
        .toBe('REFUNDED');
    });
  });
});
