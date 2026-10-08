import { expect, test, type TestInfo } from '@playwright/test';
import { CashierPage, type RedirectUrls } from '../pages/cashier-page';
import { currentDevice, deviceLabel } from '../pages/devices';
import type { BankTransaction } from '../schemas/backoffice.schema';
import type { ApiResponse } from '../types/api.types';
import type { CashierCard, CashierPaymentResult } from '../types/cashier.types';
import type { PspSummary } from './psp-validation';
import { recordBrowserResult, settleTransaction, type TransactionDeps } from './transaction-flow';

/**
 * S2S purchase flow (card payment methods only):
 *   1. POST /v1/purchases/            → status CREATED + purchaseId (checkout_url is NOT opened)
 *   2. POST /v1/p/{purchaseId}/?s2s=true with card + browser data
 *        → 202 {status: "pending", method: "GET", callback_url}   (merchant trxType ALL / 3D)
 *        → 202 purchase after the payment, trxType 2D              (merchant trxType 2D – PGS
 *          pays inside the call, no browser step, callback "no_need")
 *   3. open callback_url in the customer's browser → 3DS challenge (if the bank asks) →
 *      merchant redirect (success / failure / pending)
 *   4. final status, PSP request/response and merchant webhooks – the same checks as the cashier.
 */
export interface S2sInput {
  readonly purchaseId: string;
  readonly card: CashierCard;
  readonly body: Record<string, unknown>;
  readonly redirects: RedirectUrls;
  readonly request?: object | undefined;
  readonly expectedBank?: string | undefined;
  readonly expectedMid?: string | undefined;
}

export type S2sMode = 'callback' | '2d-direct' | 'rejected';

export interface S2sResult {
  readonly s2s: ApiResponse<Record<string, unknown>>;
  readonly mode: S2sMode;
  readonly callbackUrl?: string | undefined;
  /** Browser part (callback mode only). */
  readonly browser?: CashierPaymentResult | undefined;
  readonly finalStatus: string;
  readonly psp: PspSummary | undefined;
  readonly bank: BankTransaction | undefined;
}

const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

/** What kind of S2S answer this is. */
export function s2sMode(response: ApiResponse<Record<string, unknown>>): S2sMode {
  if (response.status !== 202) return 'rejected';
  const body = response.body;
  const callback = text(body.callback_url);
  if (text(body.status).toLowerCase() === 'pending' && /^https?:\/\//.test(callback))
    return 'callback';
  if (text(body.purchaseId) !== '' || text(body.trxType).toUpperCase() === '2D') return '2d-direct';
  return 'rejected';
}

/** Error text of a rejected S2S call (message / code, or bean-validation field errors). */
export function s2sError(response: ApiResponse<Record<string, unknown>>): string {
  const body = response.body as Record<string, unknown> | undefined;
  if (body === undefined) return '';
  const direct = [text(body.code), text(body.message)].filter(Boolean).join(': ');
  if (direct !== '') return direct;
  return JSON.stringify(body).slice(0, 300);
}

export async function executeS2sTransaction(
  deps: TransactionDeps,
  input: S2sInput,
  testInfo: TestInfo,
): Promise<S2sResult> {
  const s2s = await deps.purchaseApi.s2sPay(input.purchaseId, input.body);
  return continueS2s(deps, input, s2s, testInfo);
}

/**
 * After the S2S call (made here or by the test itself): records the answer, opens the
 * callback (3DS / redirect) when there is one, then waits for the final status and checks
 * the PSP request/response and webhooks. A rejected call only reads the purchase status.
 */
export async function continueS2s(
  deps: TransactionDeps,
  input: S2sInput,
  s2s: ApiResponse<Record<string, unknown>>,
  testInfo: TestInfo,
): Promise<S2sResult> {
  testInfo.annotations.push({ type: 'device', description: deviceLabel(currentDevice()) });
  const mode = s2sMode(s2s);
  const callbackUrl = mode === 'callback' ? text(s2s.body.callback_url) : undefined;
  testInfo.annotations.push({
    type: 's2s response',
    description:
      mode === 'callback'
        ? `HTTP ${String(s2s.status)} · status ${text(s2s.body.status)} · ${text(s2s.body.method) || 'GET'} callback_url ${callbackUrl ?? ''}`
        : mode === '2d-direct'
          ? `HTTP ${String(s2s.status)} · 2D merchant – paid inside the S2S call · status ${text(s2s.body.status)}`
          : `HTTP ${String(s2s.status)} · ${s2sError(s2s)}`,
  });
  if (mode === 'rejected') {
    const status = (await deps.purchaseApi.getPurchase(input.purchaseId)).body.status.toUpperCase();
    testInfo.annotations.push({ type: 'final status', description: status });
    return { s2s, mode, finalStatus: status, psp: undefined, bank: undefined };
  }

  let browser: CashierPaymentResult | undefined;
  if (mode === 'callback' && callbackUrl !== undefined) {
    browser = await test.step('open callback_url (customer browser)', async () => {
      const page = await deps.openPage();
      const result = await new CashierPage(page).openCallback(callbackUrl, input.redirects, {
        challenge: input.card.challenge,
        headed: deps.headed ?? process.env.RUN_HEADED === '1',
        timeBudget: () =>
          testInfo.timeout > 0
            ? Math.max(15_000, testInfo.timeout - testInfo.duration - 20_000)
            : Infinity,
      });
      await testInfo.attach('after-callback.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.close();
      return result;
    });
    await recordBrowserResult(browser, testInfo);
  }

  const settled = await settleTransaction(
    deps,
    {
      purchaseId: input.purchaseId,
      card: input.card,
      request: input.request,
      expectedBank: input.expectedBank,
      expectedMid: input.expectedMid,
      // Masking rules + webhook in / out are reported for S2S and session payments too.
      pspChecks: true,
    },
    false,
    testInfo,
  );
  return { s2s, mode, callbackUrl, browser, ...settled };
}

/** The S2S answer of a 3DS-capable merchant: 202 pending + GET callback_url to this purchase. */
export function expectPendingCallback(result: S2sResult, purchaseId: string): void {
  if (result.mode === '2d-direct') return;
  expect(result.s2s.status, `S2S answer: ${s2sError(result.s2s)}`).toBe(202);
  expect(text(result.s2s.body.status), 'S2S status').toBe('pending');
  expect.soft(text(result.s2s.body.method) || 'GET', 'callback method').toBe('GET');
  expect
    .soft(result.callbackUrl ?? '', 'callback_url points to the purchase')
    .toContain(purchaseId);
}
