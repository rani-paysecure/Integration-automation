import { HttpStatus } from '@constants/http';
import { isCardPaymentMethod } from '@helpers/card-methods';
import { s2sError } from '@helpers/s2s-flow';
import { expect, test } from '@fixtures/api.fixture';
import { requireCaseCard } from '@test-data/cashier-purchase/cashier-cards';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';
import { buildS2sRequest, changedS2sBody } from '@test-data/s2s/s2s-request.factory';

/**
 * S2S API request validation (PurchaseService.s2s). No payment is made: each case fails
 * before PGS starts processing (except S2S-023, which starts one payment to test the
 * second call). Answers confirmed on test4 – see docs/pgs-behaviour.md § 8.
 */
interface ValidationCase {
  readonly id: string;
  readonly title: string;
  /** Body changes – undefined removes the field. */
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly skipAuth?: boolean;
  readonly unknownPurchase?: boolean;
  readonly http: number;
  readonly code?: string;
  /** Text the message must contain (case-insensitive). */
  readonly message?: string;
  /** Sent as it is instead of the JSON body. */
  readonly rawBody?: string;
  /**
   * Purchase status after the rejected call: CREATED = can still be paid (default);
   * ERROR = PGS ends the purchase (card-detail / expiry errors).
   */
  readonly purchaseAfter?: 'CREATED' | 'ERROR';
  /** Confirmed PGS defect – the case is marked test.fail() until PGS is fixed. */
  readonly knownDefect?: string;
}

const CASES: readonly ValidationCase[] = [
  {
    id: 'S2S-010',
    title: 'No Authorization header',
    skipAuth: true,
    http: 401,
    code: 'authentication_failed',
    message: 'Authorization header missing',
  },
  {
    id: 'S2S-011',
    title: 'Merchant key without "Bearer "',
    headers: { authorization: 'KEY' },
    http: 401,
    code: 'authentication_failed',
    message: 'Authorization header missing',
  },
  {
    id: 'S2S-012',
    title: 'Content-Type text/plain',
    headers: { 'content-type': 'text/plain' },
    http: 415,
    code: 'unsupported_media_type',
  },
  {
    id: 'S2S-013',
    title: 'Unknown purchaseId',
    unknownPurchase: true,
    http: 400,
    code: 'transaction_error',
    message: 'PurchaseId Not found',
  },
  {
    id: 'S2S-014',
    title: 'Card number fails the Luhn check',
    body: { card_number: 'LUHN' },
    http: 400,
    code: 'transaction_error',
    message: 'Invalid card Number (Luhn algo)',
  },
  {
    id: 'S2S-015',
    title: 'card_number missing',
    body: { card_number: undefined },
    http: 400,
    code: 'transaction_error',
    knownDefect:
      'PGS answers HTTP 500 "something went wrong" (exception) and the purchase can no longer be paid',
  },
  {
    id: 'S2S-016',
    title: 'cvc missing',
    body: { cvc: undefined },
    purchaseAfter: 'ERROR',
    http: 400,
    code: 'transaction_error',
    message: 'Card Detail is missing',
  },
  {
    id: 'S2S-017',
    title: 'cardholder_name missing',
    body: { cardholder_name: undefined },
    purchaseAfter: 'ERROR',
    http: 400,
    code: 'transaction_error',
    message: 'Card Detail is missing',
  },
  {
    id: 'S2S-018',
    title: 'expires missing',
    body: { expires: undefined },
    purchaseAfter: 'ERROR',
    http: 400,
    code: 'transaction_error',
    message: 'Card Detail is missing',
  },
  {
    id: 'S2S-019',
    title: 'expires without "/" (MMYY)',
    body: { expires: '1031' },
    purchaseAfter: 'ERROR',
    http: 400,
    code: 'transaction_error',
    message: 'Invalid Card Expiry',
  },
  {
    id: 'S2S-020',
    title: 'remote_ip missing',
    body: { remote_ip: undefined },
    http: 400,
    code: 'Invalid_Parameter',
    message: 'remote_ip cannot be null',
  },
  {
    id: 'S2S-021',
    title: 'user_agent missing',
    body: { user_agent: undefined },
    http: 400,
    code: 'Invalid_Parameter',
    message: 'user_agent cannot be null',
  },
  {
    id: 'S2S-022',
    title: 'accept_header missing',
    body: { accept_header: undefined },
    http: 400,
    code: 'Invalid_Parameter',
    message: 'accept_header cannot be null',
  },
  {
    id: 'S2S-025',
    title: 'Expired card (01/20)',
    body: { expires: '01/20' },
    purchaseAfter: 'ERROR',
    http: 400,
    code: 'transaction_error',
    message: 'Invalid Card Expiry',
  },
  {
    id: 'S2S-026',
    title: 'Expiry month 13 (13/31)',
    body: { expires: '13/31' },
    http: 400,
    code: 'transaction_error',
    knownDefect: 'PGS accepts month 13 (HTTP 202 pending) and starts the payment',
  },
  {
    id: 'S2S-027',
    title: 'Letters in the card number',
    body: { card_number: '4000abcd00002701' },
    http: 400,
    code: 'transaction_error',
    message: 'Invalid card Number',
  },
  {
    id: 'S2S-029',
    title: 'remember_card empty',
    body: { remember_card: '' },
    http: 400,
    code: 'transaction_error',
    message: 'Card Detail is missing',
    purchaseAfter: 'ERROR',
  },
  {
    id: 'S2S-028',
    title: 'Malformed JSON body',
    rawBody: '{"card_number":',
    http: 400,
    code: 'invalid_json',
    message: 'Request Body Not Found/MalFormed',
  },
];

/** Same digits with the check digit changed → fails the Luhn check. */
const breakLuhn = (number: string): string =>
  number.slice(0, -1) + String((Number(number.slice(-1)) + 1) % 10);

test.describe('S2S purchase › 3. Request validation', { tag: ['@s2s'] }, () => {
  for (const c of CASES) {
    test(
      `${c.id} ${c.title} → rejected`,
      {
        tag: [`@${c.id}`],
        annotation: [
          {
            type: 'expected',
            description: `HTTP ${String(c.http)}${c.code ? ` ${c.code}` : ''}${c.message ? ` "${c.message}"` : ''}`,
          },
        ],
      },
      async ({ purchaseApi, backoffice, envData, merchant, testConfig }, testInfo) => {
        const { card } = await isCardPaymentMethod(merchant.paymentMethod, backoffice);
        test.skip(
          !card,
          `S2S is only for card payment methods – ${merchant.paymentMethod} is not a card`,
        );
        if (c.knownDefect !== undefined) {
          testInfo.annotations.push({ type: 'known defect', description: c.knownDefect });
          test.fail(true, c.knownDefect);
        }
        const scenario = requireCaseCard(
          testConfig.env,
          undefined,
          testConfig.transaction.payCardId,
        );
        let purchaseId = '6a0000000000000000000000';
        if (c.unknownPurchase !== true) {
          const created = await purchaseApi.createPurchase(buildPurchaseRequest(envData, merchant));
          expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
          purchaseId = created.body.purchaseId;
        }
        const changes = { ...(c.body ?? {}) };
        if (changes.card_number === 'LUHN') changes.card_number = breakLuhn(scenario.card.number);
        const body = changedS2sBody(
          buildS2sRequest(scenario.card, { template: envData.s2s }),
          changes,
        );
        const response = await purchaseApi.s2sPay(purchaseId, c.rawBody ?? body, {
          ...(c.skipAuth === true ? { skipAuth: true } : {}),
          ...(c.headers ? { headers: { ...c.headers } } : {}),
        });
        testInfo.annotations.push(
          { type: 'purchase id', description: purchaseId },
          {
            type: 's2s response',
            description: `HTTP ${String(response.status)} · ${s2sError(response)}`,
          },
        );
        expect(response.status, s2sError(response)).toBe(c.http);
        if (c.code !== undefined) expect(s2sError(response)).toContain(c.code);
        if (c.message !== undefined)
          expect(s2sError(response).toLowerCase()).toContain(c.message.toLowerCase());
        if (c.unknownPurchase !== true && c.knownDefect === undefined) {
          const status = (await purchaseApi.getPurchase(purchaseId)).body.status.toUpperCase();
          const wanted = c.purchaseAfter ?? 'CREATED';
          testInfo.annotations.push({ type: 'purchase status after', description: status });
          expect
            .soft(
              status,
              wanted === 'CREATED' ? 'the purchase can still be paid' : 'PGS ends the purchase',
            )
            .toBe(wanted);
        }
      },
    );
  }

  test(
    'S2S-023 Second S2S call on the same purchase → rejected',
    {
      tag: ['@S2S-023'],
      annotation: [
        {
          type: 'expected',
          description:
            'first call 202 pending; second call HTTP 400 "Only purchases that can be paid for can be initiated for payment."',
        },
      ],
    },
    async ({ purchaseApi, backoffice, envData, merchant, testConfig }, testInfo) => {
      const { card } = await isCardPaymentMethod(merchant.paymentMethod, backoffice);
      test.skip(
        !card,
        `S2S is only for card payment methods – ${merchant.paymentMethod} is not a card`,
      );
      const scenario = requireCaseCard(testConfig.env, undefined, testConfig.transaction.payCardId);
      const created = await purchaseApi.createPurchase(buildPurchaseRequest(envData, merchant));
      expect(created).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED, HttpStatus.ACCEPTED]);
      const body = buildS2sRequest(scenario.card, { template: envData.s2s });
      const first = await purchaseApi.s2sPay(created.body.purchaseId, body);
      const second = await purchaseApi.s2sPay(created.body.purchaseId, body);
      testInfo.annotations.push(
        { type: 'purchase id', description: created.body.purchaseId },
        {
          type: 's2s response',
          description: `first HTTP ${String(first.status)} · second HTTP ${String(second.status)} ${s2sError(second)}`,
        },
      );
      expect(first.status, s2sError(first)).toBe(202);
      expect(second.status).toBe(400);
      expect(s2sError(second)).toMatch(/can be paid for|already_in_process/i);
    },
  );

  test(
    'S2S-024 S2S for an APM purchase (not a card) → not supported',
    {
      tag: ['@S2S-024'],
      annotation: [
        { type: 'expected', description: 'rejected – S2S is for card payment methods only' },
      ],
    },
    async ({ purchaseApi, envData, merchant, testConfig }, testInfo) => {
      const apm = process.env.S2S_APM_METHOD?.trim() ?? '';
      const method = apm === '' ? 'BANKTRANSFER' : apm;
      const scenario = requireCaseCard(testConfig.env, undefined, testConfig.transaction.payCardId);
      const created = await purchaseApi.createPurchase(
        buildPurchaseRequest(envData, { ...merchant, paymentMethod: method }),
      );
      test.skip(
        created.status >= 300,
        `The merchant cannot create a ${method} purchase (HTTP ${String(created.status)}) – set S2S_APM_METHOD to an allowed APM`,
      );
      const response = await purchaseApi.s2sPay(
        created.body.purchaseId,
        buildS2sRequest(scenario.card, { template: envData.s2s }),
      );
      testInfo.annotations.push(
        { type: 'purchase id', description: `${created.body.purchaseId} (${method})` },
        {
          type: 's2s response',
          description: `HTTP ${String(response.status)} · ${s2sError(response)}`,
        },
      );
      // PGS takes the card's scheme as the payment method: it is not the purchase's APM.
      expect(response.status, `S2S must not start a ${method} payment`).toBe(400);
      expect.soft(s2sError(response)).toMatch(/is not Allowed/i);
    },
  );
});
