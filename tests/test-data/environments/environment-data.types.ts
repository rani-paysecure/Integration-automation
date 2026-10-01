import type { PurchaseTemplate, S2sTemplate } from '@config/settings';
import type { CardDetails } from '@app-types/payment.types';

/** Data that legitimately differs between LOCAL and UAT (merchants, test cards, limits). */
export interface EnvironmentTestData {
  readonly merchant: {
    readonly id: string;
    readonly defaultCurrency: string;
    readonly country: string;
  };
  readonly cards: {
    readonly approved: CardDetails;
    readonly declined: CardDetails;
  };
  readonly limits: {
    /** Smallest accepted amount in minor units. */
    readonly minAmount: number;
    /** Largest accepted amount in minor units. */
    readonly maxAmount: number;
  };
  readonly callbackUrl: string | undefined;
  /**
   * Baseline purchase request (client, order, redirects, callbacks) – from
   * config/defaults.json, overridable per tester in the launcher.
   */
  readonly purchase: PurchaseTemplate;
  /** Baseline S2S request (launcher → S2S data); the card comes from the Test cards tab. */
  readonly s2s: S2sTemplate;
}
