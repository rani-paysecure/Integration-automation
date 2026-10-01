import { HttpStatus } from '@constants/http';
import { isCardPaymentMethod } from '@helpers/card-methods';
import { executeS2sTransaction, expectPendingCallback, type S2sResult } from '@helpers/s2s-flow';
import { expectPspChecks } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import type { TestInfo } from '@playwright/test';
import type { CashierCardScenario } from '@app-types/cashier.types';
import { cashierCardScenarios, requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';
import { buildS2sRequest } from '@test-data/s2s/s2s-request.factory';

/**
 * S2S purchase – card payments (REAL transactions at the PSP):
 *   Purchase API (CREATED + purchaseId, checkout_url NOT opened) → S2S API with card +
 *   browser data → 202 pending + callback_url → callback opened in the browser → 3DS (if the
 *   bank asks) → merchant redirect → final status, PSP request/response, merchant webhook.
 *   A 2D merchant is paid inside the S2S call (no callback) – its webhook carries the result.
 * Card payment methods only (VISA, MASTER, AMEX …): APMs are skipped – PGS has no S2S for them.
 */
const env = (process.env.TEST_ENV ?? 'uat').toLowerCase() === 'local' ? 'local' : 'uat';
const PAYMENT_TIMEOUT_MS = 240_000;

type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
type Deps = Pick<
  Fixtures,
  'purchaseApi' | 'backoffice' | 'openCashierPage' | 'envData' | 'merchant' | 'testConfig'
>;

/** Skips when the run's payment method is not a card. */
async function requireCardMethod(f: Deps, testInfo: TestInfo): Promise<void> {
  const method = f.merchant.paymentMethod;
  const { card, source } = await isCardPaymentMethod(method, f.backoffice);
  testInfo.annotations.push({
    type: 'payment method',
    description: `${method} – ${card ? 'card' : 'not a card'} (${source})`,
  });
  test.skip(
    !card,
    `S2S is only for card payment methods (VISA, MASTER, AMEX …) – ${method} is not a card`,
  );
}

async function payS2s(
  f: Deps,
  scenario: CashierCardScenario,
  rememberCard: 'on' | 'off',
  testInfo: TestInfo,
): Promise<{ purchaseId: string; result: S2sResult }> {
  testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS));
  const request = buildPurchaseRequest(f.envData, f.merchant);
  const created = await f.purchaseApi.createPurchase(request);
  expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
  expect(created.body.status.toUpperCase(), 'purchase status').toBe('CREATED');
  const purchaseId = created.body.purchaseId;
  testInfo.annotations.push(
    { type: 'purchase id', description: purchaseId },
    { type: 'card scenario', description: scenario.label },
    { type: 'remember card', description: rememberCard },
  );
  const result = await executeS2sTransaction(
    { purchaseApi: f.purchaseApi, backoffice: f.backoffice, openPage: f.openCashierPage },
    {
      purchaseId,
      card: scenario.card,
      body: buildS2sRequest(scenario.card, { rememberCard, template: f.envData.s2s }),
      request,
      redirects: {
        success: f.envData.purchase.success_redirect,
        failure: f.envData.purchase.failure_redirect,
        pending: f.envData.purchase.pending_redirect,
      },
      expectedBank: f.merchant.expectedBank,
      expectedMid: f.merchant.expectedMid,
    },
    testInfo,
  );
  return { purchaseId, result };
}

/**
 * S2S answer, outcome and status as the card scenario expects (Test cards tab). A card the
 * cashier rejects up front (e.g. invalid card details) is rejected by the S2S API instead.
 */
function expectScenario(
  result: S2sResult,
  scenario: CashierCardScenario,
  purchaseId: string,
): void {
  if (scenario.expected.outcome === 'rejected') {
    expect(result.mode, `S2S answer HTTP ${String(result.s2s.status)}`).toBe('rejected');
  } else {
    expectPendingCallback(result, purchaseId);
  }
  if (result.browser !== undefined) {
    const where =
      result.browser.apiMessage !== '' ? result.browser.apiMessage : result.browser.finalUrl;
    expect(result.browser.outcome, `browser outcome after the callback (${where})`).toBe(
      scenario.expected.outcome,
    );
  }
  // A card the cashier rejects in the browser leaves the purchase CREATED; the S2S API
  // rejects it server-side and ends the purchase as ERROR (confirmed on test4).
  const statuses =
    scenario.expected.outcome === 'rejected'
      ? [...scenario.expected.statuses, 'ERROR']
      : scenario.expected.statuses;
  expect(statuses, `final status ${result.finalStatus}`).toContain(result.finalStatus);
  if (result.psp !== undefined) expectPspChecks(result.psp);
}

test.describe('S2S purchase › 1. Card payment', { tag: ['@s2s', '@transaction'] }, () => {
  test(
    'S2S-001 Purchase API → CREATED with purchaseId (checkout_url not opened)',
    {
      tag: ['@S2S-001'],
      annotation: [{ type: 'expected', description: 'HTTP 202, status CREATED, purchaseId' }],
    },
    async (
      { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
      testInfo,
    ) => {
      await requireCardMethod(
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      );
      const created = await purchaseApi.createPurchase(buildPurchaseRequest(envData, merchant));
      expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
      testInfo.annotations.push({ type: 'purchase id', description: created.body.purchaseId });
      expect(created.body.purchaseId, 'purchaseId').toMatch(/^[0-9a-f]{24}$/i);
      expect(created.body.status.toUpperCase(), 'status').toBe('CREATED');
      const loaded = await purchaseApi.getPurchase(created.body.purchaseId);
      expect(loaded.body.status.toUpperCase(), 'status when read back').toBe('CREATED');
    },
  );

  for (const rememberCard of ['off', 'on'] as const) {
    const id = rememberCard === 'off' ? 'S2S-002' : 'S2S-003';
    test(
      `${id} S2S payment with the run card, remember_card=${rememberCard}`,
      {
        tag: [`@${id}`],
        annotation: [
          {
            type: 'expected',
            description:
              'S2S 202 pending + callback_url → callback → 3DS / redirect → status of the card scenario',
          },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        await requireCardMethod(f, testInfo);
        const scenario = requireCaseCard(
          testConfig.env,
          undefined,
          testConfig.transaction.payCardId,
        );
        const { purchaseId, result } = await payS2s(f, scenario, rememberCard, testInfo);
        expectScenario(result, scenario, purchaseId);
      },
    );
  }
});

test.describe('S2S purchase › 2. Test cards', { tag: ['@s2s', '@transaction'] }, () => {
  for (const scenario of cashierCardScenarios(env)) {
    test(
      `S2S ${scenario.label} → ${scenario.expected.outcome}`,
      {
        tag: [`@s2s-card-${scenario.id}`],
        annotation: [
          {
            type: 'expected',
            description: `${scenario.expected.outcome}, status ${scenario.expected.statuses.join('/')}`,
          },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        await requireCardMethod(f, testInfo);
        const { purchaseId, result } = await payS2s(f, scenario, 'off', testInfo);
        expectScenario(result, scenario, purchaseId);
      },
    );
  }
});
