// @ts-check
/**
 * Minimal read-only client for the Paysecure dashboard (back-office), used by
 * the launcher to offer Bank → MID → Currency / Payment method choices exactly
 * as configured in the dashboard (same endpoints as Limits/Charges and the
 * Transactions page).
 *
 * - Session-cookie login (Spring Security form + CSRF), renewed automatically.
 * - Only whitelisted, non-secret fields ever leave this module (the raw
 *   dashboard objects contain keys, passwords and PSP credentials).
 * - Note: the dashboard allows one session per user – logging in here ends
 *   that user's browser session.
 */
'use strict';

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;

class DashboardError extends Error {}

const splitList = (value) =>
  String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

class DashboardClient {
  /** @param {{ baseUrl: string, username: string, password: string }} options */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.username = options.username;
    this.password = options.password;
    /** @type {Map<string, string>} */
    this.cookies = new Map();
    this.loggedIn = false;
    /** @type {Map<string, { at: number, data: unknown }>} */
    this.cache = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** @param {Response} res */
  storeCookies(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * fetch with manual redirects so every Set-Cookie is kept.
   * @returns {Promise<{ res: Response, url: string }>}
   */
  async request(path, init = {}, redirects = 0) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...(init.headers || {}), cookie: this.cookieHeader() },
    });
    this.storeCookies(res);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && redirects < 5) {
      return this.request(new URL(location, url).toString(), { method: 'GET' }, redirects + 1);
    }
    return { res, url };
  }

  static isLoginUrl(url) {
    const { pathname, search } = new URL(url);
    return pathname === '/' || /login|error/i.test(pathname + search);
  }

  async login() {
    this.cookies.clear();
    const { res: page } = await this.request('/');
    const html = await page.text();
    const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new DashboardError('Dashboard login page has no CSRF token');
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
      _csrf: csrf,
    });
    const { url } = await this.request('/j_spring_security_check', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (DashboardClient.isLoginUrl(url)) {
      throw new DashboardError(
        `Dashboard login failed for "${this.username}" – check the dashboard username/password of the tester.`,
      );
    }
    this.loggedIn = true;
  }

  async getJson(path, retry = true) {
    if (!this.loggedIn) await this.login();
    const { res, url } = await this.request(path, {
      headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' },
    });
    if (
      DashboardClient.isLoginUrl(url) ||
      !(res.headers.get('content-type') || '').includes('json')
    ) {
      if (!retry)
        throw new DashboardError(`Dashboard did not return data for ${path.split('?')[0]}`);
      this.loggedIn = false; // session ended elsewhere (e.g. a test run logged in)
      return this.getJson(path, false);
    }
    if (!res.ok)
      throw new DashboardError(`Dashboard returned HTTP ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  async cached(key, load) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = await load();
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  clearCache() {
    this.cache.clear();
  }

  /** Names (and status) of MIDs or banks by id, as used by Limits/Charges routing. */
  async routeTargets(routeTo, ids) {
    if (ids.length === 0) return [];
    const rows = await this.getJson(
      `/rule/getPaymentBankMidStatus?action_name=${encodeURIComponent(routeTo)}&ids=${encodeURIComponent(ids.join(','))}`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: Number(r.id),
      name: String(r.name || '').trim(),
      status: r.status === undefined ? null : Boolean(r.status),
    }));
  }

  /**
   * Routing configured for a merchant in Limits/Charges: one entry per
   * currency + payment method with the MID (or bank) it routes to.
   */
  routing(merchantId) {
    return this.cached(`routing:${merchantId}`, async () => {
      const combos = await this.getJson(
        `/limitChargesData/getCurrAndpayList?mid=${encodeURIComponent(merchantId)}`,
      );
      const configured = (Array.isArray(combos) ? combos : []).filter(
        (c) => c.currency && c.paymentMethod,
      );
      const results = [];
      // Small batches – one limit lookup per combination.
      for (let i = 0; i < configured.length; i += 5) {
        const batch = configured.slice(i, i + 5);
        results.push(
          ...(await Promise.all(
            batch.map(async (combo) => {
              const currency = String(combo.currency);
              const paymentMethod = String(combo.paymentMethod);
              const limit = await this.getJson(
                `/limitChargesData/getMerchantLimitObject?m_id=${encodeURIComponent(merchantId)}` +
                  `&currency=${encodeURIComponent(currency)}&paymentMethod=${encodeURIComponent(paymentMethod)}`,
              );
              const total = (limit && (limit.Total || limit.total)) || {};
              const routeTo = String(total.routeTo || combo.routeTo || '');
              const ids = String(total.routeValue || '')
                .split(',')
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isInteger(v) && v > 0);
              const targets =
                routeTo === 'route_to_mid' || routeTo === 'route_to_bank'
                  ? await this.routeTargets(routeTo, ids)
                  : [];
              return { currency, paymentMethod, routeTo, targets };
            }),
          )),
        );
      }
      return results.sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) || a.paymentMethod.localeCompare(b.paymentMethod),
      );
    });
  }

  /** Active banks – only id and name leave this module (the raw rows hold keys and test cards). */
  banks() {
    return this.cached('banks', async () => {
      const rows = await this.getJson('/admin/getAllActivePaymentBanks');
      return (Array.isArray(rows) ? rows : [])
        .map((b) => ({ id: Number(b.id), name: String(b.name || '').trim() }))
        .filter((b) => b.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** Field regexes of a bank (PaymentBankJsonData → Field Regex): { field: pattern }. */
  fieldRules(bankName) {
    return this.cached(`rules:${bankName}`, async () => {
      let body;
      try {
        body = await this.getJson(
          `/admin/getFieldValidationRules?bank_name=${encodeURIComponent(bankName)}`,
        );
      } catch (error) {
        if (error instanceof DashboardError && /did not return data/.test(error.message)) return {};
        throw error;
      }
      const rules = body && typeof body === 'object' ? body.validationJson : undefined;
      if (!rules || typeof rules !== 'object') return {};
      return Object.fromEntries(Object.entries(rules).filter(([, v]) => typeof v === 'string'));
    });
  }

  /**
   * KYC configuration of a merchant (Merchant Details → Kyc Configuration → Bank MID).
   * Only the MID's id / provider / name leave this module – never its mid_auth_key.
   */
  async kycSetup(merchantId) {
    const config = await this.getJson(`/admin/getKycConfig?mid=${encodeURIComponent(merchantId)}`);
    const bankMidId = Number(config && config.bankMidId);
    if (!Number.isInteger(bankMidId) || bankMidId <= 0) return { enabled: false };
    const mids = await this.cached('kycMids', () => this.getJson('/admin/getPaymentBankMIDForKYC'));
    const row = (Array.isArray(mids) ? mids : []).find((m) => Number(m.id) === bankMidId);
    return {
      enabled: true,
      bankMidId,
      provider: String((row && row.bankName) || '').trim(),
      mid: String((row && (row.mid || row.mid_desc)) || '').trim(),
    };
  }

  /**
   * Settings that change routing / refunds for the AI's bank & MID cases: the routed MID,
   * its bank and the merchant. Whitelisted fields only – never auth keys, passwords or
   * the bank's test cards (the raw rows hold them).
   */
  async bankConfigContext(midName, merchantId) {
    const rows = await this.cached('banksRaw', () =>
      this.getJson('/admin/getAllActivePaymentBanks'),
    );
    const banks = (Array.isArray(rows) ? rows : []).filter((b) => b && b.name);
    const lower = String(midName || '').toLowerCase();
    const ordered = [
      ...banks
        .filter((b) => lower.startsWith(String(b.name).toLowerCase()))
        .sort((a, b) => String(b.name).length - String(a.name).length),
      ...banks.filter((b) => !lower.startsWith(String(b.name).toLowerCase())),
    ].slice(0, 25);
    for (const bank of ordered) {
      let mids;
      try {
        mids = await this.getJson(
          `/admin/v2/getAllPaymentBankMIDList?pp_id=${encodeURIComponent(bank.id)}`,
          false,
        );
      } catch {
        continue;
      }
      const mid = (Array.isArray(mids) ? mids : []).find(
        (m) => m.mid === midName || m.mid_desc === midName,
      );
      if (!mid) continue;
      const page = merchantId
        ? await this.request(`/admin/getMerchant?m_id=${encodeURIComponent(merchantId)}`).then(
            (r) => r.res.text(),
          )
        : '';
      const pick = (re) => (re.exec(page) || [])[1];
      return {
        bank: {
          name: String(bank.name),
          maxRefundDays: Number(bank.max_refund_days) || 0,
          allowedCurr: String(bank.allowed_curr || ''),
          allowedCard: String(bank.allowed_card || ''),
        },
        mid: {
          name: String(mid.mid),
          onlyTwoD: Number(mid.onlyTwoD) || 0,
          is3ds: Number(mid.is3ds) || 0,
          partialRefundAllowed: Number(mid.partial_refund_allowed) || 0,
          currConvertTo: String(mid.curr_convert_to || ''),
          allowedCurr: String(mid.allowed_curr || ''),
          allowedCard: String(mid.allowed_card || ''),
          allowedCountry: String(mid.allowedCountry || ''),
          isTestData: mid.is_test_data === true,
        },
        merchant: {
          conversionAllowed: Number(pick(/"conversionAllowed"\s*:\s*(-?\d+)/)) || 0,
          trxType: pick(/"trxType"\s*:\s*"([^"]*)"/) || 'ALL',
        },
      };
    }
    return undefined;
  }

  /**
   * Payment methods with their own parameters (Payment Methods page): required fields and the
   * two extraParam key groups. Only these fields leave this module.
   */
  paymentMethods() {
    return this.cached('paymentMethods', async () => {
      const rows = await this.getJson('/admin/getAllPaymentMethods');
      const { toMethod } = require('./payment-method-cases');
      return (Array.isArray(rows) ? rows : [])
        .map(toMethod)
        .filter((m) => m.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** Merchants with their allowed currencies / payment methods: [{ id, name, currencies, paymentMethods }] */
  merchants() {
    return this.cached('merchants', async () => {
      const rows = await this.getJson('/admin/getAllNotP2PMerchant');
      return (Array.isArray(rows) ? rows : [])
        .map((m) => ({
          id: Number(m.id),
          name: String(m.name || ''),
          currencies: splitList(m.allowedCurr),
          paymentMethods: splitList(m.allowedPaymentMethod),
        }))
        .filter((m) => m.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}

module.exports = { DashboardClient, DashboardError };
