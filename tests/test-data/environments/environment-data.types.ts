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
  /** Hosted-checkout purchase settings (POST /v1/purchases/). */
  readonly purchase: {
    readonly platform: string;
    readonly successRedirect: string;
    readonly pendingRedirect: string;
    readonly failureRedirect: string;
    readonly successCallback: string;
    readonly failureCallback: string;
  };
}
