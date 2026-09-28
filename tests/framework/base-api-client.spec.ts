import { expect as baseExpect, test, type APIRequestContext } from '@playwright/test';
import { ApiRequestError } from '@clients/api-error';
import { PaymentApiClient } from '@clients/payment-api-client';
import { expect } from '@helpers/api-matchers';
import { expectApiError } from '@helpers/api-assertions';
import type { HttpExchange } from '@app-types/api.types';
import { createLogger } from '@utils/logger';
import { startMockServer, type MockServer } from './support/mock-server';

const logger = createLogger({ level: 'silent' });

test.describe('BaseApiClient (offline, against a local mock server)', () => {
  let server: MockServer;

  test.beforeAll(async () => {
    server = await startMockServer((req) => {
      if (req.url.startsWith('/api/v1/payments/missing')) {
        return { status: 404, body: { code: 'NOT_FOUND', message: 'Payment not found' } };
      }
      if (req.method === 'POST' && req.url === '/api/v1/payments') {
        return {
          status: 201,
          body: { paymentId: 'pay_1', echoedCard: '4111111111111111' },
          headers: { 'x-correlation-id': 'corr-1' },
        };
      }
      return { status: 200, body: { ok: true } };
    });
  });

  test.afterAll(async () => {
    await server.close();
  });

  function client(request: APIRequestContext, exchanges: HttpExchange[]): PaymentApiClient {
    return new PaymentApiClient({
      request,
      baseUrl: server.url,
      logger,
      timeoutMs: 5_000,
      logBodies: true,
      defaultHeaders: { 'x-test-environment': 'qa' },
      authHeaders: () => Promise.resolve({ 'x-api-key': 'super-secret-key' }),
      onExchange: (exchange) => exchanges.push(exchange),
    });
  }

  test('keeps the base path, sends default + auth headers and parses JSON', async ({ request }) => {
    const exchanges: HttpExchange[] = [];
    const response = await client(request, exchanges).createPayment({ amount: 1 });

    expect(response).toHaveStatus(201);
    expect(response).toHaveHeader('x-correlation-id', 'corr-1');
    baseExpect(response.body).toMatchObject({ paymentId: 'pay_1' });

    const received = server.requests.at(-1);
    baseExpect(received?.url).toBe('/api/v1/payments');
    baseExpect(received?.headers['x-api-key']).toBe('super-secret-key');
    baseExpect(received?.headers['x-test-environment']).toBe('qa');
    baseExpect(received?.headers['idempotency-key']).toBeTruthy();
  });

  test('never exposes secrets in captured exchanges', async ({ request }) => {
    const exchanges: HttpExchange[] = [];
    await client(request, exchanges).createPayment({
      card: { cardNumber: '4111111111111111', cvv: '999' },
    });

    const serialised = JSON.stringify(exchanges);
    baseExpect(serialised).not.toContain('super-secret-key');
    baseExpect(serialised).not.toContain('4111111111111111');
    baseExpect(serialised).not.toContain('"999"');
  });

  test('skipAuth omits authentication headers', async ({ request }) => {
    await client(request, []).getPayment('abc', { skipAuth: true });
    baseExpect(server.requests.at(-1)?.headers['x-api-key']).toBeUndefined();
  });

  test('returns (does not throw) HTTP error responses', async ({ request }) => {
    const response = await client(request, []).getPayment('missing');
    expectApiError(response, { status: 404, code: 'NOT_FOUND', message: 'not found' });
  });

  test('wraps transport failures in ApiRequestError', async ({ request }) => {
    const unreachable = new PaymentApiClient({
      request,
      baseUrl: 'http://127.0.0.1:1',
      logger,
      timeoutMs: 2_000,
      logBodies: false,
    });
    await baseExpect(unreachable.getPayment('x')).rejects.toBeInstanceOf(ApiRequestError);
  });
});
