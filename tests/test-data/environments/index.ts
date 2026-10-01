import { getSettings } from '@config/settings';
import type { TestEnvironment } from '@app-types/config.types';
import type { EnvironmentTestData } from './environment-data.types';
import { localData } from './local.data';
import { uatData } from './uat.data';

const DATA: Readonly<Record<TestEnvironment, Omit<EnvironmentTestData, 'purchase' | 's2s'>>> = {
  local: localData,
  uat: uatData,
};

/** Environment data + the baseline purchase template from the (launcher) settings. */
export function getEnvironmentData(env: TestEnvironment): EnvironmentTestData {
  const settings = getSettings();
  return { ...DATA[env], purchase: settings.purchase[env], s2s: settings.s2s[env] };
}

export type { EnvironmentTestData } from './environment-data.types';
