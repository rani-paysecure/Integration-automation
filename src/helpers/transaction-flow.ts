import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BackofficeClient } from '../clients/backoffice-client';
import type { PurchaseApiClient } from '../clients/purchase-api-client';
import { CashierPage, type RedirectUrls } from '../pages/cashier-page';
<<<<<<< Updated upstream
import { currentDevice, deviceLabel } from '../pages/devices';
import type { BankTransaction, MerchantWebhook } from '../schemas/backoffice.schema';
import type { CashierCard, CashierPaymentResult } from '../types/cashier.types';
import {
  merchantWebhookChecks,
  pspWebhookChecks,
  WEBHOOK_STATUSES,
  type ComplianceResult,
} from './psp-compliance';
=======
import type { BankTransaction } from '../schemas/backoffice.schema';
import type { CashierCard, CashierOutcome, CashierPaymentResult } from '../types/cashier.types';
>>>>>>> Stashed changes
import { recordPspResult, summarizePsp, type PspSummary } from './psp-validation';

const FINAL_STATUS_TIMEOUT_MS = 90_000;
const PENDING = new Set([
  'CREATED',
  'VIEWED',
  'PENDING_EXECUTE',
  'PENDINGEXECUTE',
  'PAYMENT_IN_PROCESS',
]);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface TransactionInput {
  readonly purchaseId: string;
  readonly checkoutUrl: string;
  readonly card: CashierCard;
  readonly redirects: RedirectUrls;
  readonly expectedBank?: string | undefined;
  readonly expectedMid?: string | undefined;
  /** Purchase request that was sent – enables the purchase ↔ PSP mapping and webhook URL checks. */
  readonly request?: object | undefined;
}

export interface TransactionResult {
  readonly cashier: CashierPaymentResult;
  readonly finalStatus: string;
  readonly psp: PspSummary;
  readonly bank: BankTransaction | undefined;
}

export interface TransactionDeps {
  readonly purchaseApi: PurchaseApiClient;
  readonly backoffice: BackofficeClient;
  /** Opens a fresh browser page (the browser is only started when a payment is made). */
  readonly openPage: () => Promise<Page>;
  /** Browser is visible – a "manual" 3DS challenge waits for the tester. Default: RUN_HEADED. */
  readonly headed?: boolean;
}

async function waitForFinalStatus(
  api: PurchaseApiClient,
  purchaseId: string,
  seen: { status: string },
  timeoutMs: number = FINAL_STATUS_TIMEOUT_MS,
): Promise<string> {
  await expect
    .poll(
      async () => {
        seen.status = (await api.getPurchase(purchaseId)).body.status.toUpperCase();
        return PENDING.has(seen.status) ? 'pending' : 'final';
      },
      {
        timeout: timeoutMs,
        intervals: [2_000, 3_000, 5_000],
        message: 'final purchase status',
      },
    )
    .toBe('final');
  return seen.status;
}

/** Polls the purchase for a short while; true as soon as it has a final status. */
async function isPurchaseFinal(
  api: PurchaseApiClient,
  purchaseId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await api.getPurchase(purchaseId)).body.status.toUpperCase();
    if (!PENDING.has(status)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(2_000);
  }
}

/** The bank/PSP record is written asynchronously – give it a moment. */
async function waitForBankRecord(
  backoffice: BackofficeClient,
  purchaseId: string,
  attempts: number,
): Promise<BankTransaction | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const bank = await backoffice.getBankTransaction(purchaseId);
    if (bank !== undefined) return bank;
    await sleep(3_000);
  }
  return undefined;
}

const WEBHOOK_WAIT_MS = 30_000;

/** Merchant webhooks are sent asynchronously (webhook queue) – wait for the one of `status`. */
export async function waitForMerchantWebhooks(
  backoffice: BackofficeClient,
  purchaseId: string,
  status: string,
  timeoutMs = WEBHOOK_WAIT_MS,
): Promise<MerchantWebhook[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const webhooks = await backoffice.getMerchantWebhooks(purchaseId);
    const found = webhooks.some(
      (w) => (w.transactionStatus ?? '').toLowerCase() === status.toLowerCase(),
    );
    if (found || Date.now() > until) return webhooks;
    await sleep(3_000);
  }
}

/** Callback PGS uses for a status (PurchaseService.callWebhook); other statuses use the dashboard URL. */
export function callbackFor(status: string, request: object | undefined): string | undefined {
  const s = status.toLowerCase();
  const pick = (key: string): string | undefined => {
    const value = (request as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  if (['paid', 'partial_paid', 'over_paid'].includes(s)) return pick('success_callback');
  if (['error', 'expired'].includes(s)) return pick('failure_callback');
  return undefined;
}

/** Webhook in (PSP → PGS) and webhook out (PGS → merchant) for the final status. */
export async function webhookResults(
  backoffice: BackofficeClient,
  purchaseId: string,
  status: string,
  options: {
    readonly request?: object | undefined;
    readonly pspTransId?: string | undefined;
  },
): Promise<ComplianceResult> {
  const results: ComplianceResult[] = [];
  if (WEBHOOK_STATUSES.has(status.toLowerCase())) {
    const out = await waitForMerchantWebhooks(backoffice, purchaseId, status);
    results.push(
      merchantWebhookChecks(out, { status, callbackUrl: callbackFor(status, options.request) }),
    );
  }
  const incoming = await backoffice.getPspWebhooks([purchaseId, options.pspTransId ?? '']);
  results.push(pspWebhookChecks(incoming));
  return {
    checks: results.flatMap((r) => r.checks),
    notes: results.flatMap((r) => r.notes),
  };
}

/**
 * Real transaction for an already created purchase:
 * cashier (card → PAY → 3DS/PSP → redirect) → final status → PSP record in
 * the back-office → PSP checks (reference, amount, currency, bank, status).
 * Records everything on the test for the reports.
 */
export async function executeTransaction(
  deps: TransactionDeps,
  input: TransactionInput,
  testInfo: TestInfo,
): Promise<TransactionResult> {
  testInfo.annotations.push({ type: 'device', description: deviceLabel(currentDevice()) });
  const cashier = await test.step('pay on cashier', async () => {
    const page = await deps.openPage();
    const cashierPage = new CashierPage(page);
    await cashierPage.open(input.checkoutUrl);
    await cashierPage.enterCard(input.card);
    const result = await cashierPage.pay(input.redirects, {
      challenge: input.card.challenge,
      headed: deps.headed ?? process.env.RUN_HEADED === '1',
      // Only asked when the 3DS page comes back after the OTP (see CashierPage.pay).
      isSettled: () => isPurchaseFinal(deps.purchaseApi, input.purchaseId, 10_000),
    });
    await testInfo.attach('after-pay.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.close();
    return result;
  });
  if (cashier.browserData) {
    const { sent, screen } = cashier.browserData;
    const fp = (key: string): string => sent[key] ?? '–';
    testInfo.annotations.push({
      type: 'device data to PGS',
      description:
        `screen ${fp('sw')}×${fp('sh')} · colour depth ${fp('cd')} · pixel depth ${fp('pd')} · ` +
        `timezone offset ${fp('uo')} min · java ${fp('ije')}`,
    });
    // PGS forwards these to PSPs that need 3DS browser data – they must be the device's real values.
    expect
      .soft(
        `${fp('sw')}×${fp('sh')}`,
        `screen size sent to PGS should be the device screen ${String(screen.width)}×${String(screen.height)}`,
      )
      .toBe(`${String(screen.width)}×${String(screen.height)}`);
  }
  if (cashier.challenge) {
    testInfo.annotations.push({
      type: '3ds challenge',
      description: `${cashier.challenge.host}: ${cashier.challenge.detail}`,
    });
  }
  testInfo.annotations.push({
    type: 'cashier outcome',
    description:
      `${cashier.outcome}${cashier.apiMessage ? `: ${cashier.apiMessage}` : ''}` +
      (cashier.visitedPages.length ? ` (via ${cashier.visitedPages.join(', ')})` : ''),
  });

  const finalStatus = await test.step('final purchase status', async () => {
    if (cashier.outcome === 'rejected') {
      return (await deps.purchaseApi.getPurchase(input.purchaseId)).body.status.toUpperCase();
    }
    const seen = { status: '' };
    // Stay inside the test timeout so a still-pending purchase is reported
    // (last status seen) instead of the test being killed with no result.
    const remaining =
      testInfo.timeout > 0 ? testInfo.timeout - testInfo.duration - 5_000 : Infinity;
    const budget = Math.max(5_000, Math.min(FINAL_STATUS_TIMEOUT_MS, remaining));
    try {
      return await waitForFinalStatus(deps.purchaseApi, input.purchaseId, seen, budget);
    } catch (error) {
      testInfo.annotations.push({
        type: 'final status',
        description: `${seen.status || 'unknown'} (not final after ${String(Math.round(budget / 1000))} s)`,
      });
      throw error;
    }
  });
  testInfo.annotations.push({ type: 'final status', description: finalStatus });

  return test.step('PSP request/response (back-office)', async () => {
    const trx = await deps.backoffice.requireTransaction(input.purchaseId, 1);
    const bank = await waitForBankRecord(
      deps.backoffice,
      input.purchaseId,
      cashier.outcome === 'rejected' ? 1 : 6,
    );
    const summary = summarizePsp(input.purchaseId, trx, bank, {
      expectedBank: input.expectedBank,
      expectedMid: input.expectedMid,
      request: input.request,
      card: input.card,
    });
    const webhooks = summary.attempted
      ? await webhookResults(deps.backoffice, input.purchaseId, finalStatus, {
          request: input.request,
          pspTransId: bank?.paymentTransId,
        })
      : { checks: [], notes: [] };
    const psp: PspSummary = {
      ...summary,
      checks: [...summary.checks, ...webhooks.checks],
      notes: [...summary.notes, ...webhooks.notes],
    };
    await recordPspResult(testInfo, psp, bank);
    return { cashier, finalStatus, psp, bank };
  });
}

/**
 * The 3DS page came back after the OTP, so the merchant redirect was never
 * seen, yet the purchase reached one of the expected final statuses. That is
 * an observation (the payment itself is fine), not a failed payment.
 */
export function redirectMissedButSettled(
  result: TransactionResult,
  expected: {
    readonly outcome?: CashierOutcome | string | undefined;
    readonly statuses?: readonly string[] | undefined;
  },
): boolean {
  return (
    result.cashier.challengeReshown === true &&
    expected.outcome !== undefined &&
    result.cashier.outcome !== expected.outcome &&
    expected.statuses !== undefined &&
    expected.statuses.includes(result.finalStatus)
  );
}

/** Records the observation so the report shows OBSERVED with the reason. */
export function markRedirectObserved(result: TransactionResult, testInfo: TestInfo): void {
  testInfo.annotations.push(
    { type: 'verdict', description: 'observe' },
    {
      type: 'error message',
      description: `Status ${result.finalStatus}; 3DS page shown again after OTP; no merchant redirect seen (${result.cashier.finalUrl})`,
    },
  );
}

/** Soft-asserts every PSP check so all problems are reported together. */
export function expectPspChecks(psp: PspSummary): void {
  for (const check of psp.checks) {
    expect
      .soft(
        check.passed,
        `${check.name}: expected ${check.expected}, got ${check.actual || '(empty)'}`,
      )
      .toBe(true);
  }
}
