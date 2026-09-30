import type { Frame, Page, Response } from '@playwright/test';
import type {
  BrowserData,
  CashierCard,
  CashierPaymentResult,
  ChallengeSetting,
} from '../types/cashier.types';
import { watchForChallenge } from './three-ds-challenge';

export interface RedirectUrls {
  readonly success: string;
  readonly failure: string;
  readonly pending: string;
}

const NPV_PATH = /\/npv\/[^/]+\//;

/** Hosts visited between PAY and the final redirect (3DS / PSP pages). */
function externalPages(urls: readonly string[], targets: readonly string[]): string[] {
  const hosts = urls
    .filter((url) => !url.includes('/payments/') && !targets.some((t) => url.startsWith(t)))
    .map((url) => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    });
  return [...new Set(hosts)];
}
const PAYMENT_TIMEOUT_MS = 90_000;
/** A tester completing a challenge by hand gets more time. */
const MANUAL_CHALLENGE_TIMEOUT_MS = 300_000;

/**
 * Hosted checkout page (`checkout_url` from the purchase response).
 * Selectors are the stable element IDs of the cashier form.
 */
export class CashierPage {
  constructor(private readonly page: Page) {}

  readonly cardNumber = () => this.page.locator('#cardNumber');
  readonly cardholderName = () => this.page.locator('#cardholderName');
  readonly expiry = () => this.page.locator('#cardMonthyear');
  readonly cvv = () => this.page.locator('#cardCvc');
  readonly email = () => this.page.locator('#emailId');
  readonly fullName = () => this.page.locator('#full_name');
  readonly address = () => this.page.locator('#address');
  readonly city = () => this.page.locator('#city');
  readonly country = () => this.page.locator('#country');
  readonly zipCode = () => this.page.locator('#zip_code');
  readonly payButton = () => this.page.locator('button.payNow_btn');

  /** Opens the checkout URL and waits until the card form is usable. */
  async open(checkoutUrl: string): Promise<void> {
    // The page keeps polling in the background, so never wait for "networkidle".
    await this.page.goto(checkoutUrl, { waitUntil: 'load' });
    await this.cardNumber().waitFor({ state: 'visible' });
  }

  /** Types the card like a customer (the inputs are masked, so `fill` is not enough). */
  async enterCard(card: CashierCard): Promise<void> {
    await this.cardNumber().pressSequentially(card.number, { delay: 25 });
    await this.cardholderName().pressSequentially(card.holderName, { delay: 10 });
    await this.expiry().pressSequentially(card.expiry.replace('/', ''), { delay: 25 });
    await this.cvv().pressSequentially(card.cvv, { delay: 25 });
    await this.cvv().blur();
  }

  /**
   * Clicks PAY and waits until the customer lands on one of the merchant
   * redirect URLs (passing through 3DS / PSP pages on the way), or the cashier
   * API rejects the payment. A page that never redirects (e.g. a 3DS challenge
   * waiting for input) ends as `other-page`.
   */
  async pay(
    redirects: RedirectUrls,
    options: { readonly challenge?: ChallengeSetting | undefined; readonly headed?: boolean } = {},
  ): Promise<CashierPaymentResult> {
    const targets = [redirects.success, redirects.failure, redirects.pending];
    const manual = options.challenge?.action === 'manual' && options.headed === true;
    const timeout = manual ? MANUAL_CHALLENGE_TIMEOUT_MS : PAYMENT_TIMEOUT_MS;
    const cashierHost = new URL(this.page.url()).host;
    let finished = false;
    const visited: string[] = [];
    const onNavigate = (frame: Frame): void => {
      if (frame === this.page.mainFrame()) visited.push(frame.url());
    };
    this.page.on('framenavigated', onNavigate);

    const npv = this.page
      .waitForResponse((res) => NPV_PATH.test(res.url()) && res.request().method() === 'POST', {
        timeout: PAYMENT_TIMEOUT_MS,
      })
      .catch(() => undefined);
    const redirected = this.page
      .waitForURL((url) => targets.some((target) => url.toString().startsWith(target)), {
        timeout,
        waitUntil: 'commit',
      })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        finished = true;
      });

    try {
      // String expression: the project compiles without DOM types.
      const screen = await this.page.evaluate<{ width: number; height: number }>(
        '({ width: screen.width, height: screen.height })',
      );
      await this.payButton().click();
      const submission = await npv;
      const browserData: BrowserData | undefined =
        submission === undefined
          ? undefined
          : { sent: Object.fromEntries(new URL(submission.url()).searchParams), screen };
      if (submission !== undefined) {
        const rejected = await this.rejectionMessage(submission);
        if (rejected !== undefined) {
          return {
            outcome: 'rejected',
            finalUrl: this.page.url(),
            apiMessage: rejected,
            visitedPages: externalPages(visited, targets),
            ...(browserData ? { browserData } : {}),
          };
        }
      }
      const challenge = watchForChallenge(this.page, options.challenge, {
        cashierHost,
        headed: options.headed === true,
        isFinished: () => finished,
        deadline: Date.now() + timeout,
      });
      await redirected;
      const shown = await challenge;
      return {
        ...this.classify(redirects),
        visitedPages: externalPages(visited, targets),
        ...(browserData ? { browserData } : {}),
        ...(shown ? { challenge: shown } : {}),
      };
    } finally {
      finished = true;
      this.page.off('framenavigated', onNavigate);
    }
  }

  private async rejectionMessage(response: Response): Promise<string | undefined> {
    if (response.ok()) return undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      return typeof body.message === 'string' ? body.message : `HTTP ${response.status()}`;
    } catch {
      return `HTTP ${response.status()}`;
    }
  }

  private classify(redirects: RedirectUrls): Omit<CashierPaymentResult, 'visitedPages'> {
    const finalUrl = this.page.url();
    const matches = (target: string): boolean => finalUrl.startsWith(target);
    const outcome = matches(redirects.success)
      ? 'success-redirect'
      : matches(redirects.failure)
        ? 'failure-redirect'
        : matches(redirects.pending)
          ? 'pending-redirect'
          : finalUrl.includes('/payments/')
            ? 'timeout'
            : 'other-page';
    return { outcome, finalUrl, apiMessage: '' };
  }
}
