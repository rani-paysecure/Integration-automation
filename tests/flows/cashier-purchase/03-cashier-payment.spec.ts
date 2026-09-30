import { HttpStatus } from '@constants/http';
import {
  executeTransaction,
  expectPspChecks,
  markRedirectObserved,
  redirectMissedButSettled,
} from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import { cashierCardScenarios } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – transaction scenarios (REAL transactions at the PSP):
 *   create purchase (API) → open checkout_url → enter test card → PAY →
 *   redirect → final purchase status → PSP request/response (back-office).
 * One test per enabled card in the launcher's "Test cards" tab.
 */
const env = (process.env.TEST_ENV ?? 'uat').toLowerCase() === 'local' ? 'local' : 'uat';

test.describe(
  'Cashier purchase › transactions (test cards)',
  { tag: ['@cashier', '@cashier-payment', '@transaction'] },
  () => {
    for (const scenario of cashierCardScenarios(env)) {
      test(
        `${scenario.label} → ${scenario.expected.outcome}`,
        { tag: [`@card-${scenario.id}`] },
        async ({ purchaseApi, backoffice, openCashierPage, envData, merchant }, testInfo) => {
          const request = buildPurchaseRequest(envData, merchant);
          const created = await purchaseApi.createPurchase(request);
          expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
          testInfo.annotations.push(
            { type: 'purchase id', description: created.body.purchaseId },
            { type: 'card scenario', description: scenario.label },
            {
              type: 'expected',
              description: `${scenario.expected.outcome}, status ${scenario.expected.statuses.join('/')}`,
            },
          );

          const result = await executeTransaction(
            { purchaseApi, backoffice, openPage: openCashierPage },
            {
              purchaseId: created.body.purchaseId,
              checkoutUrl: created.body.checkout_url,
              card: scenario.card,
              request,
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

          if (redirectMissedButSettled(result, scenario.expected)) {
            markRedirectObserved(result, testInfo);
          } else {
            expect(
              result.cashier.outcome,
              `cashier outcome (${result.cashier.apiMessage || result.cashier.finalUrl})`,
            ).toBe(scenario.expected.outcome);
          }
          expect(scenario.expected.statuses, `final status ${result.finalStatus}`).toContain(
            result.finalStatus,
          );
          expectPspChecks(result.psp);
        },
      );
    }
  },
);
