import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ConfigurationError } from '@config/errors';
import { loadProfiles, resolveProfile } from '@config/profiles';

function writeProfiles(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  const file = path.join(dir, 'profiles.local.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test.describe('Tester profiles', () => {
  const valid = {
    profiles: [
      {
        id: 'rani',
        name: 'Rani',
        environments: { uat: { brandId: 'brand-uat', apiKey: 'key-uat' } },
      },
    ],
  };

  test('returns no profiles when the file is missing', () => {
    expect(loadProfiles(path.join(os.tmpdir(), 'does-not-exist.json'))).toEqual([]);
  });

  test('resolves credentials for the selected environment', () => {
    const file = writeProfiles(valid);
    const { profile, credentials } = resolveProfile('rani', 'uat', file);
    expect(profile.name).toBe('Rani');
    expect(credentials).toEqual({ brandId: 'brand-uat', apiKey: 'key-uat' });
  });

  test('fails clearly for unknown profiles and missing environments', () => {
    const file = writeProfiles(valid);
    expect(() => resolveProfile('someone', 'uat', file)).toThrow(/not found/);
    expect(() => resolveProfile('rani', 'local', file)).toThrow(/no credentials for LOCAL/);
  });

  test('rejects malformed profile files', () => {
    const file = writeProfiles({ profiles: [{ id: 'Bad Id', name: '', environments: {} }] });
    expect(() => loadProfiles(file)).toThrow(ConfigurationError);
  });
});
