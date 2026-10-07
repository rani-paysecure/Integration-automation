import { randomUUID } from 'node:crypto';
import type { PurchaseTemplate, SessionTemplate } from '@config/settings';
import type { SessionCustomer } from '@app-types/session.types';

/**
 * Create customer / create session bodies. The baseline comes from the launcher's
 * "Session data" tab (config/defaults.json → session); redirects and callbacks default to the
 * Purchase data tab, so one place configures where the customer lands.
 *
 * Dynamic values: any string in the bodies may contain
 *   {{unique}}    unique reference (use for merchantCustomerId)   {{uuid}}   random UUID
 *   {{timestamp}} epoch seconds                                   {{date}}   today, yyyy-MM-dd
 *   {{random}}    6 random digits                                 {{customerId}} (session body only)
 * and is filled in on every run.
 */
export type SessionBody = Record<string, unknown>;

/** merchantCustomerId must be unique every time a customer is created. */
export function uniqueMerchantCustomerId(): string {
  const time = Date.now().toString(36);
  const random = randomUUID().replace(/-/g, '').slice(0, 8);
  return `MC${time}${random}`.toUpperCase();
}

const TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

function tokenValue(name: string, customerId: string | undefined): string | undefined {
  switch (name.toLowerCase()) {
    case 'unique':
      return uniqueMerchantCustomerId();
    case 'uuid':
      return randomUUID();
    case 'timestamp':
      return String(Math.floor(Date.now() / 1000));
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'random':
      return String(Math.floor(100_000 + Math.random() * 900_000));
    case 'customerid':
      return customerId;
    default:
      return undefined;
  }
}

/** Fills the {{tokens}} in every string of a body (unknown tokens stay as typed). */
export function resolveTokens<T>(value: T, customerId?: string): T {
  if (typeof value === 'string') {
    return value.replace(
      TOKEN,
      (whole, name: string) => tokenValue(name, customerId) ?? whole,
    ) as T;
  }
  if (Array.isArray(value))
    return (value as unknown[]).map((item) => resolveTokens(item, customerId)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTokens(item, customerId)]),
    ) as T;
  }
  return value;
}

export function buildCustomerRequest(
  template: SessionTemplate,
  overrides: Readonly<Record<string, unknown>> = {},
): SessionBody {
  const body: SessionBody = { ...resolveTokens(structuredClone(template.customer)), ...overrides };
  // The API needs a unique merchantCustomerId – add one when the body has none.
  const id = body.merchantCustomerId;
  if (typeof id !== 'string' || id.trim() === '')
    body.merchantCustomerId = uniqueMerchantCustomerId();
  return body;
}

export function buildSessionRequest(
  template: SessionTemplate,
  purchase: PurchaseTemplate,
  customerId: string,
  options: { readonly currency?: string | undefined } = {},
): SessionBody {
  return {
    success_redirect: purchase.success_redirect,
    failure_redirect: purchase.failure_redirect,
    pending_redirect: purchase.pending_redirect,
    success_callback: purchase.success_callback,
    failure_callback: purchase.failure_callback,
    ...resolveTokens(structuredClone(template.session), customerId),
    ...(options.currency === undefined ? {} : { currency: options.currency }),
    customerId,
  };
}

/** Existing customer ID of the run: SESSION_CUSTOMER_ID (shell / CI) wins over the Session data tab. */
export function existingCustomerId(template: SessionTemplate): string {
  return (process.env.SESSION_CUSTOMER_ID?.trim() ?? '') || template.existingCustomerId.trim();
}

/**
 * Which customer the session is made for, as chosen on the Session data tab:
 * "new" = create a customer first (fresh unique body), "existing" = reuse a customer ID.
 */
export function sessionCustomer(template: SessionTemplate): SessionCustomer {
  const existing = existingCustomerId(template);
  const useExisting = template.mode === 'existing' || process.env.SESSION_CUSTOMER_ID?.trim();
  if (useExisting) {
    if (existing === '') {
      throw new Error(
        'Session data is set to "existing customer" but no customer ID is given – enter it on the Session data tab (or set SESSION_CUSTOMER_ID).',
      );
    }
    return { mode: 'existing', customerId: existing };
  }
  return { mode: 'new', body: buildCustomerRequest(template) };
}
