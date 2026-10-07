import type { PurchaseTemplate, S2sTemplate, SessionTemplate } from '@config/settings';

/** Request baselines per environment (launcher tabs → config/defaults.json + settings.local.json). */
export interface EnvironmentTestData {
  /**
   * Baseline purchase request (client, order, redirects, callbacks) – from
   * config/defaults.json, overridable per tester in the launcher.
   */
  readonly purchase: PurchaseTemplate;
  /** Baseline S2S request (launcher → S2S data); the card comes from the Test cards tab. */
  readonly s2s: S2sTemplate;
  /** Baseline session payment bodies (launcher → Session data). */
  readonly session: SessionTemplate;
}
