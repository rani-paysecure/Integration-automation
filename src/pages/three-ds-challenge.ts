import type { Frame, Page } from '@playwright/test';
import type { ChallengeResult, ChallengeSetting } from '../types/cashier.types';

/**
 * 3DS challenge pages (the bank's OTP / password step) shown between PAY and
 * the merchant redirect. Test ACS pages differ per PSP but look alike: an
 * input for the code (often inside an iframe) and a Submit button, e.g. the
 * Cardinal Commerce test ACS used by Paysafe (field `challengeDataEntry`,
 * "(OTP: 1234)" printed on the page).
 */
const OTP_INPUT = [
  'input[autocomplete="one-time-code"]',
  'input[name*="challenge" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[placeholder*="code" i]',
  'input[placeholder*="otp" i]',
  'input[name*="code" i]',
  'input[type="password"]',
].join(', ');
const DEFAULT_SUBMIT =
  /^(submit|continue|verify|confirm|authenticate|authorise|authorize|ok|send|next)$/i;
/** "(OTP: 1234)", "OTP 1234", "password: 1234" on test pages. */
const OTP_HINT =
  /\b(?:otp|one[- ]time (?:code|password)|password|code)\b\s*(?:is)?\s*[:=]?\s*([0-9A-Za-z]{3,10})\b/i;

const POLL_MS = 1_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

async function findOtpInput(page: Page, ignoreHost: string): Promise<{ frame: Frame } | undefined> {
  for (const frame of page.frames()) {
    const host = hostOf(frame.url());
    if (!host || host === ignoreHost) continue;
    const input = frame.locator(OTP_INPUT).first();
    if ((await input.count().catch(() => 0)) > 0 && (await input.isVisible().catch(() => false))) {
      return { frame };
    }
  }
  return undefined;
}

/** True while a challenge (OTP) input is visible on the page or in one of its frames. */
export async function isChallengeVisible(page: Page, cashierHost: string): Promise<boolean> {
  return (await findOtpInput(page, cashierHost)) !== undefined;
}

async function readOtpHint(frame: Frame): Promise<string> {
  const text = await frame
    .locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  return OTP_HINT.exec(text)?.[1] ?? '';
}

async function pressSubmit(frame: Frame, label: string): Promise<string> {
  const wanted = label
    ? new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
    : DEFAULT_SUBMIT;
  const candidates = frame.locator(
    'button, input[type="submit"], input[type="button"], [role="button"], a',
  );
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const inner = (await el.innerText().catch(() => '')).trim();
    const text = inner === '' ? ((await el.getAttribute('value')) ?? '').trim() : inner;
    if (wanted.test(text)) {
      await el.click();
      return text;
    }
  }
  await frame.locator(OTP_INPUT).first().press('Enter');
  return 'Enter key';
}

/**
 * Watches for a challenge page until `isFinished()` (redirect reached) or the
 * deadline, and answers it according to the card's setting. Runs alongside
 * the redirect wait in `CashierPage.pay`.
 */
export async function watchForChallenge(
  page: Page,
  setting: ChallengeSetting | undefined,
  options: {
    readonly cashierHost: string;
    readonly headed: boolean;
    readonly isFinished: () => boolean;
    readonly deadline: number;
  },
): Promise<ChallengeResult | undefined> {
  const action = setting?.action ?? 'none';
  while (!options.isFinished() && Date.now() < options.deadline && !page.isClosed()) {
    const found = await findOtpInput(page, options.cashierHost);
    if (found) {
      const host = hostOf(found.frame.url());
      if (action === 'none') {
        return {
          shown: true,
          host,
          action,
          detail: 'challenge shown but the card has no 3DS setting (not answered)',
        };
      }
      if (action === 'manual') {
        return {
          shown: true,
          host,
          action,
          detail: options.headed
            ? 'waiting for the tester to complete it in the browser'
            : 'manual challenge needs "Show browser while paying" – not answered',
        };
      }
      const configured = setting?.otp ?? '';
      const otp = configured === '' ? await readOtpHint(found.frame) : configured;
      if (!otp) {
        return {
          shown: true,
          host,
          action,
          detail: 'no OTP configured and none shown on the page – not answered',
        };
      }
      const input = found.frame.locator(OTP_INPUT).first();
      await input.fill(otp);
      const pressed = await pressSubmit(found.frame, setting?.submit ?? '');
      return {
        shown: true,
        host,
        action,
        detail: `OTP ${configured === '' ? 'read from the page' : 'from card settings'} entered, "${pressed}" pressed`,
        answered: true,
      };
    }
    await page.waitForTimeout(POLL_MS).catch(() => undefined);
  }
  return undefined;
}
