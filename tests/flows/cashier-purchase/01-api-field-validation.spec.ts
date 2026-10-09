import type { TestInfo } from '@playwright/test';
import type { BackofficeClient } from '@clients/backoffice-client';
import type { PurchaseApiClient } from '@clients/purchase-api-client';
import {
  applyFieldCase,
  casePaymentMethod,
  expectStoredAsSent,
  FIELD_PSP_RESPONSE_ANNOTATION,
  FIELD_PSP_RULE_ANNOTATION,
  fieldCaseAnnotation,
  recordFieldResult,
  verifyFieldExpectation,
  type FieldTestCase,
} from '@helpers/field-testing';
import {
  CUSTOMER_DATA_RULE_TEXT,
  customerDataRule,
  customerDataVerdict,
  fieldPaymentVerdict,
  isPspCheckedCase,
  type FieldPaymentVerdict,
} from '@helpers/field-payment-checks';
import { executeTransaction } from '@helpers/transaction-flow';
import { purchaseCreatedSchema, type PurchaseCreated } from '@schemas/purchase.schema';
import type { ApiResponse } from '@app-types/api.types';
import type { TestConfig } from '@app-types/config.types';
import { expect, type Page } from '@playwright/test';
import { test } from '@fixtures/api.fixture';
import { fieldTestCases } from '@test-data/cashier-purchase/api-field-cases';
import { findCardScenario, requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import type { EnvironmentTestData } from '@test-data/environments';
import {
  loadUploadedFieldCases,
  removedBuiltinCaseIds,
} from '@test-data/uploaded-cases/uploaded-cases';
import {
  buildPurchaseRequest,
  type MerchantContext,
} from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 1: Paysecure API field validation.
 * One test per row of "field_test_cases 1.xlsx" against POST /v1/purchases/,
 * plus the cases uploaded in the launcher (uploaded-cases/field-validation.json).
 *
 * Two sub-categories:
 * 1. API field validation – fields the purchase API validates (e-mail, country, currency,
 *    amount, expiry, redirects …): the create answer decides.
 * 1b. Customer data at the PSP – name, street, city, zip, state, phone, date of birth. The
 *    API accepts any value for them (202 CREATED, confirmed on test4), so every case is paid
 *    and judged on the PSP request: NA / null / empty / not sent must never reach the PSP,
 *    valid values must arrive unchanged, anything else is recorded with the PSP's answer.
 *
 * When the run enables "Also pay for accepted field cases" (launcher),
 * every ACCEPTED (or OBSERVED and created) case continues into a real transaction: cashier → PSP →
 * back-office. The case still tests ONE field: it passes when that field's value
 * is carried correctly (API response, stored purchase, PSP request) – whatever the
 * payment result. Declines, purchase-ID mapping and other PSP checks are reported
 * as "not part of this case" and never fail it (see field-payment-checks.ts).
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
    // Accepted cases, and observed ones that were created (NA / null / empty …): pay and record.
    !['accepted', 'observe'].includes(testCase.expectation) ||
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

  judgeAndRecord(
    fieldPaymentVerdict(await verdictInput(testCase, response, request, deps.purchaseApi, result)),
    testCase,
    testInfo,
  );
}

type PaidResult = Awaited<ReturnType<typeof executeTransaction>>;

async function verdictInput(
  testCase: FieldTestCase,
  response: ApiResponse<PurchaseCreated>,
  request: Record<string, unknown>,
  purchaseApi: PurchaseApiClient,
  result: PaidResult,
): Promise<Parameters<typeof fieldPaymentVerdict>[0]> {
  const stored = await purchaseApi
    .getPurchase(response.body.purchaseId)
    .then((r) => (r.ok ? (r.body as unknown) : undefined))
    .catch(() => undefined);
  return {
    testCase,
    request,
    created: response.body,
    stored,
    psp: result.psp,
    bank: result.bank,
    finalStatus: result.finalStatus,
    cashierOutcome: result.cashier.outcome,
  };
}

/** Records the verdict for the reports and soft-asserts the checks about the field. */
function judgeAndRecord(
  verdict: FieldPaymentVerdict & { readonly recordOnly?: boolean; readonly sentToPsp?: string },
  testCase: FieldTestCase,
  testInfo: TestInfo,
): void {
  testInfo.annotations.push({
    type: FIELD_PSP_RESPONSE_ANNOTATION,
    description: verdict.pspResponse,
  });
  if (verdict.sentToPsp !== undefined) {
    testInfo.annotations.push({ type: 'sent to PSP', description: verdict.sentToPsp });
  }
  if (verdict.checks.length > 0) {
    testInfo.annotations.push({
      type: `checks for ${testCase.path}`,
      description: verdict.checks
        .map((c) => `${c.passed ? '✓' : '✗'} ${c.name}: expected ${c.expected}, got ${c.actual}`)
        .join('\n'),
    });
  }
  if (verdict.info.length > 0) {
    testInfo.annotations.push({ type: 'note', description: verdict.info.join('\n') });
  }
  if (verdict.separate.length > 0) {
    testInfo.annotations.push({
      type: 'not part of this case (reported only)',
      description: verdict.separate.join('\n'),
    });
  }
  if (verdict.recordOnly === true) {
    testInfo.annotations.push({ type: 'verdict', description: 'observe' });
  } else if (verdict.unverifiable) {
    testInfo.annotations.push(
      { type: 'verdict', description: 'observe' },
      {
        type: 'error message',
        description: `${testCase.path} is not returned by the API and not sent to the PSP – it could not be verified`,
      },
    );
  }
  for (const check of verdict.checks) {
    expect
      .soft(check.passed, `${check.name}: expected ${check.expected}, got ${check.actual}`)
      .toBe(true);
  }
}

// Built-in cases (FT-xxx, minus those removed on the launcher's Test cases tab) + uploaded cases (FV-xxx).
const REMOVED_BUILTIN = removedBuiltinCaseIds();
const ALL_CASES: readonly FieldTestCase[] = [
  ...fieldTestCases.filter((c) => !REMOVED_BUILTIN.has(c.id)),
  ...loadUploadedFieldCases(),
];
const AUTH_FAILURES = [401, 403];

test.describe(
  'Cashier purchase › 1. API field validation',
  { tag: ['@cashier', '@field-validation'] },
  () => {
    // API-validated fields (the PSP-checked ones run in the block below).
    for (const testCase of ALL_CASES.filter((c) => !isPspCheckedCase(c))) {
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

test.describe(
  'Cashier purchase › 1b. Field validation – customer data at the PSP',
  { tag: ['@cashier', '@field-validation', '@customer-data-psp', '@transaction'] },
  () => {
    for (const testCase of ALL_CASES.filter((c) => isPspCheckedCase(c))) {
      const rule = customerDataRule(testCase);

      test(
        `${testCase.id} ${testCase.parameter} – ${testCase.title}`,
        {
          tag: [`@${testCase.id}`, `@${testCase.expectation}`],
          annotation: [
            fieldCaseAnnotation(testCase),
            { type: FIELD_PSP_RULE_ANNOTATION, description: CUSTOMER_DATA_RULE_TEXT[rule] },
          ],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          test.skip(testCase.cashierOnly === true, testCase.apiNote ?? 'Cashier-only case');
          const request = applyFieldCase(buildPurchaseRequest(envData, merchant), testCase);
          const response = await purchaseApi.createPurchase(request);
          recordFieldResult(testInfo, response);
          expect(response.status, 'server error on customer data').toBeLessThan(500);
          expect(AUTH_FAILURES, 'authentication problem, not a field result').not.toContain(
            response.status,
          );
          // NA / blank refused at create can never reach the PSP – that also satisfies the rule.
          const refusedBeforePsp = rule === 'not-passed' && !response.ok;
          testInfo.annotations.push({
            type: 'sent to PSP',
            description: refusedBeforePsp
              ? `never – rejected at create (HTTP ${String(response.status)})`
              : 'see payment',
          });
          expect(
            response.ok || refusedBeforePsp,
            'The purchase API does not validate customer data – expected 202 CREATED',
          ).toBe(true);
          test.skip(refusedBeforePsp, 'Rejected at create – the value never reaches the PSP');

          const scenario = requireCaseCard(
            testConfig.env,
            undefined,
            testConfig.transaction.payCardId,
          );
          testInfo.annotations.push({ type: 'card scenario', description: scenario.label });
          const result = await executeTransaction(
            { purchaseApi, backoffice, openPage: openCashierPage },
            {
              purchaseId: response.body.purchaseId,
              checkoutUrl: response.body.checkout_url,
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
          judgeAndRecord(
            customerDataVerdict(
              await verdictInput(testCase, response, request, purchaseApi, result),
            ),
            testCase,
            testInfo,
          );
        },
      );
    }
  },
);
