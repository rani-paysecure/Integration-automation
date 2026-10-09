import { executeTransaction } from '@helpers/transaction-flow';
import {
  expectRegexOutcome,
  regexCaseRequest,
  rejectedBeforePsp,
} from '@helpers/uploaded-case-checks';
import { HttpStatus } from '@constants/http';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { loadUploadedRegexCases } from '@test-data/uploaded-cases/uploaded-cases';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 2: regex validation against the bank's field
 * regexes (dashboard → PaymentBankJsonData → Field Regex). REAL transaction
 * per case: the value is sent on the purchase, the customer pays, and the PSP
 * request (dashboard log) shows whether the value reached the PSP:
 *   matches the live regex        → must arrive unchanged
 *   does not match the live regex → must not arrive (it is replaced)
 * Product standard, with or without a bank regex: empty / null / missing values, and
 * placeholders (NA, n/a …) in full_name, must never reach the PSP – PGS rejects the
 * purchase or sends a DB value instead. Only the field's own keys are looked at.
 */
test.describe(
  'Cashier purchase › 2. Regex validation',
  { tag: ['@cashier', '@regex-validation', '@transaction'] },
  () => {
    for (const regexCase of loadUploadedRegexCases()) {
      test(
        `${regexCase.id} ${regexCase.title}`,
        { tag: [`@${regexCase.id}`] },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          const scenario = requireCaseCard(
            testConfig.env,
            undefined,
            testConfig.transaction.payCardId,
          );

          const { request, country } = regexCaseRequest(
            { ...buildPurchaseRequest(envData, merchant) },
            regexCase,
          );
          const created = await purchaseApi.createPurchase(request);
          // A blank value refused at create can never reach the PSP – that satisfies the rule.
          if (rejectedBeforePsp(regexCase, created, testInfo)) return;
          expect(created, 'The purchase must be created').toHaveStatus([
            HttpStatus.OK,
            HttpStatus.CREATED,
            HttpStatus.ACCEPTED,
          ]);
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
            },
            testInfo,
          );

          const usedBank = result.bank?.bankName ?? '';

          const rules = await test.step('bank field regexes (dashboard)', () =>
            backoffice.getFieldValidationRules(regexCase.bank ?? usedBank));

          expectRegexOutcome(regexCase, { usedBank, country, rules, bank: result.bank }, testInfo);
        },
      );
    }
  },
);
