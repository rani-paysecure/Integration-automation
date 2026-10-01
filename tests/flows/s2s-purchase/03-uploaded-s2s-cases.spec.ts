import { HttpStatus } from '@constants/http';
import { isCardPaymentMethod } from '@helpers/card-methods';
import { continueS2s, s2sError } from '@helpers/s2s-flow';
import { expectPspChecks } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';
import { buildS2sRequest, changedS2sBody } from '@test-data/s2s/s2s-request.factory';
import { loadUploadedS2sCases, type S2sCase } from '@test-data/uploaded-cases/uploaded-cases';

/**
 * S2S purchase – uploaded / AI cases (S2-xxx, launcher → Test cases → S2S cases).
 * Purchase API → S2S request = the S2S data tab baseline + the case's changes, with the case's
 * auth variant → expected HTTP / code / message. An accepted call (202) continues like a real
 * customer: callback opened → 3DS / redirect → final status, PSP checks, webhook.
 * Card payment methods only. REAL transactions when the call is accepted.
 */
const PAYMENT_TIMEOUT_MS = 240_000;
const UNKNOWN_PURCHASE = '6a0000000000000000000000';

const headersFor = (c: S2sCase): { skipAuth?: true; headers?: Record<string, string> } => {
  switch (c.auth) {
    case 'none':
      return { skipAuth: true };
    case 'no-bearer':
      return { headers: { authorization: 'QA-KEY-WITHOUT-BEARER' } };
    case 'text-plain':
      return { headers: { 'content-type': 'text/plain' } };
    default:
      return {};
  }
};

const OUTCOME_TEXT = {
  'success-redirect': 'success redirect',
  'failure-redirect': 'failure redirect',
  'pending-redirect': 'pending redirect',
} as const;
const expectedText = (e: S2sCase['expected']): string =>
  [
    `HTTP ${String(e.http)}`,
    e.code ?? '',
    e.messageContains ? `message contains "${e.messageContains}"` : '',
    e.statuses?.length ? `status ${e.statuses.join(' / ')}` : '',
    e.outcome ? OUTCOME_TEXT[e.outcome] : '',
  ]
    .filter(Boolean)
    .join(' · ');

test.describe('S2S purchase › 4. Uploaded cases', { tag: ['@s2s', '@transaction'] }, () => {
  for (const s2sCase of loadUploadedS2sCases()) {
    test(
      `${s2sCase.id} ${s2sCase.title}`,
      {
        tag: [`@${s2sCase.id}`],
        annotation: [{ type: 'expected', description: expectedText(s2sCase.expected) }],
      },
      async (
        { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
        testInfo,
      ) => {
        testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS));
        const { card } = await isCardPaymentMethod(merchant.paymentMethod, backoffice);
        test.skip(
          !card,
          `S2S is only for card payment methods (VISA, MASTER, AMEX …) – ${merchant.paymentMethod} is not a card`,
        );
        const scenario = requireCaseCard(
          testConfig.env,
          s2sCase.card,
          testConfig.transaction.payCardId,
        );
        const request = buildPurchaseRequest(envData, merchant);
        let purchaseId = UNKNOWN_PURCHASE;
        if (s2sCase.purchase !== 'unknown') {
          const created = await purchaseApi.createPurchase(request);
          expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
          purchaseId = created.body.purchaseId;
        }
        const base = buildS2sRequest(scenario.card, { template: envData.s2s });
        if (s2sCase.purchase === 'second') {
          const first = await purchaseApi.s2sPay(purchaseId, base);
          testInfo.annotations.push({
            type: 'first s2s call',
            description: `HTTP ${String(first.status)} ${s2sError(first)}`,
          });
        }
        const changes: Record<string, unknown> = { ...(s2sCase.set ?? {}) };
        for (const key of s2sCase.remove ?? []) changes[key] = undefined;
        const body = changedS2sBody(base, changes);
        const s2s = await purchaseApi.s2sPay(purchaseId, body, headersFor(s2sCase));
        testInfo.annotations.push(
          { type: 'purchase id', description: purchaseId },
          { type: 'card scenario', description: scenario.label },
        );

        const e = s2sCase.expected;
        expect(s2s.status, `S2S answer: ${s2sError(s2s)}`).toBe(e.http);
        if (e.code !== undefined) expect(s2sError(s2s), 'error code').toContain(e.code);
        if (e.messageContains !== undefined)
          expect(s2sError(s2s).toLowerCase(), 'message').toContain(e.messageContains.toLowerCase());

        if (s2s.status !== 202 || s2sCase.purchase === 'unknown') {
          testInfo.annotations.push({
            type: 's2s response',
            description: `HTTP ${String(s2s.status)} · ${s2sError(s2s)}`,
          });
          if (e.statuses?.length && purchaseId !== UNKNOWN_PURCHASE) {
            const status = (await purchaseApi.getPurchase(purchaseId)).body.status.toUpperCase();
            testInfo.annotations.push({ type: 'purchase status after', description: status });
            expect(e.statuses, `purchase status after the call: ${status}`).toContain(status);
          }
          return;
        }

        // Accepted: continue like the customer – callback, 3DS, redirect, final status.
        const result = await continueS2s(
          { purchaseApi, backoffice, openPage: openCashierPage },
          {
            purchaseId,
            card: scenario.card,
            body,
            request,
            redirects: {
              success: envData.purchase.success_redirect,
              failure: envData.purchase.failure_redirect,
              pending: envData.purchase.pending_redirect,
            },
            expectedBank: merchant.expectedBank,
            expectedMid: merchant.expectedMid,
          },
          s2s,
          testInfo,
        );
        if (e.outcome !== undefined && result.browser !== undefined)
          expect(result.browser.outcome, 'browser outcome after the callback').toBe(e.outcome);
        if (e.statuses?.length)
          expect(e.statuses, `final status ${result.finalStatus}`).toContain(result.finalStatus);
        if (result.psp !== undefined) expectPspChecks(result.psp);
      },
    );
  }
});
