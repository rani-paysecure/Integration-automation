import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Duplicate checks read saved cases – use an empty folder.
process.env.UPLOADED_CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cases-'));

interface PreviewCase {
  data: Record<string, unknown>;
  issues: string[];
  warnings: string[];
  info?: string[];
  include: boolean;
}
interface AiModule {
  generateCases(
    category: string,
    options: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<{ cases: PreviewCase[]; model: string; note: string }>;
  buildContext(category: string, ctx: Record<string, unknown>): string;
}
const ai = createRequire(__filename)('../../tools/launcher/ai-generate.js') as AiModule;

/** Simulated Messages API: returns the given rows through the tool call. */
function fakeClaude(rows: unknown[]): { calls: { body: Record<string, unknown> }[] } {
  const record = { calls: [] as { body: Record<string, unknown> }[] };
  globalThis.fetch = ((_url: unknown, init: { body: string }) => {
    record.calls.push({ body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'submit_test_cases', input: { cases: rows } }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  return record;
}

test.describe('AI test-case generation (simulated API)', () => {
  const realFetch = globalThis.fetch;

  test.beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  test.afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.ANTHROPIC_API_KEY = '';
  });

  test('regex: the bank regex decides Valid / Invalid, not the model', async () => {
    const record = fakeClaude([
      {
        bank: 'paysafe_payfac',
        parameter: 'full_name',
        title: 'Digits',
        data: 'John123',
        result: 'Valid',
        why: 'digits are not letters',
      },
      {
        bank: 'paysafe_payfac',
        parameter: 'full_name',
        title: 'Two words',
        data: 'Maria Lopez',
        result: 'Valid',
        why: 'plain name',
      },
      {
        bank: 'paysafe_payfac',
        parameter: 'shoe_size',
        title: 'Unknown',
        data: '42',
        result: 'Invalid',
        why: 'x',
      },
    ]);
    const result = await ai.generateCases(
      'regex',
      { min: 2, max: 5 },
      { bank: 'paysafe_payfac', rules: { full_name: '^[A-Za-z]+(\\s[A-Za-z]+)*$' }, cardIds: [] },
    );
    const [digits, name, unknown] = result.cases as [PreviewCase, PreviewCase, PreviewCase];
    expect(digits.data).toMatchObject({
      expectation: 'invalid',
      origin: 'ai',
      bank: 'paysafe_payfac',
    });
    expect(digits.warnings.join()).toContain('regex wins');
    expect(name.data).toMatchObject({ expectation: 'valid' });
    expect(name.info).toEqual(['plain name']);
    expect(unknown.include).toBe(false);
    const sent = JSON.stringify(record.calls[0]?.body);
    expect(sent).toContain('full_name: ^[A-Za-z]+');
    expect(sent).not.toContain('test-key');
  });

  test('field / edge / psp rows go through the upload validation', async () => {
    fakeClaude([
      {
        parameter: 'client.email',
        title: 'No TLD',
        data: 'qa@example',
        expected: 'Validation error',
        why: 'no top-level domain',
      },
    ]);
    const field = await ai.generateCases(
      'field',
      { min: 1, max: 3 },
      { purchaseTemplate: { client: { email: 'a@b.c' } } },
    );
    expect(field.cases[0]?.data).toMatchObject({ path: 'client.email', expectation: 'rejected' });

    fakeClaude([
      {
        title: 'Declined card',
        card: 'visa-3ds-challenge-decline',
        changes: '',
        cashier: 'Failure redirect',
        status: 'ERROR',
        error: '',
        why: 'N result',
      },
    ]);
    const edge = await ai.generateCases(
      'edge',
      { min: 1, max: 3 },
      { cardIds: ['visa-3ds-challenge-decline'], cards: [] },
    );
    expect(edge.cases[0]?.data).toMatchObject({
      card: 'visa-3ds-challenge-decline',
      expected: { outcome: 'failure-redirect' },
    });
    expect(edge.note).toBe('');
  });

  test('context carries no secrets and lists existing cases', () => {
    const text = ai.buildContext('psp', {
      cards: [
        {
          id: 'visa-ok',
          label: 'Visa OK',
          expectedOutcome: 'success-redirect',
          expectedStatuses: ['PAID'],
        },
      ],
      existing: ['Order sent to PSP'],
    });
    expect(text).toContain('visa-ok: Visa OK');
    expect(text).toContain('do NOT repeat');
    expect(text).not.toMatch(/\b\d{13,19}\b/);
  });

  test('without an API key the generator explains what to set', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    await expect(ai.generateCases('field', {}, {})).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
