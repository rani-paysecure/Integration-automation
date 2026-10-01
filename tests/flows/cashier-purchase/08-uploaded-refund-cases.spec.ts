import { HttpStatus } from '@constants/http';
import { field, money, PSP_REFUSED, recordHistory, settledStatus } from '@helpers/refund-flow';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';
import {
  createAndPay,
  describeRefundAmount,
  describeRefundExpected,
  observe,
  refundReason,
  resolveRefundAmount,
} from '@test-data/uploaded-cases/refund-bank-cases';
import { loadUploadedRefundCases } from '@test-data/uploaded-cases/uploaded-cases';

/**
 * Cashier purchase – stage 5: refunds, uploaded / AI cases (RC-xxx, launcher → Test cases).
 * REAL refunds on: a purchase the case pays itself, an unpaid purchase, or the settled
 * purchase entered on the Run tab (REFUND_PURCHASE_ID). Every step waits until the previous
 * refund is processed; the expectations apply to the last step. A PSP refusal of an
 * expected-successful refund (e.g. Paysafe 3406, not batched yet) is OBSERVED.
 */
const givenPurchaseId = process.env.REFUND_PURCHASE_ID?.trim() ?? '';

/** Status once no refund is in process; undefined = still in process at the PSP after the wait. */
async function settled(
  purchaseApi: Parameters<typeof settledStatus>[0],
  purchaseId: string,
): Promise<string | undefined> {
  try {
    return await settledStatus(purchaseApi, purchaseId);
  } catch {
    return undefined;
  }
}
const PAYMENT_TIMEOUT_MS = 240_000;

test.describe(
  'Cashier purchase › 5. Refunds (uploaded)',
  { tag: ['@cashier', '@refunds', '@transaction'] },
  () => {
    // One after another in one worker (a settled purchase is shared), but a failure
    // does not skip the other cases.
    test.describe.configure({ mode: 'default' });

    for (const refundCase of loadUploadedRefundCases()) {
      test(
        `${refundCase.id} ${refundCase.title}`,
        {
          tag: [`@${refundCase.id}`],
          annotation: [
            { type: 'expected', description: describeRefundExpected(refundCase.expected) },
          ],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS));
          const request = buildPurchaseRequest(envData, merchant);
          let purchaseId: string;
          if (refundCase.purchase === 'given') {
            test.skip(
              givenPurchaseId === '',
              'Enter the settled purchase to refund on the Run tab (Settled purchase to refund)',
            );
            purchaseId = givenPurchaseId;
            testInfo.annotations.push({
              type: 'purchase id',
              description: `${purchaseId} (given)`,
            });
          } else if (refundCase.purchase === 'unpaid') {
            const created = await purchaseApi.createPurchase(request);
            expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
            purchaseId = created.body.purchaseId;
            testInfo.annotations.push({ type: 'purchase id', description: purchaseId });
          } else {
            const scenario = requireCaseCard(
              testConfig.env,
              refundCase.card,
              testConfig.transaction.payCardId,
            );
            const paid = await createAndPay(
              {
                purchaseApi,
                backoffice,
                openPage: openCashierPage,
                request: { ...request },
                redirects: {
                  success: envData.purchase.success_redirect,
                  failure: envData.purchase.failure_redirect,
                  pending: envData.purchase.pending_redirect,
                },
              },
              scenario,
              testInfo,
            );
            expect(paid.result.finalStatus, 'the card must approve the payment').toBe('PAID');
            purchaseId = paid.purchaseId;
          }

          const trx = await backoffice.requireTransaction(purchaseId, 365);
          const total = money(trx.purchase.total);
          const reason = refundReason(refundCase);
          let last: { status: number; body: unknown } | undefined;
          let pspRefusedEarlier = false;

          for (const [index, step] of refundCase.steps.entries()) {
            // A refund still in process blocks the next one ("Previous Refund Request already in Process").
            if (
              refundCase.purchase !== 'unpaid' &&
              (await settled(purchaseApi, purchaseId)) === undefined
            ) {
              observe(
                testInfo,
                `The PSP is still processing the previous refund – step ${String(index + 1)} could not be sent`,
              );
              return;
            }
            const refunded =
              refundCase.purchase === 'unpaid'
                ? 0
                : ((await backoffice.getRefundDetails(purchaseId))?.totalRefunded ?? 0);
            const amount = resolveRefundAmount(step.amount, total, refunded);
            const body = {
              ...(amount === undefined ? {} : { amount }),
              ...(reason === undefined ? {} : { reason }),
            };
            const response = await purchaseApi.refundPurchase(purchaseId, body);
            last = { status: response.status, body: response.body };
            const message = field(response.body, 'message');
            testInfo.annotations.push({
              type: 'refund',
              description: `step ${String(index + 1)}: ${describeRefundAmount(step.amount)} → ${amount === undefined ? '(no amount)' : JSON.stringify(amount)} ${trx.purchase.currency} → HTTP ${String(response.status)}${field(response.body, 'code') ? ` ${field(response.body, 'code')}` : ''}${message ? `: ${message}` : ''}`,
            });
            const isLast = index === refundCase.steps.length - 1;
            if (!isLast && response.status === 400 && message.startsWith(PSP_REFUSED))
              pspRefusedEarlier = true;
          }

          const finalStatus =
            refundCase.purchase === 'unpaid'
              ? (await purchaseApi.getPurchase(purchaseId)).body.status.toUpperCase()
              : ((await settled(purchaseApi, purchaseId)) ?? 'REFUND_IN_PROCESS');
          testInfo.annotations.push({ type: 'final status', description: finalStatus });
          if (refundCase.purchase !== 'unpaid')
            recordHistory(testInfo, await backoffice.getRefundDetails(purchaseId));

          const e = refundCase.expected;
          const lastStatus = last?.status ?? 0;
          const lastMessage = field(last?.body, 'message');
          // PSP refused a refund PGS accepted (sandbox: not settled / batched yet) → OBSERVED.
          if (
            (e.http === HttpStatus.ACCEPTED || pspRefusedEarlier) &&
            lastStatus === 400 &&
            lastMessage.startsWith(PSP_REFUSED)
          ) {
            observe(
              testInfo,
              'The PSP refused the refund (sandbox: payment not settled yet) – use a settled purchase for a successful refund',
            );
            return;
          }
          if (pspRefusedEarlier) {
            observe(
              testInfo,
              'An earlier refund step was refused by the PSP – later results depend on it',
            );
          }
          if (e.http !== undefined) expect(lastStatus, 'HTTP of the last refund').toBe(e.http);
          if (e.code !== undefined) expect(field(last?.body, 'code'), 'refund code').toBe(e.code);
          if (e.messageContains !== undefined)
            expect(lastMessage.toLowerCase(), 'refund message').toContain(
              e.messageContains.toLowerCase(),
            );
          if (e.statuses?.length) {
            if (finalStatus === 'REFUND_IN_PROCESS') {
              observe(
                testInfo,
                'The PSP had not confirmed the refund yet – final status not checked',
              );
              return;
            }
            expect(e.statuses, `final purchase status ${finalStatus}`).toContain(finalStatus);
          }
        },
      );
    }
  },
);
