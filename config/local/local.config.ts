import type { EnvironmentSettings } from '../../src/types/config.types';

/**
 * LOCAL environment – tests run from the tester's machine against the test4
 * stack (same URLs as UAT by default, see config/defaults.json; change them in
 * the launcher's Environments tab if you run Paysecure locally). Credentials
 * come from the selected tester profile or `LOCAL_*` variables.
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
