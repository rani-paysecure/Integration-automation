import type { Frame, Locator, Page } from '@playwright/test';
import type {
  ChallengeResult,
  ChallengeSetting,
  ResolvedThreeDsFlow,
} from '../types/cashier.types';

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

/** Set on the challenge document right before the OTP is submitted (see `findReshownChallenge`). */
const ANSWERED_MARK = '__psOtpAnswered';

async function markDocument(frame: Frame): Promise<void> {
  // String expression: the project compiles without DOM types.
  await frame.evaluate(`window.${ANSWERED_MARK} = true`).catch(() => undefined);
}

export interface ChallengePageSnapshot {
  readonly frameUrl: string;
  readonly text: string;
}

/**
 * The challenge page is visible again in a NEW document: the one that was
 * answered carries the mark, a reloaded / re-opened page does not. Comparing
 * documents (instead of watching the input disappear) also catches a page that
 * reloads faster than we poll.
 */
export async function findReshownChallenge(
  page: Page,
  cashierHost: string,
): Promise<ChallengePageSnapshot | undefined> {
  const found = await findOtpInput(page, cashierHost);
  if (!found) return undefined;
  const sameDocument = await found.frame
    .evaluate(`window.${ANSWERED_MARK} === true`)
    .catch(() => true);
  if (sameDocument) return undefined;
  const text = await found.frame
    .locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  return { frameUrl: found.frame.url(), text: text.trim().slice(0, 1_500) };
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

// ── 3DS flows (per bank / PSP, configured on the launcher's 3DS flows page) ──

const STEP_TIMEOUT_MS = 30_000;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (text: string): RegExp => new RegExp(`^\\s*${escape(text)}\\s*$`, 'i');

/** Candidate elements for a step in one frame – first visible one wins. */
function candidates(frame: Frame, action: string, target: string): Locator[] {
  if (target.startsWith('css=')) return [frame.locator(target.slice(4))];
  switch (action) {
    case 'fill':
      return [
        frame.getByLabel(target, { exact: false }),
        frame.getByPlaceholder(target, { exact: false }),
        frame.locator(
          `input[name="${target}" i], input[id="${target}" i], textarea[name="${target}" i]`,
        ),
      ];
    case 'click':
      return [
        frame.getByRole('button', { name: exact(target) }),
        frame.getByRole('link', { name: exact(target) }),
        frame.locator(
          `input[type="submit"][value="${target}" i], input[type="button"][value="${target}" i]`,
        ),
        frame.getByText(exact(target)),
        frame.getByRole('button', { name: target }),
      ];
    case 'select':
      return target === ''
        ? [frame.locator('select')]
        : [
            frame.getByLabel(target, { exact: false }),
            frame.locator(`select[name="${target}" i], select[id="${target}" i]`),
          ];
    case 'check':
      return [
        frame.getByLabel(target, { exact: false }),
        frame.getByRole('checkbox', { name: target }),
      ];
    default: // waitText
      return [frame.getByText(target, { exact: false })];
  }
}

/** First visible match in any frame that is not the cashier, until the deadline. */
async function findVisible(
  page: Page,
  cashierHost: string,
  action: string,
  target: string,
  until: number,
  isFinished: () => boolean,
): Promise<{ el: Locator; host: string } | undefined> {
  while (Date.now() < until && !isFinished() && !page.isClosed()) {
    for (const frame of page.frames()) {
      const host = hostOf(frame.url());
      if (!host || host === cashierHost) continue;
      for (const locator of candidates(frame, action, target)) {
        const first = locator.first();
        if (await first.isVisible().catch(() => false)) return { el: first, host };
      }
    }
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return undefined;
}

/** The first step that points at something on the page – it tells that the 3DS page is there. */
const isLocating = (action: string): boolean =>
  ['waitText', 'fill', 'click', 'select', 'check'].includes(action);

/**
 * Runs a bank's 3DS scenario: waits for its page (first step's target visible), then does
 * every step in order. The report lists each step (✓ / ✗) – typed values only by their label.
 */
async function runFlow(
  page: Page,
  flow: ResolvedThreeDsFlow,
  options: {
    readonly cashierHost: string;
    readonly isFinished: () => boolean;
    readonly deadline: number;
  },
): Promise<ChallengeResult | undefined> {
  const title = `${flow.bank} › ${flow.scenario}`;
  const first = flow.steps.find((step) => isLocating(step.action));
  let host = '';
  if (first !== undefined) {
    const found = await findVisible(
      page,
      options.cashierHost,
      first.action,
      first.target,
      options.deadline,
      options.isFinished,
    );
    if (found === undefined) return undefined; // 3DS page never showed (frictionless / redirect first)
    host = found.host;
  }
  const done: string[] = [];
  for (const step of flow.steps) {
    const label = `${step.action}${step.target ? ` "${step.target}"` : ''}${step.shown ? ` = ${step.shown}` : ''}`;
    if (step.action === 'expire') {
      done.push(`${label} ✓ (left to time out)`);
      return {
        shown: true,
        host,
        action: 'flow',
        detail: `${title}: ${done.join(' → ')}`,
        answered: false,
      };
    }
    if (step.action === 'wait') {
      await page
        .waitForTimeout(Math.min(120, Math.max(0, Number(step.value) || 0)) * 1000)
        .catch(() => undefined);
      done.push(`${label} ✓`);
      continue;
    }
    const hit = await findVisible(
      page,
      options.cashierHost,
      step.action,
      step.target,
      Math.min(options.deadline, Date.now() + STEP_TIMEOUT_MS),
      options.isFinished,
    );
    if (hit === undefined) {
      done.push(`${label} ✗ not found on the 3DS page`);
      return {
        shown: true,
        host,
        action: 'flow',
        detail: `${title}: ${done.join(' → ')}`,
        answered: false,
      };
    }
    const { el } = hit;
    if (step.action === 'fill') await el.fill(step.value);
    else if (step.action === 'click') await el.click();
    else if (step.action === 'select') {
      await el.selectOption({ label: step.value }).catch(() => el.selectOption(step.value));
    } else if (step.action === 'check') await el.check();
    done.push(`${label} ✓`);
  }
  return {
    shown: true,
    host,
    action: 'flow',
    detail: `${title}: ${done.join(' → ')}`,
    answered: true,
  };
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
  if (action === 'flow') {
    if (setting?.flow === undefined) {
      return {
        shown: false,
        host: '',
        action,
        detail: `3DS flow "${setting?.flowId ?? ''}" / scenario "${setting?.scenarioId ?? ''}" not found – check the card on the Test cards tab`,
      };
    }
    return runFlow(page, setting.flow, options);
  }
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
      await markDocument(found.frame);
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
