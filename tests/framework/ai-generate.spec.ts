import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Duplicate checks read saved cases – use an empty folder.
process.env.UPLOADED_CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cases-'));

interface PreviewCase {
  ref?: string;
  data: Record<string, unknown>;
  issues: string[];
  warnings: string[];
  info?: string[];
  include: boolean;
}
interface AiResult {
  cases: PreviewCase[];
  model: string;
  note?: string;
  session: string;
  resumed?: boolean;
  changes?: { added: number; updated: number; removed: number; note: string };
}
interface AiModule {
  generateCases(
    category: string,
    options: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<AiResult>;
  refineCases(session: string, options: Record<string, unknown>): Promise<AiResult>;
  closeAiSession(session: string): boolean;
  buildContext(category: string, ctx: Record<string, unknown>): string;
  parseCasesJson(text: string): unknown[];
  resetForTests(): void;
}
const ai = createRequire(__filename)('../../tools/launcher/ai-generate.js') as AiModule;

type Frame = Record<string, unknown>;

/**
 * Simulated gateway WebSocket (protocol v1). Each user.message gets the next scripted answer
 * (a string, or a frame to send instead – e.g. an error).
 */
class FakeGateway {
  static answers: (string | Frame)[] = [];
  static sockets: FakeGateway[] = [];
  static packSkills = ['paysecure-qa__generate-test-cases'];

  readyState = 0;
  sent: Frame[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: (() => void) | null;
  private session = '';

  constructor(readonly url: string) {
    FakeGateway.sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  private emit(frame: Frame): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) }), 0);
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    this.sent.push(frame);
    if (frame.type === 'auth') this.emit({ type: 'ready', protocol_version: 1 });
    if (frame.type === 'session.open') {
      this.session = `gw-${String(FakeGateway.sockets.length)}`;
      const agent = frame.mode === 'agent';
      this.emit({
        type: 'session.ready',
        session: this.session,
        model: 'sonnet',
        mode: frame.mode,
        skills: agent ? FakeGateway.packSkills : [],
      });
    }
    if (frame.type === 'user.message') {
      const next = FakeGateway.answers.shift() ?? '{"cases":[]}';
      if (typeof next !== 'string') {
        this.emit(next);
        return;
      }
      this.emit({ type: 'assistant.text', session: this.session, text: next });
      this.emit({
        type: 'turn.complete',
        session: this.session,
        cost_usd: 0.01,
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 50 },
      });
    }
    if (frame.type === 'session.close') this.readyState = 3;
  }

  close(): void {
    this.readyState = 3;
  }

  /** Simulates the gateway ending the session (idle suspend, restart). */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  messages(): string[] {
    return this.sent.filter((f) => f.type === 'user.message').map((f) => String(f.text));
  }
}

const json = (value: unknown): string => JSON.stringify(value);
const fieldRow = (ref: string, title: string, data: string) => ({
  ref,
  parameter: 'client.email',
  title,
  data,
  expected: 'Validation error',
  why: `${title} is not an email`,
});
const fieldCtx = { purchaseTemplate: { client: { email: 'a@b.c' } } };

test.describe('AI test-case generation (simulated gateway WebSocket)', () => {
  test.describe.configure({ mode: 'serial' });
  const realWebSocket = globalThis.WebSocket;

  test.beforeEach(() => {
    ai.resetForTests();
    FakeGateway.answers = [];
    FakeGateway.sockets = [];
    FakeGateway.packSkills = ['paysecure-qa__generate-test-cases'];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeGateway;
    process.env.AI_GATEWAY_URL = 'http://gateway.test:8081/v1/agent/completions';
    process.env.AI_GATEWAY_TOKEN = 'gw-token';
    process.env.AI_GATEWAY_SKILLS = '';
  });

  test.afterEach(() => {
    ai.resetForTests();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    for (const k of ['AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'AI_GATEWAY_SKILLS'])
      process.env[k] = '';
  });

  test('uses the skill pack in a locked-down agent session; the token only goes in the auth frame', async () => {
    FakeGateway.answers = [json({ cases: [fieldRow('C1', 'No TLD', 'qa@example')] })];
    const result = await ai.generateCases('field', { min: 1, max: 3 }, fieldCtx);
    const socket = FakeGateway.sockets[0];
    expect(socket?.url).toBe('ws://gateway.test:8081/v1/agent');
    expect(socket?.sent[0]).toMatchObject({ type: 'auth', token: 'gw-token' });
    const open = socket?.sent.find((f) => f.type === 'session.open');
    expect(open).toMatchObject({ mode: 'agent', skills: ['paysecure-qa'] });
    expect(open?.disallowed_tools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write']));
    const [message] = socket?.messages() ?? [];
    expect(message).toContain('Use the skill paysecure-qa__generate-test-cases');
    expect(message).toContain('TASK: generate-test-cases');
    expect(message).toContain('- parameter (');
    expect(JSON.stringify(socket?.sent.slice(1))).not.toContain('gw-token');
    expect(result.model).toBe('sonnet via AI gateway · skill pack');
    expect(result.cases[0]).toMatchObject({
      ref: 'C1',
      data: { path: 'client.email', expectation: 'rejected', origin: 'ai' },
    });
    expect(result.session).toBeTruthy();
  });

  test('without the deployed pack it falls back to a chat session with SKILL.md as system prompt', async () => {
    FakeGateway.packSkills = [];
    FakeGateway.answers = [json({ cases: [fieldRow('C1', 'No TLD', 'qa@example')] })];
    const result = await ai.generateCases('field', { min: 1, max: 3 }, fieldCtx);
    expect(FakeGateway.sockets).toHaveLength(2);
    const open = FakeGateway.sockets[1]?.sent.find((f) => f.type === 'session.open');
    expect(open).toMatchObject({ mode: 'chat' });
    expect(String(open?.append_system_prompt)).toContain('Answer format – JSON only');
    expect(FakeGateway.sockets[1]?.messages()[0]).not.toContain('Use the skill');
    expect(result.model).toContain('inline skill');
  });

  test('refine applies add / update / remove in the same conversation and sends rejected refs', async () => {
    process.env.AI_GATEWAY_SKILLS = 'inline';
    FakeGateway.answers = [
      json({
        cases: [
          fieldRow('C1', 'No TLD', 'qa@example'),
          fieldRow('C2', 'Two @', 'qa@@example.com'),
          fieldRow('C3', 'Spaces', 'qa @example.com'),
        ],
      }),
      `Here are the changes:\n\`\`\`json\n${json({
        add: [fieldRow('C4', 'Trailing dot', 'qa@example.com.')],
        update: [fieldRow('C2', 'Double at sign', 'qa@@example.com')],
        remove: ['C3'],
        note: 'dropped the space case',
      })}\n\`\`\``,
    ];
    const first = await ai.generateCases('field', { min: 1, max: 5 }, fieldCtx);
    const refined = await ai.refineCases(first.session, {
      instruction: 'add a trailing dot case, drop the space case',
      rejected: ['C1'],
    });
    expect(FakeGateway.sockets).toHaveLength(1);
    const followUp = FakeGateway.sockets[0]?.messages()[1] ?? '';
    expect(followUp).toContain('TASK: refine-test-cases');
    expect(followUp).toContain('REJECTED: C1');
    expect(followUp).not.toContain('CONTEXT:');
    expect(refined.changes).toEqual({
      added: 1,
      updated: 1,
      removed: 1,
      note: 'dropped the space case',
    });
    expect(refined.cases.map((c) => c.ref)).toEqual(['C1', 'C2', 'C4']);
    expect(refined.cases[0]?.include).toBe(false);
    expect(refined.cases[1]?.data).toMatchObject({ title: 'Double at sign' });
  });

  test('refine after the gateway session ended seeds a new session with the current cases', async () => {
    process.env.AI_GATEWAY_SKILLS = 'inline';
    FakeGateway.answers = [
      json({ cases: [fieldRow('C1', 'No TLD', 'qa@example')] }),
      json({ add: [fieldRow('C2', 'Unicode', 'qä@example.com')], update: [], remove: [] }),
    ];
    const first = await ai.generateCases('field', { min: 1, max: 3 }, fieldCtx);
    FakeGateway.sockets[0]?.drop();
    const refined = await ai.refineCases(first.session, { instruction: 'add a unicode case' });
    expect(refined.resumed).toBe(true);
    const seeded = FakeGateway.sockets[1]?.messages()[0] ?? '';
    expect(seeded).toContain('TASK: refine-test-cases');
    expect(seeded).toContain('CURRENT CASES: [{"ref":"C1"');
    expect(seeded).toContain('CONTEXT:');
    expect(refined.cases.map((c) => c.ref)).toEqual(['C1', 'C2']);
  });

  test('an answer that is not JSON is asked again once in the same session', async () => {
    process.env.AI_GATEWAY_SKILLS = 'inline';
    FakeGateway.answers = [
      'Sure, here are some ideas …',
      json({ cases: [fieldRow('C1', 'No TLD', 'qa@example')] }),
    ];
    const result = await ai.generateCases('field', { min: 1, max: 3 }, fieldCtx);
    expect(FakeGateway.sockets[0]?.messages()[1]).toContain('ONLY the JSON object');
    expect(result.cases).toHaveLength(1);
  });

  test('gateway errors become clear messages; unknown conversations are reported as ended', async () => {
    process.env.AI_GATEWAY_SKILLS = 'inline';
    FakeGateway.answers = [
      { type: 'error', code: 'seat_pool_saturated', message: 'no seat', retryable: true },
    ];
    await expect(ai.generateCases('field', {}, fieldCtx)).rejects.toThrow(/busy/);
    await expect(ai.refineCases('no-such-id', { instruction: 'x' })).rejects.toThrow(
      /conversation has ended/,
    );
  });

  test('regex: the bank regex decides Valid / Invalid, not the model', async () => {
    FakeGateway.answers = [
      json({
        cases: [
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
        ],
      }),
    ];
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
    expect(digits.ref).toBe('C1');
    expect(name.data).toMatchObject({ expectation: 'valid' });
    expect(name.info).toEqual(['plain name']);
    expect(unknown.include).toBe(false);
    expect(FakeGateway.sockets[0]?.messages()[0]).toContain('full_name: ^[A-Za-z]+');
  });

  test('edge rows go through the upload validation', async () => {
    FakeGateway.answers = [
      json({
        cases: [
          {
            title: 'Declined card',
            card: 'visa-3ds-challenge-decline',
            changes: '',
            cashier: 'Failure redirect',
            status: 'ERROR',
            error: '',
            why: 'N result',
          },
        ],
      }),
    ];
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

  test('without a token the generator explains what to set', async () => {
    const token = process.env.AI_GATEWAY_TOKEN;
    process.env.AI_GATEWAY_TOKEN = '';
    try {
      await expect(ai.generateCases('field', {}, {})).rejects.toThrow(/AI_GATEWAY_TOKEN/);
    } finally {
      if (token === undefined) delete process.env.AI_GATEWAY_TOKEN;
      else process.env.AI_GATEWAY_TOKEN = token;
    }
  });
});

test.describe('AI helpers', () => {
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

  test('parseCasesJson tolerates fences and prose, rejects answers without cases', () => {
    expect(ai.parseCasesJson('{"cases":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(ai.parseCasesJson('Sure!\n```json\n{"cases":[]}\n```\nDone.')).toEqual([]);
    expect(ai.parseCasesJson('text before {"cases":[{"b":2}]} text after')).toEqual([{ b: 2 }]);
    expect(() => ai.parseCasesJson('no json here')).toThrow();
    expect(() => ai.parseCasesJson('{"rows":[]}')).toThrow();
  });
});
