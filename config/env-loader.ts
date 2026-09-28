import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getSettings, settingsAsEnv } from './settings';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOADED_FLAG = '__IQA_CONFIG_LOADED';

/**
 * Loads configuration into `process.env` once per run. Precedence (highest first):
 *
 * 1. shell / CI variables
 * 2. launcher settings – settings.local.json (git-ignored)
 * 3. `.env`
 * 4. team defaults – config/defaults.json
 *
 * Workers inherit the result from the main process, so they skip this.
 */
export function loadEnvFiles(): void {
  if (process.env[LOADED_FLAG] === '1') return;
  const fromShell = new Set(Object.keys(process.env).filter((k) => process.env[k] !== ''));

  const settings = getSettings();
  const local = settingsAsEnv(settings);
  const envFile = path.join(PROJECT_ROOT, '.env');
  const dotenvValues = fs.existsSync(envFile)
    ? dotenv.parse(fs.readFileSync(envFile))
    : ({} as Record<string, string>);

  const localOverrides = localKeys();
  for (const [key, value] of Object.entries(dotenvValues)) {
    if (!fromShell.has(key) && value !== '' && !localOverrides.has(key)) process.env[key] = value;
  }
  for (const [key, value] of Object.entries(local)) {
    if (fromShell.has(key)) continue;
    // settings.local.json beats .env; team defaults only fill gaps.
    if (localOverrides.has(key) || readEnv(key) === undefined) process.env[key] = value;
  }
  process.env[LOADED_FLAG] = '1';
}

/** Env var names that the tester changed in the launcher (present in settings.local.json). */
function localKeys(): Set<string> {
  const file = path.join(PROJECT_ROOT, 'settings.local.json');
  if (!fs.existsSync(file)) return new Set();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return new Set();
  }
  const keys = new Set<string>();
  const run = (raw.run ?? {}) as Record<string, unknown>;
  const auth = (raw.auth ?? {}) as Record<string, unknown>;
  const environments = (raw.environments ?? {}) as Record<string, Record<string, unknown>>;
  if ('defaultEnvironment' in run) keys.add('TEST_ENV');
  if ('logLevel' in run) keys.add('LOG_LEVEL');
  if ('logHttpBodies' in run) keys.add('LOG_HTTP_BODIES');
  if ('trace' in run) keys.add('PW_TRACE');
  if ('apiKeyHeader' in auth) keys.add('API_KEY_HEADER');
  if ('apiKeyPrefix' in auth) keys.add('API_KEY_PREFIX');
  if ('tokenPath' in auth) keys.add('AUTH_TOKEN_PATH');
  for (const [name, endpoints] of Object.entries(environments)) {
    const prefix = name.toUpperCase();
    if ('baseUrl' in endpoints) keys.add(`${prefix}_BASE_URL`);
    if ('apiBaseUrl' in endpoints) keys.add(`${prefix}_API_BASE_URL`);
  }
  return keys;
}

/** Returns a trimmed env var, treating empty strings as undefined. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Returns the first defined value among the given env var names. */
export function readFirstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}
