import type { Frame, Page, Response } from '@playwright/test';
import type {
  BrowserData,
  CashierCard,
  CashierPaymentResult,
  ChallengeResult,
  ChallengeSetting,
  ReshownEvidence,
} from '../types/cashier.types';
import {
  findReshownChallenge,
  watchForChallenge,
  type ChallengePageSnapshot,
} from './three-ds-challenge';

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
/** After the OTP is submitted, how long to watch for the challenge page re-opening before waiting on the redirect as usual. */
const POST_OTP_WATCH_MS = 20_000;
const POST_OTP_POLL_MS = 1_000;
/** How long the re-opened challenge is given to be answered again. */
const OTP_RETRY_WINDOW_MS = 15_000;

export interface FollowOptions {
  readonly challenge?: ChallengeSetting | undefined;
  readonly headed?: boolean;
  /** Called once when the challenge page re-opens after the OTP was submitted. */
  readonly onChallengeReshown?: () => void;
  /** Milliseconds this call may still spend waiting for a redirect (e.g. what is left of the test timeout). */
  readonly timeBudget?: () => number;
}

type AfterSubmit =
  | { readonly kind: 'redirect' }
  | { readonly kind: 'reshown'; readonly page: ChallengePageSnapshot }
  | { readonly kind: 'expired' };

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
  async pay(redirects: RedirectUrls, options: FollowOptions = {}): Promise<CashierPaymentResult> {
    const cashierHost = new URL(this.page.url()).host;
    return this.follow(redirects, options, cashierHost, async () => {
      // String expression: the project compiles without DOM types.
      const screen = await this.page.evaluate<{ width: number; height: number }>(
        '({ width: screen.width, height: screen.height })',
      );
      const npv = this.page
        .waitForResponse((res) => NPV_PATH.test(res.url()) && res.request().method() === 'POST', {
          timeout: PAYMENT_TIMEOUT_MS,
        })
        .catch(() => undefined);
      await this.payButton().click();
      const submission = await npv;
      if (submission === undefined) return {};
      return {
        browserData: { sent: Object.fromEntries(new URL(submission.url()).searchParams), screen },
        rejected: await this.rejectionMessage(submission),
      };
    });
  }

  /**
   * Session page: clicks PAY and follows the browser (3DS challenge, then the merchant redirect). Unlike
   * {@link pay} it does not wait for the cashier's `/npv/{id}/` request – the session page pays through a
   * different call, and waiting for it would hold back the 3DS handling for the whole payment timeout.
   */
  async paySession(
    redirects: RedirectUrls,
    options: FollowOptions = {},
  ): Promise<CashierPaymentResult> {
    const cashierHost = new URL(this.page.url()).host;
    return this.follow(redirects, options, cashierHost, async () => {
      await this.payButton().click();
      return {};
    });
  }

  /**
   * S2S: opens the `callback_url` the S2S API answered with (the customer's browser
   * continues the payment there) and follows it like {@link pay} – 3DS challenge,
   * PSP pages, then one of the merchant redirect URLs.
   */
  async openCallback(
    callbackUrl: string,
    redirects: RedirectUrls,
    options: FollowOptions = {},
  ): Promise<CashierPaymentResult> {
    return this.follow(redirects, options, new URL(callbackUrl).host, async () => {
      await this.page.goto(callbackUrl, { waitUntil: 'commit', timeout: PAYMENT_TIMEOUT_MS });
      return {};
    });
  }

  /** Starts the payment (`start`) and follows the browser to the merchant redirect. */
  private async follow(
    redirects: RedirectUrls,
    options: FollowOptions,
    cashierHost: string,
    start: () => Promise<{ browserData?: BrowserData; rejected?: string | undefined }>,
  ): Promise<CashierPaymentResult> {
    const targets = [redirects.success, redirects.failure, redirects.pending];
    const manual = options.challenge?.action === 'manual' && options.headed === true;
    const timeout = manual ? MANUAL_CHALLENGE_TIMEOUT_MS : PAYMENT_TIMEOUT_MS;
    let finished = false;
    const visited: string[] = [];
    const onNavigate = (frame: Frame): void => {
      if (frame === this.page.mainFrame()) visited.push(frame.url());
    };
    this.page.on('framenavigated', onNavigate);

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
      const { browserData, rejected } = await start();
      if (rejected !== undefined) {
        return {
          outcome: 'rejected',
          finalUrl: this.page.url(),
          apiMessage: rejected,
          visitedPages: externalPages(visited, targets),
          ...(browserData ? { browserData } : {}),
        };
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
      const evidence: ReshownEvidence[] = [];
      if (first.kind === 'challenge' && first.result?.answered === true) {
        // OTP submitted. Normally the bank redirects to the merchant. If the
        // challenge page opens again instead, keep the evidence and enter the
        // same OTP once more. In every other case the redirect is awaited as before.
        const notes: string[] = [];
        let after = await this.watchAfterSubmit(redirected, cashierHost);
        if (after.kind === 'reshown') {
          evidence.push(await this.captureReshown(after.page, 1));
          options.onChallengeReshown?.();
          const again = await watch(Date.now() + OTP_RETRY_WINDOW_MS);
          if (again?.answered === true) {
            notes.push('OTP page re-opened after submit; same OTP entered again');
            after = await this.watchAfterSubmit(redirected, cashierHost);
            if (after.kind === 'reshown') {
              evidence.push(await this.captureReshown(after.page, 2));
              notes.push('OTP page re-opened again; not retried further');
            }
          } else {
            notes.push('OTP page re-opened after submit; it could not be answered again');
          }
        }
        if (after.kind === 'expired') {
          const wait = Math.max(0, Math.min(timeout, options.timeBudget?.() ?? timeout));
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            redirected,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, wait);
            }),
          ]);
          clearTimeout(timer);
        }
        shown = { ...first.result, detail: [first.result.detail, ...notes].join('; ') };
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
        ...(evidence.length > 0 ? { challengeReshown: true, reshownEvidence: evidence } : {}),
      };
    } finally {
      finished = true;
      this.page.off('framenavigated', onNavigate);
    }
  }

  /**
   * Watches (bounded) what happens right after the OTP was submitted:
   * 'redirect' = the merchant redirect happened, 'reshown' = the challenge page
   * was opened again (a new document), 'expired' = neither within the window.
   */
  private async watchAfterSubmit(
    redirected: Promise<boolean>,
    cashierHost: string,
  ): Promise<AfterSubmit> {
    // Set from the promise callback – read through a function so it is re-checked after every await.
    const state = { landed: false };
    const landed = (): boolean => state.landed;
    void redirected.then((ok) => {
      state.landed = ok;
    });
    const deadline = Date.now() + POST_OTP_WATCH_MS;
    while (!landed() && Date.now() < deadline && !this.page.isClosed()) {
      await this.page.waitForTimeout(POST_OTP_POLL_MS).catch(() => undefined);
      if (landed()) break;
      const page = await findReshownChallenge(this.page, cashierHost);
      if (page) return { kind: 'reshown', page };
    }
    return landed() ? { kind: 'redirect' } : { kind: 'expired' };
  }

  private async captureReshown(
    snapshot: ChallengePageSnapshot,
    attempt: number,
  ): Promise<ReshownEvidence> {
    const screenshot = await this.page.screenshot().catch(() => undefined);
    return {
      attempt,
      at: new Date().toISOString(),
      pageUrl: this.page.url(),
      frameUrl: snapshot.frameUrl,
      text: snapshot.text,
      ...(screenshot ? { screenshot } : {}),
    };
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
