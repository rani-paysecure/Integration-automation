import { HttpStatus } from '@constants/http';
import {
  evaluatePspFieldChecks,
  PSP_FIELD_CHECKS_ANNOTATION,
  purchaseVars,
} from '@helpers/psp-field-checks';
import { executeTransaction, expectPspChecks } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { loadUploadedPspCases } from '@test-data/uploaded-cases/uploaded-cases';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 3: PSP request/response field checks (uploaded in
 * the launcher). One REAL transaction per case: create purchase → pay with the
 * card → PSP log from the dashboard → every check of the case, plus the
 * standard PSP checks (reference, amount, currency, routing …).
 */
test.describe(
  'Cashier purchase › 3. PSP request/response validation',
  { tag: ['@cashier', '@psp-validation', '@transaction'] },
  () => {
    for (const pspCase of loadUploadedPspCases()) {
      test(
        `${pspCase.id} ${pspCase.title}`,
        {
          tag: [`@${pspCase.id}`],
          annotation: [
            { type: 'expected', description: `${pspCase.checks.length} PSP field check(s) pass` },
          ],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          const scenario = requireCaseCard(
            testConfig.env,
            pspCase.card,
            testConfig.transaction.payCardId,
          );
          const request = buildPurchaseRequest(envData, merchant);
          const created = await purchaseApi.createPurchase(request);
          expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
          testInfo.annotations.push(
            { type: 'purchase id', description: created.body.purchaseId },
            { type: 'card scenario', description: scenario.label },
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

          const checks = await test.step('PSP field checks', () =>
            evaluatePspFieldChecks(
              result.bank,
              pspCase.checks,
              purchaseVars(request, created.body.purchaseId),
            ));

          testInfo.annotations.push({
            type: PSP_FIELD_CHECKS_ANNOTATION,
            description: JSON.stringify(checks),
          });
          for (const check of checks) {
            expect
              .soft(check.passed, `${check.name}: expected ${check.expected}, got ${check.actual}`)
              .toBe(true);
          }
          expectPspChecks(result.psp);
        },
      );
    }
  },
);
