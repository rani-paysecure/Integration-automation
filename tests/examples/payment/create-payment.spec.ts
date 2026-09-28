import { HttpStatus } from '@constants/http';
import { expectApiError, expectRequiredFields } from '@helpers/api-assertions';
import { paymentResponseSchema } from '@schemas/payment.schema';
import { omitPath, setPath } from '@utils/object';
import { expect, test } from '@fixtures/api.fixture';
import {
  amountBoundaryScenarios,
  descriptionBoundaryScenarios,
} from '@test-data/payment/boundary-payment-data';
import { invalidPaymentScenarios, toInvalidRequest } from '@test-data/payment/invalid-payment-data';
import { buildPaymentRequest } from '@test-data/payment/payment-request.factory';
import { validPaymentScenarios } from '@test-data/payment/valid-payment-data';

test.describe('Create payment – POST /payments', { tag: ['@payment', '@api'] }, () => {
  test(
    'creates a card payment with a valid request',
    { tag: '@smoke' },
    async ({ paymentApi, envData }) => {
      const request = buildPaymentRequest(envData);

      const response = await paymentApi.createPayment(request);

      expect(response).toHaveStatus(HttpStatus.CREATED);
      expect(response).toMatchSchema(paymentResponseSchema);
      expect(response).toHaveHeader('content-type', /application\/json/);
      expectRequiredFields(response.body, ['paymentId', 'status', 'paymentMethod.type']);

      // Business rules
      expect(response.body.amount).toBe(request.amount);
      expect(response.body.currency).toBe(request.currency);
      expect(response.body.merchantReference).toBe(request.merchantReference);
      expect(['PENDING', 'AUTHORIZED']).toContain(response.body.status);
      // Card data must never be echoed back in full
      expect(response.text).not.toContain(envData.cards.approved.cardNumber);
    },
  );

  for (const scenario of validPaymentScenarios) {
    test(`accepts ${scenario.title}`, { tag: '@regression' }, async ({ paymentApi, envData }) => {
      let request: Record<string, unknown> = {
        ...buildPaymentRequest(envData, scenario.overrides),
      };
      for (const path of scenario.omit ?? []) request = omitPath(request, path);

      const response = await paymentApi.createPayment(request);

      expect(response).toHaveStatus(HttpStatus.CREATED);
      expect(response).toMatchSchema(paymentResponseSchema);
    });
  }

  test.describe('validation', { tag: '@negative' }, () => {
    for (const scenario of invalidPaymentScenarios) {
      test(`rejects ${scenario.title}`, async ({ paymentApi, envData }) => {
        const valid = buildPaymentRequest(envData);
        const request = toInvalidRequest(valid, scenario);

        const response = await paymentApi.createPayment(request);

        expectApiError(response, {
          status: [scenario.expectedStatus, HttpStatus.UNPROCESSABLE_ENTITY],
          message: scenario.expectedMessage ?? /.+/,
        });
      });
    }
  });

  test.describe('boundaries', { tag: '@boundary' }, () => {
    test('amount limits', async ({ paymentApi, envData }) => {
      for (const scenario of amountBoundaryScenarios(envData)) {
        await test.step(scenario.title, async () => {
          const request = setPath(buildPaymentRequest(envData), scenario.field, scenario.value);
          const response = await paymentApi.createPayment(request);
          expect.soft(response).toHaveStatus(scenario.expectedStatus);
        });
      }
    });

    for (const scenario of descriptionBoundaryScenarios) {
      test(scenario.title, async ({ paymentApi, envData }) => {
        const request = setPath(buildPaymentRequest(envData), scenario.field, scenario.value);
        const response = await paymentApi.createPayment(request);
        expect(response).toHaveStatus(scenario.expectedStatus);
      });
    }
  });

  test.describe('security', { tag: '@security' }, () => {
    test('rejects a request without credentials', async ({ paymentApi, envData }) => {
      const response = await paymentApi.createPayment(buildPaymentRequest(envData), {
        skipAuth: true,
      });

      expect(response).toHaveStatus([HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN]);
    });
  });
});
