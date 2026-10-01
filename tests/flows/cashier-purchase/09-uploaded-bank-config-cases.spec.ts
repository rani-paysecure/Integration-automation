import {
  findMid,
  getMidSettings,
  type BankSettings,
  type MidChange,
  type MidSettings,
} from '@clients/bank-config';
import {
  midCacheWaitMs,
  restoreJournal,
  safeMessage,
  waitForMidCache,
  withMerchantConversion,
  withMidSettings,
} from '@helpers/bank-config-flow';
import { field, money, PSP_REFUSED, settledStatus } from '@helpers/refund-flow';
import type { TransactionResult } from '@helpers/transaction-flow';
import { expect, test } from '@fixtures/api.fixture';
import type { TestInfo } from '@playwright/test';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';
import {
  changedRequest,
  createAndPay,
  describeBankExpected,
  observe,
  resolveBankSettings,
  resolveCurrencyToken,
  type PayDeps,
} from '@test-data/uploaded-cases/refund-bank-cases';
import {
  loadUploadedBankConfigCases,
  type BankConfigCase,
} from '@test-data/uploaded-cases/uploaded-cases';

/**
 * Cashier purchase – stage 6: bank & MID configuration, uploaded / AI cases (BC-xxx).
 *
 * FLIP → TEST → RESTORE like BM-xxx: the routed MID's settings (and the merchant's
 * conversion switch) are changed through the dashboard, a REAL payment or refund is
 * made, and every original value is restored (journalled first). PGS routes from a
 * 5-minute MID cache, so a payment waits until that cache holds the current settings.
 * The launcher runs these cases on their own with one worker.
 *
 * MID under test: the run's MID (Routes to on the Run tab, RUN_MID – the first one if
 * several), otherwise the MID a probe payment is routed to.
 */
interface Target {
  readonly bank: BankSettings;
  readonly mid: MidSettings;
  readonly merchantId: number;
}
let target: Target | undefined;
const PAYMENT_TIMEOUT_MS = 240_000;

type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
type Deps = Pick<
  Fixtures,
  'purchaseApi' | 'backoffice' | 'openCashierPage' | 'envData' | 'merchant' | 'testConfig'
>;

const currentOf = (mid: MidSettings): MidChange => ({
  onlyTwoD: mid.onlyTwoD === 1 ? 1 : 0,
  partial_refund_allowed: mid.partialRefundAllowed === 1 ? 1 : 0,
  curr_convert_to: mid.currConvertTo,
  allowed_curr: mid.allowedCurr,
  allowed_card: mid.allowedCard,
});

function payDeps(f: Deps, c: BankConfigCase): PayDeps {
  return {
    purchaseApi: f.purchaseApi,
    backoffice: f.backoffice,
    openPage: f.openCashierPage,
    request: changedRequest(buildPurchaseRequest(f.envData, f.merchant), c.set, c.remove),
    redirects: {
      success: f.envData.purchase.success_redirect,
      failure: f.envData.purchase.failure_redirect,
      pending: f.envData.purchase.pending_redirect,
    },
  };
}

/** Pays once PGS's MID cache holds the current MID settings. */
async function pay(
  f: Deps,
  c: BankConfigCase,
  testInfo: TestInfo,
): Promise<{ purchaseId: string; result: TransactionResult }> {
  const wait = midCacheWaitMs();
  testInfo.setTimeout(Math.max(testInfo.timeout, PAYMENT_TIMEOUT_MS) + wait);
  if (wait > 0) {
    testInfo.annotations.push({
      type: 'note',
      description: `waited ${String(Math.round(wait / 1000))} s for PGS's MID cache (5 min) to pick up the MID settings`,
    });
    await test.step('wait for PGS MID cache', waitForMidCache);
  }
  const scenario = requireCaseCard(f.testConfig.env, c.card, f.testConfig.transaction.payCardId);
  return createAndPay(payDeps(f, c), scenario, testInfo);
}

async function resolveTarget(f: Deps, c: BankConfigCase, testInfo: TestInfo): Promise<Target> {
  if (target !== undefined) return target;
  const merchantId = f.testConfig.merchant.id;
  test.skip(merchantId === undefined, 'Merchant ID unknown – set it on the tester profile');
  const runMid = f.testConfig.merchant.expectedMid?.split(',')[0]?.trim() ?? '';
  const runBank = f.testConfig.merchant.expectedBank?.split(',')[0]?.trim() ?? '';
  let midName = runMid;
  let bankName: string | undefined = runBank === '' ? undefined : runBank;
  if (midName === '') {
    // No MID on the Run tab – a probe payment shows where the merchant routes.
    testInfo.annotations.push({
      type: 'note',
      description: 'probe payment to find the routed MID',
    });
    const { result } = await pay(f, { ...c, set: {}, remove: [] }, testInfo);
    midName = result.bank?.midName ?? '';
    bankName = result.bank?.bankName;
    expect(midName, 'MID the probe payment was routed to').not.toBe('');
  }
  const found = await findMid(f.backoffice, midName, bankName);
  expect(found, `MID "${midName}" in the dashboard`).toBeDefined();
  if (found === undefined) throw new Error(`MID ${midName} not found`);
  expect(found.mid.isTestData, 'MID flagged as test data cannot be changed safely').toBe(false);
  target = { ...found, merchantId: merchantId ?? 0 };
  return target;
}

test.describe(
  'Cashier purchase › 6. Bank & MID configuration (uploaded)',
  { tag: ['@cashier', '@bank-config', '@transaction'] },
  () => {
    // One after another (shared settings), a failure does not skip the other cases.
    test.describe.configure({ mode: 'default' });

    test.beforeAll(async ({ backoffice }) => {
      // A killed run may have left a setting changed – put it back first.
      await restoreJournal(backoffice);
    });

    for (const bankCase of loadUploadedBankConfigCases()) {
      test(
        `${bankCase.id} ${bankCase.title}`,
        {
          tag: [`@${bankCase.id}`],
          annotation: [{ type: 'expected', description: describeBankExpected(bankCase.expected) }],
        },
        async (
          { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig },
          testInfo,
        ) => {
          const f = { purchaseApi, backoffice, openCashierPage, envData, merchant, testConfig };
          const t = await resolveTarget(f, bankCase, testInfo);
          const request = payDeps(f, bankCase).request as { purchase?: { currency?: string } };
          const ctx = {
            purchaseCurrency: (request.purchase?.currency ?? 'EUR').toUpperCase(),
            scheme: testConfig.merchant.paymentMethod.toUpperCase(),
            preferredOther: process.env.BANK_CONFIG_CONVERT_TO,
          };
          const { mid: change, merchantConversion } = resolveBankSettings(bankCase.settings, ctx);
          const current = currentOf(await getMidSettings(backoffice, t.bank.id, t.mid.mid));
          testInfo.annotations.push({
            type: 'mid settings',
            description: `${t.bank.name} / ${t.mid.mid}: ${
              Object.entries(change)
                .map(([k, v]) => `${k}=${String(v) || '(empty)'}`)
                .join(', ') || 'unchanged'
            }${merchantConversion === undefined ? '' : ` · merchant conversion=${String(merchantConversion)}`} (temporary – restored after the test)`,
          });
          const withSettings = <T>(body: () => Promise<T>): Promise<T> => {
            const inner = (): Promise<T> =>
              withMidSettings(
                backoffice,
                { bankId: t.bank.id, midId: t.mid.id },
                change,
                current,
                body,
              );
            return merchantConversion === undefined
              ? inner()
              : withMerchantConversion(backoffice, t.merchantId, merchantConversion, inner);
          };
          const e = bankCase.expected;

          if (bankCase.action === 'pay') {
            await withSettings(async () => {
              const { purchaseId, result } = await pay(f, bankCase, testInfo);
              const trx = await backoffice.requireTransaction(purchaseId, 1);
              const usedMid = result.bank?.midName ?? '';
              const error = [trx.errorMsg, result.cashier.apiMessage].filter(Boolean).join(' · ');
              testInfo.annotations.push({
                type: 'routing',
                description: `${usedMid ? `processed on ${result.bank?.bankName ?? '?'} / ${usedMid}` : 'not sent to any MID'} · status ${result.finalStatus} · currency ${trx.purchase.currency} → PSP ${trx.fx_Currency ?? result.bank?.currency ?? '–'}${error ? ` · ${safeMessage(error)}` : ''}`,
              });
              if (e.routing === 'uses')
                expect(usedMid, 'processed on the MID under test').toBe(t.mid.mid);
              if (e.routing === 'skips')
                expect(usedMid, 'MID under test skipped').not.toBe(t.mid.mid);
              if (e.statuses?.length)
                expect(e.statuses, `final status ${result.finalStatus}`).toContain(
                  result.finalStatus,
                );
              if (e.errorContains)
                expect(error.toLowerCase(), 'purchase error').toContain(
                  e.errorContains.toLowerCase(),
                );
              if (e.currency) {
                const wanted = resolveCurrencyToken(e.currency, ctx);
                expect(trx.fx_Currency ?? result.bank?.currency, 'currency sent to the PSP').toBe(
                  wanted,
                );
              }
            });
            return;
          }

          // Refund: pay with the current settings first, then change them and refund.
          const { purchaseId, result } = await pay(f, bankCase, testInfo);
          expect(result.finalStatus, 'the card must approve the payment').toBe('PAID');
          const total = money((await backoffice.requireTransaction(purchaseId, 1)).purchase.total);
          await withSettings(async () => {
            const amount =
              bankCase.action === 'full-refund' ? total : money(Math.max(0.01, total * 0.1));
            const response = await purchaseApi.refundPurchase(purchaseId, {
              amount,
              reason: `QA ${bankCase.id}`,
            });
            const code = field(response.body, 'code');
            const message = safeMessage(field(response.body, 'message'));
            const status = await settledStatus(purchaseApi, purchaseId);
            testInfo.annotations.push(
              {
                type: 'refund',
                description: `${String(amount)} ${result.bank?.currency ?? ''} → HTTP ${String(response.status)}${code ? ` ${code}` : ''}${message && message !== code ? `: ${message}` : ''}`,
              },
              { type: 'final status', description: status },
            );
            if (e.code) expect(code, 'refund code').toBe(e.code);
            if (!e.code && response.status === 400 && message.startsWith(PSP_REFUSED)) {
              observe(testInfo, 'The PSP refused the refund (sandbox: payment not settled yet)');
              return;
            }
            if (e.errorContains)
              expect(message.toLowerCase(), 'refund message').toContain(
                e.errorContains.toLowerCase(),
              );
            if (e.statuses?.length) expect(e.statuses, `final status ${status}`).toContain(status);
          });
        },
      );
    }
  },
);
