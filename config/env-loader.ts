import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const PROJECT_ROOT = path.resolve(__dirname, '..');

let loaded = false;

/**
 * Loads `.env.<env>` (optional) and then `.env` from the project root.
 *
 * - Variables already present in `process.env` (shell, CI secrets) always win.
 * - Earlier files win over later ones, so `.env.uat` overrides `.env`.
 * - Safe to call multiple times; files are only read once per process.
 */
export function loadEnvFiles(env: string): void {
  if (loaded) return;
  loaded = true;

  const candidates = [`.env.${env}`, '.env'];
  for (const file of candidates) {
    const fullPath = path.join(PROJECT_ROOT, file);
    if (fs.existsSync(fullPath)) {
      dotenv.config({ path: fullPath, override: false, quiet: true });
    }
  }
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
