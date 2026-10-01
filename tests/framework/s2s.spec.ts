import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { KNOWN_CARD_METHODS, isCardPaymentMethod } from '@helpers/card-methods';
import { s2sError, s2sMode } from '@helpers/s2s-flow';
import type { ApiResponse } from '@app-types/api.types';
import { maskSensitiveData } from '@utils/masking';
import {
  DEFAULT_REMOTE_IP,
  buildS2sRequest,
  changedS2sBody,
} from '@test-data/s2s/s2s-request.factory';

const card = { number: '4000000000002701', holderName: 'AUTHORISED', expiry: '10/31', cvv: '791' };
const answer = (
  status: number,
  body: Record<string, unknown>,
): ApiResponse<Record<string, unknown>> =>
  ({
    status,
    ok: status < 300,
    body,
    headers: {},
    text: JSON.stringify(body),
    durationMs: 1,
  }) as unknown as ApiResponse<Record<string, unknown>>;

test.describe('S2S purchase helpers (offline)', () => {
  test('body: card, remember_card and browser data of the device', () => {
    const body = buildS2sRequest(card, { rememberCard: 'on', device: 'desktop' });
    expect(body).toMatchObject({
      cardholder_name: 'AUTHORISED',
      card_number: '4000000000002701',
      expires: '10/31',
      cvc: '791',
      remember_card: 'on',
      remote_ip: DEFAULT_REMOTE_IP,
      accept_header: 'text/html',
      java_enabled: 'false',
      javascript_enabled: true,
      color_depth: 24,
      utc_offset: 0,
    });
    expect(String(body.user_agent)).toContain('Mozilla/5.0');
    expect(Number(body.screen_width)).toBeGreaterThan(0);
    expect(buildS2sRequest(card).remember_card).toBe('off');
    const phone = buildS2sRequest(card, { device: 'phone-iphone' });
    expect(String(phone.user_agent)).toContain('iPhone');
  });

  test('changed body removes fields set to undefined', () => {
    const body = changedS2sBody(buildS2sRequest(card), { cvc: undefined, expires: '1031' });
    expect(body).not.toHaveProperty('cvc');
    expect(body.expires).toBe('1031');
  });

  test('answer kinds: pending + callback, 2D purchase, rejection', () => {
    expect(
      s2sMode(
        answer(202, {
          status: 'pending',
          method: 'GET',
          callback_url: 'https://h/api/v1/payment/p/',
        }),
      ),
    ).toBe('callback');
    expect(s2sMode(answer(202, { purchaseId: 'p', status: 'PAID', trxType: '2D' }))).toBe(
      '2d-direct',
    );
    const rejected = answer(400, { code: 'transaction_error', message: 'Card Detail is missing' });
    expect(s2sMode(rejected)).toBe('rejected');
    expect(s2sError(rejected)).toBe('transaction_error: Card Detail is missing');
  });

  test('card data in an S2S body is masked in logs', () => {
    const masked = maskSensitiveData(buildS2sRequest(card));
    expect(masked.card_number).not.toBe(card.number);
    expect(String(masked.card_number)).toMatch(/2701$/);
    expect(masked.cvc).toBe('***');
    expect(masked.expires).toBe('***');
    expect(masked.cardholder_name).toBe('***');
  });

  test('card methods: built-in list without a dashboard', async () => {
    expect(KNOWN_CARD_METHODS).toContain('VISA');
    expect((await isCardPaymentMethod('master')).card).toBe(true);
    expect(await isCardPaymentMethod('BANKTRANSFER')).toEqual({
      card: false,
      source: 'built-in list',
    });
  });
});

interface S2sImporter {
  previewObjects(
    category: string,
    rows: object[],
  ): {
    cases: {
      data: Record<string, unknown>;
      include: boolean;
      issues: string[];
      warnings: string[];
    }[];
  };
}
const s2sImporter = createRequire(__filename)(
  '../../tools/launcher/test-case-import.js',
) as S2sImporter;

test.describe('S2S cases (S2-xxx) and S2S data template', () => {
  test('rows: purchase, auth, typed body changes, expectations', () => {
    const { cases } = s2sImporter.previewObjects('s2s', [
      {
        title: 'typed',
        purchase: 'Second call (payment already started)',
        auth: 'Key without Bearer',
        changes:
          'expires="12/3"; cvc not sent; screen_width=0; javascript_enabled=false; deviceId=null; cardholder_name=300 characters',
        http: '400',
        code: 'transaction_error',
        status: 'ERROR / CREATED',
      },
      { title: 'bad', purchase: 'later', http: 'x', changes: 'oops' },
    ]);
    expect(cases[0]?.include).toBe(true);
    const data = cases[0]?.data as { set: Record<string, unknown>; remove: string[] };
    expect(data).toMatchObject({
      purchase: 'second',
      auth: 'no-bearer',
      expected: { http: 400, statuses: ['ERROR', 'CREATED'] },
    });
    expect(data.set.expires).toBe('12/3');
    expect(data.set.screen_width).toBe(0);
    expect(data.set.javascript_enabled).toBe(false);
    expect(data.set.deviceId).toBeNull();
    expect(String(data.set.cardholder_name)).toHaveLength(300);
    expect(data.remove).toEqual(['cvc']);
    expect(cases[0]?.warnings.join(' ')).toContain('deviceId');
    expect(cases[1]?.include).toBe(false);
    expect(cases[1]?.issues.length).toBe(3);
  });

  test('template: custom browser data, remember_card and extra fields from the S2S data tab', () => {
    const body = buildS2sRequest(card, {
      device: 'desktop',
      template: {
        browserData: 'custom',
        remote_ip: '203.0.113.9',
        remember_card: 'on',
        user_agent: 'QA-UA',
        accept_header: 'text/html',
        language: 'de-DE',
        java_enabled: 'true',
        javascript_enabled: false,
        color_depth: 32,
        utc_offset: -60,
        screen_width: 800,
        screen_height: 600,
        extraFields: { deviceId: 'QA-1' },
      },
    });
    expect(body).toMatchObject({
      remote_ip: '203.0.113.9',
      remember_card: 'on',
      user_agent: 'QA-UA',
      language: 'de-DE',
      java_enabled: 'true',
      javascript_enabled: false,
      color_depth: 32,
      utc_offset: -60,
      screen_width: 800,
      screen_height: 600,
      deviceId: 'QA-1',
    });
  });
});
