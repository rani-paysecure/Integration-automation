import type { Frame, Locator, Page } from '@playwright/test';
import type {
  ChallengeResult,
  ChallengeSetting,
  ResolvedThreeDsFlow,
  ThreeDsPageCapture,
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

/** Outcome dropdown of a test ACS ("Select authentication outcome": Approve / Reject …). */
const OUTCOME_SELECT = 'select';
/** Options that mean "authenticate successfully" when the card names no option. */
const SUCCESS_OPTION =
  /^(approve|approved|authenticated?|success(ful)?|pass(ed)?|y|yes|ok|frictionless)\b/i;
/** A foreign page with a form that nothing answered for this long is reported as not recognised. */
const UNRECOGNISED_MS = 30_000;

/** A visible outcome dropdown next to a button, outside the cashier. */
async function findOutcomeSelect(
  page: Page,
  ignoreHost: string,
): Promise<{ frame: Frame; select: Locator } | undefined> {
  for (const frame of page.frames()) {
    const host = hostOf(frame.url());
    if (!host || host === ignoreHost) continue;
    const select = frame.locator(OUTCOME_SELECT).first();
    if (!(await select.isVisible().catch(() => false))) continue;
    const button = frame.locator('button, input[type="submit"], input[type="button"]').first();
    if (await button.isVisible().catch(() => false)) return { frame, select };
  }
  return undefined;
}

/** Option texts of a dropdown (for the report and for matching). */
async function optionTexts(select: Locator): Promise<string[]> {
  const texts = await select
    .locator('option')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((t) => t.trim()).filter(Boolean);
}

/** What a foreign page that nothing recognised shows: fields and buttons (labels only, no values). */
async function describeForm(frame: Frame): Promise<string> {
  const parts: string[] = [];
  const selects = frame.locator('select');
  for (let i = 0; i < Math.min(await selects.count().catch(() => 0), 3); i++) {
    const opts = await optionTexts(selects.nth(i));
    parts.push(`dropdown [${opts.slice(0, 6).join(', ')}]`);
  }
  const inputs = await frame
    .locator('input:visible:not([type="hidden"]):not([type="submit"]):not([type="button"])')
    .count()
    .catch(() => 0);
  if (inputs > 0) parts.push(`${String(inputs)} input field(s)`);
  const buttons = await frame
    .locator('button:visible, input[type="submit"]:visible')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const named = buttons.map((b) => b.trim()).filter(Boolean);
  if (named.length > 0)
    parts.push(
      `button(s) ${named
        .slice(0, 4)
        .map((b) => `"${b}"`)
        .join(', ')}`,
    );
  return parts.join(' · ');
}

/** A visible form (field / dropdown + button) on a page outside the cashier. */
async function findForeignForm(page: Page, ignoreHost: string): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const host = hostOf(frame.url());
    if (!host || host === ignoreHost) continue;
    const control = frame.locator('select, input:not([type="hidden"]), textarea').first();
    const button = frame.locator('button, input[type="submit"]').first();
    if (
      (await control.isVisible().catch(() => false)) &&
      (await button.isVisible().catch(() => false))
    ) {
      return frame;
    }
  }
  return undefined;
}

/**
 * Reads the 3DS page's structure in the browser: dropdowns (label + option texts), fields
 * (label / name / type), buttons. Never field values. String expression: no DOM types here.
 */
const READ_PAGE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = (e) => (e && e.innerText ? e.innerText : '').replace(/\\s+/g, ' ').trim();
  const labelOf = (e) => {
    if (e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l && text(l)) return text(l); }
    const wrap = e.closest('label'); if (wrap) { const t = text(wrap).replace(text(e), '').trim(); if (t) return t; }
    const aria = e.getAttribute('aria-label') || e.getAttribute('placeholder'); if (aria) return aria.trim();
    let s = e.previousElementSibling; while (s && !text(s)) s = s.previousElementSibling;
    if (!s && e.parentElement) { s = e.parentElement.previousElementSibling; while (s && !text(s)) s = s.previousElementSibling; }
    return s ? text(s) : '';
  };
  const cut = (v) => String(v).slice(0, 80);
  return {
    heading: cut(text(document.querySelector('h1, h2, h3, h4')) || document.title || ''),
    dropdowns: [...document.querySelectorAll('select')].filter(vis).slice(0, 5).map((s) => ({
      label: cut(labelOf(s)), name: cut(s.name || s.id || ''),
      options: [...s.options].map((o) => cut(o.text.trim())).filter(Boolean).slice(0, 30) })),
    inputs: [...document.querySelectorAll('input, textarea')]
      .filter((e) => vis(e) && !['hidden', 'submit', 'button', 'checkbox', 'radio', 'image', 'reset'].includes(e.type))
      .slice(0, 15).map((e) => ({ label: cut(labelOf(e)), name: cut(e.name || e.id || ''), type: e.type || 'text' })),
    buttons: [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')]
      .filter(vis).map((b) => cut(text(b) || b.value || '')).filter(Boolean).slice(0, 15),
  };
})()`;

/** The 3DS page of `frame` as the launcher needs it to draft a Dynamic 3DS flow. */
export async function captureThreeDsPage(
  page: Page,
  frame: Frame,
): Promise<ThreeDsPageCapture | undefined> {
  const read = (await frame.evaluate(READ_PAGE).catch(() => undefined)) as
    Omit<ThreeDsPageCapture, 'url' | 'host' | 'capturedAt' | 'screenshot'> | undefined;
  if (read === undefined) return undefined;
  const url = ((): string => {
    try {
      const u = new URL(frame.url());
      return `${u.origin}${u.pathname}`;
    } catch {
      return '';
    }
  })();
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
  return {
    ...read,
    url,
    host: hostOf(frame.url()),
    capturedAt: new Date().toISOString(),
    ...(screenshot ? { screenshot } : {}),
  };
}

/**
 * Watches for a page outside the cashier that shows a form and stays the same: after
 * UNRECOGNISED_MS it returns that frame (nothing handled it – report instead of waiting).
 */
function foreignWatcher(page: Page, cashierHost: string): () => Promise<Frame | undefined> {
  let since = 0;
  let url = '';
  return async () => {
    const form = await findForeignForm(page, cashierHost);
    if (form?.url() !== url) {
      since = form === undefined ? 0 : Date.now();
      url = form?.url() ?? '';
      return undefined;
    }
    return since > 0 && Date.now() - since > UNRECOGNISED_MS ? form : undefined;
  };
}

/** Capture of the first non-cashier frame that shows a form (for a failed / unknown 3DS page). */
async function captureForeign(
  page: Page,
  cashierHost: string,
): Promise<ThreeDsPageCapture | undefined> {
  const frame = await findForeignForm(page, cashierHost);
  return frame === undefined ? undefined : captureThreeDsPage(page, frame);
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

async function pressSubmit(frame: Frame, label: string, fallback?: Locator): Promise<string> {
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
  await (fallback ?? frame.locator(OTP_INPUT).first()).press('Enter');
  return 'Enter key';
}

// ── 3DS flows (per bank / PSP, configured on the launcher's 3DS flows page) ──

const STEP_TIMEOUT_MS = 30_000;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (text: string): RegExp => new RegExp(`^\\s*${escape(text)}\\s*$`, 'i');

/** Candidate elements for a step in one frame – first visible one wins. "A|B" tries A, then B. */
function candidates(frame: Frame, action: string, target: string): Locator[] {
  if (target.includes('|') && !target.startsWith('css=')) {
    return target
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
      .flatMap((t) => candidates(frame, action, t));
  }
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
    const stuck = foreignWatcher(page, options.cashierHost);
    let found: { el: Locator; host: string } | undefined;
    while (found === undefined && Date.now() < options.deadline && !options.isFinished()) {
      found = await findVisible(
        page,
        options.cashierHost,
        first.action,
        first.target,
        Math.min(options.deadline, Date.now() + 3_000),
        options.isFinished,
      );
      if (found !== undefined || page.isClosed()) break;
      // A different 3DS page than the scenario describes – report it instead of timing out.
      const other = await stuck();
      if (other !== undefined) {
        const captured = await captureThreeDsPage(page, other);
        return {
          shown: true,
          host: hostOf(other.url()),
          action: 'flow',
          detail: `${title}: first step ${first.action} "${first.target}" ✗ not on the 3DS page (${await describeForm(other)}) – check the scenario steps, or create a flow from this page`,
          answered: false,
          stuck: true,
          ...(captured ? { page: captured } : {}),
        };
      }
    }
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
      const captured = await captureForeign(page, options.cashierHost);
      return {
        shown: true,
        host,
        action: 'flow',
        detail: `${title}: ${done.join(' → ')}`,
        answered: false,
        stuck: true,
        ...(captured ? { page: captured } : {}),
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
  const unrecognised = foreignWatcher(page, options.cashierHost);
  while (!options.isFinished() && Date.now() < options.deadline && !page.isClosed()) {
    if (action === 'otp') {
      const outcome = await findOutcomeSelect(page, options.cashierHost);
      if (outcome !== undefined && (await findOtpInput(page, options.cashierHost)) === undefined) {
        const captured = await captureThreeDsPage(page, outcome.frame);
        const answer = await answerOutcomeSelect(
          outcome,
          setting?.otp ?? '',
          setting?.submit ?? '',
        );
        return captured ? { ...answer, page: captured } : answer;
      }
    }
    // A page outside the cashier with a form that nothing below recognises → report it after a while
    // instead of waiting silently until the test times out.
    const form = action === 'manual' ? undefined : await unrecognised();
    if (form !== undefined && (await findOtpInput(page, options.cashierHost)) === undefined) {
      const captured = await captureThreeDsPage(page, form);
      return {
        ...(captured ? { page: captured } : {}),
        shown: true,
        host: hostOf(form.url()),
        action,
        detail: `3DS page on ${hostOf(form.url())} not recognised (${await describeForm(form)}) – nothing was entered for ${String(UNRECOGNISED_MS / 1000)} s. Set this card's 3DS handling to "Dynamic 3DS flow" – the report offers "Create 3DS flow from this page"`,
        answered: false,
        stuck: true,
      };
    }
    const found = await findOtpInput(page, options.cashierHost);
    if (found) {
      const host = hostOf(found.frame.url());
      // Read before anything is typed: labels, options and buttons only.
      const captured = await captureThreeDsPage(page, found.frame);
      const withPage = (r: ChallengeResult): ChallengeResult =>
        captured ? { ...r, page: captured } : r;
      if (action === 'none') {
        return withPage({
          shown: true,
          host,
          action,
          detail: 'challenge shown but the card has no 3DS setting (not answered)',
        });
      }
      if (action === 'manual') {
        return withPage({
          shown: true,
          host,
          action,
          detail: options.headed
            ? 'waiting for the tester to complete it in the browser'
            : 'manual challenge needs "Show browser while paying" – not answered',
        });
      }
      const configured = setting?.otp ?? '';
      const otp = configured === '' ? await readOtpHint(found.frame) : configured;
      if (!otp) {
        return withPage({
          shown: true,
          host,
          action,
          detail: 'no OTP configured and none shown on the page – not answered',
        });
      }
      const input = found.frame.locator(OTP_INPUT).first();
      await markDocument(found.frame);
      await input.fill(otp);
      const pressed = await pressSubmit(found.frame, setting?.submit ?? '');
      return withPage({
        shown: true,
        host,
        action,
        detail: `OTP ${configured === '' ? 'read from the page' : 'from card settings'} entered, "${pressed}" pressed`,
        answered: true,
      });
    }
    await page.waitForTimeout(POLL_MS).catch(() => undefined);
  }
  return undefined;
}

/**
 * OTP mode on a test ACS that offers an outcome dropdown instead of a code field:
 * the card's "OTP" names the option (e.g. Approve); empty = the success option.
 */
async function answerOutcomeSelect(
  found: { frame: Frame; select: Locator },
  wanted: string,
  submit: string,
): Promise<ChallengeResult> {
  const host = hostOf(found.frame.url());
  const options = await optionTexts(found.select);
  const pick =
    wanted === ''
      ? options.find((o) => SUCCESS_OPTION.test(o))
      : (options.find((o) => o.toLowerCase() === wanted.trim().toLowerCase()) ??
        options.find((o) => o.toLowerCase().includes(wanted.trim().toLowerCase())));
  if (pick === undefined) {
    return {
      shown: true,
      host,
      action: 'otp',
      detail: `outcome dropdown shown, but ${wanted === '' ? 'no success option' : `"${wanted}" is not one of its options`} (${options.join(', ')}) – put the option text in the card's OTP field`,
      answered: false,
      stuck: true,
    };
  }
  await markDocument(found.frame);
  await found.select.selectOption({ label: pick });
  const pressed = await pressSubmit(found.frame, submit, found.select);
  return {
    shown: true,
    host,
    action: 'otp',
    detail: `outcome dropdown: "${pick}" chosen, "${pressed}" pressed`,
    answered: true,
  };
}
