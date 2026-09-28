import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { getSettings, mergeSettings, settingsAsEnv } from '@config/settings';

function writeLocal(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test.describe('Launcher settings', () => {
  test('deep-merges objects and replaces arrays', () => {
    expect(mergeSettings({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] })).toEqual({
      a: { b: 1, c: 3 },
      list: [9],
    });
  });

  test('team defaults are valid and map to env vars', () => {
    const settings = getSettings(path.join(os.tmpdir(), 'no-such-settings.json'));
    const env = settingsAsEnv(settings);
    expect(env.UAT_API_BASE_URL).toBe('https://test4.paymentsclub.net/api');
    expect(env.API_KEY_HEADER).toBe('Authorization');
    expect(settings.cards.uat.length).toBeGreaterThan(0);
  });

  test('local overrides win over defaults', () => {
    const file = writeLocal({
      environments: { local: { apiBaseUrl: 'http://localhost:8080/api' } },
      purchase: { uat: { purchase: { currency: 'USD' } } },
    });
    const settings = getSettings(file);
    expect(settings.environments.local.apiBaseUrl).toBe('http://localhost:8080/api');
    expect(settings.purchase.uat.purchase.currency).toBe('USD');
    expect(settings.purchase.uat.client.city).toBe('jaipur');
  });

  test('rejects invalid values with a clear message', () => {
    const file = writeLocal({ cards: { uat: [{ id: 'x', number: 'abc' }] } });
    expect(() => getSettings(file)).toThrow(/Settings are invalid/);
  });
});
