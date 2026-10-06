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
import { maskString } from '../utils/masking';
import { recordPspResult, summarizePsp, type PspSummary } from './psp-validation';

const FINAL_STATUS_TIMEOUT_MS = 90_000;
/** Added to the test timeout when the 3DS page re-opens and the OTP is entered again. */
const RESHOWN_EXTRA_MS = 30_000;
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
  // Reports → Transaction Log shows every webhook:IN; if it cannot be read the PSP webhook log decides.
  const log = await backoffice.getTransactionLog(purchaseId).catch(() => undefined);
  const loggedIn = log?.filter((entry) => entry.event === 'webhook:IN').length;
  results.push(pspWebhookChecks(incoming, loggedIn));
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
      // Never wait for a redirect longer than the test can still run (keeps room for the checks after).
      timeBudget: () =>
        testInfo.timeout > 0
          ? Math.max(15_000, testInfo.timeout - testInfo.duration - 20_000)
          : Infinity,
      // Entering the OTP a second time needs extra time on top of the normal budget.
      onChallengeReshown: () => {
        if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + RESHOWN_EXTRA_MS);
      },
    });
    await testInfo.attach('after-pay.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.close();
    return result;
  });
  await recordBrowserResult(cashier, testInfo);
  const settled = await settleTransaction(deps, input, cashier.outcome === 'rejected', testInfo);
  return { cashier, ...settled };
}

/** Annotations / attachments for what happened in the browser (device data, 3DS, outcome). */
export async function recordBrowserResult(
  cashier: CashierPaymentResult,
  testInfo: TestInfo,
): Promise<void> {
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
  for (const item of cashier.reshownEvidence ?? []) {
    const name = `otp-reopened-${String(item.attempt)}`;
    if (item.screenshot) {
      await testInfo.attach(`${name}.png`, { body: item.screenshot, contentType: 'image/png' });
    }
    await testInfo.attach(`${name}.json`, {
      body: JSON.stringify(
        {
          attempt: item.attempt,
          at: item.at,
          pageUrl: maskString(item.pageUrl),
          frameUrl: maskString(item.frameUrl),
          text: maskString(item.text),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
  if (cashier.reshownEvidence?.length) {
    testInfo.annotations.push({
      type: 'otp page reopened',
      description: `${String(cashier.reshownEvidence.length)}× after submit – artifacts: ${cashier.reshownEvidence.map((e) => `otp-reopened-${String(e.attempt)}.png/.json`).join(', ')}`,
    });
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
}

export interface SettleInput {
  readonly purchaseId: string;
  readonly card?: CashierCard | undefined;
  readonly expectedBank?: string | undefined;
  readonly expectedMid?: string | undefined;
  readonly request?: object | undefined;
}

/**
 * After the payment was started (cashier PAY, S2S callback or S2S 2D): waits for the final
 * purchase status, then checks the PSP request/response (back-office) and the webhooks.
 * `rejected` = the payment never reached PGS processing (status read once, no PSP wait).
 */
export async function settleTransaction(
  deps: Pick<TransactionDeps, 'purchaseApi' | 'backoffice'>,
  input: SettleInput,
  rejected: boolean,
  testInfo: TestInfo,
): Promise<{ finalStatus: string; psp: PspSummary; bank: BankTransaction | undefined }> {
  const finalStatus = await test.step('final purchase status', async () => {
    if (rejected) {
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
    const bank = await waitForBankRecord(deps.backoffice, input.purchaseId, rejected ? 1 : 6);
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
    return { finalStatus, psp, bank };
  });
}

/**
 * The 3DS page re-opened after the OTP was submitted (the OTP was entered
 * again) and the purchase still ended as expected. That is an observation for
 * the report, not a pass or a failure: the payment is fine, the bank page
 * behaved unexpectedly. A wrong final status is still a failure.
 */
export function challengeReshownObserved(
  result: TransactionResult,
  expected: {
    /** A CashierOutcome, or free text from an uploaded case. */
    readonly outcome?: string | undefined;
    readonly statuses?: readonly string[] | undefined;
  },
): boolean {
  if (result.cashier.challengeReshown !== true) return false;
  const statuses = expected.statuses ?? [];
  const statusGiven = statuses.length > 0;
  const statusOk = !statusGiven || statuses.includes(result.finalStatus);
  const outcomeOk = expected.outcome === undefined || result.cashier.outcome === expected.outcome;
  return statusOk && (outcomeOk || statusGiven);
}

/** Records the observation so the report shows OBSERVED with the reason. */
export function markChallengeReshown(result: TransactionResult, testInfo: TestInfo): void {
  const times = result.cashier.reshownEvidence?.length ?? 1;
  testInfo.annotations.push(
    { type: 'verdict', description: 'observe' },
    {
      type: 'error message',
      description:
        `3DS OTP page re-opened after submit (${String(times)}×), same OTP entered again → ` +
        `cashier ${result.cashier.outcome}, final status ${result.finalStatus}`,
    },
  );
  // PSP checks are not asserted for an observed case (the OTP was entered twice, which can
  // affect them); the ones that did not pass stay visible in the report details.
  const notMet = result.psp.checks.filter((check) => !check.passed);
  if (notMet.length > 0) {
    testInfo.annotations.push({
      type: 'observed – checks not met',
      description: notMet
        .map(
          (check) => `${check.name}: expected ${check.expected}, got ${check.actual || '(empty)'}`,
        )
        .join(' | '),
    });
  }
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
