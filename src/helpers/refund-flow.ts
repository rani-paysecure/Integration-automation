import { expect, test, type TestInfo } from '@playwright/test';
import type { BackofficeClient } from '../clients/backoffice-client';
import type { PurchaseApiClient } from '../clients/purchase-api-client';
import type { RefundDetails } from '../schemas/backoffice.schema';
import {
  cancelInfoChecks,
  maskingChecks,
  merchantWebhookChecks,
  type ComplianceCheck,
} from './psp-compliance';
import { findFirstValue } from './psp-validation';
import { waitForMerchantWebhooks } from './transaction-flow';

/**
 * Refund flow (RefundService.partialRefundPurchase) and what it must leave behind:
 *  - a RefundHistory entry (Reports → transaction → refunds) and a status history line "<status> amt: x",
 *  - the masked refund request in the bank record's `cancelInfo` (commongateway Main, refund call),
 *  - status partial_refunded / refunded and a merchant webhook ("payment refund"),
 *  - when the PSP refuses: refund entry ERROR, "refund_failed amt: x", status unchanged.
 */
export interface RefundablePurchase {
  readonly purchaseId: string;
  readonly total: number;
  readonly currency: string;
  /** Card number used to pay (must never appear in clear); undefined for a purchase given by ID. */
  readonly cardNumber?: string | undefined;
  /** Status before the refund (PAID / PARTIAL_REFUNDED). */
  status: string;
  /** Refunded so far (PSP-confirmed). */
  refunded: number;
}

export interface RefundDeps {
  readonly purchaseApi: PurchaseApiClient;
  readonly backoffice: BackofficeClient;
}

/** PGS answer when the PSP call of the refund failed. */
export const PSP_REFUSED = 'Refund can not be initiated';
const REFUND_WAIT_MS = 90_000;

export const money = (value: number): number => Math.round(value * 100) / 100;

/** Text of a field of an API answer (`code`, `message`, `amount` …). */
export function field(body: unknown, key: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function expectChecks(checks: readonly ComplianceCheck[]): void {
  for (const check of checks) {
    expect
      .soft(
        check.passed,
        `${check.name}: expected ${check.expected}, got ${check.actual || '(empty)'}`,
      )
      .toBe(true);
  }
}

async function settledStatus(api: PurchaseApiClient, purchaseId: string): Promise<string> {
  let status = '';
  await expect
    .poll(
      async () => {
        status = (await api.getPurchase(purchaseId)).body.status.toUpperCase();
        return status === 'REFUND_IN_PROCESS' ? 'in process' : 'done';
      },
      { timeout: REFUND_WAIT_MS, intervals: [2_000, 3_000, 5_000], message: 'refund processed' },
    )
    .toBe('done');
  return status;
}

export function recordHistory(testInfo: TestInfo, details: RefundDetails | undefined): void {
  if (details === undefined) return;
  testInfo.annotations.push({
    type: 'refund history',
    description:
      `refunded ${String(details.totalRefunded ?? 0)} · refundable ${String(details.refundable_amount ?? '?')} · ` +
      `${String(details.refunds?.length ?? 0)} refund(s) [${(details.refunds ?? []).map((r) => `${String(r.amount ?? '?')} ${r.status ?? '?'}`).join(', ')}] · status ${details.status ?? '?'}`,
  });
}

/** The refund request must be in cancelInfo, masked like every other PSP payload. */
async function verifyCancelInfo(
  deps: RefundDeps,
  purchase: RefundablePurchase,
  amount: number,
  testInfo: TestInfo,
): Promise<string> {
  const bank = await deps.backoffice.getBankTransaction(purchase.purchaseId);
  expect(bank, 'bank record of the purchase').toBeDefined();
  const record = bank ?? {};
  expectChecks(cancelInfoChecks(record, amount).checks);
  const masking = maskingChecks(
    record,
    purchase.cardNumber === undefined ? undefined : { number: purchase.cardNumber },
  );
  expectChecks(masking.checks);
  testInfo.annotations.push(...masking.notes.map((description) => ({ type: 'note', description })));
  const responses = Array.isArray(record.response) ? (record.response as unknown[]) : [];
  const last = responses.at(-1);
  return findFirstValue((last as { error?: unknown } | undefined)?.error, ['message', 'code']);
}

/**
 * Sends the refund and verifies the result. PSP refused (e.g. Paysafe 3406
 * "settlement … has not been batched yet") → verifies the failure is recorded
 * and marks the test OBSERVED (a PSP/sandbox limitation, not a PGS defect).
 * @returns true when the PSP refunded.
 */
export async function refundAndVerify(
  deps: RefundDeps,
  purchase: RefundablePurchase,
  amount: number,
  testInfo: TestInfo,
): Promise<boolean> {
  const response = await deps.purchaseApi.refundPurchase(purchase.purchaseId, {
    amount,
    reason: `QA refund ${String(amount)}`,
  });
  testInfo.annotations.push({
    type: 'refund',
    description: `${String(amount)} ${purchase.currency} → HTTP ${String(response.status)}${field(response.body, 'message') ? `: ${field(response.body, 'message')}` : ''}`,
  });
  const refused =
    response.status === 400 && field(response.body, 'message').startsWith(PSP_REFUSED);
  if (!refused) {
    expect(response.status, `refund accepted: ${field(response.body, 'message')}`).toBe(202);
    expect.soft(Number(field(response.body, 'amount')), 'refund entry amount').toBe(amount);
  }

  const status = await settledStatus(deps.purchaseApi, purchase.purchaseId);
  testInfo.annotations.push({ type: 'final status', description: status });
  const wanted = refused
    ? purchase.status
    : money(purchase.refunded + amount) >= purchase.total
      ? 'REFUNDED'
      : 'PARTIAL_REFUNDED';
  expect.soft(status, 'purchase status after the refund').toBe(wanted);

  await test.step('refund history in the dashboard', async () => {
    const details = await deps.backoffice.getRefundDetails(purchase.purchaseId);
    recordHistory(testInfo, details);
    expect(details, 'refund details in the dashboard').toBeDefined();
    const entry = [...(details?.refunds ?? [])]
      .reverse()
      .find((r) => Math.abs((r.amount ?? 0) - amount) < 0.011);
    expect.soft(entry, `refund of ${String(amount)} listed in the refund history`).toBeDefined();
    const refundedNow = refused ? purchase.refunded : money(purchase.refunded + amount);
    expect.soft(money(details?.totalRefunded ?? 0), 'total refunded').toBe(refundedNow);
    expect
      .soft(money(details?.refundable_amount ?? Number.NaN), 'refundable amount')
      .toBe(money(purchase.total - refundedNow));
    if (refused) {
      expect.soft(entry?.status?.toUpperCase(), 'refused refund entry status').toBe('ERROR');
    }
    const history = (details?.status_history ?? []).map((h) => (h.status ?? '').toLowerCase());
    const line = refused ? 'refund_failed amt' : `${status.toLowerCase()} amt`;
    expect
      .soft(
        history.some((h) => h.startsWith(line)),
        `status history has "${line}: …" (has: ${history.join(', ')})`,
      )
      .toBe(true);
  });

  const pspError = await test.step('refund request in cancelInfo (masked)', () =>
    verifyCancelInfo(deps, purchase, amount, testInfo));

  if (refused) {
    testInfo.annotations.push(
      { type: 'verdict', description: 'observe' },
      {
        type: 'note',
        description: `PSP refused the refund${pspError ? `: "${pspError}"` : ''} – use a settled purchase (launcher: "Settled purchase to refund") to test a successful refund`,
      },
    );
    return false;
  }

  await test.step('merchant webhook for the refund', async () => {
    const webhooks = await waitForMerchantWebhooks(deps.backoffice, purchase.purchaseId, status);
    const result = merchantWebhookChecks(webhooks, { status });
    expectChecks(result.checks);
    testInfo.annotations.push(
      ...result.notes.map((description) => ({ type: 'note', description })),
    );
  });
  purchase.refunded = money(purchase.refunded + amount);
  purchase.status = status;
  return true;
}

/** A purchase given by ID (already settled at the PSP) – read total, status and refunds so far. */
export async function loadRefundablePurchase(
  backoffice: BackofficeClient,
  purchaseId: string,
): Promise<RefundablePurchase> {
  const trx = await backoffice.requireTransaction(purchaseId, 365);
  const details = await backoffice.getRefundDetails(purchaseId);
  return {
    purchaseId,
    total: money(trx.purchase.total),
    currency: trx.purchase.currency,
    status: trx.status.toUpperCase(),
    refunded: money(details?.totalRefunded ?? 0),
  };
}
