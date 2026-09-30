import type { APIRequestContext } from '@playwright/test';
import { ConfigurationError } from '../../config/errors';
import { Endpoints } from '../constants/endpoints';
import {
  backofficeTransactionSchema,
  bankTransactionSchema,
  merchantWebhookSchema,
  refundDetailsSchema,
  type BackofficeTransaction,
  type BankTransaction,
  type MerchantWebhook,
  type PspWebhook,
  type TransLogEntry,
  type RefundDetails,
} from '../schemas/backoffice.schema';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';
import { MemorySessionStore, type SessionStore, type StorageState } from './backoffice-session';

export interface DashboardCredentials {
  readonly username: string;
  readonly password: string;
}

const HTML = { accept: 'text/html,application/xhtml+xml' } as const;
const DAY_SECONDS = 86_400;
/** Transaction Log pages read per purchase (100 lines each). */
const MAX_TRANS_LOG_PAGES = 5;
/** Event label at the start of a Transaction Log line: `webhook:IN`, `webhook:OUT:paid`, `custRedirect`. */
const TRANS_LOG_EVENT = /^[A-Za-z]+(?::(?:IN|OUT))?(?::[A-Za-z_]+)?/;

/** Hidden `_csrf` input of the login form. */
export function extractLoginCsrf(html: string): string | undefined {
  return (
    /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1] ??
    /value="([^"]+)"\s+name="_csrf"/.exec(html)?.[1]
  );
}

/** `<meta name="_csrf" content="…">` of an authenticated page. */
export function extractMetaCsrf(html: string): string | undefined {
  return (
    /<meta\s+name="_csrf"\s+content="([^"]+)"/.exec(html)?.[1] ??
    /<meta\s+content="([^"]+)"\s+name="_csrf"/.exec(html)?.[1]
  );
}

/** True when the final URL after login is still the login page or an error page. */
export function isLoginFailure(finalUrl: string): boolean {
  const { pathname, search } = new URL(finalUrl);
  return pathname === '/' || /login|error/i.test(pathname + search);
}

/** KYC provider MID configured for a merchant. */
export interface KycSetup {
  readonly bankMidId: number;
  /** Payment bank name of the MID – the `{provider}` in /kyc/webhook/{provider}. */
  readonly provider: string;
  readonly midName: string;
  /** Webhook signing secret (never log). */
  readonly webhookSecret: string | undefined;
}

/** Thrown when a request lands on the login page (session ended elsewhere). */
class SessionExpiredError extends Error {}

export type RequestContextFactory = (storageState?: StorageState) => Promise<APIRequestContext>;

/**
 * Paysecure back-office (dashboard) client.
 *
 * Uses the same endpoints as the dashboard's Transactions page: form login
 * (Spring Security, session cookie + CSRF), transaction search and the bank /
 * PSP record per purchase. Read-only – never changes back-office data.
 *
 * The dashboard allows one active session per user, so the login is shared
 * through a `SessionStore` (all workers reuse it) and renewed automatically
 * if the session is ended elsewhere (e.g. the tester logs in in the browser).
 */
export class BackofficeClient extends BaseApiClient {
  private csrfToken: string | undefined;
  private context: APIRequestContext | undefined;
  private usedState: string | undefined;

  constructor(
    options: Omit<BaseApiClientOptions, 'authHeaders' | 'request'>,
    private readonly credentials: DashboardCredentials,
    private readonly createContext: RequestContextFactory,
    private readonly store: SessionStore = new MemorySessionStore(),
    /** Set when the configuration is incomplete – reported on first use. */
    private readonly configurationProblem?: string,
    /**
     * Separate session on the host that serves Reports → Transaction Log (the React
     * dashboard is attached to staging; a test4 login cannot open that section).
     */
    private readonly transLogSource?: BackofficeClient,
  ) {
    super({
      ...options,
      // Placeholder – every call goes through requestContext() below.
      request: undefined as unknown as APIRequestContext,
      logger: options.logger.child('backoffice'),
      authHeaders: () => Promise.resolve(this.sessionHeaders()),
    });
  }

  protected override requestContext(): APIRequestContext {
    if (this.context === undefined) throw new Error('Back-office client is not connected');
    return this.context;
  }

  get isConnected(): boolean {
    return this.context !== undefined && this.csrfToken !== undefined;
  }

  private sessionHeaders(): Record<string, string> {
    return {
      'x-requested-with': 'XMLHttpRequest',
      ...(this.csrfToken === undefined
        ? {}
        : { 'x-csrf-token': this.csrfToken, 'x-xsrf-token': this.csrfToken }),
    };
  }

  private async useContext(state?: StorageState): Promise<void> {
    await this.context?.dispose();
    this.context = await this.createContext(state);
    this.csrfToken = undefined;
  }

  /** Loads the Transactions page to obtain the CSRF token. False = not logged in. */
  private async loadCsrf(): Promise<boolean> {
    const page = await this.get<string>(Endpoints.backoffice.transactionsPage, {
      skipAuth: true,
      headers: HTML,
    });
    if (isLoginFailure(page.raw.url())) return false;
    this.csrfToken = extractMetaCsrf(page.text);
    if (this.csrfToken === undefined) {
      throw new Error(
        'Logged in, but the Transactions page has no CSRF token – does this user have access to Transactions?',
      );
    }
    return true;
  }

  private async tryResume(state: StorageState): Promise<boolean> {
    await this.useContext(state);
    this.usedState = JSON.stringify(state);
    return this.loadCsrf();
  }

  private async login(): Promise<void> {
    await this.useContext();
    const loginPage = await this.get<string>(Endpoints.backoffice.loginPage, {
      skipAuth: true,
      headers: HTML,
    });
    const loginCsrf = extractLoginCsrf(loginPage.text);
    if (loginCsrf === undefined) {
      throw new Error('Back-office login page has no CSRF token – page layout changed?');
    }
    const result = await this.post<string>(Endpoints.backoffice.login, {
      skipAuth: true,
      headers: HTML,
      form: {
        username: this.credentials.username,
        password: this.credentials.password,
        _csrf: loginCsrf,
      },
    });
    if (!result.ok || isLoginFailure(result.raw.url())) {
      throw new ConfigurationError(
        `Back-office login failed for "${this.credentials.username}" (HTTP ${result.status}). ` +
          'Check the dashboard username/password of your tester profile. Note: the dashboard ' +
          'allows one active session per user.',
      );
    }
    if (!(await this.loadCsrf())) {
      throw new Error('Back-office login succeeded but the session was rejected immediately.');
    }
    const state = await this.requestContext().storageState();
    this.store.write(state);
    this.usedState = JSON.stringify(state);
    this.logger.info(`Back-office session started for ${this.credentials.username}`);
  }

  /** Connects using the shared session, logging in only when none is valid. */
  async connect(): Promise<void> {
    if (this.configurationProblem !== undefined) {
      throw new ConfigurationError(this.configurationProblem);
    }
    const shared = this.store.read();
    if (shared !== undefined && (await this.tryResume(shared))) return;
    await this.renewSession();
  }

  /** Logs in under the shared lock – unless another worker already renewed it. */
  private async renewSession(): Promise<void> {
    await this.store.withLock(async () => {
      const shared = this.store.read();
      if (shared !== undefined && JSON.stringify(shared) !== this.usedState) {
        if (await this.tryResume(shared)) return;
      }
      await this.login();
    });
  }

  /** Runs a call; if the session was ended elsewhere, renews it once and retries. */
  private async withSession<T>(call: () => Promise<T>): Promise<T> {
    if (!this.isConnected) await this.connect();
    try {
      return await call();
    } catch (error: unknown) {
      if (!(error instanceof SessionExpiredError)) throw error;
      this.logger.warn('Back-office session ended elsewhere – logging in again');
      await this.renewSession();
      return call();
    }
  }

  private assertSession(finalUrl: string): void {
    if (isLoginFailure(finalUrl)) throw new SessionExpiredError('Back-office session expired');
  }

  async dispose(): Promise<void> {
    await this.context?.dispose();
    this.context = undefined;
  }

  /** Finds a transaction by purchase ID (searches the last `lookbackDays`). */
  async findTransaction(
    purchaseId: string,
    lookbackDays = 30,
  ): Promise<BackofficeTransaction | undefined> {
    const now = Math.floor(Date.now() / 1000);
    const response = await this.withSession(async () => {
      const result = await this.post(Endpoints.backoffice.transactions, {
        params: {
          pageNo: 0,
          pagesize: 10,
          from_seconds: now - lookbackDays * DAY_SECONDS,
          to_seconds: now + DAY_SECONDS,
          status: '',
          purchaseId,
          sandbox: 0,
          bankmid: '',
          bankid: -1,
          currency: '',
          includePaidOn: 0,
          settleStatus: -1,
        },
      });
      this.assertSession(result.raw.url());
      return result;
    });
    if (!response.ok) {
      throw new Error(`Transaction search failed with HTTP ${response.status}`);
    }
    const rows = Array.isArray(response.body) ? (response.body as unknown[]) : [];
    const match = rows.find(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        (row as { purchaseId?: unknown }).purchaseId === purchaseId,
    );
    return match === undefined ? undefined : backofficeTransactionSchema.parse(match);
  }

  /** Like `findTransaction`, but fails with a clear message when the purchase is unknown. */
  async requireTransaction(purchaseId: string, lookbackDays = 30): Promise<BackofficeTransaction> {
    const trx = await this.findTransaction(purchaseId, lookbackDays);
    if (trx === undefined) {
      throw new Error(
        `Purchase ${purchaseId} not found in back-office (searched last ${lookbackDays} days).`,
      );
    }
    return trx;
  }

  /**
   * Bank / PSP record for a purchase: request sent to the PSP (`paymentInfo`),
   * PSP response(s), PSP transaction ID (`paymentTransId`), bank and MID.
   * Returns `undefined` when no payment was attempted yet.
   */
  async getBankTransaction(purchaseId: string): Promise<BankTransaction | undefined> {
    const response = await this.withSession(async () => {
      const result = await this.get(Endpoints.backoffice.bankTransaction, {
        params: { purchaseId },
      });
      this.assertSession(result.raw.url());
      return result;
    });
    if (!response.ok) {
      throw new Error(`Bank transaction lookup failed with HTTP ${response.status}`);
    }
    const body = response.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('paymentTransId' in body || 'orderId' in body)
    ) {
      // Unpaid purchases only return timing data (createdAt / methodCalls).
      return undefined;
    }
    return bankTransactionSchema.parse(body);
  }

  /**
   * Field regexes of a bank (PaymentBankJsonData → Field Regex): `{ full_name: '^…$', … }`.
   * Banks without rules return a non-JSON page – treated as "no rules".
   */
  async getFieldValidationRules(bankName: string): Promise<Record<string, string>> {
    const response = await this.withSession(async () => {
      const result = await this.get(Endpoints.backoffice.fieldValidationRules, {
        params: { bank_name: bankName },
      });
      this.assertSession(result.raw.url());
      return result;
    });
    const body: unknown = response.body;
    if (!response.ok || typeof body !== 'object' || body === null || !('validationJson' in body)) {
      return {};
    }
    const rules = body.validationJson;
    if (typeof rules !== 'object' || rules === null) return {};
    return Object.fromEntries(
      Object.entries(rules as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  /** JSON GET on the dashboard; `undefined` when it answers with a page instead of data. */
  private async getData(path: string, params?: Record<string, string | number>): Promise<unknown> {
    const response = await this.withSession(async () => {
      const result = await this.get(path, params === undefined ? {} : { params });
      this.assertSession(result.raw.url());
      return result;
    });
    if (!response.ok) throw new Error(`Dashboard ${path} failed with HTTP ${response.status}`);
    const body: unknown = response.body;
    return typeof body === 'object' && body !== null ? body : undefined;
  }

  /**
   * Reports → Transaction Log for one purchase (`webhook:IN` = received from the PSP,
   * `webhook:OUT:<status>` = sent to the merchant). Only the event label of each line is
   * returned – the log text contains customer data.
   */
  async getTransactionLog(purchaseId: string, lookbackDays = 3): Promise<TransLogEntry[]> {
    if (this.transLogSource !== undefined) {
      return this.transLogSource.getTransactionLog(purchaseId, lookbackDays);
    }
    const now = Math.floor(Date.now() / 1000);
    const entries: TransLogEntry[] = [];
    for (let pageNo = 1; pageNo <= MAX_TRANS_LOG_PAGES; pageNo++) {
      const body = await this.getData(Endpoints.backoffice.transLog, {
        pid: purchaseId,
        pageNo,
        pageSize: 100,
        download: 'false',
        from_seconds: now - lookbackDays * DAY_SECONDS,
        to_seconds: now + 3_600,
      });
      const { data, totalPage } = (body ?? {}) as { data?: unknown; totalPage?: unknown };
      if (!Array.isArray(data)) break;
      for (const row of data as Record<string, unknown>[]) {
        const text = typeof row.text === 'string' ? row.text : '';
        entries.push({
          at: typeof row.currentTime === 'number' ? row.currentTime : 0,
          event: TRANS_LOG_EVENT.exec(text)?.[0] ?? '',
        });
      }
      if (typeof totalPage !== 'number' || pageNo >= totalPage) break;
    }
    return entries;
  }

  /** Transaction log → Webhook out: every webhook PGS sent to the merchant for the purchase. */
  async getMerchantWebhooks(purchaseId: string): Promise<MerchantWebhook[]> {
    const body = await this.getData(Endpoints.backoffice.merchantWebhooks, { pid: purchaseId });
    if (!Array.isArray(body)) return [];
    // The merchant's answer (often an HTML page) is not needed for the checks.
    return body.map((row): MerchantWebhook => {
      const parsed = merchantWebhookSchema.parse(row);
      return {
        purchaseId: parsed.purchaseId,
        callback_url: parsed.callback_url,
        transactionStatus: parsed.transactionStatus,
        callTime: parsed.callTime,
        callStatus: parsed.callStatus,
        channel: parsed.channel,
      };
    });
  }

  /**
   * PSP Webhook log → Webhook in: webhooks received from the PSP that mention
   * the purchase (or the PSP transaction ID). Headers and body are dropped –
   * they contain signatures and cookies.
   */
  async getPspWebhooks(searchTerms: readonly string[]): Promise<PspWebhook[]> {
    const seen = new Map<string, PspWebhook>();
    for (const term of searchTerms.filter(Boolean)) {
      const body = await this.getData(Endpoints.backoffice.pspWebhooks, {
        search: term,
        page: 0,
        limit: 50,
      });
      const rows = (body as { rows?: unknown } | undefined)?.rows;
      if (!Array.isArray(rows)) continue;
      const text = (value: unknown): string =>
        typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      for (const row of rows as Record<string, unknown>[]) {
        const id = text(row.id) || `${text(row.receiveTime)}-${String(seen.size)}`;
        seen.set(id, {
          pspName: text(row.pspName),
          status: text(row.status),
          receiveTime: text(row.receiveTime),
        });
      }
    }
    return [...seen.values()];
  }

  /** Refund history of a purchase (status history, refunds, refunded / refundable amount). */
  async getRefundDetails(purchaseId: string): Promise<RefundDetails | undefined> {
    const body = await this.getData(Endpoints.backoffice.refundDetails(purchaseId));
    if (body === undefined || Array.isArray(body)) return undefined;
    // Only whitelisted keys – the raw answer includes unmasked customer data.
    const raw = body as Record<string, unknown>;
    return refundDetailsSchema.parse({
      status: raw.status,
      status_history: raw.status_history,
      totalRefunded: raw.totalRefunded,
      refundable_amount: raw.refundable_amount,
      refund_availability: raw.refund_availability,
      refunds: raw.refunds,
    });
  }

  /**
   * KYC configuration of a merchant (Dashboard → Merchant → KYC configuration).
   * Returns the configured KYC provider MID, or `undefined` when KYC is not set up.
   * Only id / provider / MID name leave this method; the webhook secret (index 2 of the
   * `##`-separated mid_auth_key) is returned separately and must never be logged.
   */
  async getKycSetup(merchantId: number): Promise<KycSetup | undefined> {
    const config = await this.getData(Endpoints.backoffice.kycConfig, { mid: merchantId });
    const raw = (config as { bankMidId?: unknown } | undefined)?.bankMidId;
    const bankMidId = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(bankMidId) || bankMidId <= 0) return undefined;
    const mids = await this.getData(Endpoints.backoffice.kycMids);
    const row = (Array.isArray(mids) ? (mids as Record<string, unknown>[]) : []).find(
      (m) => Number(m.id) === bankMidId,
    );
    const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const authKey = text(row?.mid_auth_key);
    return {
      bankMidId,
      provider: text(row?.bankName),
      midName: text(row?.mid) || text(row?.mid_desc),
      webhookSecret: authKey.split('##')[2]?.trim() || undefined,
    };
  }
}
