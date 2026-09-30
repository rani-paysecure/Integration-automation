import type { Frame, Page, Response } from '@playwright/test';
import type {
<<<<<<< Updated upstream
  BrowserData,
  CashierCard,
  CashierPaymentResult,
  ChallengeSetting,
} from '../types/cashier.types';
import { watchForChallenge } from './three-ds-challenge';
=======
  CashierCard,
  CashierPaymentResult,
  ChallengeResult,
  ChallengeSetting,
} from '../types/cashier.types';
import { isChallengeVisible, watchForChallenge } from './three-ds-challenge';
>>>>>>> Stashed changes

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
/** After the OTP is submitted, how long to wait for the merchant redirect before looking at the purchase status. */
const POST_OTP_REDIRECT_MS = 20_000;
const POST_OTP_POLL_MS = 1_000;
/** How long the re-shown challenge is given to be answered again (only when the purchase is still pending). */
const OTP_RETRY_WINDOW_MS = 15_000;

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
    options: {
      readonly challenge?: ChallengeSetting | undefined;
      readonly headed?: boolean;
      /**
       * Called when the challenge page comes back after the OTP was submitted:
       * resolves true when the purchase already has a final status (the page
       * is then left alone), false while it is still pending (the OTP is
       * retried once).
       */
      readonly isSettled?: () => Promise<boolean>;
    } = {},
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
      const watch = (deadline: number): Promise<ChallengeResult | undefined> =>
        watchForChallenge(this.page, options.challenge, {
          cashierHost,
          headed: options.headed === true,
          isFinished: () => finished,
          deadline,
        });
      const challenge = watch(Date.now() + timeout);
      const first = await Promise.race([
        redirected.then(() => ({ kind: 'redirect' as const })),
        challenge.then((result) => ({ kind: 'challenge' as const, result })),
      ]);
      let shown: ChallengeResult | undefined;
      let challengeReshown = false;
      if (first.kind === 'challenge' && first.result?.answered === true) {
        // OTP submitted. Normally the bank redirects to the merchant; if it does
        // not (e.g. the challenge page opens again) don't sit out the full
        // timeout – the purchase status decides the result.
        const notes: string[] = [];
        let landed = await this.waitAfterSubmit(redirected, cashierHost);
        if (!landed) {
          challengeReshown = await isChallengeVisible(this.page, cashierHost);
          if (challengeReshown && (await options.isSettled?.()) === false) {
            const again = await watch(Date.now() + OTP_RETRY_WINDOW_MS);
            if (again?.answered === true) {
              notes.push('page re-shown, OTP retried once');
              landed = await this.waitAfterSubmit(redirected, cashierHost);
              challengeReshown = !landed && (await isChallengeVisible(this.page, cashierHost));
            }
          }
          if (challengeReshown) notes.push('challenge page shown again, no merchant redirect seen');
        }
        shown = {
          ...first.result,
          detail: [first.result.detail, ...notes].join('; '),
        };
      } else if (first.kind === 'challenge') {
        shown = first.result;
        await redirected;
      } else {
        shown = await challenge;
      }
      return {
        ...this.classify(redirects),
        visitedPages: externalPages(visited, targets),
        ...(browserData ? { browserData } : {}),
        ...(shown ? { challenge: shown } : {}),
        ...(challengeReshown ? { challengeReshown } : {}),
      };
    } finally {
      finished = true;
      this.page.off('framenavigated', onNavigate);
    }
  }

  /**
   * Waits (bounded) for the merchant redirect after the OTP was submitted.
   * Returns true when the redirect happened, false when the window ended or
   * the challenge page came back first.
   */
  private async waitAfterSubmit(
    redirected: Promise<boolean>,
    cashierHost: string,
  ): Promise<boolean> {
    let landed = false;
    void redirected.then((ok) => {
      landed = ok;
    });
    const deadline = Date.now() + POST_OTP_REDIRECT_MS;
    let challengeGone = false;
    while (!landed && Date.now() < deadline && !this.page.isClosed()) {
      await this.page.waitForTimeout(POST_OTP_POLL_MS).catch(() => undefined);
      if (landed) break;
      const visible = await isChallengeVisible(this.page, cashierHost);
      if (!visible) challengeGone = true;
      else if (challengeGone) return false; // the challenge page is back
    }
    return landed;
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
