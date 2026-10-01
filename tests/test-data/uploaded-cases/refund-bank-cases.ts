import { expect, type Page, type TestInfo } from '@playwright/test';
import type { CashierCardScenario } from '@app-types/cashier.types';
import type { BackofficeClient } from '@clients/backoffice-client';
import type { MidChange } from '@clients/bank-config';
import type { PurchaseApiClient } from '@clients/purchase-api-client';
import { otherCurrency, otherScheme } from '@helpers/bank-config-flow';
import { money } from '@helpers/refund-flow';
import { executeTransaction, type TransactionResult } from '@helpers/transaction-flow';
import { omitPath, setPath } from '@utils/object';
import type { BankConfigCase, RefundAmount, RefundCase } from './uploaded-cases';

/**
 * Shared pieces of the uploaded refund (RC-xxx) and bank & MID config (BC-xxx) cases.
 */

// ── refunds ─────────────────────────────────────────────────────────────────

/** Amount to send for a step; undefined = "amount not sent". */
export function resolveRefundAmount(
  amount: RefundAmount,
  total: number,
  refunded: number,
): number | string | undefined {
  switch (amount.kind) {
    case 'none':
      return undefined;
    case 'total':
      return money(total);
    case 'rest':
      return money(total - refunded + (amount.delta ?? 0));
    case 'percent':
      return money((total * amount.value) / 100);
    case 'fixed':
      return amount.value;
    case 'raw':
      return amount.value;
  }
}

export function describeRefundAmount(amount: RefundAmount): string {
  switch (amount.kind) {
    case 'none':
      return 'amount not sent';
    case 'total':
      return 'total';
    case 'rest':
      return amount.delta ? `rest${amount.delta > 0 ? '+' : ''}${String(amount.delta)}` : 'rest';
    case 'percent':
      return `${String(amount.value)}%`;
    case 'fixed':
      return String(amount.value);
    case 'raw':
      return JSON.stringify(amount.value);
  }
}

export function refundReason(c: RefundCase): string | undefined {
  if (c.reason?.kind === 'none') return undefined;
  if (c.reason?.kind === 'value') return c.reason.value;
  return `QA refund ${c.id}`;
}

export const describeRefundExpected = (e: RefundCase['expected']): string =>
  [
    e.http === undefined ? '' : `HTTP ${String(e.http)}`,
    e.code ?? '',
    e.messageContains ? `message contains "${e.messageContains}"` : '',
    e.statuses?.length ? `status ${e.statuses.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ') + ' (last refund step)';

// ── bank & MID config ───────────────────────────────────────────────────────

export interface SettingContext {
  readonly purchaseCurrency: string;
  readonly scheme: string;
  /** BANK_CONFIG_CONVERT_TO – preferred "other" currency. */
  readonly preferredOther?: string | undefined;
}

/** Replaces {purchase} / {other} / {card} tokens. */
function resolveTokens(value: string, kind: 'currency' | 'card', ctx: SettingContext): string {
  return value
    .split(',')
    .filter(Boolean)
    .map((item) => {
      if (item === '{purchase}') return ctx.purchaseCurrency;
      if (item === '{card}') return ctx.scheme;
      if (item === '{other}')
        return kind === 'currency'
          ? otherCurrency(ctx.purchaseCurrency, ctx.preferredOther)
          : otherScheme(ctx.scheme);
      return item;
    })
    .join(',');
}

/** MID change + merchant conversion flag of a BC case, tokens resolved. */
export function resolveBankSettings(
  settings: BankConfigCase['settings'],
  ctx: SettingContext,
): { mid: MidChange; merchantConversion: 0 | 1 | undefined } {
  const mid: {
    onlyTwoD?: 0 | 1;
    partial_refund_allowed?: 0 | 1;
    curr_convert_to?: string;
    allowed_curr?: string;
    allowed_card?: string;
  } = {};
  if (settings.onlyTwoD !== undefined) mid.onlyTwoD = settings.onlyTwoD;
  if (settings.partial_refund_allowed !== undefined)
    mid.partial_refund_allowed = settings.partial_refund_allowed;
  if (settings.curr_convert_to !== undefined)
    mid.curr_convert_to = resolveTokens(settings.curr_convert_to, 'currency', ctx);
  if (settings.allowed_curr !== undefined)
    mid.allowed_curr = resolveTokens(settings.allowed_curr, 'currency', ctx);
  if (settings.allowed_card !== undefined)
    mid.allowed_card = resolveTokens(settings.allowed_card, 'card', ctx);
  return { mid, merchantConversion: settings.merchant_conversion };
}

export function resolveCurrencyToken(value: string, ctx: SettingContext): string {
  return resolveTokens(value, 'currency', ctx);
}

const ROUTING_TEXT = { uses: 'processed on the MID under test', skips: 'MID under test skipped' };
export const describeBankExpected = (e: BankConfigCase['expected']): string =>
  [
    e.routing ? ROUTING_TEXT[e.routing] : '',
    e.statuses?.length ? `status ${e.statuses.join(' / ')}` : '',
    e.code ? `code ${e.code}` : '',
    e.errorContains ? `error contains "${e.errorContains}"` : '',
    e.currency ? `PSP currency ${e.currency}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

// ── payment ─────────────────────────────────────────────────────────────────

export interface PayDeps {
  readonly purchaseApi: PurchaseApiClient;
  readonly backoffice: BackofficeClient;
  readonly openPage: () => Promise<Page>;
  readonly request: Record<string, unknown>;
  readonly redirects: { success: string; failure: string; pending: string };
}

/** Request with the case's changes applied. */
export function changedRequest(
  base: object,
  set: Readonly<Record<string, unknown>> | undefined,
  remove: readonly string[] | undefined,
): Record<string, unknown> {
  let request: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [path, value] of Object.entries(set ?? {})) request = setPath(request, path, value);
  for (const path of remove ?? []) request = omitPath(request, path);
  return request;
}

/** Creates the purchase and pays it on the cashier with the scenario's card. */
export async function createAndPay(
  deps: PayDeps,
  scenario: CashierCardScenario,
  testInfo: TestInfo,
): Promise<{ purchaseId: string; result: TransactionResult }> {
  const created = await deps.purchaseApi.createPurchase(deps.request);
  expect(created.status, 'purchase created').toBeLessThan(300);
  testInfo.annotations.push(
    { type: 'purchase id', description: created.body.purchaseId },
    { type: 'card scenario', description: scenario.label },
  );
  const result = await executeTransaction(
    { purchaseApi: deps.purchaseApi, backoffice: deps.backoffice, openPage: deps.openPage },
    {
      purchaseId: created.body.purchaseId,
      checkoutUrl: created.body.checkout_url,
      card: scenario.card,
      request: deps.request,
      redirects: deps.redirects,
    },
    testInfo,
  );
  return { purchaseId: created.body.purchaseId, result };
}

/** Marks the test OBSERVED with a reason (PSP / sandbox limitation, not a PGS defect). */
export function observe(testInfo: TestInfo, why: string): void {
  testInfo.annotations.push(
    { type: 'note', description: why },
    { type: 'verdict', description: 'observe' },
  );
}
