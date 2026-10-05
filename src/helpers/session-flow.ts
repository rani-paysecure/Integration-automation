import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BackofficeClient } from '../clients/backoffice-client';
import { Endpoints } from '../constants/endpoints';
import { CashierPage, type RedirectUrls } from '../pages/cashier-page';
import { currentDevice, deviceLabel } from '../pages/devices';
import type { BankTransaction } from '../schemas/backoffice.schema';
import type { CashierCard, CashierPaymentResult } from '../types/cashier.types';
import type { CustomerCreated, SessionCreated, SessionCustomer } from '../types/session.types';
import type { SessionApiClient } from '../clients/session-api-client';
import type { PspSummary } from './psp-validation';
import { recordBrowserResult, settleTransaction, type TransactionDeps } from './transaction-flow';

/**
 * Session purchase flow:
 *   1. POST create customer (unique merchantCustomerId)      → customerId
 *      – or skipped: the session is created for an existing customerId
 *   2. POST create session (customerId + order + redirects)  → sessionUrl + sessionId
 *   3. open sessionUrl in the customer's browser → enter the card → PAY → 3DS → merchant redirect
 *      (same hosted card form as the cashier)
 *   4. back-office: find the transaction by sessionId (the table row carries the purchaseId)
 *   5. final status, PSP request/response and merchant webhooks – same checks as the cashier.
 */
export interface SessionIds {
  readonly customerId: string;
  /** Empty when an existing customer was used. */
  readonly merchantCustomerId: string;
  readonly sessionId: string;
  readonly sessionUrl: string;
}

export interface SessionInput {
  readonly card: CashierCard;
  /** Payment method the customer picks on the session page (a session itself only carries a currency). */
  readonly paymentMethod?: string | undefined;
  /** New customer (create it first) or an existing customer ID (create the session only). */
  readonly customer: SessionCustomer;
  /** Merchant brand – sent as the `BrandId` header on create customer and create session. */
  readonly brandId: string;
  /** Builds the create-session body once the customerId is known. */
  readonly sessionBody: (customerId: string) => Record<string, unknown>;
  readonly redirects: RedirectUrls;
  readonly expectedBank?: string | undefined;
  readonly expectedMid?: string | undefined;
}

export interface SessionResult extends SessionIds {
  readonly purchaseId: string;
  readonly cashier: CashierPaymentResult;
  readonly finalStatus: string;
  readonly psp: PspSummary;
  readonly bank: BankTransaction | undefined;
}

const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const DAY_SECONDS = 86_400;

/** Short, readable API error for a failure message (code / message, else the start of the body). */
function apiError(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  const direct = [text(record.code), text(record.message), text(record.error)]
    .filter(Boolean)
    .join(': ');
  return direct !== '' ? direct : JSON.stringify(body).slice(0, 300);
}
const PURCHASE_LOOKUP_MS = 60_000;
/** Added to the test timeout when the 3DS page re-opens and the OTP is entered again. */
const RESHOWN_EXTRA_MS = 30_000;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Label of the method tile on the page (exact text), e.g. VISA → "Visa", MASTER → "MasterCard". */
function tilePatterns(method: string): RegExp[] {
  const name = method.trim();
  if (name === '') return [];
  if (/^master/i.test(name)) return [/^master\s*card$/i];
  return [new RegExp(`^${escapeRegex(name)}$`, 'i')];
}

/** What the customer would click: the method itself, then a generic "card" entry. */
function methodPatterns(method: string): RegExp[] {
  const name = method.trim();
  const patterns = name === '' ? [] : [new RegExp(escapeRegex(name), 'i')];
  if (/^master/i.test(name)) patterns.push(/master/i);
  patterns.push(/credit|debit|card/i);
  return patterns;
}

/**
 * The session page lets the customer pick the payment method in real time. Opens it and, unless the
 * card form is already showing, clicks the method (button / tab / radio / text) until the card form appears.
 */
export async function openSessionPage(
  page: Page,
  sessionUrl: string,
  paymentMethod: string | undefined,
  testInfo: TestInfo,
): Promise<void> {
  const cardForm = page.locator('#cardNumber');
  const cardVisible = (timeout: number): Promise<boolean> =>
    cardForm
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
  // Not "load": the session page keeps background requests open (polling, scripts, widgets), so the load
  // event can take minutes or never fire. The DOM is enough – the card form / method list is awaited below.
  try {
    await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    // A slow page may still have rendered: carry on when the browser got to the session URL.
    const reached = page.url().startsWith('http');
    testInfo.annotations.push({
      type: 'session page',
      description: `navigation did not finish (${error instanceof Error ? error.message.split('\n')[0] : 'error'}) – ${reached ? 'continuing with what is shown' : 'page not reached'}`,
    });
    if (!reached) {
      await testInfo.attach('session-page.png', {
        body: await page.screenshot().catch(() => Buffer.from('')),
        contentType: 'image/png',
      });
      throw error;
    }
  }
  // Wait for the card form, or for the method list to render (whichever comes first).
  await Promise.race([
    cardVisible(10_000),
    page
      .locator('button, [role=tab], [role=radio], label')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined),
  ]);
  // The page opens with a default tile selected (e.g. MasterCard): always pick the requested method, even
  // when a card form is already showing – switching tiles resets the form, so settle before typing.
  for (const pattern of tilePatterns(paymentMethod ?? '')) {
    const tile = page.getByText(pattern).first();
    if (!(await tile.isVisible().catch(() => false))) continue;
    await tile.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    if (await cardVisible(5_000)) {
      testInfo.annotations.push({
        type: 'payment method on page',
        description: `${paymentMethod ?? ''} tile selected`,
      });
      return;
    }
  }
  if (await cardVisible(500)) return;

  for (const pattern of methodPatterns(paymentMethod ?? '')) {
    const candidates = [
      page.getByRole('button', { name: pattern }),
      page.getByRole('tab', { name: pattern }),
      page.getByRole('radio', { name: pattern }),
      page.getByLabel(pattern),
      page.getByText(pattern),
    ];
    for (const candidate of candidates) {
      const target = candidate.first();
      if ((await candidate.count()) === 0 || !(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 5_000 }).catch(() => undefined);
      if (await cardVisible(4_000)) {
        testInfo.annotations.push({
          type: 'payment method on page',
          description: `${paymentMethod ?? ''} (clicked "${pattern.source}")`,
        });
        return;
      }
    }
  }

  const clickable = await page
    .locator('button, [role=tab], [role=radio], label, a')
    .allInnerTexts()
    .catch(() => [] as string[]);
  await testInfo.attach('session-page.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  throw new Error(
    `Card form not found on the session page after choosing ${paymentMethod ?? '(no payment method)'}. ` +
      `Clickable items on the page: ${clickable.map((t) => t.trim()).filter(Boolean).slice(0, 15).join(' | ') || '(none)'}`,
  );
}

/** Steps 1 + 2 – customer and session through the API (no payment yet). */
export async function createSession(
  api: SessionApiClient,
  input: Pick<SessionInput, 'customer' | 'sessionBody' | 'brandId'>,
  testInfo: TestInfo,
): Promise<SessionIds> {
  return test.step('create customer + session (API)', async () => {
    const headers = { BrandId: input.brandId };
    let customerId: string;
    let merchantCustomerId = '';
    if (input.customer.mode === 'new') {
      const customer = await api.createCustomer(input.customer.body, { headers });
      expect([200, 201, 202], `create customer: API answered HTTP ${String(customer.status)} (expected 200/201/202) – ${apiError(customer.body) || 'no error text'} – check the path ${Endpoints.customers.collection} and the request body`).toContain(
        customer.status,
      );
      const customerBody: CustomerCreated = customer.body;
      customerId = text(customerBody.customerId);
      expect(customerId, 'customerId in the create-customer response').not.toBe('');
      merchantCustomerId = text(input.customer.body.merchantCustomerId);
    } else {
      customerId = input.customer.customerId;
    }
    testInfo.annotations.push({
      type: 'customer',
      description:
        input.customer.mode === 'new'
          ? 'new – created in this run'
          : 'existing – customer not created, session only',
    });

    const session = await api.createSession(input.sessionBody(customerId), { headers });
    expect([200, 201, 202], `create session: API answered HTTP ${String(session.status)} (expected 200/201/202) – ${apiError(session.body) || 'no error text'} – check the path ${Endpoints.sessions.collection} and the request body`).toContain(
      session.status,
    );
    const sessionBody: SessionCreated = session.body;
    const sessionUrl = text(sessionBody.sessionUrl);
    const sessionId = text(sessionBody.sessionId);
    expect(sessionUrl, 'sessionUrl in the create-session response').toMatch(/^https?:\/\//);
    expect(sessionId, 'sessionId in the create-session response').not.toBe('');

    testInfo.annotations.push(
      { type: 'customer id', description: customerId },
      ...(merchantCustomerId === ''
        ? []
        : [{ type: 'merchant customer id', description: merchantCustomerId }]),
      { type: 'session id', description: sessionId },
      { type: 'session url', description: sessionUrl },
    );
    return { customerId, merchantCustomerId, sessionId, sessionUrl };
  });
}

/**
 * Back-office lookup by session ID (Transactions table: the session's row has the purchaseId).
 * The row is written when the customer starts paying, so this polls for a while.
 */
export async function findPurchaseIdBySession(
  backoffice: BackofficeClient,
  sessionId: string,
  timeoutMs = PURCHASE_LOOKUP_MS,
): Promise<string | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    const query = new URLSearchParams({
      pageNo: '0',
      pagesize: '10',
      from_seconds: String(now - 7 * DAY_SECONDS),
      to_seconds: String(now + DAY_SECONDS),
      status: '',
      purchaseId: '',
      sessionId,
      sandbox: '0',
      bankmid: '',
      bankid: '-1',
      currency: '',
      includePaidOn: '0',
      settleStatus: '-1',
    });
    const response = await backoffice.rawRequest(
      'POST',
      `${Endpoints.backoffice.transactions}?${query.toString()}`,
    );
    let rows: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(response.text);
      rows = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    } catch {
      rows = [];
    }
    const records = rows.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
    const hit = records.find((row) =>
      [row.sessionId, row.session_id, row.sessionID].some((value) => text(value) === sessionId),
    );
    const pid = text(hit?.purchaseId);
    if (pid !== '') return pid;
    if (Date.now() > until) return undefined;
    await sleep(3_000);
  }
}

const CARD_FIELDS = (card: CashierCard): Array<{ id: string; value: string; digits: boolean }> => [
  { id: '#cardNumber', value: card.number, digits: true },
  { id: '#cardholderName', value: card.holderName, digits: false },
  { id: '#cardMonthyear', value: card.expiry.replace('/', ''), digits: true },
  { id: '#cardCvc', value: card.cvv, digits: true },
];

const sameValue = (actual: string, expected: string, digits: boolean): boolean =>
  digits
    ? actual.replace(/\D/g, '') === expected.replace(/\D/g, '')
    : actual.trim() === expected.trim();

/**
 * Types the card like a customer and checks every value is really in the field before PAY: the session page
 * can reset the form (tile switch, late re-render), and PAY with empty fields never sends a payment.
 */
export async function fillCardOnSessionPage(
  page: Page,
  card: CashierCard,
  testInfo: TestInfo,
): Promise<void> {
  const fields = CARD_FIELDS(card);
  const missing = async (): Promise<string[]> => {
    const bad: string[] = [];
    for (const field of fields) {
      const actual = await page.locator(field.id).inputValue().catch(() => '');
      if (!sameValue(actual, field.value, field.digits)) bad.push(field.id.slice(1));
    }
    return bad;
  };
  let notRetained: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const field of fields) {
      const input = page.locator(field.id);
      await input.waitFor({ state: 'visible' });
      await input.click();
      await input.fill('');
      await input.pressSequentially(field.value, { delay: 25 });
    }
    await page.locator('#cardCvc').blur();
    await page.waitForTimeout(700); // a late re-render would wipe the form now
    notRetained = await missing();
    if (notRetained.length === 0) {
      if (attempt > 1) {
        testInfo.annotations.push({
          type: 'card entry',
          description: `form was reset by the page – entered again (attempt ${String(attempt)})`,
        });
      }
      await testInfo.attach('card-filled.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      return;
    }
  }
  await testInfo.attach('card-not-retained.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  throw new Error(
    `The session page did not keep the card details (empty or reset: ${notRetained.join(', ')}) – PAY would not send a payment. See card-not-retained.png.`,
  );
}

/** The whole session transaction (steps 1–5). Records everything on the test for the reports. */
export async function executeSessionTransaction(
  deps: TransactionDeps & { readonly sessionApi: SessionApiClient },
  input: SessionInput,
  testInfo: TestInfo,
): Promise<SessionResult> {
  testInfo.annotations.push({ type: 'device', description: deviceLabel(currentDevice()) });
  const ids = await createSession(deps.sessionApi, input, testInfo);

  const cashier = await test.step('pay on the session page', async () => {
    const page = await deps.openPage();
    const cashierPage = new CashierPage(page);
    await openSessionPage(page, ids.sessionUrl, input.paymentMethod, testInfo);
    await fillCardOnSessionPage(page, input.card, testInfo);
    const result = await cashierPage.paySession(input.redirects, {
      challenge: input.card.challenge,
      headed: deps.headed ?? process.env.RUN_HEADED === '1',
      timeBudget: () =>
        testInfo.timeout > 0
          ? Math.max(15_000, testInfo.timeout - testInfo.duration - 20_000)
          : Infinity,
      // The 3DS page re-opened after the OTP: it is entered again, which needs extra time (same as the cashier).
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

  const purchaseId = await test.step('find the purchase by session ID (back-office)', async () => {
    const found = await findPurchaseIdBySession(deps.backoffice, ids.sessionId);
    expect(
      found,
      `no transaction with session ID ${ids.sessionId} in the back-office – cashier outcome ${cashier.outcome}`,
    ).toBeDefined();
    return found ?? '';
  });
  testInfo.annotations.push({ type: 'purchase id', description: purchaseId });

  const settled = await settleTransaction(
    deps,
    {
      purchaseId,
      card: input.card,
      request: input.sessionBody(ids.customerId),
      expectedBank: input.expectedBank,
      expectedMid: input.expectedMid,
    },
    cashier.outcome === 'rejected',
    testInfo,
  );
  return { ...ids, purchaseId, cashier, ...settled };
}
