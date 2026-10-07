import type { TestInfo } from '@playwright/test';
import { getSettings } from '../../config/settings';
import type { BackofficeTransaction, BankTransaction } from '../schemas/backoffice.schema';
import type { CashierCard } from '../types/cashier.types';
import { maskSensitiveData } from '../utils/masking';
import { mappingChecks, maskingChecks, paymentInfoChecks, requestParts } from './psp-compliance';

export const PSP_RESULT_ANNOTATION = 'psp-result';

/** Purchase statuses that mean "customer has not paid / no PSP call yet". */
const NOT_ATTEMPTED_STATUSES = new Set(['CREATED', 'VIEWED', 'SENT', 'EXPIRED', 'OVERDUE']);
const AMOUNT_TOLERANCE = 0.01;

export interface PspCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface PspSummary {
  readonly purchaseId: string;
  readonly purchaseStatus: string;
  readonly merchant: string;
  readonly paymentMethod: string;
  readonly attempted: boolean;
  /** Transaction ID at the PSP (bank `paymentTransId`). */
  readonly txnId: string;
  readonly bankName: string;
  readonly midName: string;
  readonly purchaseAmount: string;
  readonly purchaseCurrency: string;
  readonly pspAmount: string;
  readonly pspCurrency: string;
  readonly pspStatus: string;
  readonly gatewayCode: string;
  readonly gatewayMessage: string;
  readonly errorMessage: string;
  readonly checks: readonly PspCheck[];
  /** Observations that are worth a look but are not failures. */
  readonly notes: readonly string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Depth-first search for the first primitive value under one of `keys`. */
export function findFirstValue(value: unknown, keys: readonly string[], depth = 0): string {
  if (depth > 6) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, keys, depth + 1);
      if (found !== '') return found;
    }
    return '';
  }
  if (!isObject(value)) return '';
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null) {
      const found = findFirstValue(nested, keys, depth + 1);
      if (found !== '') return found;
    }
  }
  return '';
}

function firstResponse(bank: BankTransaction | undefined): unknown {
  const response = bank?.response;
  return Array.isArray(response) ? response[0] : response;
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

const text = (value: unknown): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/**
 * Cross-checks the purchase (back-office transaction) against what was sent to
 * and received from the PSP. PSP-agnostic: only fields every bank record has.
 */
export function summarizePsp(
  purchaseId: string,
  trx: BackofficeTransaction,
  bank: BankTransaction | undefined,
  options: {
    readonly expectedBank?: string | undefined;
    readonly expectedMid?: string | undefined;
    /** Purchase request – enables the purchase ↔ PSP field mapping checks. */
    readonly request?: object | undefined;
    /** Card used – its full number must not appear anywhere in clear. */
    readonly card?:
      (Pick<CashierCard, 'number'> & Partial<Pick<CashierCard, 'cvv' | 'expiry'>>) | undefined;
    /**
     * PSP checks only (PSP request/response cases, PSP check by ID): apply the masking
     * rules. Cashier, S2S and session transactions do not run them.
     */
    readonly pspChecks?: boolean | undefined;
  } = {},
): PspSummary {
  const status = trx.status.toUpperCase();
  const attempted = bank !== undefined || !NOT_ATTEMPTED_STATUSES.has(status);
  const response = firstResponse(bank);

  const expectedCurrency = trx.fx_Currency ?? trx.purchase.currency;
  const expectedAmount = Number(trx.fx_Amount ?? trx.purchase.total);
  const pspAmount = bank?.amt === undefined ? Number.NaN : Number(bank.amt);
  const attempts = trx.transaction_data?.attempts ?? [];
  const lastAttempt = attempts.at(-1);

  const checks: PspCheck[] = [];
  const notes: string[] = [];
  if (attempted) {
    checks.push(
      {
        name: 'PSP record exists',
        passed: bank !== undefined,
        expected: 'bank transaction for purchase',
        actual: bank === undefined ? 'missing' : 'present',
      },
      {
        name: 'Order reference = purchase ID',
        passed: bank?.orderId === purchaseId || bank?.subOrderId === purchaseId,
        expected: purchaseId,
        actual: bank?.orderId ?? bank?.subOrderId ?? '',
      },
      {
        name: 'Currency sent to PSP',
        passed: bank?.currency === expectedCurrency,
        expected: expectedCurrency,
        actual: bank?.currency ?? '',
      },
      {
        name: 'Amount sent to PSP',
        passed:
          Number.isFinite(pspAmount) && Math.abs(pspAmount - expectedAmount) <= AMOUNT_TOLERANCE,
        expected: String(expectedAmount),
        actual: Number.isFinite(pspAmount) ? String(pspAmount) : '',
      },
      {
        name: 'PSP request recorded',
        passed: isNonEmpty(bank?.paymentInfo) || isNonEmpty(bank?.allOtherRequest),
        expected: 'request payload',
        actual: isNonEmpty(bank?.paymentInfo)
          ? 'present (paymentInfo)'
          : isNonEmpty(bank?.allOtherRequest)
            ? 'present (allOtherRequest – paymentInfo missing)'
            : 'missing',
      },
      {
        name: 'PSP response recorded',
        passed: isNonEmpty(bank?.response),
        expected: 'response payload',
        actual: isNonEmpty(bank?.response) ? 'present' : 'missing',
      },
    );
    if (options.expectedBank !== undefined) {
      checks.push({
        name: 'Routed to selected bank',
        passed: (bank?.bankName ?? '').toLowerCase() === options.expectedBank.toLowerCase(),
        expected: options.expectedBank,
        actual: bank?.bankName ?? '',
      });
    }
    if (options.expectedMid !== undefined) {
      // Limits/Charges may route one combination to several MIDs (comma-separated).
      const allowed = options.expectedMid
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean);
      checks.push({
        name: 'Routed to configured MID',
        passed: allowed.includes((bank?.midName ?? '').trim().toLowerCase()),
        expected: options.expectedMid,
        actual: bank?.midName ?? '',
      });
    }
    const pspCalled =
      bank !== undefined && (isNonEmpty(bank.response) || isNonEmpty(bank.paymentTransId));
    if (bank !== undefined && options.pspChecks === true) {
      // The card and purchase the test sent: their clear values are searched under any key.
      const masking = maskingChecks(
        bank,
        { card: options.card, request: options.request },
        { paymentMethod: trx.paymentMethod ?? '', rules: getSettings().masking.rules },
      );
      checks.push(...masking.checks);
      notes.push(...masking.notes);
    }
    if (bank !== undefined && pspCalled) {
      const info = paymentInfoChecks(bank, expectedAmount, expectedCurrency);
      checks.push(...info.checks);
      notes.push(...info.notes);
      if (options.request !== undefined && requestParts(bank).length > 0) {
        const mapping = mappingChecks(options.request as Record<string, unknown>, bank, purchaseId);
        checks.push(...mapping.checks);
        notes.push(...mapping.notes);
      }
    }
    if (status === 'PAID') {
      checks.push(
        {
          name: 'PSP transaction ID present',
          passed: isNonEmpty(bank?.paymentTransId),
          expected: 'paymentTransId',
          actual: bank?.paymentTransId ?? '',
        },
        {
          name: 'Paid ⇒ last attempt successful',
          passed: lastAttempt?.successful === true,
          expected: 'true',
          actual: text(lastAttempt?.successful),
        },
      );
    }
    if (status === 'ERROR') {
      const attemptError = lastAttempt?.error?.message ?? '';
      checks.push({
        name: 'Error ⇒ last attempt failed',
        passed: lastAttempt?.successful !== true || attemptError !== '',
        expected: 'successful=false or an attempt error',
        actual: `successful=${text(lastAttempt?.successful)}${attemptError ? `, error="${attemptError}"` : ''}`,
      });
      if (lastAttempt?.successful === true && attemptError !== '') {
        notes.push(`Attempt is flagged successful=true although it failed ("${attemptError}")`);
      }
    }
  }

  return {
    purchaseId,
    purchaseStatus: status,
    merchant: trx.merchantName ?? '',
    paymentMethod: trx.paymentMethod ?? '',
    attempted,
    txnId: bank?.paymentTransId ?? '',
    bankName: bank?.bankName ?? '',
    midName: bank?.midName ?? '',
    purchaseAmount: String(trx.purchase.total),
    purchaseCurrency: trx.purchase.currency,
    pspAmount: Number.isFinite(pspAmount) ? String(pspAmount) : '',
    pspCurrency: bank?.currency ?? '',
    pspStatus: findFirstValue(response, ['status', 'transactionStatus', 'state']),
    gatewayCode: findFirstValue(response, ['responseCode', 'resultCode', 'code', 'errorCode']),
    gatewayMessage: findFirstValue(response, [
      'responseCodeDescription',
      'message',
      'description',
      'errorMessage',
    ]),
    errorMessage: trx.errorMsg ?? '',
    checks,
    notes,
  };
}

/** Records the summary (for the PSP CSV) and attaches masked PSP request/response. */
export async function recordPspResult(
  testInfo: TestInfo,
  summary: PspSummary,
  bank: BankTransaction | undefined,
): Promise<void> {
  testInfo.annotations.push({ type: PSP_RESULT_ANNOTATION, description: JSON.stringify(summary) });
  if (bank === undefined) return;
  await testInfo.attach('psp-request.json', {
    body: JSON.stringify(
      maskSensitiveData(bank.paymentInfo ?? bank.allOtherRequest ?? null),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('psp-response.json', {
    body: JSON.stringify(maskSensitiveData(bank.response ?? null), null, 2),
    contentType: 'application/json',
  });
}
