import type { EnvironmentSettings } from '../../src/types/config.types';

/**
 * UAT environment – shared server (test4.paymentsclub.net).
 * Shared by all testers, so it runs with limited parallelism and blocks
 * destructive tests by default.
 */
export const uatSettings: EnvironmentSettings = {
  name: 'uat',
  displayName: 'UAT',
  timeouts: {
    test: 90_000,
    expect: 15_000,
    request: 45_000,
  },
  retries: { local: 0, ci: 1 },
  workers: { local: 4, ci: 2 },
  allowDestructiveTests: false,
  defaultHeaders: {
    'x-test-environment': 'uat',
  },
};
