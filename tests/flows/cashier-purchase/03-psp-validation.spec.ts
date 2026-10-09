import { HttpStatus } from '@constants/http';
import { recordPspResult, summarizePsp } from '@helpers/psp-validation';
import { serviceMaskingKeys, webhookResults } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

/**
 * Cashier purchase – stage 3: PSP request/response validation.
 *
 * For each purchase ID in PSP_PURCHASE_IDS (launcher field or env var), reads
 * the back-office transaction and the bank/PSP record and cross-checks what
 * was sent to the PSP (reference, amount, currency) and what came back
 * (transaction ID, status). Results: reports/psp-validation/psp-validation-results.csv
 *
 * Until the cashier payment is automated, pay on the checkout page manually and
 * paste the purchase IDs here.
 */
const purchaseIds = (process.env.PSP_PURCHASE_IDS ?? '')
  .split(/[\s,;]+/)
  .map((id) => id.trim())
  .filter(Boolean);

test.describe(
  'Cashier purchase › 3. PSP request/response validation',
  { tag: ['@cashier', '@psp-validation'] },
  () => {
    test(
      'API-created purchase is visible in back-office with no PSP attempt yet',
      { tag: '@backoffice-smoke' },
      async ({ purchaseApi, backoffice, envData, merchant }) => {
        const created = await purchaseApi.createPurchase(buildPurchaseRequest(envData, merchant));
        expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
        const purchaseId = String((created.body as { purchaseId?: unknown }).purchaseId);

        const trx = await backoffice.findTransaction(purchaseId, 1);

        expect(trx, `purchase ${purchaseId} in back-office`).toBeDefined();
        expect(trx?.status).toBe('CREATED');
        expect(trx?.brand_id).toBe(merchant.brandId);
        expect(await backoffice.getBankTransaction(purchaseId)).toBeUndefined();
      },
    );

    for (const purchaseId of purchaseIds) {
      test(
        `PSP check – ${purchaseId}`,
        { tag: '@psp-by-id' },
        async ({ backoffice, merchant }, testInfo) => {
          const trx = await backoffice.requireTransaction(purchaseId);

          const bank = await backoffice.getBankTransaction(purchaseId);
          const psp = summarizePsp(purchaseId, trx, bank, {
            expectedBank: merchant.expectedBank,
            expectedMid: merchant.expectedMid,
            // Stored purchase (customer data as received) → purchase ↔ PSP mapping checks.
            request: trx,
            // PSP checks: masking rules + webhook in / out.
            pspChecks: true,
            serviceMaskingKeys: await serviceMaskingKeys(backoffice),
          });
          // Webhook in (PSP → PGS) / webhook out (PGS → merchant) for the current status.
          const webhooks = psp.attempted
            ? await webhookResults(backoffice, purchaseId, psp.purchaseStatus, {
                request: trx,
                pspTransId: bank?.paymentTransId,
              })
            : { checks: [], notes: [] };
          const summary = {
            ...psp,
            checks: [...psp.checks, ...webhooks.checks],
            notes: [...psp.notes, ...webhooks.notes],
          };
          testInfo.annotations.push({ type: 'purchase id', description: purchaseId });
          await recordPspResult(testInfo, summary, bank);

          test.skip(
            !summary.attempted,
            `No payment attempt yet (status ${summary.purchaseStatus})`,
          );
          for (const check of summary.checks) {
            expect
              .soft(
                check.passed,
                `${check.name}: expected ${check.expected}, got ${check.actual || '(empty)'}`,
              )
              .toBe(true);
          }
        },
      );
    }
  },
);
