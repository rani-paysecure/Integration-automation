import type { TestEnvironment } from '@app-types/config.types';
import type { EnvironmentTestData } from './environment-data.types';
import { localData } from './local.data';
import { uatData } from './uat.data';

const DATA: Readonly<Record<TestEnvironment, EnvironmentTestData>> = {
  local: localData,
  uat: uatData,
};

export function getEnvironmentData(env: TestEnvironment): EnvironmentTestData {
  return DATA[env];
}

export type { EnvironmentTestData } from './environment-data.types';
