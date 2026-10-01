import type { TestInfo } from '@playwright/test';
import type { BackofficeClient } from '@clients/backoffice-client';
import type { PurchaseApiClient } from '@clients/purchase-api-client';
import {
  applyFieldCase,
  casePaymentMethod,
  expectStoredAsSent,
  fieldCaseAnnotation,
  recordFieldResult,
  verifyFieldExpectation,
  type FieldTestCase,
} from '@helpers/field-testing';
import { executeTransaction, expectPspChecks } from '@helpers/transaction-flow';
import { purchaseCreatedSchema, type PurchaseCreated } from '@schemas/purchase.schema';
import type { ApiResponse } from '@app-types/api.types';
import type { TestConfig } from '@app-types/config.types';
import type { Page } from '@playwright/test';
import { test } from '@fixtures/api.fixture';
import { fieldTestCases } from '@test-data/cashier-purchase/api-field-cases';
import { findCardScenario } from '@test-data/cashier-purchase/cashier-cards';
import type { EnvironmentTestData } from '@test-data/environments';
import { loadUploadedFieldCases } from '@test-data/uploaded-cases/uploaded-cases';
import {
  buildPurchaseRequest,
  type MerchantContext,
} from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 1: Paysecure API field validation.
 * One test per row of "field_test_cases 1.xlsx" against POST /v1/purchases/,
 * plus the cases uploaded in the launcher (uploaded-cases/field-validation.json).
 *
 * When the run enables "Also pay for accepted field cases" (launcher),
 * every ACCEPTED case continues into a real transaction: cashier → PSP →
 * back-office checks – validating that valid requests reach the PSP.
 */
async function completeTransactionIfSelected(
  testCase: FieldTestCase,
  response: ApiResponse<PurchaseCreated>,
  request: Record<string, unknown>,
  deps: {
    testConfig: TestConfig;
    envData: EnvironmentTestData;
    merchant: MerchantContext;
    purchaseApi: PurchaseApiClient;
    backoffice: BackofficeClient;
    openCashierPage: () => Promise<Page>;
  },
  testInfo: TestInfo,
): Promise<void> {
  const cardId = deps.testConfig.transaction.payCardId;
  if (
    !deps.testConfig.transaction.payFieldCases ||
    cardId === undefined ||
    testCase.expectation !== 'accepted' ||
    !response.ok
  ) {
    return;
  }
  const scenario = findCardScenario(deps.testConfig.env, cardId);
  if (scenario === undefined) throw new Error(`Test card "${cardId}" not found in settings`);
  testInfo.annotations.push({ type: 'card scenario', description: scenario.label });
  const result = await executeTransaction(
    { purchaseApi: deps.purchaseApi, backoffice: deps.backoffice, openPage: deps.openCashierPage },
    {
      purchaseId: response.body.purchaseId,
      checkoutUrl: response.body.checkout_url,
      card: scenario.card,
      request,
      redirects: {
        success: deps.envData.purchase.success_redirect,
        failure: deps.envData.purchase.failure_redirect,
        pending: deps.envData.purchase.pending_redirect,
      },
      expectedBank: deps.merchant.expectedBank,
      expectedMid: deps.merchant.expectedMid,
    },
    testInfo,
  );
  expectPspChecks(result.psp);
}

test.describe(
  'Cashier purchase › 1. API field validation',
  { tag: ['@cashier', '@field-validation'] },
  () => {
    // Built-in cases (FT-xxx) + cases uploaded in the launcher (FV-xxx).
    for (const testCase of [...fieldTestCases, ...loadUploadedFieldCases()]) {
      test(
        `${testCase.id} ${testCase.parameter} – ${testCase.title}`,
        {
          tag: [`@${testCase.id}`, `@${testCase.expectation}`],
          annotation: [fieldCaseAnnotation(testCase)],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          test.skip(testCase.cashierOnly === true, testCase.apiNote ?? 'Cashier-only case');

          // The case's payment method (context paymentMethod=…) picks its Purchase data fields.
          const paymentMethod = casePaymentMethod(testCase) ?? merchant.paymentMethod;
          const request = applyFieldCase(
            buildPurchaseRequest(envData, { ...merchant, paymentMethod }),
            testCase,
          );

          const response = await purchaseApi.createPurchase(request);

          recordFieldResult(testInfo, response);
          // A payment method the merchant does not allow says nothing about the field.
          const notAllowed =
            casePaymentMethod(testCase) !== undefined &&
            response.status === 400 &&
            response.text.includes('payment_method_not_allowed');
          test.skip(
            notAllowed,
            `The merchant does not allow payment method ${casePaymentMethod(testCase) ?? ''} – enable it for the tester's merchant to run this case`,
          );
          verifyFieldExpectation(response, testCase, { successSchema: purchaseCreatedSchema });
          expectStoredAsSent(response, testCase);
          await completeTransactionIfSelected(
            testCase,
            response,
            request,
            { testConfig, envData, merchant, purchaseApi, backoffice, openCashierPage },
            testInfo,
          );
        },
      );
    }
  },
);
