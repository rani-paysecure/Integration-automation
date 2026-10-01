import path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from './errors';
import * as core from './settings-core';

/**
 * Runtime settings = committed team defaults (config/defaults.json) deep-merged
 * with the tester's local overrides (settings.local.json, git-ignored, edited
 * in the launcher UI). Arrays are replaced, not merged. No secrets live here –
 * API keys and dashboard passwords belong in profiles.local.json.
 */
export const SETTINGS_FILE: string = core.SETTINGS_FILE;
export const mergeSettings: (base: unknown, override: unknown) => unknown = core.mergeSettings;

export type Settings = z.infer<typeof core.settingsSchema>;
export type PurchaseTemplate = z.infer<typeof core.purchaseTemplateSchema>;
export type S2sTemplate = z.infer<typeof core.s2sTemplateSchema>;
export type CardSetting = z.infer<typeof core.cardSettingSchema>;

let cached: Settings | undefined;

/** Effective settings (defaults + local overrides), validated. */
export function getSettings(file: string = SETTINGS_FILE): Settings {
  if (cached && file === SETTINGS_FILE) return cached;
  let result: ReturnType<typeof core.resolveSettings>;
  try {
    result = core.resolveSettings(file);
  } catch (error: unknown) {
    throw new ConfigurationError(
      `${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!result.success) {
    throw new ConfigurationError(
      `Settings are invalid (config/defaults.json + ${path.basename(file)}):\n${z.prettifyError(result.error)}`,
    );
  }
  if (file === SETTINGS_FILE) cached = result.data;
  return result.data;
}

/** Settings expressed as the env vars the rest of the framework reads. */
export function settingsAsEnv(settings: Settings): Record<string, string> {
  const env: Record<string, string> = {
    TEST_ENV: settings.run.defaultEnvironment,
    LOG_LEVEL: settings.run.logLevel,
    LOG_HTTP_BODIES: String(settings.run.logHttpBodies),
    API_KEY_HEADER: settings.auth.apiKeyHeader,
    API_KEY_PREFIX: settings.auth.apiKeyPrefix,
    AUTH_TOKEN_PATH: settings.auth.tokenPath,
  };
  if (settings.run.trace !== '') env.PW_TRACE = settings.run.trace;
  for (const [name, endpoints] of Object.entries(settings.environments)) {
    const prefix = name.toUpperCase();
    if (endpoints.baseUrl) env[`${prefix}_BASE_URL`] = endpoints.baseUrl;
    if (endpoints.apiBaseUrl) env[`${prefix}_API_BASE_URL`] = endpoints.apiBaseUrl;
  }
  return env;
}
