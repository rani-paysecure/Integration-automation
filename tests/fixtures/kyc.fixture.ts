import { expect } from '@playwright/test';
import { ConfigurationError } from '@config/errors';
import { KycHttp } from '@clients/kyc-http';
import type { HttpExchange } from '@app-types/api.types';
import { createCustomer, type NewCustomerOptions } from '@test-data/kyc/customer';
import { createKyc } from '@test-data/kyc/kyc';
import type {
  CreateKycBody,
  Customer,
  KycErrorBody,
  KycRecordView,
} from '@test-data/kyc/kyc-types';
import { test as base } from './api.fixture';

/** KYC settings of the run (tester profile, overridable with <ENV>_KYC_* in .env). */
export interface KycEnv {
  /** Environment root, e.g. https://test4.paymentsclub.net – KYC lives at /kyc, not under /api. */
  readonly baseUrl: string;
  /** Merchant key WITHOUT the "Bearer " prefix (never logged). */
  readonly apiKey: string;
  readonly brandId: string;
  readonly country: string;
  readonly secondApiKey: string | undefined;
  readonly secondBrandId: string | undefined;
  readonly callbackUrl: string | undefined;
  readonly hasSecondMerchant: boolean;
  readonly hasCallbackSink: boolean;
}

/** Provider name + webhook secret (from .env or Dashboard → Merchant → KYC configuration). */
export interface KycWebhookSetup {
  readonly provider: string;
  /** undefined = unknown → signed webhook cases skip. Never logged. */
  readonly secret: string | undefined;
}

interface KycTestFixtures {
  /** Authenticated as the KYC merchant: Authorization + Brand-Id (both spellings). */
  api: KycHttp;
  /** A second merchant, for cross-merchant isolation. Throws if not configured. */
  apiOther: KycHttp;
  /** No auth headers at all – how the subject / the provider reach PGS. */
  anon: KycHttp;
  /** Creates a customer with complete dummy data (POST /api/v1/customer). */
  newCustomer: (options?: NewCustomerOptions) => Promise<Customer>;
  /** POST /kyc/create with `test: true` and the run country; expects 200. */
  newKyc: (body: CreateKycBody) => Promise<KycRecordView>;
}

interface KycWorkerFixtures {
  kycEnv: KycEnv;
  kycWebhook: KycWebhookSetup;
  /** Fails every KYC case with one clear message when the merchant has no KYC MID. */
  kycEnabled: true;
}

const stripBearer = (value: string): string => value.replace(/^bearer\s+/i, '');

export const test = base.extend<KycTestFixtures, KycWorkerFixtures>({
  kycEnv: [
    async ({ testConfig }, use) => {
      const env = testConfig.env.toUpperCase();
      if (testConfig.backoffice.baseUrl === undefined) {
        throw new ConfigurationError(
          `${env}_BASE_URL is not set – KYC runs on the environment root.`,
        );
      }
      const apiKey = testConfig.kyc.apiKey ?? testConfig.auth.apiKey;
      const brandId = testConfig.kyc.brandId ?? testConfig.merchant.brandId;
      if (apiKey === undefined || brandId === undefined) {
        throw new ConfigurationError(
          `No merchant API key / brand ID for KYC. Select a tester profile or set ${env}_KYC_API_KEY and ${env}_KYC_BRAND_ID in .env.`,
        );
      }
      await use({
        baseUrl: testConfig.backoffice.baseUrl.replace(/\/+$/, ''),
        apiKey: stripBearer(apiKey),
        brandId,
        country: testConfig.kyc.country,
        secondApiKey: testConfig.kyc.secondApiKey,
        secondBrandId: testConfig.kyc.secondBrandId ?? brandId,
        callbackUrl: testConfig.kyc.callbackUrl,
        hasSecondMerchant: testConfig.kyc.secondApiKey !== undefined,
        hasCallbackSink: testConfig.kyc.callbackUrl !== undefined,
      });
    },
    { scope: 'worker' },
  ],

  kycWebhook: [
    async ({ testConfig, backoffice }, use) => {
      const { provider, webhookSecret } = testConfig.kyc;
      if (provider !== undefined && webhookSecret !== undefined) {
        await use({ provider, secret: webhookSecret });
        return;
      }
      // Dashboard → Merchant → KYC configuration → provider MID (index 2 of mid_auth_key).
      const merchantId = testConfig.kyc.merchantId ?? testConfig.merchant.id;
      const setup =
        merchantId === undefined
          ? undefined
          : await backoffice.getKycSetup(merchantId).catch(() => undefined);
      await use({
        provider:
          provider ?? (setup !== undefined && setup.provider !== '' ? setup.provider : 'sumsub'),
        secret: webhookSecret ?? setup?.webhookSecret,
      });
    },
    { scope: 'worker' },
  ],

  kycEnabled: [
    async ({ playwright, kycEnv }, use) => {
      const ctx = await playwright.request.newContext();
      const probe = await ctx.post(`${kycEnv.baseUrl}/kyc/create`, {
        headers: {
          Authorization: `Bearer ${kycEnv.apiKey}`,
          'Brand-Id': kycEnv.brandId,
          'Content-Type': 'application/json',
        },
        data: { country: kycEnv.country, test: true, customer_id: '000000000000000000000000' },
        failOnStatusCode: false,
      });
      const body = (await probe.json().catch(() => ({}))) as Partial<KycErrorBody>;
      await ctx.dispose();
      if (body.code === 'kyc_not_enabled') {
        throw new ConfigurationError(
          'KYC is not enabled for this merchant (403 kyc_not_enabled). Select a KYC provider MID in ' +
            'Dashboard → Merchant → KYC configuration, or set <ENV>_KYC_API_KEY / <ENV>_KYC_BRAND_ID ' +
            '(and <ENV>_KYC_MERCHANT_ID) in .env for a merchant that has one.',
        );
      }
      await use(true);
    },
    { scope: 'worker' },
  ],

  api: async (
    { playwright, kycEnv, kycEnabled, logger, httpExchanges, testConfig },
    use,
    testInfo,
  ) => {
    // kycEnabled is a dependency only – it fails fast when the merchant has no KYC MID.
    expect(kycEnabled).toBe(true);
    const ctx = await playwright.request.newContext();
    const seen: HttpExchange[] = [];
    await use(
      new KycHttp(ctx, {
        baseUrl: kycEnv.baseUrl,
        // Both spellings, deliberately: KycController takes `Brand-Id`; the legacy
        // APIController reads `brandid`. Send only one and half the calls resolve the
        // customer without a brand ("customer does not exist").
        headers: {
          Authorization: `Bearer ${kycEnv.apiKey}`,
          'Brand-Id': kycEnv.brandId,
          brandid: kycEnv.brandId,
          'Content-Type': 'application/json',
        },
        logger,
        timeoutMs: testConfig.settings.timeouts.request,
        label: 'merchant',
        onExchange: (exchange) => {
          seen.push(exchange);
          httpExchanges.push(exchange);
        },
      }),
    );
    // Report: last KYC answer of the test (status / code / kyc id).
    const last = [...seen].reverse().find((e) => /\/kyc\/(create|KYC)/.test(e.request.url));
    const body = last?.response?.body as
      { code?: string; kyc_id?: string; status?: string | null } | undefined;
    if (last?.response !== undefined) {
      testInfo.annotations.push({
        type: 'kyc response',
        description: [
          `${last.request.method} ${new URL(last.request.url).pathname} → HTTP ${String(last.response.status)}`,
          body?.code,
          body?.kyc_id === undefined ? undefined : `status ${String(body.status)}`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      if (typeof body?.kyc_id === 'string') {
        testInfo.annotations.push({ type: 'kyc id', description: body.kyc_id });
      }
    }
    await ctx.dispose();
  },

  apiOther: async ({ playwright, kycEnv, logger, httpExchanges, testConfig }, use) => {
    if (kycEnv.secondApiKey === undefined) {
      throw new Error('<ENV>_KYC_API_KEY_2 is not set — this test should have skipped.');
    }
    const ctx = await playwright.request.newContext();
    await use(
      new KycHttp(ctx, {
        baseUrl: kycEnv.baseUrl,
        headers: {
          Authorization: `Bearer ${kycEnv.secondApiKey}`,
          'Brand-Id': kycEnv.secondBrandId ?? kycEnv.brandId,
          brandid: kycEnv.secondBrandId ?? kycEnv.brandId,
          'Content-Type': 'application/json',
        },
        logger,
        timeoutMs: testConfig.settings.timeouts.request,
        label: 'second merchant',
        onExchange: (exchange) => httpExchanges.push(exchange),
      }),
    );
    await ctx.dispose();
  },

  anon: async ({ playwright, kycEnv, logger, httpExchanges, testConfig }, use) => {
    const ctx = await playwright.request.newContext();
    await use(
      new KycHttp(ctx, {
        baseUrl: kycEnv.baseUrl,
        headers: { 'Content-Type': 'application/json' },
        logger,
        timeoutMs: testConfig.settings.timeouts.request,
        label: 'anonymous',
        onExchange: (exchange) => httpExchanges.push(exchange),
      }),
    );
    await ctx.dispose();
  },

  newCustomer: async ({ api, kycEnv }, use) => {
    await use((options) => createCustomer(api, kycEnv.brandId, kycEnv.country, options));
  },

  newKyc: async ({ api, kycEnv }, use) => {
    await use((body) => createKyc(api, body, kycEnv.country));
  },
});

export { expect };

/**
 * Assert the standard KYC error envelope and hand back the body. Checks
 * `status: "fail"` as well as the code: a 4xx rendered by Spring's own error
 * handler rather than KycExceptionHandler carries neither.
 */
export async function expectKycError(
  response: { status(): number; json(): Promise<unknown> },
  httpStatus: number,
  code: string,
): Promise<KycErrorBody> {
  const body = (await response.json()) as KycErrorBody;
  expect(
    { http: response.status(), status: body.status, code: body.code },
    `expected ${String(httpStatus)} ${code}, got ${String(response.status())} ${JSON.stringify(body)}`,
  ).toEqual({ http: httpStatus, status: 'fail', code });
  expect(body.message, 'error message should not be empty').toBeTruthy();
  return body;
}
