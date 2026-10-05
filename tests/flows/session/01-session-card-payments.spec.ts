import {
  challengeReshownObserved,
  expectPspChecks,
  markChallengeReshown,
} from '@helpers/transaction-flow';
import { createSession, executeSessionTransaction } from '@helpers/session-flow';
import { expect, test } from '@fixtures/api.fixture';
import { cashierCardScenarios } from '@test-data/cashier-purchase/cashier-cards';
import {
  buildCustomerRequest,
  buildSessionRequest,
  existingCustomerId,
  sessionCustomer,
} from '@test-data/session/session-request.factory';

/**
 * Session payment (REAL transactions at the PSP). Two ways to get the customer:
 *   new      – create customer (unique merchantCustomerId) → create session with its customerId
 *   existing – create session straight away for a customerId created earlier
 * then: open sessionUrl → card → PAY → 3DS → merchant redirect → back-office lookup by session
 * ID (row has the purchaseId) → final status, PSP request/response, merchant webhook.
 * Which one the card cases use is chosen on the launcher's Session data tab.
 */
const env = (process.env.TEST_ENV ?? 'uat').toLowerCase() === 'local' ? 'local' : 'uat';
const PAYMENT_TIMEOUT_MS = 240_000;

test.describe('Session › API', { tag: ['@session', '@session-api'] }, () => {
  test(
    'SES-001 new customer: create customer → create session',
    { tag: ['@SES-001'] },
    async ({ sessionApi, envData, merchant }, testInfo) => {
      const ids = await createSession(
        sessionApi,
        {
          brandId: merchant.brandId,
          customer: { mode: 'new', body: buildCustomerRequest(envData.session) },
          sessionBody: (customerId) =>
            buildSessionRequest(envData.session, envData.purchase, customerId, {
              currency: merchant.currency,
            }),
        },
        testInfo,
      );
      expect(ids.sessionUrl).toContain(ids.sessionId);
    },
  );

  test(
    'SES-002 existing customer: create session only',
    { tag: ['@SES-002'] },
    async ({ sessionApi, envData, merchant }, testInfo) => {
      const customerId = existingCustomerId(envData.session);
      test.skip(
        customerId === '',
        'No existing customer ID – enter one on the Session data tab (or set SESSION_CUSTOMER_ID)',
      );
      const ids = await createSession(
        sessionApi,
        {
          brandId: merchant.brandId,
          customer: { mode: 'existing', customerId },
          sessionBody: (id) =>
            buildSessionRequest(envData.session, envData.purchase, id, {
              currency: merchant.currency,
            }),
        },
        testInfo,
      );
      expect(ids.customerId).toBe(customerId);
      expect(ids.sessionUrl).toContain(ids.sessionId);
    },
  );
});

test.describe(
  'Session › transactions (test cards)',
  { tag: ['@session', '@session-payment', '@transaction'] },
  () => {
    for (const scenario of cashierCardScenarios(env)) {
      test(
        `${scenario.label} → ${scenario.expected.outcome}`,
        { tag: [`@session-card-${scenario.id}`] },
        async (
          { sessionApi, purchaseApi, backoffice, openCashierPage, envData, merchant },
          testInfo,
        ) => {
          testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS));
          testInfo.annotations.push(
            { type: 'card scenario', description: scenario.label },
            {
              type: 'expected',
              description: `${scenario.expected.outcome}, status ${scenario.expected.statuses.join('/')}`,
            },
          );
          const result = await executeSessionTransaction(
            { sessionApi, purchaseApi, backoffice, openPage: openCashierPage },
            {
              card: scenario.card,
              // Not sent to the API (a session only has a currency): chosen on the session page like a customer would
              paymentMethod: merchant.paymentMethod,
              brandId: merchant.brandId,
              // new customer (fresh unique body) or the existing customer ID of the Session data tab
              customer: sessionCustomer(envData.session),
              sessionBody: (customerId) =>
                buildSessionRequest(envData.session, envData.purchase, customerId, {
                  currency: merchant.currency,
                }),
              redirects: {
                success: envData.purchase.success_redirect,
                failure: envData.purchase.failure_redirect,
                pending: envData.purchase.pending_redirect,
              },
              expectedBank: merchant.expectedBank,
              expectedMid: merchant.expectedMid,
            },
            testInfo,
          );

          const observed = challengeReshownObserved(result, scenario.expected);
          if (observed) {
            markChallengeReshown(result, testInfo);
          } else {
            expect(
              result.cashier.outcome,
              `cashier outcome (${result.cashier.apiMessage || result.cashier.finalUrl})`,
            ).toBe(scenario.expected.outcome);
          }
          expect(scenario.expected.statuses, `final status ${result.finalStatus}`).toContain(
            result.finalStatus,
          );
          if (!observed) expectPspChecks(result.psp);
        },
      );
    }
  },
);
