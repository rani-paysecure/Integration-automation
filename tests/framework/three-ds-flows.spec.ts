import { expect, test } from '@playwright/test';
import { resolveThreeDsFlow } from '@helpers/three-ds-flows';
import { watchForChallenge } from '../../src/pages/three-ds-challenge';

/** A bank whose 3DS page asks for an OTP, then sort code + account number and an outcome. */
const flows = [
  {
    id: 'demo-bank',
    bank: 'demo-bank-json',
    label: 'Demo Bank',
    methods: ['VISA'],
    details: [
      { key: 'otp', label: 'OTP', value: '1234' },
      { key: 'sortCode', label: 'Sort code', value: '112233' },
      { key: 'account', label: 'Account number', value: '87654321' },
    ],
    docsUrl: '',
    notes: '',
    attachments: [],
    scenarios: [
      {
        id: 'success',
        name: '3DS + OTP + bank check → success',
        outcome: 'success' as const,
        description: '',
        steps: [
          { action: 'waitText' as const, target: 'Verify your payment', value: '' },
          { action: 'fill' as const, target: 'One-time password', value: '{otp}' },
          { action: 'click' as const, target: 'Next', value: '' },
          { action: 'fill' as const, target: 'Sort code', value: '{sortCode}' },
          { action: 'fill' as const, target: 'Account number', value: '{account}' },
          { action: 'select' as const, target: 'Outcome', value: 'Authenticated' },
          { action: 'click' as const, target: 'Submit', value: '' },
        ],
      },
      {
        id: 'missing',
        name: 'Button that does not exist',
        outcome: 'failure' as const,
        description: '',
        steps: [{ action: 'click' as const, target: 'Decline payment', value: '' }],
      },
    ],
  },
];

const ACS = `<!doctype html><body><h3>Verify your payment</h3>
<div id="s1"><label>One-time password <input id="otp"></label><button onclick="s1.hidden=true;s2.hidden=false">Next</button></div>
<div id="s2" hidden>
  <label>Sort code <input id="sc"></label><label>Account number <input id="acc"></label>
  <label>Outcome <select id="out"><option>Failed</option><option>Authenticated</option></select></label>
  <button onclick="document.body.dataset.result=[otp.value,sc.value,acc.value,out.value].join('|')">Submit</button>
</div></body>`;

const SIMPLE_ACS = `<!doctype html><body><h3>Purchase Authentication</h3>
<label>Enter OTP <input placeholder="OTP" id="otp"></label>
<button onclick="document.body.dataset.result=otp.value">Continue</button></body>`;

test.describe('3DS flows (per bank)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('http://cashier.test/**', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: '<iframe src="http://acs.test/acs" width=600 height=400></iframe>',
      }),
    );
    await page.route('http://acs.test/**', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: r.request().url().endsWith('/simple') ? SIMPLE_ACS : ACS,
      }),
    );
  });

  test('runs the scenario steps on the bank 3DS page (multi-step, details, dropdown)', async ({
    page,
  }) => {
    const flow = resolveThreeDsFlow('demo-bank', 'success', flows);
    expect(flow?.steps.map((s) => s.shown)).toEqual([
      '',
      'OTP',
      '',
      'Sort code',
      'Account number',
      'Authenticated',
      '',
    ]);
    await page.goto('http://cashier.test/pay');
    const result = await watchForChallenge(
      page,
      { action: 'flow', otp: '', submit: '', flow },
      {
        cashierHost: 'cashier.test',
        headed: false,
        isFinished: () => false,
        deadline: Date.now() + 20_000,
      },
    );
    expect(result?.answered).toBe(true);
    expect(result?.host).toBe('acs.test');
    expect(result?.detail).toContain('demo-bank-json › 3DS + OTP + bank check → success');
    expect(result?.detail).not.toContain('87654321'); // values never in the report
    const acs = page.frames().find((f) => f.url().startsWith('http://acs.test'));
    await expect
      .poll(() => acs?.locator('body').getAttribute('data-result'))
      .toBe('1234|112233|87654321|Authenticated');
  });

  test('a step whose button is missing is reported, not hung', async ({ page }) => {
    await page.goto('http://cashier.test/pay');
    const flow = resolveThreeDsFlow('demo-bank', 'missing', flows);
    const result = await watchForChallenge(
      page,
      { action: 'flow', otp: '', submit: '', flow },
      {
        cashierHost: 'cashier.test',
        headed: false,
        isFinished: () => false,
        deadline: Date.now() + 3_000,
      },
    );
    // The first step points at the page – never visible → the 3DS page "never showed".
    expect(result).toBeUndefined();
    const gone = await watchForChallenge(
      page,
      { action: 'flow', otp: '', submit: '', flowId: 'x', scenarioId: 'y' },
      {
        cashierHost: 'cashier.test',
        headed: false,
        isFinished: () => false,
        deadline: Date.now() + 1_000,
      },
    );
    expect(gone?.detail).toContain('3DS flow "x" / scenario "y" not found');
  });

  test('Automatic (no scenario): types the 3DS fields, then Submit / Continue', async ({
    page,
  }) => {
    await page.route('http://cashier.test/auto', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: '<iframe src="http://acs.test/simple" width=600 height=400></iframe>',
      }),
    );
    const [demo] = flows;
    if (demo === undefined) throw new Error('demo flow missing');
    const noScenarios = [{ ...demo, details: demo.details.slice(0, 1), scenarios: [] }];
    const flow = resolveThreeDsFlow('demo-bank', 'auto', noScenarios);
    expect(flow?.outcome).toBe('success');
    expect(flow?.steps.map((s) => s.action)).toEqual(['fill', 'click']);
    await page.goto('http://cashier.test/auto');
    const result = await watchForChallenge(
      page,
      { action: 'flow', otp: '', submit: '', flow },
      {
        cashierHost: 'cashier.test',
        headed: false,
        isFinished: () => false,
        deadline: Date.now() + 20_000,
      },
    );
    expect(result?.answered).toBe(true);
    expect(result?.detail).toContain('demo-bank-json › Automatic');
    const acs = page.frames().find((f) => f.url().startsWith('http://acs.test'));
    await expect.poll(() => acs?.locator('body').getAttribute('data-result')).toBe('1234');
  });
});
