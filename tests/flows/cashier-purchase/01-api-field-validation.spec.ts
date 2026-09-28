import {
  applyFieldCase,
  fieldCaseAnnotation,
  recordFieldResult,
  verifyFieldExpectation,
} from '@helpers/field-testing';
import { purchaseCreatedSchema } from '@schemas/purchase.schema';
import { test } from '@fixtures/api.fixture';
import { fieldTestCases } from '@test-data/cashier-purchase/api-field-cases';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 1: Paysecure API field validation.
 * One test per row of "field_test_cases 1.xlsx" against POST /v1/purchases/
 * (card / VISA). Results: reports/field-tests/field-test-results.csv.
 */
test.describe(
  'Cashier purchase › 1. API field validation (card / VISA)',
  { tag: ['@cashier', '@field-validation'] },
  () => {
    for (const testCase of fieldTestCases) {
      test(
        `${testCase.id} ${testCase.parameter} – ${testCase.title}`,
        {
          tag: [`@${testCase.expectation}`],
          annotation: [fieldCaseAnnotation(testCase)],
        },
        async ({ purchaseApi, envData, merchant }, testInfo) => {
          test.skip(testCase.cashierOnly === true, testCase.apiNote ?? 'Cashier-only case');

          const request = applyFieldCase(buildPurchaseRequest(envData, merchant), testCase);

          const response = await purchaseApi.createPurchase(request);

          recordFieldResult(testInfo, response);
          verifyFieldExpectation(response, testCase, { successSchema: purchaseCreatedSchema });
        },
      );
    }
  },
);
