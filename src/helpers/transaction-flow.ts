import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BackofficeClient } from '../clients/backoffice-client';
import type { PurchaseApiClient } from '../clients/purchase-api-client';
import { CashierPage, type RedirectUrls } from '../pages/cashier-page';
import { currentDevice, deviceLabel } from '../pages/devices';
import type { BankTransaction, MerchantWebhook } from '../schemas/backoffice.schema';
import type { CashierCard, CashierPaymentResult } from '../types/cashier.types';
import {
  merchantWebhookChecks,
  pspWebhookChecks,
  WEBHOOK_STATUSES,
  type ComplianceResult,
} from './psp-compliance';
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

async function waitForFinalStatus(api: PurchaseApiClient, purchaseId: string): Promise<string> {
  let status = '';
  await expect
    .poll(
      async () => {
        status = (await api.getPurchase(purchaseId)).body.status.toUpperCase();
        return PENDING.has(status) ? 'pending' : 'final';
      },
      {
        timeout: FINAL_STATUS_TIMEOUT_MS,
        intervals: [2_000, 3_000, 5_000],
        message: 'final purchase status',
      },
    )
    .toBe('final');
  return status;
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

  const finalStatus = await test.step('final purchase status', async () =>
    cashier.outcome === 'rejected'
      ? (await deps.purchaseApi.getPurchase(input.purchaseId)).body.status.toUpperCase()
      : waitForFinalStatus(deps.purchaseApi, input.purchaseId));
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
