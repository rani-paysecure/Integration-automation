import type { EnvironmentSettings } from '../../src/types/config.types';

/**
 * LOCAL environment – a Paysecure stack running on a developer / QA machine
 * (e.g. http://localhost:8080). URLs and credentials come from `LOCAL_*`
 * variables or the selected tester profile – see `.env.example`.
 */
export const localSettings: EnvironmentSettings = {
  name: 'local',
  displayName: 'LOCAL',
  timeouts: {
    test: 60_000,
    expect: 10_000,
    request: 30_000,
  },
  retries: { local: 0, ci: 0 },
  workers: { local: '50%', ci: 2 },
  allowDestructiveTests: true,
  defaultHeaders: {
    'x-test-environment': 'local',
  },
};
