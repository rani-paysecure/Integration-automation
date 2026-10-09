import type { TestInfo } from '@playwright/test';
import { getSettings } from '../../config/settings';
import type { BackofficeTransaction, BankTransaction } from '../schemas/backoffice.schema';
import type { CashierCard } from '../types/cashier.types';
import { maskSensitiveData } from '../utils/masking';
import {
  mappingChecks,
  serviceConfigMaskingChecks,
  bankProfileFor,
  profileMappingChecks,
  maskingChecks,
  parseJsonString,
  paymentInfoChecks,
  requestParts,
} from './psp-compliance';

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

const normKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Depth-first search for the first primitive value under one of `keys` (case, "_" and "-"
 * ignored: `errorMessage` = `error_message` = `errormessage`). Strings holding a JSON,
 * form-encoded or XML payload are searched too.
 */
export function findFirstValue(value: unknown, keys: readonly string[], depth = 0): string {
  if (depth > 6) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed === undefined ? '' : findFirstValue(parsed, keys, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, keys, depth + 1);
      if (found !== '') return found;
    }
    return '';
  }
  if (!isObject(value)) return '';
  const wanted = keys.map(normKey);
  for (const want of wanted) {
    const hit = Object.entries(value).find(([k]) => normKey(k) === want)?.[1];
    if ((typeof hit === 'string' && hit.trim() !== '') || typeof hit === 'number')
      return String(hit);
  }
  for (const nested of Object.values(value)) {
    if ((typeof nested === 'object' && nested !== null) || typeof nested === 'string') {
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

/** PSP answers newest first (the last answer carries the final result / error), 3DS answers after. */
function responsesNewestFirst(bank: BankTransaction | undefined): unknown[] {
  const list = (v: unknown): unknown[] =>
    Array.isArray(v) ? (v as unknown[]).slice() : v === undefined || v === null ? [] : [v];
  return [
    ...list(bank?.response).reverse(),
    ...list((bank as Json | undefined)?.response3ds).reverse(),
  ];
}

/** Error / result text of the PSP – newest answer first. */
const PSP_CODE_KEYS = [
  'responseCode',
  'resultCode',
  'errorCode',
  'error_code',
  'reasonCode',
  'code',
  'returnCode',
];
const PSP_MESSAGE_KEYS = [
  'responseCodeDescription',
  'errorMessage',
  'error_message',
  'errorDescription',
  'responseMessage',
  'resultMessage',
  'statusMessage',
  'reason',
  'declineReason',
  'message',
  'description',
];

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
/** The PSP was actually called for this purchase (a response or a PSP transaction ID is stored). */
export function pspWasCalled(bank: BankTransaction | undefined): boolean {
  return bank !== undefined && (isNonEmpty(bank.response) || isNonEmpty(bank.paymentTransId));
}

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
     * Masking rules (+ service config keys) whenever the PSP was called – on by default;
     * `false` switches them off.
     */
    readonly pspChecks?: boolean | undefined;
    /**
     * Service config COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS (field names PGS masks for every PSP)
     * – or the error that prevented reading it. Checked with the masking rules.
     */
    readonly serviceMaskingKeys?: readonly string[] | Error | undefined;
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
    const pspCalled = pspWasCalled(bank);
    // Whenever the PSP was called: masking rules + service config keys (webhooks: transaction flow).
    if (bank !== undefined && pspCalled && options.pspChecks !== false) {
      // The card and purchase the test sent: their clear values are searched under any key.
      const masking = maskingChecks(
        bank,
        { card: options.card, request: options.request },
        { paymentMethod: trx.paymentMethod ?? '', rules: getSettings().masking.rules },
      );
      checks.push(...masking.checks);
      notes.push(...masking.notes);
      const keys = options.serviceMaskingKeys;
      if (keys instanceof Error) {
        notes.push(
          `Warning: service config COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS could not be read (${keys.message}) – its masking keys were not checked`,
        );
      } else if (keys !== undefined) {
        const service = serviceConfigMaskingChecks(bank, keys);
        checks.push(...service.checks);
        notes.push(...service.notes);
      }
    }
    if (bank !== undefined && pspCalled) {
      const info = paymentInfoChecks(bank, expectedAmount, expectedCurrency);
      checks.push(...info.checks);
      notes.push(...info.notes);
      if (options.request !== undefined && requestParts(bank).length > 0) {
        // The bank's profile (Bank profiles page) defines the exact mapping; without one the
        // generic field-name checks run.
        const profile = bankProfileFor(bank.bankName ?? '', trx.paymentMethod ?? '');
        const mapping =
          profile !== undefined && profile.mapping.length > 0
            ? profileMappingChecks(
                bank,
                options.request as Record<string, unknown>,
                profile,
                purchaseId,
              )
            : mappingChecks(options.request as Record<string, unknown>, bank, purchaseId);
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
    gatewayCode: findFirstValue(responsesNewestFirst(bank), PSP_CODE_KEYS),
    gatewayMessage: findFirstValue(responsesNewestFirst(bank), PSP_MESSAGE_KEYS),
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
  // Every non-empty part, with payloads stored as strings (JSON / form / XML) shown parsed.
  const parts = (names: readonly string[]): unknown => {
    const record = bank as Json;
    const readable = (v: unknown): unknown =>
      typeof v === 'string' ? (parseJsonString(v) ?? v) : Array.isArray(v) ? v.map(readable) : v;
    const filled = names.filter((n) => isNonEmpty(record[n]));
    if (filled.length === 0) return null;
    if (filled.length === 1) return readable(record[filled[0] ?? '']);
    return Object.fromEntries(filled.map((n) => [n, readable(record[n])]));
  };
  await testInfo.attach('psp-request.json', {
    body: JSON.stringify(
      maskSensitiveData(
        parts(['paymentInfo', 'allOtherRequest', 'allOtherRequest3ds', 'cancelInfo']),
      ),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('psp-response.json', {
    body: JSON.stringify(maskSensitiveData(parts(['response', 'response3ds'])), null, 2),
    contentType: 'application/json',
  });
}
