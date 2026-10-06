import { getSettings } from '@config/settings';
import type { TestEnvironment } from '@app-types/config.types';
import type { EnvironmentTestData } from './environment-data.types';

/** The baseline purchase / S2S / session requests of an environment (launcher settings). */
export function getEnvironmentData(env: TestEnvironment): EnvironmentTestData {
  const settings = getSettings();
  return {
    purchase: settings.purchase[env],
    s2s: settings.s2s[env],
    session: settings.session[env],
  };
}

export type { EnvironmentTestData } from './environment-data.types';
