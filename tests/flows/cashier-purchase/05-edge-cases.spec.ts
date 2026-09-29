import { HttpStatus } from '@constants/http';
import { executeTransaction } from '@helpers/transaction-flow';
import { describeEdgeExpectation, expectEdgeOutcome } from '@helpers/uploaded-case-checks';
import { omitPath, setPath } from '@utils/object';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { loadUploadedEdgeCases } from '@test-data/uploaded-cases/uploaded-cases';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 4: custom & edge cases (uploaded in the launcher).
 * REAL transaction per case: request changes → create purchase → pay with the
 * card → compare cashier result, final status and error / PSP message.
 */
test.describe(
  'Cashier purchase › 4. Custom & edge cases',
  { tag: ['@cashier', '@edge-cases', '@transaction'] },
  () => {
    for (const edgeCase of loadUploadedEdgeCases()) {
      test(
        `${edgeCase.id} ${edgeCase.title}`,
        {
          tag: [`@${edgeCase.id}`],
          annotation: [
            { type: 'expected', description: describeEdgeExpectation(edgeCase.expected) },
          ],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          const scenario = requireCaseCard(
            testConfig.env,
            edgeCase.card,
            testConfig.transaction.payCardId,
          );
          let request: Record<string, unknown> = { ...buildPurchaseRequest(envData, merchant) };
          for (const [path, value] of Object.entries(edgeCase.set ?? {})) {
            request = setPath(request, path, value);
          }
          for (const path of edgeCase.remove ?? []) request = omitPath(request, path);

          const created = await purchaseApi.createPurchase(request);
          expect(
            created,
            'The purchase must be created – request rules belong in Field validation',
          ).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
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
              redirects: {
                success: envData.purchase.success_redirect,
                failure: envData.purchase.failure_redirect,
                pending: envData.purchase.pending_redirect,
              },
            },
            testInfo,
          );

          expectEdgeOutcome(result, edgeCase.expected, testInfo);
        },
      );
    }
  },
);
