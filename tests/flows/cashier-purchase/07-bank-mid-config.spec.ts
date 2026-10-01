import {
  getBankSettings,
  getMerchantSettings,
  getMidSettings,
  type BankSettings,
  type MidChange,
  type MidSettings,
} from '@clients/bank-config';
import { HttpStatus } from '@constants/http';
import {
  expectedRefundUpto,
  otherCurrency,
  otherScheme,
  restoreJournal,
  midCacheWaitMs,
  safeMessage,
  waitForMidCache,
  scalar,
  withMerchantConversion,
  withMidSettings,
  type MidTarget,
} from '@helpers/bank-config-flow';
import { field, money, settledStatus } from '@helpers/refund-flow';
import { executeTransaction, type TransactionResult } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import type { TestInfo } from '@playwright/test';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 6: bank & MID configuration (InitiateAction / RefundService).
 *
 * FLIP → TEST → RESTORE: cases that need a setting other than the current one change it
 * through the dashboard's own MID form / merchant switch, make a REAL payment or refund,
 * and put the original value back in `finally`. Every change is journalled first
 * (reports/bank-config-journal.json) and restored at the start of the next run if a run
 * was killed. These settings are shared test4 config – the launcher runs these cases on
 * their own with one worker.
 *
 * The bank / MID under test is the one the merchant routes to (BM-001), checked against
 * the run's bank / MID when given.
 */
interface Routed {
  readonly bank: BankSettings;
  readonly mid: MidSettings;
  readonly target: MidTarget;
  readonly merchantId: number;
  readonly purchaseId: string;
  readonly total: number;
  readonly currency: string;
}

let routed: Routed | undefined;
/** Settings an interrupted earlier run had left changed (restored in beforeAll). */
let restoredAtStart: string[] = [];
const PAYMENT_TIMEOUT_MS = 240_000;

function requireRouted(): Routed {
  test.skip(routed === undefined, 'Bank / MID not known (BM-001 failed)');
  if (routed === undefined) throw new Error('Bank / MID not known');
  return routed;
}

/** Current values of the MID fields the cases change. */
function currentOf(mid: MidSettings): MidChange {
  return {
    onlyTwoD: mid.onlyTwoD === 1 ? 1 : 0,
    partial_refund_allowed: mid.partialRefundAllowed === 1 ? 1 : 0,
    curr_convert_to: mid.currConvertTo,
    allowed_curr: mid.allowedCurr,
    allowed_card: mid.allowedCard,
  };
}

const describeChange = (change: object): string =>
  Object.entries(change)
    .map(([k, v]) => `${k}=${String(v) || '(empty)'}`)
    .join(', ');

type Fixtures = Parameters<Parameters<typeof test>[2]>[0];

/** New purchase paid on the cashier with the run's card. */
async function pay(
  f: Pick<
    Fixtures,
    'purchaseApi' | 'backoffice' | 'openCashierPage' | 'envData' | 'merchant' | 'testConfig'
  >,
  testInfo: TestInfo,
): Promise<{ purchaseId: string; result: TransactionResult }> {
  const cacheWait = midCacheWaitMs();
  testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS) + cacheWait);
  if (cacheWait > 0) {
    // PGS routes from a 5-minute MID cache – pay only once it holds the current settings.
    testInfo.annotations.push({
      type: 'note',
      description: `waited ${String(Math.round(cacheWait / 1000))} s for PGS's MID cache (5 min) to pick up the MID settings`,
    });
    await test.step('wait for PGS MID cache', waitForMidCache);
  }
  const scenario = requireCaseCard(f.testConfig.env, undefined, f.testConfig.transaction.payCardId);
  const request = buildPurchaseRequest(f.envData, f.merchant);
  const created = await f.purchaseApi.createPurchase(request);
  expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
  testInfo.annotations.push(
    { type: 'purchase id', description: created.body.purchaseId },
    { type: 'card scenario', description: scenario.label },
  );
  const result = await executeTransaction(
    { purchaseApi: f.purchaseApi, backoffice: f.backoffice, openPage: f.openCashierPage },
    {
      purchaseId: created.body.purchaseId,
      checkoutUrl: created.body.checkout_url,
      card: scenario.card,
      request,
      redirects: {
        success: f.envData.purchase.success_redirect,
        failure: f.envData.purchase.failure_redirect,
        pending: f.envData.purchase.pending_redirect,
      },
    },
    testInfo,
  );
  return { purchaseId: created.body.purchaseId, result };
}

/** BANK_CONFIG_PURCHASE_ID: a paid purchase of this merchant to start from (no new payment for BM-001). */
const givenPurchaseId = process.env.BANK_CONFIG_PURCHASE_ID?.trim() ?? '';

async function paidPurchase(
  f: Parameters<typeof pay>[0],
  testInfo: TestInfo,
): Promise<{ purchaseId: string; status: string; bank: TransactionResult['bank'] }> {
  if (givenPurchaseId === '') {
    const { purchaseId, result } = await pay(f, testInfo);
    return { purchaseId, status: result.finalStatus, bank: result.bank };
  }
  testInfo.annotations.push({ type: 'purchase id', description: `${givenPurchaseId} (given)` });
  // A refund still in process (an earlier run) blocks the refund cases – wait for it.
  const status = await settledStatus(f.purchaseApi, givenPurchaseId);
  return {
    purchaseId: givenPurchaseId,
    status: status === 'PARTIAL_REFUNDED' ? 'PAID' : status,
    bank: await f.backoffice.getBankTransaction(givenPurchaseId),
  };
}

/** The PSP request (bank record paymentInfo) carries a 3DS block. */
function hasThreeDs(paymentInfo: unknown): boolean {
  const text = typeof paymentInfo === 'string' ? paymentInfo : JSON.stringify(paymentInfo ?? '');
  return /"threeDs"|"threeDSecure"|"3ds"|"authentication"\s*:/i.test(text);
}

/** The payment must not have been processed on the MID under test. */
function expectNotOnMid(r: Routed, result: TransactionResult, testInfo: TestInfo): void {
  const usedMid = result.bank?.midName ?? '';
  testInfo.annotations.push({
    type: 'routing',
    description: usedMid
      ? `processed on ${result.bank?.bankName ?? '?'} / ${usedMid} (status ${result.finalStatus})`
      : `not sent to any MID (status ${result.finalStatus})`,
  });
  expect(usedMid, `payment must skip MID ${r.mid.mid}`).not.toBe(r.mid.mid);
  if (usedMid === '') {
    expect.soft(result.finalStatus, 'purchase without an eligible MID').not.toBe('PAID');
  }
}

function flipNote(testInfo: TestInfo, r: Routed, change: MidChange): void {
  const current = currentOf(r.mid) as Record<string, unknown>;
  const flipped = Object.entries(change).filter(([k, v]) => scalar(v) !== scalar(current[k]));
  testInfo.annotations.push({
    type: 'mid settings',
    description: flipped.length
      ? `${r.mid.mid}: ${describeChange(Object.fromEntries(flipped))} (temporary – restored after the test)`
      : `${r.mid.mid}: ${describeChange(change)} (already set – nothing changed)`,
  });
}

const statusTime = (trx: Record<string, unknown>, status: string): number => {
  const history = Array.isArray(trx.status_history) ? (trx.status_history as unknown[]) : [];
  const entry = history.find(
    (h) => typeof h === 'object' && h !== null && (h as { status?: unknown }).status === status,
  ) as { timestamp?: unknown } | undefined;
  return typeof entry?.timestamp === 'number' ? entry.timestamp : 0;
};

test.describe(
  'Cashier purchase › 6. Bank & MID configuration',
  { tag: ['@cashier', '@bank-config', '@transaction'] },
  () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ backoffice }) => {
      // A killed run may have left a setting flipped – put it back first.
      restoredAtStart = await restoreJournal(backoffice);
    });

    test(
      'BM-001 Paid purchase → bank / MID it was routed to and their settings',
      {
        tag: ['@BM-001'],
        annotation: [{ type: 'expected', description: 'status PAID, bank & MID settings read' }],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        for (const line of restoredAtStart) {
          testInfo.annotations.push({
            type: 'note',
            description: `restored from an interrupted run: ${line}`,
          });
        }
        const merchantId = f.testConfig.merchant.id;
        test.skip(merchantId === undefined, 'Merchant ID unknown – set it on the tester profile');
        const { purchaseId, status, bank: bankRecord } = await paidPurchase(f, testInfo);
        expect(status, 'the purchase must be paid').toBe('PAID');
        const bankName = bankRecord?.bankName ?? '';
        const midName = bankRecord?.midName ?? '';
        expect(bankName, 'bank of the payment').not.toBe('');
        expect(midName, 'MID of the payment').not.toBe('');
        const { expectedBank, expectedMid } = f.testConfig.merchant;
        if (expectedBank) expect(bankName, 'routed bank = run bank').toBe(expectedBank);
        if (expectedMid) {
          expect(
            expectedMid.split(',').map((m) => m.trim()),
            'routed MID is one of the run MIDs',
          ).toContain(midName);
        }

        const bank = await getBankSettings(f.backoffice, bankName);
        const mid = await getMidSettings(f.backoffice, bank.id, midName);
        const merchantSettings = await getMerchantSettings(f.backoffice, merchantId ?? 0);
        const trx = await f.backoffice.requireTransaction(purchaseId, 365);
        routed = {
          bank,
          mid,
          target: { bankId: bank.id, midId: mid.id },
          merchantId: merchantId ?? 0,
          purchaseId,
          total: money(trx.purchase.total),
          currency: trx.purchase.currency.toUpperCase(),
        };
        testInfo.annotations.push(
          {
            type: 'bank settings',
            description: `${bank.name}: max_refund_days ${String(bank.maxRefundDays)} · currencies ${bank.allowedCurr.join(',') || 'all'} · cards ${bank.allowedCard.join(',') || 'all'}`,
          },
          {
            type: 'mid settings',
            description: `${mid.mid}: onlyTwoD ${String(mid.onlyTwoD)} · partial refund ${String(mid.partialRefundAllowed)} · convert to ${mid.currConvertTo || '–'} · currencies ${mid.allowedCurr || 'all'} · cards ${mid.allowedCard || 'all'}`,
          },
          {
            type: 'merchant settings',
            description: `conversion allowed ${String(merchantSettings.conversionAllowed)} · trxType ${merchantSettings.trxType}`,
          },
        );
        expect
          .soft(mid.isTestData, 'MID flagged as test data cannot be changed safely')
          .toBe(false);
      },
    );

    test(
      'BM-002 Refund window = paid time + bank max_refund_days − 1 h',
      {
        tag: ['@BM-002'],
        annotation: [
          {
            type: 'expected',
            description: 'refund_upto = paid + max_refund_days × 24 h − 1 h (0 when days ≤ 0)',
          },
        ],
      },
      async ({ backoffice }, testInfo) => {
        const r = requireRouted();
        const trx = (await backoffice.requireTransaction(r.purchaseId, 365)) as Record<
          string,
          unknown
        >;
        const upto = Number(trx.refund_upto ?? 0);
        const paidAt = statusTime(trx, 'paid');
        const wanted = expectedRefundUpto(paidAt, r.bank.maxRefundDays);
        testInfo.annotations.push({
          type: 'refund window',
          description: `max_refund_days ${String(r.bank.maxRefundDays)} · paid ${new Date(paidAt * 1000).toISOString()} · refund_upto ${upto > 0 ? new Date(upto * 1000).toISOString() : '0'} · refundable ${scalar(trx.refundable_amount) || '?'}`,
        });
        if (r.bank.maxRefundDays <= 0) {
          expect(upto, 'not refundable').toBe(0);
          expect.soft(Number(trx.refundable_amount ?? 0), 'refundable amount').toBe(0);
          return;
        }
        expect(paidAt, 'paid time in the status history').toBeGreaterThan(0);
        // refund_upto is set when the PSP confirms – a few seconds before "paid" is logged.
        expect(Math.abs(upto - wanted), `refund_upto ≈ ${String(wanted)}`).toBeLessThanOrEqual(120);
        expect.soft(money(Number(trx.refundable_amount ?? 0)), 'refundable amount').toBe(r.total);
      },
    );

    test(
      'BM-003 2D only = 0 → MID used, 3DS data in the PSP request',
      {
        tag: ['@BM-003'],
        annotation: [
          { type: 'expected', description: 'PAID on the MID; PSP request carries threeDs data' },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const change: MidChange = { onlyTwoD: 0 };
        flipNote(testInfo, r, change);
        await withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
          // BM-001's payment already ran with 2D only = 0 – pay again only if it was flipped.
          const bank =
            r.mid.onlyTwoD === 0
              ? await f.backoffice.getBankTransaction(r.purchaseId)
              : (await pay(f, testInfo)).result.bank;
          const threeDs = hasThreeDs(bank?.paymentInfo);
          testInfo.annotations.push({
            type: '2d / 3d',
            description: `${bank?.midName ?? '–'} · threeDs in PSP request: ${threeDs ? 'yes' : 'no'}`,
          });
          expect(bank?.midName, 'processed on the MID under test').toBe(r.mid.mid);
          expect.soft(threeDs, '3DS data sent to the PSP').toBe(true);
        });
      },
    );

    test(
      'BM-004 2D only = 1 → MID still used for the payment (2D)',
      {
        tag: ['@BM-004'],
        annotation: [
          {
            type: 'expected',
            description:
              'PAID on the MID (merchant trxType ALL); records whether the PSP request still carries 3DS data',
          },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const merchantSettings = await getMerchantSettings(f.backoffice, r.merchantId);
        const change: MidChange = { onlyTwoD: 1 };
        flipNote(testInfo, r, change);
        await withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
          const { result } = await pay(f, testInfo);
          const threeDs = hasThreeDs(result.bank?.paymentInfo);
          testInfo.annotations.push({
            type: '2d / 3d',
            description: `merchant trxType ${merchantSettings.trxType} · ${result.bank?.midName ?? '–'} · status ${result.finalStatus} · threeDs in PSP request: ${threeDs ? 'yes' : 'no'}`,
          });
          if (merchantSettings.trxType.toUpperCase() === '3D') {
            // InitiateAction: 3D-only merchant + 2D-only MID → MID_IS_NOT_3D, MID skipped.
            expectNotOnMid(r, result, testInfo);
            return;
          }
          expect(result.bank?.midName, 'processed on the MID under test').toBe(r.mid.mid);
          const notes: string[] = [];
          if (threeDs) {
            notes.push(`${r.bank.name} request template still sends threeDs on a 2D-only MID`);
          }
          if (result.finalStatus !== 'PAID') {
            // PGS goes Direct 2D (no 3DS step) – a PSP that expects 3DS on the handle refuses it
            // (Paysafe 5068 "payment handle … not permitted … because of its state").
            const trx = await f.backoffice.requireTransaction(result.psp.purchaseId, 1);
            notes.push(
              `PSP refused the 2D payment: ${safeMessage(trx.errorMsg ?? result.finalStatus)}`,
            );
          }
          if (notes.length > 0) {
            testInfo.annotations.push(
              ...notes.map((description) => ({ type: 'note', description })),
              { type: 'verdict', description: 'observe' },
            );
          }
        });
      },
    );

    test(
      'BM-005 Partial refund allowed = 0 → partial refund rejected',
      {
        tag: ['@BM-005'],
        annotation: [
          {
            type: 'expected',
            description:
              'HTTP 400 code payment_can_not_be_refunded (PGS: "PaymentBankMID does not allow partial refund")',
          },
        ],
      },
      async ({ backoffice, purchaseApi }, testInfo) => {
        const r = requireRouted();
        const change: MidChange = { partial_refund_allowed: 0 };
        flipNote(testInfo, r, change);
        await withMidSettings(backoffice, r.target, change, currentOf(r.mid), async () => {
          await settledStatus(purchaseApi, r.purchaseId);
          const before = await backoffice.getRefundDetails(r.purchaseId);
          const remaining = money(r.total - (before?.totalRefunded ?? 0));
          test.skip(remaining < 0.02, 'Nothing left to refund partially');
          const amount = money(Math.max(0.01, remaining * 0.1));
          const response = await purchaseApi.refundPurchase(r.purchaseId, {
            amount,
            reason: 'QA partial refund – MID refuses partial refunds',
          });
          const message = safeMessage(field(response.body, 'message'));
          testInfo.annotations.push({
            type: 'refund',
            description: `${String(amount)} ${r.currency} → HTTP ${String(response.status)} ${field(response.body, 'code')}: ${message}`,
          });
          // The API answers only the code; the detailed "PaymentBankMID does not allow partial
          // refund" text stays in the PGS log (it contains the MID auth key).
          expect(response.status).toBe(HttpStatus.BAD_REQUEST);
          expect(field(response.body, 'code')).toBe('payment_can_not_be_refunded');
          const after = await backoffice.getRefundDetails(r.purchaseId);
          expect
            .soft(money(after?.totalRefunded ?? 0), 'nothing refunded')
            .toBe(money(before?.totalRefunded ?? 0));
        });
      },
    );

    test(
      'BM-006 Partial refund allowed = 1 → partial refund passes the MID check',
      {
        tag: ['@BM-006'],
        annotation: [
          {
            type: 'expected',
            description:
              'not rejected with payment_can_not_be_refunded (the PSP may still refuse an unsettled payment)',
          },
        ],
      },
      async ({ backoffice, purchaseApi }, testInfo) => {
        const r = requireRouted();
        const change: MidChange = { partial_refund_allowed: 1 };
        flipNote(testInfo, r, change);
        await withMidSettings(backoffice, r.target, change, currentOf(r.mid), async () => {
          const amount = money(Math.max(0.01, r.total * 0.1));
          const response = await purchaseApi.refundPurchase(r.purchaseId, {
            amount,
            reason: 'QA partial refund – MID allows partial refunds',
          });
          const message = safeMessage(field(response.body, 'message'));
          testInfo.annotations.push({
            type: 'refund',
            description: `${String(amount)} ${r.currency} → HTTP ${String(response.status)}${message ? `: ${message}` : ''}`,
          });
          expect(field(response.body, 'code')).not.toBe('payment_can_not_be_refunded');
          expect.soft(message).not.toContain('does not allow partial refund');
          // Let the PSP finish (or refuse) it – a refund in process blocks the next one.
          testInfo.annotations.push({
            type: 'final status',
            description: await settledStatus(purchaseApi, r.purchaseId),
          });
        });
      },
    );

    test(
      'BM-007 Currency conversion ON (MID converts, merchant allows) → PSP gets the converted currency',
      {
        tag: ['@BM-007'],
        annotation: [
          {
            type: 'expected',
            description:
              'routed to the MID; purchase fx_Currency and bank currency = MID "convert to" currency',
          },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const to = otherCurrency(r.currency, process.env.BANK_CONFIG_CONVERT_TO);
        const change: MidChange = { curr_convert_to: to };
        flipNote(testInfo, r, change);
        await withMerchantConversion(f.backoffice, r.merchantId, 1, () =>
          withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
            const { purchaseId, result } = await pay(f, testInfo);
            const trx = await f.backoffice.requireTransaction(purchaseId, 1);
            testInfo.annotations.push({
              type: 'conversion',
              description: `${r.currency} → ${to}: fx ${trx.fx_Currency ?? '–'} ${String(trx.fx_Amount ?? '')} · bank ${result.bank?.currency ?? '–'} ${String(result.bank?.amt ?? '')} · status ${result.finalStatus}`,
            });
            expect(result.bank?.midName, 'processed on the MID under test').toBe(r.mid.mid);
            expect(trx.fx_Currency, 'purchase fx_Currency').toBe(to);
            expect.soft(result.bank?.currency, 'currency sent to the PSP').toBe(to);
            expect.soft(Number(trx.fx_Amount ?? 0), 'converted amount').toBeGreaterThan(0);
          }),
        );
      },
    );

    test(
      'BM-008 Currency conversion OFF on the merchant → converting MID is skipped',
      {
        tag: ['@BM-008'],
        annotation: [
          {
            type: 'expected',
            description:
              'not processed on the MID (CONVERSION_NOT_ALLOWED → "This customer can not be processed !")',
          },
        ],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const to = otherCurrency(r.currency, process.env.BANK_CONFIG_CONVERT_TO);
        const change: MidChange = { curr_convert_to: to };
        flipNote(testInfo, r, change);
        testInfo.annotations.push({
          type: 'merchant settings',
          description: 'conversion allowed = 0 (temporary – restored after the test)',
        });
        await withMerchantConversion(f.backoffice, r.merchantId, 0, () =>
          withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
            const { result } = await pay(f, testInfo);
            expectNotOnMid(r, result, testInfo);
          }),
        );
      },
    );

    test(
      'BM-009 MID allowed currencies exclude the purchase currency → MID skipped',
      {
        tag: ['@BM-009'],
        annotation: [{ type: 'expected', description: 'not processed on the MID' }],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const change: MidChange = {
          allowed_curr: otherCurrency(r.currency, process.env.BANK_CONFIG_CONVERT_TO),
        };
        flipNote(testInfo, r, change);
        await withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
          const { result } = await pay(f, testInfo);
          expectNotOnMid(r, result, testInfo);
        });
      },
    );

    test(
      'BM-010 MID allowed cards exclude the card scheme → MID skipped',
      {
        tag: ['@BM-010'],
        annotation: [{ type: 'expected', description: 'not processed on the MID' }],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
        const r = requireRouted();
        const change: MidChange = {
          allowed_card: otherScheme(f.testConfig.merchant.paymentMethod),
        };
        flipNote(testInfo, r, change);
        await withMidSettings(f.backoffice, r.target, change, currentOf(r.mid), async () => {
          const { result } = await pay(f, testInfo);
          expectNotOnMid(r, result, testInfo);
        });
      },
    );

    test(
      'BM-011 Settings restored after the run',
      {
        tag: ['@BM-011'],
        annotation: [
          { type: 'expected', description: 'MID and merchant settings equal the BM-001 snapshot' },
        ],
      },
      async ({ backoffice }, testInfo) => {
        const r = requireRouted();
        const mid = await getMidSettings(backoffice, r.bank.id, r.mid.mid);
        testInfo.annotations.push({
          type: 'mid settings',
          description: `${mid.mid}: ${describeChange(currentOf(mid))}`,
        });
        expect(currentOf(mid)).toEqual(currentOf(r.mid));
      },
    );
  },
);
