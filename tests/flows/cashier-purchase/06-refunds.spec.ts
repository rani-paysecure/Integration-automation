import { HttpStatus } from '@constants/http';
import {
  field,
  loadRefundablePurchase,
  money,
  recordHistory,
  refundAndVerify,
  type RefundablePurchase,
} from '@helpers/refund-flow';
import { executeTransaction } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import type { TestInfo } from '@playwright/test';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 5: refunds. REAL refunds, only on:
 *  - a purchase this spec pays itself with the run's card, or
 *  - the settled purchase given in the launcher (REFUND_PURCHASE_ID).
 * PSP sandboxes usually refuse refunds until the payment is settled/batched
 * (Paysafe 3406) – then the failure recording is verified and the case is OBSERVED.
 * Validation cases (RF-007…) need no payment.
 */
const givenPurchaseId = process.env.REFUND_PURCHASE_ID?.trim() ?? '';
let purchase: RefundablePurchase | undefined;

/** RF-001 with a purchase ID given: use it instead of paying a new one. */
async function useGivenPurchase(
  backoffice: Parameters<typeof loadRefundablePurchase>[0],
  testInfo: TestInfo,
): Promise<void> {
  purchase = await loadRefundablePurchase(backoffice, givenPurchaseId);
  testInfo.annotations.push(
    { type: 'purchase id', description: givenPurchaseId },
    { type: 'final status', description: purchase.status },
  );
  expect(['PAID', 'PARTIAL_REFUNDED'], 'purchase to refund must be paid').toContain(
    purchase.status,
  );
}

function requirePurchase(): RefundablePurchase {
  test.skip(purchase === undefined, 'No paid purchase (RF-001 failed)');
  if (purchase === undefined) throw new Error('No paid purchase');
  return purchase;
}

test.describe(
  'Cashier purchase › 5. Refunds',
  { tag: ['@cashier', '@refunds', '@transaction'] },
  () => {
    test.describe.configure({ mode: 'serial' });

    test(
      'RF-001 Paid purchase to refund (new payment, or the settled purchase given)',
      {
        tag: ['@RF-001'],
        annotation: [{ type: 'expected', description: 'status PAID' }],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        if (givenPurchaseId !== '') return useGivenPurchase(backoffice, testInfo);
        const scenario = requireCaseCard(
          testConfig.env,
          undefined,
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
          },
          testInfo,
        );
        expect(result.finalStatus, 'the run card must approve the payment').toBe('PAID');
        const loaded = await loadRefundablePurchase(backoffice, created.body.purchaseId);
        purchase = { ...loaded, cardNumber: scenario.card.number };
      },
    );

    test(
      'RF-002 Partial refund (30%) → partial_refunded, history, cancelInfo, webhook',
      {
        tag: ['@RF-002'],
        annotation: [{ type: 'expected', description: 'HTTP 202, status PARTIAL_REFUNDED' }],
      },
      async ({ purchaseApi, backoffice }, testInfo) => {
        const p = requirePurchase();
        testInfo.annotations.push({ type: 'purchase id', description: p.purchaseId });
        const amount = money(Math.min(p.total * 0.3, p.total - p.refunded - 0.01));
        await refundAndVerify({ purchaseApi, backoffice }, p, amount, testInfo);
      },
    );

    test(
      'RF-003 Refund above the refundable amount → rejected',
      {
        tag: ['@RF-003'],
        annotation: [{ type: 'expected', description: 'rejected: HTTP 400 invalid_amount' }],
      },
      async ({ purchaseApi, backoffice }, testInfo) => {
        const p = requirePurchase();
        const amount = money(p.total - p.refunded + 1);
        const response = await purchaseApi.refundPurchase(p.purchaseId, {
          amount,
          reason: 'QA over-refund',
        });
        testInfo.annotations.push(
          { type: 'purchase id', description: p.purchaseId },
          {
            type: 'refund',
            description: `${String(amount)} → HTTP ${String(response.status)} ${field(response.body, 'code')}: ${field(response.body, 'message')}`,
          },
        );
        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect.soft(field(response.body, 'code')).toBe('invalid_amount');
        expect.soft(field(response.body, 'message')).toContain('exceeds refundable amount');
        recordHistory(testInfo, await backoffice.getRefundDetails(p.purchaseId));
      },
    );

    test(
      'RF-004 Refund amount 0 → rejected',
      {
        tag: ['@RF-004'],
        annotation: [
          {
            type: 'expected',
            description: 'rejected: HTTP 400 "Refund amount must be greater than zero."',
          },
        ],
      },
      async ({ purchaseApi }, testInfo) => {
        const p = requirePurchase();
        const response = await purchaseApi.refundPurchase(p.purchaseId, {
          amount: 0,
          reason: 'QA zero refund',
        });
        testInfo.annotations.push(
          { type: 'purchase id', description: p.purchaseId },
          {
            type: 'refund',
            description: `0 → HTTP ${String(response.status)}: ${field(response.body, 'message')}`,
          },
        );
        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect.soft(field(response.body, 'message')).toContain('greater than zero');
      },
    );

    test(
      'RF-005 Refund the remaining amount → refunded',
      {
        tag: ['@RF-005'],
        annotation: [{ type: 'expected', description: 'HTTP 202, status REFUNDED' }],
      },
      async ({ purchaseApi, backoffice }, testInfo) => {
        const p = requirePurchase();
        testInfo.annotations.push({ type: 'purchase id', description: p.purchaseId });
        await refundAndVerify(
          { purchaseApi, backoffice },
          p,
          money(p.total - p.refunded),
          testInfo,
        );
      },
    );

    test(
      'RF-006 Refund after the full refund → rejected',
      {
        tag: ['@RF-006'],
        annotation: [
          { type: 'expected', description: 'rejected: HTTP 400 already fully refunded' },
        ],
      },
      async ({ purchaseApi }, testInfo) => {
        const p = requirePurchase();
        test.skip(p.status !== 'REFUNDED', 'The purchase was not fully refunded by the PSP');
        const response = await purchaseApi.refundPurchase(p.purchaseId, {
          amount: 1,
          reason: 'QA refund after full refund',
        });
        testInfo.annotations.push(
          { type: 'purchase id', description: p.purchaseId },
          {
            type: 'refund',
            description: `1 → HTTP ${String(response.status)}: ${field(response.body, 'message')}`,
          },
        );
        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect.soft(field(response.body, 'message')).toContain('already fully refunded');
      },
    );
  },
);

const INVALID_REFUNDS = [
  {
    id: 'RF-007',
    title: 'Refund of an unpaid purchase → rejected',
    body: { amount: 1, reason: 'QA refund of unpaid purchase' },
    message: 'can be refunded',
  },
  {
    id: 'RF-008',
    title: 'Refund request without reason → rejected',
    body: { amount: 1 },
    message: 'reason for refund is required',
  },
  {
    id: 'RF-009',
    title: 'Refund request without amount → rejected',
    body: { reason: 'QA refund' },
    message: 'amount is required',
  },
] as const;

test.describe(
  'Cashier purchase › 5. Refunds (request validation)',
  { tag: ['@cashier', '@refunds'] },
  () => {
    for (const invalid of INVALID_REFUNDS) {
      test(
        `${invalid.id} ${invalid.title}`,
        {
          tag: [`@${invalid.id}`],
          annotation: [
            { type: 'expected', description: `rejected: HTTP 400 "${invalid.message}"` },
          ],
        },
        async ({ purchaseApi, envData, merchant }, testInfo) => {
          // A new, unpaid purchase – nothing can actually be refunded.
          const created = await purchaseApi.createPurchase(buildPurchaseRequest(envData, merchant));
          expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
          const response = await purchaseApi.refundPurchase(created.body.purchaseId, invalid.body);
          testInfo.annotations.push(
            { type: 'purchase id', description: created.body.purchaseId },
            {
              type: 'refund',
              description: `${JSON.stringify(invalid.body)} → HTTP ${String(response.status)}: ${field(response.body, 'message')}`,
            },
          );
          expect(response.status).toBe(HttpStatus.BAD_REQUEST);
          expect.soft(field(response.body, 'message')).toContain(invalid.message);
        },
      );
    }
  },
);
