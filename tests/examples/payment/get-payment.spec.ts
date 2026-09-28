import { HttpStatus } from '@constants/http';
import { paymentResponseSchema } from '@schemas/payment.schema';
import { uniqueReference } from '@utils/id-generator';
import { expect, test } from '@fixtures/api.fixture';
import { buildPaymentRequest } from '@test-data/payment/payment-request.factory';

test.describe('Get payment – GET /payments/{id}', { tag: ['@payment', '@api'] }, () => {
  test(
    'returns a previously created payment',
    { tag: '@smoke' },
    async ({ paymentApi, envData }) => {
      const created = await paymentApi.createPayment(buildPaymentRequest(envData));
      expect(created).toHaveStatus(HttpStatus.CREATED);

      const response = await paymentApi.getPayment(created.body.paymentId);

      expect(response).toHaveStatus(HttpStatus.OK);
      expect(response).toMatchSchema(paymentResponseSchema);
      expect(response.body).toMatchObject({
        paymentId: created.body.paymentId,
        merchantReference: created.body.merchantReference,
        amount: created.body.amount,
        currency: created.body.currency,
      });
    },
  );

  test('returns 404 for an unknown payment id', { tag: '@negative' }, async ({ paymentApi }) => {
    const response = await paymentApi.getPayment(uniqueReference('MISSING'));

    expect(response).toHaveStatus(HttpStatus.NOT_FOUND);
  });
});
